import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRef, SessionSnapshot } from "@wuming/protocol";
import { DatabaseSync } from "node:sqlite";
import { ArtifactError } from "./errors.js";
import { extractArtifact, type PdfExtractionOptions } from "./extraction.js";
import { validateArtifact, type ArtifactValidationOptions } from "./validation.js";

interface ArtifactRow {
	id: string;
	workspace_id: string;
	owner_id: string;
	name: string;
	mime_type: string;
	size: number;
	sha256: string;
	kind: "binary" | "image" | "text";
	created_at: number;
}

export interface ArtifactRecord {
	ref: ArtifactRef;
	workspaceId: string;
	ownerId: string;
	sha256: string;
	kind: "binary" | "image" | "text";
	createdAt: number;
}

export interface ArtifactStoreOptions extends ArtifactValidationOptions {
	idFactory?: () => string;
	clock?: () => number;
	maxExtractedTextChars?: number;
	pdfExtraction?: PdfExtractionOptions;
}

function record(row: ArtifactRow): ArtifactRecord {
	return {
		ref: { id: row.id, name: row.name, mimeType: row.mime_type, size: row.size },
		workspaceId: row.workspace_id,
		ownerId: row.owner_id,
		sha256: row.sha256,
		kind: row.kind,
		createdAt: row.created_at,
	};
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
	return (
		left.id === right.id && left.name === right.name && left.mimeType === right.mimeType && left.size === right.size
	);
}

export class ArtifactStore implements Disposable {
	readonly #db: DatabaseSync;
	readonly #objectRoot: string;
	readonly #idFactory: () => string;
	readonly #clock: () => number;
	readonly #validation: ArtifactValidationOptions;
	readonly #maxExtractedTextChars: number;
	readonly #pdfExtraction: PdfExtractionOptions;

	private constructor(databasePath: string, objectRoot: string, options: ArtifactStoreOptions) {
		this.#db = new DatabaseSync(databasePath);
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS artifacts (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				name TEXT NOT NULL,
				mime_type TEXT NOT NULL,
				size INTEGER NOT NULL,
				sha256 TEXT NOT NULL,
				kind TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS artifacts_workspace_created ON artifacts(workspace_id, created_at DESC);
		`);
		this.#objectRoot = objectRoot;
		this.#idFactory = options.idFactory ?? randomUUID;
		this.#clock = options.clock ?? Date.now;
		this.#maxExtractedTextChars = options.maxExtractedTextChars ?? 200_000;
		this.#pdfExtraction = options.pdfExtraction ?? {};
		this.#validation = {
			...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
			...(options.maxImageBytes === undefined ? {} : { maxImageBytes: options.maxImageBytes }),
			...(options.maxVideoBytes === undefined ? {} : { maxVideoBytes: options.maxVideoBytes }),
			...(options.maxTextBytes === undefined ? {} : { maxTextBytes: options.maxTextBytes }),
			...(options.maxImagePixels === undefined ? {} : { maxImagePixels: options.maxImagePixels }),
		};
	}

	static async open(
		databasePath: string,
		objectRoot: string,
		options: ArtifactStoreOptions = {}
	): Promise<ArtifactStore> {
		await mkdir(objectRoot, { recursive: true });
		return new ArtifactStore(databasePath, objectRoot, options);
	}

	async create(input: {
		workspaceId: string;
		ownerId: string;
		name: string;
		suppliedMimeType?: string;
		content: Buffer;
	}): Promise<ArtifactRecord> {
		if (!input.workspaceId || !input.ownerId) throw new ArtifactError("invalid", "Workspace and owner are required");
		const validated = validateArtifact(input, this.#validation);
		const sha256 = createHash("sha256").update(input.content).digest("hex");
		await this.#writeObject(sha256, input.content);
		const value: ArtifactRecord = {
			ref: {
				id: this.#idFactory(),
				name: validated.name,
				mimeType: validated.mimeType,
				size: input.content.length,
			},
			workspaceId: input.workspaceId,
			ownerId: input.ownerId,
			sha256,
			kind: validated.kind,
			createdAt: this.#clock(),
		};
		this.#db
			.prepare(
				"INSERT INTO artifacts(id, workspace_id, owner_id, name, mime_type, size, sha256, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
			)
			.run(
				value.ref.id,
				value.workspaceId,
				value.ownerId,
				value.ref.name,
				value.ref.mimeType,
				value.ref.size,
				value.sha256,
				value.kind,
				value.createdAt
			);
		return value;
	}

	get(id: string): ArtifactRecord | undefined {
		const row = this.#db
			.prepare(
				"SELECT id, workspace_id, owner_id, name, mime_type, size, sha256, kind, created_at FROM artifacts WHERE id = ?"
			)
			.get(id) as unknown as ArtifactRow | undefined;
		return row ? record(row) : undefined;
	}

	assertReference(ref: ArtifactRef, workspaceId: string): ArtifactRecord {
		const stored = this.get(ref.id);
		if (!stored) throw new ArtifactError("not_found", `Artifact ${ref.id} does not exist`);
		if (stored.workspaceId !== workspaceId)
			throw new ArtifactError("forbidden", "Artifact belongs to another workspace");
		if (!sameRef(stored.ref, ref)) throw new ArtifactError("invalid", `Artifact reference ${ref.id} was modified`);
		return stored;
	}

	assertSessionReference(ref: ArtifactRef, snapshot: SessionSnapshot): ArtifactRecord {
		return this.assertReference(ref, snapshot.session.workspaceId);
	}

	async read(id: string): Promise<{ record: ArtifactRecord; content: Buffer }> {
		const stored = this.get(id);
		if (!stored) throw new ArtifactError("not_found", `Artifact ${id} does not exist`);
		let content: Buffer;
		try {
			content = await readFile(this.#objectPath(stored.sha256));
		} catch {
			throw new ArtifactError("corrupt", `Artifact object ${id} is unavailable`);
		}
		if (content.length !== stored.ref.size || createHash("sha256").update(content).digest("hex") !== stored.sha256) {
			throw new ArtifactError("corrupt", `Artifact object ${id} failed integrity validation`);
		}
		return { record: stored, content };
	}

	async resolve(
		ref: ArtifactRef,
		snapshot: SessionSnapshot
	): Promise<{
		data: string;
		mimeType: string;
		binary?: boolean;
		extractedText?: string;
		extractionNotice?: string;
	}> {
		this.assertSessionReference(ref, snapshot);
		const { record: stored, content } = await this.read(ref.id);
		const extraction =
			stored.kind === "binary"
				? await extractArtifact(
						{ name: stored.ref.name, mimeType: stored.ref.mimeType, content },
						this.#maxExtractedTextChars,
						this.#pdfExtraction
					)
				: {};
		return {
			data: content.toString("base64"),
			mimeType: stored.ref.mimeType,
			...(stored.kind === "binary" ? { binary: true } : {}),
			...(extraction.text === undefined ? {} : { extractedText: extraction.text }),
			...(extraction.notice === undefined ? {} : { extractionNotice: extraction.notice }),
		};
	}

	#objectPath(sha256: string): string {
		return join(this.#objectRoot, sha256.slice(0, 2), sha256);
	}

	async #writeObject(sha256: string, content: Buffer): Promise<void> {
		const directory = join(this.#objectRoot, sha256.slice(0, 2));
		await mkdir(directory, { recursive: true });
		const target = this.#objectPath(sha256);
		try {
			await access(target);
			return;
		} catch {
			// Continue with an atomic create.
		}
		const temporary = join(directory, `.${sha256}.${randomUUID()}.tmp`);
		await writeFile(temporary, content, { flag: "wx" });
		try {
			await rename(temporary, target);
		} catch (error) {
			try {
				await access(target);
				await rm(temporary, { force: true });
				return;
			} catch {
				await rm(temporary, { force: true });
				throw error;
			}
		}
	}

	close(): void {
		this.#db.close();
	}

	[Symbol.dispose](): void {
		this.close();
	}
}

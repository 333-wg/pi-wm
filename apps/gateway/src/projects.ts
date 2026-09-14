import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { WorkspaceSummary } from "@wuming/protocol";
import type { WorkspaceConfiguration } from "./configuration.js";

interface ImportedProjectRecord {
	id: string;
	name: string;
	path: string;
	createdAt: number;
	updatedAt: number;
	hiddenAt?: number;
}

interface ProjectDraft extends ImportedProjectRecord {
	ownerId: string;
	files: Set<string>;
	totalBytes: number;
}

interface ImportedProjectManifest {
	version: 1;
	projects: ImportedProjectRecord[];
}

export interface ImportedProjectCatalogOptions {
	maxFiles?: number;
	maxTotalBytes?: number;
	clock?: () => number;
	idFactory?: () => string;
}

function projectError(message: string, httpStatus: number): Error {
	return Object.assign(new Error(message), { httpStatus });
}

function safeProjectName(value: string): string {
	const name = value.trim();
	if (!name) throw projectError("Project name is required", 400);
	if (name.length > 500) throw projectError("Project name is too long", 400);
	return name;
}

function safeRelativePath(value: string): string {
	if (!value || value.length > 4000 || value.includes("\0")) throw projectError("Project file path is invalid", 400);
	const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
	const segments = normalized.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw projectError("Project file path is invalid", 400);
	}
	return segments.join("/");
}

function summary(record: ImportedProjectRecord, status: WorkspaceSummary["status"] = "ready"): WorkspaceSummary {
	return {
		id: record.id,
		name: record.name,
		status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export class ImportedProjectCatalog {
	readonly #root: string;
	readonly #manifestPath: string;
	readonly #maxFiles: number;
	readonly #maxTotalBytes: number;
	readonly #clock: () => number;
	readonly #idFactory: () => string;
	readonly #projects = new Map<string, ImportedProjectRecord>();
	readonly #drafts = new Map<string, ProjectDraft>();

	private constructor(root: string, options: ImportedProjectCatalogOptions) {
		this.#root = resolve(root);
		this.#manifestPath = join(this.#root, "projects.json");
		this.#maxFiles = options.maxFiles ?? 10_000;
		this.#maxTotalBytes = options.maxTotalBytes ?? 512 * 1024 * 1024;
		this.#clock = options.clock ?? Date.now;
		this.#idFactory = options.idFactory ?? (() => `project-${randomUUID()}`);
	}

	static async open(root: string, options: ImportedProjectCatalogOptions = {}): Promise<ImportedProjectCatalog> {
		const catalog = new ImportedProjectCatalog(root, options);
		await mkdir(catalog.#root, { recursive: true });
		let manifest: ImportedProjectManifest | undefined;
		try {
			manifest = JSON.parse(await readFile(catalog.#manifestPath, "utf8")) as ImportedProjectManifest;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (!manifest) return catalog;
		if (manifest.version !== 1 || !Array.isArray(manifest.projects))
			throw new Error("Imported project manifest is invalid");
		for (const record of manifest.projects) {
			if (
				!record ||
				typeof record.id !== "string" ||
				typeof record.name !== "string" ||
				typeof record.path !== "string"
			)
				continue;
			const path = resolve(record.path);
			try {
				if (!(await stat(path)).isDirectory()) continue;
			} catch {
				continue;
			}
			catalog.#projects.set(record.id, { ...record, path });
		}
		return catalog;
	}

	configurations(): WorkspaceConfiguration[] {
		return [...this.#projects.values()]
			.filter((project) => project.hiddenAt === undefined)
			.map(({ id, name, path }) => ({ id, name, path }));
	}

	async addLocal(pathValue: string, kind: "file" | "directory"): Promise<WorkspaceSummary> {
		const selectedPath = await realpath(pathValue);
		const info = await stat(selectedPath);
		if (kind === "directory" && !info.isDirectory()) throw projectError("Selected path is not a directory", 400);
		if (kind === "file" && !info.isFile()) throw projectError("Selected path is not a file", 400);
		const path = kind === "directory" ? selectedPath : dirname(selectedPath);
		const selectedName = basename(selectedPath) || basename(path) || "Local project";
		const existing = [...this.#projects.values()].find((project) => project.path === path);
		if (existing) {
			if (existing.hiddenAt !== undefined) {
				delete existing.hiddenAt;
				existing.updatedAt = this.#clock();
				await this.#save();
			}
			return summary(existing);
		}
		const now = this.#clock();
		const id = this.#idFactory();
		if (!id || this.#projects.has(id) || this.#drafts.has(id)) throw new Error("Project ID collision");
		const record: ImportedProjectRecord = {
			id,
			name: selectedName,
			path,
			createdAt: now,
			updatedAt: now,
		};
		this.#projects.set(record.id, record);
		await this.#save();
		return summary(record);
	}

	async create(ownerId: string, name: string): Promise<WorkspaceSummary> {
		const id = this.#idFactory();
		if (!id || this.#projects.has(id) || this.#drafts.has(id)) throw new Error("Project ID collision");
		const now = this.#clock();
		const path = join(this.#root, id, "workspace");
		await mkdir(path, { recursive: true });
		const draft: ProjectDraft = {
			id,
			name: safeProjectName(name),
			path,
			createdAt: now,
			updatedAt: now,
			ownerId,
			files: new Set(),
			totalBytes: 0,
		};
		this.#drafts.set(id, draft);
		return summary(draft, "provisioning");
	}

	async writeProjectFile(ownerId: string, projectId: string, pathValue: string, content: Buffer): Promise<void> {
		const draft = this.#ownedDraft(ownerId, projectId);
		const path = safeRelativePath(pathValue);
		const replacing = draft.files.has(path);
		if (!replacing && draft.files.size >= this.#maxFiles) throw projectError("Project contains too many files", 413);
		if (draft.totalBytes + content.length > this.#maxTotalBytes)
			throw projectError("Project exceeds the total upload limit", 413);
		const target = resolve(draft.path, ...path.split("/"));
		const escaped = relative(draft.path, target);
		if (escaped.startsWith(`..${sep}`) || escaped === "..")
			throw projectError("Project file path escapes the project", 400);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
		if (!replacing) draft.files.add(path);
		draft.totalBytes += content.length;
		draft.updatedAt = this.#clock();
	}

	async complete(
		ownerId: string,
		projectId: string
	): Promise<{ configuration: WorkspaceConfiguration; workspace: WorkspaceSummary }> {
		const draft = this.#ownedDraft(ownerId, projectId);
		if (draft.files.size === 0) throw projectError("Project must contain at least one file", 400);
		const record: ImportedProjectRecord = {
			id: draft.id,
			name: draft.name,
			path: draft.path,
			createdAt: draft.createdAt,
			updatedAt: this.#clock(),
		};
		this.#projects.set(record.id, record);
		this.#drafts.delete(record.id);
		await this.#save();
		return {
			configuration: { id: record.id, name: record.name, path: record.path },
			workspace: summary(record),
		};
	}

	async renameProject(projectId: string, name: string): Promise<WorkspaceSummary> {
		const project = this.#visibleProject(projectId);
		project.name = safeProjectName(name);
		project.updatedAt = this.#clock();
		await this.#save();
		return summary(project);
	}

	async removeProject(projectId: string): Promise<void> {
		const project = this.#visibleProject(projectId);
		project.hiddenAt = this.#clock();
		project.updatedAt = project.hiddenAt;
		await this.#save();
	}

	#ownedDraft(ownerId: string, projectId: string): ProjectDraft {
		const draft = this.#drafts.get(projectId);
		if (!draft) throw projectError("Project import does not exist", 404);
		if (draft.ownerId !== ownerId) throw projectError("Project import access denied", 403);
		return draft;
	}

	#visibleProject(projectId: string): ImportedProjectRecord {
		const project = this.#projects.get(projectId);
		if (!project || project.hiddenAt !== undefined) throw projectError("Project does not exist", 404);
		return project;
	}

	async #save(): Promise<void> {
		const manifest: ImportedProjectManifest = {
			version: 1,
			projects: [...this.#projects.values()],
		};
		const temporary = `${this.#manifestPath}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await rename(temporary, this.#manifestPath);
	}
}

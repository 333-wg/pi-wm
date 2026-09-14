import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SandboxError } from "./errors.js";
import { WorkspacePathPolicy } from "./path-policy.js";
import type { EditTextOptions, ReadTextOptions, ReadTextResult, WorkspaceFiles } from "./types.js";

export interface WorkspaceFileExecutorOptions {
	maxReadBytes?: number;
	maxWriteBytes?: number;
}

export class WorkspaceFileExecutor implements WorkspaceFiles {
	readonly root: string;
	readonly #policy: WorkspacePathPolicy;
	readonly #maxReadBytes: number;
	readonly #maxWriteBytes: number;

	private constructor(policy: WorkspacePathPolicy, options: WorkspaceFileExecutorOptions) {
		this.#policy = policy;
		this.root = policy.root;
		this.#maxReadBytes = options.maxReadBytes ?? 1024 * 1024;
		this.#maxWriteBytes = options.maxWriteBytes ?? 2 * 1024 * 1024;
	}

	static async create(root: string, options: WorkspaceFileExecutorOptions = {}): Promise<WorkspaceFileExecutor> {
		return new WorkspaceFileExecutor(await WorkspacePathPolicy.create(root), options);
	}

	async readFile(path: string): Promise<Buffer> {
		const resolved = await this.#policy.existing(path);
		const fileStats = await stat(resolved);
		if (!fileStats.isFile()) throw new SandboxError("path_invalid", `${path} is not a file`);
		if (fileStats.size > this.#maxReadBytes) {
			throw new SandboxError("file_too_large", `Read exceeds ${this.#maxReadBytes} byte limit`);
		}
		return readFile(resolved);
	}

	async readText(path: string, options: ReadTextOptions = {}): Promise<ReadTextResult> {
		const resolved = await this.#policy.existing(path);
		const fileStats = await stat(resolved);
		if (!fileStats.isFile()) throw new SandboxError("path_invalid", `${path} is not a file`);
		const handle = await open(resolved, "r");
		try {
			const maxBytes = Math.min(this.#maxReadBytes, fileStats.size);
			const buffer = Buffer.alloc(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			const decoded = buffer.subarray(0, bytesRead).toString("utf8");
			const lines = decoded.split(/\r?\n/);
			const offset = Math.max(1, Math.floor(options.offset ?? 1));
			const limit = Math.max(1, Math.floor(options.limit ?? lines.length));
			const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n");
			return {
				content: selected,
				bytesRead: Buffer.byteLength(selected),
				totalBytes: fileStats.size,
				truncated: fileStats.size > bytesRead || offset > 1 || offset - 1 + limit < lines.length,
			};
		} finally {
			await handle.close();
		}
	}

	async writeText(path: string, content: string): Promise<{ bytesWritten: number }> {
		return this.#writeText(path, content);
	}

	async writeTextIfUnchanged(path: string, content: string, expectedSha256: string): Promise<{ bytesWritten: number }> {
		return this.#writeText(path, content, expectedSha256);
	}

	async #writeText(path: string, content: string, expectedSha256?: string): Promise<{ bytesWritten: number }> {
		const bytes = Buffer.byteLength(content);
		if (bytes > this.#maxWriteBytes) {
			throw new SandboxError("file_too_large", `Write exceeds ${this.#maxWriteBytes} byte limit`);
		}
		const target = await this.#policy.writable(path);
		await mkdir(dirname(target), { recursive: true });
		// Revalidate after directory creation so a newly introduced junction cannot redirect the write.
		const revalidatedTarget = await this.#policy.writable(path);
		const assertUnchanged = async () => {
			if (expectedSha256 === undefined) return;
			const current = await readFile(revalidatedTarget).catch((error: unknown) => {
				throw new SandboxError(
					"edit_conflict",
					`File changed before edit could be written: ${error instanceof Error ? error.message : String(error)}`
				);
			});
			const currentSha256 = createHash("sha256").update(current).digest("hex");
			if (currentSha256 !== expectedSha256)
				throw new SandboxError("edit_conflict", "File changed while the edit was being prepared");
		};
		await assertUnchanged();
		const temporary = join(dirname(revalidatedTarget), `.${basename(revalidatedTarget)}.wuming-${randomUUID()}.tmp`);
		const handle = await open(temporary, "wx");
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
			const existing = await stat(revalidatedTarget).catch(() => undefined);
			if (existing) await chmod(temporary, existing.mode & 0o777);
			await assertUnchanged();
			await handle.close();
			await rename(temporary, revalidatedTarget);
		} catch (error) {
			await handle.close().catch(() => undefined);
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
		return { bytesWritten: bytes };
	}

	async editText(
		path: string,
		oldText: string,
		newText: string,
		options: EditTextOptions = {}
	): Promise<{ bytesWritten: number; replacements: number }> {
		if (!oldText) throw new SandboxError("edit_conflict", "oldText must not be empty");
		const resolved = await this.#policy.existing(path);
		const fileStats = await stat(resolved);
		if (fileStats.size > this.#maxReadBytes) {
			throw new SandboxError("file_too_large", `Edit source exceeds ${this.#maxReadBytes} byte limit`);
		}
		const originalBuffer = await readFile(resolved);
		const original = originalBuffer.toString("utf8");
		const matches = original.split(oldText).length - 1;
		if (matches === 0) throw new SandboxError("edit_conflict", "oldText was not found");
		if (!options.replaceAll && matches !== 1) {
			throw new SandboxError("edit_conflict", `oldText matched ${matches} times; provide a unique match`);
		}
		const content = options.replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, newText);
		const expectedSha256 = createHash("sha256").update(originalBuffer).digest("hex");
		const result = await this.writeTextIfUnchanged(path, content, expectedSha256);
		return { ...result, replacements: options.replaceAll ? matches : 1 };
	}
}

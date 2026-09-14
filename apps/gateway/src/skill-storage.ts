import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export function skillError(message: string, protocolCode = "invalid_request"): Error {
	return Object.assign(new Error(message), { protocolCode });
}

export function validateSkillId(id: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id) || !validName(id)) throw skillError("Invalid skill id");
}

function validName(name: string): boolean {
	return (
		name !== "." &&
		name !== ".." &&
		!/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
		!/[. ]$/.test(name) &&
		!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
	);
}

export async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Inspect each ancestor before traversing it; never silently follow a junction. */
export async function safeDirectory(path: string, create = false): Promise<string> {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
		current = join(current, component);
		if (create)
			await mkdir(current).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			});
		const info = await lstat(current);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw skillError("Skill directory must not contain symbolic links", "forbidden");
	}
	return absolute;
}

export async function boundedFile(path: string, limit: number): Promise<Buffer> {
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink()) throw skillError("Skill files must be regular files", "forbidden");
	const file = await open(path, "r");
	try {
		const info = await file.stat();
		if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev)
			throw skillError("Skill file changed while reading", "conflict");
		if (info.size > limit) throw skillError("Skill package exceeds size limit");
		const data = Buffer.alloc(limit + 1);
		let offset = 0;
		while (offset < data.length) {
			const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset > limit) throw skillError("Skill package exceeds size limit");
		return data.subarray(0, offset);
	} finally {
		await file.close();
	}
}

export async function snapshotSkillPackage(directory: string): Promise<Map<string, Buffer>> {
	const root = await safeDirectory(directory);
	const files = new Map<string, Buffer>();
	let bytes = 0;
	let entries = 0;
	async function visit(path: string, depth: number): Promise<void> {
		if (depth > 12) throw skillError("Skill package nesting is too deep");
		for (const entry of await readdir(path, { withFileTypes: true })) {
			if (++entries > 256) throw skillError("Skill package has too many entries");
			if (!validName(entry.name) || entry.name.length > 200) throw skillError("Invalid skill package filename");
			const child = join(path, entry.name);
			const info = await lstat(child);
			if (info.isSymbolicLink()) throw skillError("Skill package contains a symbolic link", "forbidden");
			if (info.isDirectory()) {
				await visit(child, depth + 1);
				continue;
			}
			const key = relative(root, child);
			const buffer = await boundedFile(child, key === "SKILL.md" ? 200 * 1024 : 2 * 1024 * 1024);
			bytes += buffer.length;
			if (bytes > 8 * 1024 * 1024) throw skillError("Skill package exceeds total size limit");
			files.set(key, buffer);
		}
	}
	await visit(root, 0);
	if (!files.has("SKILL.md")) throw skillError("Skill package must contain SKILL.md");
	return files;
}

/** Cleanup is restricted to our private, generated staging directories. */
export async function removeSkillStage(control: string, stage: string): Promise<void> {
	await safeDirectory(control);
	const path = resolve(stage);
	const suffix = relative(resolve(control), path);
	if (isAbsolute(suffix) || suffix.includes(sep) || !/^\.skill-stage-[0-9a-f-]+$/.test(suffix))
		throw skillError("Invalid staging cleanup path", "forbidden");
	if (!(await exists(path))) return;
	await safeDirectory(path);
	await rm(path, { recursive: true });
}

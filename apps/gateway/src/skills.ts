import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Skill, SkillSummary } from "@wuming/protocol";

const SKILLS_DIRECTORY = ".wuming/skills";
const SKILL_FILE = "SKILL.md";
const MAX_SKILLS = 100;
const MAX_CONTENT_BYTES = 200 * 1024;

export interface SkillCatalog {
	list(workspaceId: string, workspaceRoot: string): Promise<SkillSummary[]>;
	get(workspaceId: string, workspaceRoot: string, skillId: string): Promise<Skill>;
}

function safeId(value: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
}

function parseMetadata(raw: string, fallbackName: string): { name: string; description: string; content: string } {
	let content = raw;
	let name = fallbackName;
	let description = "";
	if (raw.startsWith("---\n")) {
		const end = raw.indexOf("\n---", 4);
		if (end >= 0) {
			const header = raw.slice(4, end).split(/\r?\n/);
			for (const line of header) {
				const separator = line.indexOf(":");
				if (separator < 0) continue;
				const key = line.slice(0, separator).trim().toLowerCase();
				const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
				if (key === "name" && value) name = value.slice(0, 200);
				if (key === "description" && value) description = value.slice(0, 2000);
			}
			content = raw.slice(end + 4).replace(/^\r?\n/, "");
		}
	}
	if (!description) {
		const paragraph = content.split(/\r?\n\s*\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
		description = (paragraph ?? "").slice(0, 2000);
	}
	return { name: name || fallbackName, description, content };
}

async function skillPath(workspaceRoot: string, skillId: string): Promise<string> {
	if (!safeId(skillId)) throw Object.assign(new Error("Invalid skill id"), { protocolCode: "invalid_request" });
	const root = resolve(workspaceRoot);
	const directory = resolve(root, SKILLS_DIRECTORY, skillId);
	if (relative(root, directory).startsWith("..")) throw Object.assign(new Error("Skill path escapes workspace"), { protocolCode: "forbidden" });
	const candidate = join(directory, SKILL_FILE);
	const directoryInfo = await lstat(directory).catch(() => undefined);
	const fileInfo = await lstat(candidate).catch(() => undefined);
	if (!directoryInfo || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !fileInfo || !fileInfo.isFile() || fileInfo.isSymbolicLink()) {
		throw Object.assign(new Error(`Skill ${skillId} was not found`), { protocolCode: "not_found" });
	}
	return candidate;
}

export class FileSkillCatalog implements SkillCatalog {
	async list(workspaceId: string, workspaceRoot: string): Promise<SkillSummary[]> {
		const root = resolve(workspaceRoot);
		const directory = join(root, SKILLS_DIRECTORY);
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		const skills: SkillSummary[] = [];
		for (const entry of entries.slice(0, MAX_SKILLS)) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || !safeId(entry.name)) continue;
			try {
				const path = await skillPath(root, entry.name);
				const info = await stat(path);
				const raw = await readFile(path, { encoding: "utf8" });
				const metadata = parseMetadata(raw.slice(0, MAX_CONTENT_BYTES), entry.name);
				skills.push({ id: entry.name, workspaceId, name: metadata.name, description: metadata.description, path: relative(root, path).replaceAll("\\", "/"), updatedAt: Math.trunc(info.mtimeMs) });
			} catch {
				// Ignore malformed or unreadable skills while keeping discovery available.
			}
		}
		return skills.sort((left, right) => left.name.localeCompare(right.name));
	}

	async get(workspaceId: string, workspaceRoot: string, skillId: string): Promise<Skill> {
		const path = await skillPath(workspaceRoot, skillId);
		const info = await stat(path);
		const raw = await readFile(path, { encoding: "utf8" });
		const metadata = parseMetadata(raw.slice(0, MAX_CONTENT_BYTES), skillId);
		return { id: skillId, workspaceId, name: metadata.name, description: metadata.description, path: relative(resolve(workspaceRoot), path).replaceAll("\\", "/"), updatedAt: Math.trunc(info.mtimeMs), content: metadata.content.slice(0, MAX_CONTENT_BYTES), truncated: Buffer.byteLength(raw, "utf8") > MAX_CONTENT_BYTES };
	}
}

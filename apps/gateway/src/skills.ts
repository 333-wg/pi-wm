import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Skill, SkillSummary } from "@wuming/protocol";
import { boundedFile, exists, safeDirectory } from "./skill-storage.js";

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

export function parseSkillMetadata(
	raw: string,
	fallbackName: string,
	requireMetadata = false
): { name: string; description: string; content: string; allowImplicitInvocation?: boolean } {
	const source = raw.replace(/^\uFEFF/, "");
	let content = source;
	let name = fallbackName;
	let description = "";
	let allowImplicitInvocation: boolean | undefined;
	const header = /^---[ \t]*(?:\r\n|\n|\r)(?:([\s\S]*?)(?:\r\n|\n|\r))?---[ \t]*(?:(?:\r\n|\n|\r)|$)/.exec(source);
	if (requireMetadata && !header)
		throw Object.assign(new Error("Skill YAML metadata is required"), {
			protocolCode: "invalid_request",
		});
	if (header) {
		try {
			const { frontmatter } = parseFrontmatter(`---\n${header[1] ?? ""}\n---\n`);
			if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter))
				throw new Error("Expected a metadata object");
			if (requireMetadata) {
				for (const [field, limit] of [
					["name", 200],
					["description", 2000],
				] as const) {
					const value = (frontmatter as Record<string, unknown>)[field];
					if (typeof value !== "string" || !value.trim() || value.length > limit)
						throw new Error("Required skill metadata is missing or invalid");
				}
			}
			for (const [field, value] of Object.entries(frontmatter)) {
				const key = field.toLowerCase();
				if (key === "disable-model-invocation") {
					if (typeof value !== "boolean") throw new Error("Expected boolean invocation policy");
					allowImplicitInvocation = !value;
					continue;
				}
				if (key !== "name" && key !== "description") continue;
				if (typeof value !== "string") throw new Error("Expected a metadata string");
				if (key === "name" && value.trim()) name = value.trim().slice(0, 200);
				if (key === "description" && value.trim()) description = value.trim().slice(0, 2000);
			}
		} catch {
			throw Object.assign(new Error(`Skill ${fallbackName} has invalid YAML metadata`), {
				protocolCode: "invalid_request",
			});
		}
		// Only the metadata is normalized by Pi; preserve instruction whitespace.
		content = source.slice(header[0].length);
	}
	if (!description) {
		const paragraph = content
			.split(/\r?\n\s*\r?\n/)
			.map((line) => line.trim())
			.find((line) => line && !line.startsWith("#"));
		description = (paragraph ?? "").slice(0, 2000);
	}
	return {
		name: name || fallbackName,
		description,
		content,
		...(allowImplicitInvocation === undefined ? {} : { allowImplicitInvocation }),
	};
}

async function skillBase(workspaceRoot: string, components = [".wuming", "skills"]): Promise<string> {
	let directory = resolve(workspaceRoot);
	for (const component of components) {
		directory = join(directory, component);
		const info = await lstat(directory).catch(() => undefined);
		if (!info || !info.isDirectory() || info.isSymbolicLink()) {
			throw Object.assign(new Error("Skill directory was not found or is a symbolic link"), {
				protocolCode: "not_found",
			});
		}
	}
	return directory;
}

export function parseOpenAiSkillPolicy(yaml: string, frontmatterPolicy?: boolean): boolean | undefined {
	try {
		const { frontmatter } = parseFrontmatter(`---\n${yaml}\n---\n`);
		if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) throw new Error();
		const policy = (frontmatter as Record<string, unknown>).policy;
		if (policy === undefined) return frontmatterPolicy;
		if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error();
		const allow = (policy as Record<string, unknown>).allow_implicit_invocation;
		if (allow !== undefined && typeof allow !== "boolean") throw new Error();
		return frontmatterPolicy === false || allow === false
			? false
			: (frontmatterPolicy ?? (allow as boolean | undefined));
	} catch {
		throw Object.assign(new Error("Invalid skill invocation policy"), {
			protocolCode: "invalid_request",
		});
	}
}

async function invocationPolicy(path: string, frontmatterPolicy?: boolean): Promise<boolean | undefined> {
	const agents = join(dirname(path), "agents");
	if (!(await exists(agents))) return frontmatterPolicy;
	await safeDirectory(agents);
	const yamlPath = join(agents, "openai.yaml");
	if (!(await exists(yamlPath))) return frontmatterPolicy;
	const yaml = new TextDecoder("utf-8", { fatal: true }).decode(await boundedFile(yamlPath, 32 * 1024));
	return parseOpenAiSkillPolicy(yaml, frontmatterPolicy);
}

async function readSkill(path: string): Promise<{ raw: string; updatedAt: number; truncated: boolean }> {
	const file = await open(path, "r");
	try {
		const info = await file.stat();
		if (!info.isFile()) throw new Error("Skill must be a regular file");
		// One extra byte distinguishes an exact-size file from a truncated file.
		const buffer = Buffer.alloc(MAX_CONTENT_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		const truncated = length > MAX_CONTENT_BYTES;
		const decoder = new StringDecoder("utf8");
		const raw =
			decoder.write(buffer.subarray(0, Math.min(length, MAX_CONTENT_BYTES))) + (truncated ? "" : decoder.end());
		return { raw, updatedAt: Math.trunc(info.mtimeMs), truncated };
	} finally {
		await file.close();
	}
}

async function skillPath(workspaceRoot: string, skillId: string, components?: string[]): Promise<string> {
	if (!safeId(skillId)) throw Object.assign(new Error("Invalid skill id"), { protocolCode: "invalid_request" });
	const root = resolve(workspaceRoot);
	const directory = resolve(await skillBase(root, components), skillId);
	if (relative(root, directory).startsWith(".."))
		throw Object.assign(new Error("Skill path escapes workspace"), { protocolCode: "forbidden" });
	const candidate = join(directory, SKILL_FILE);
	const directoryInfo = await lstat(directory).catch(() => undefined);
	const fileInfo = await lstat(candidate).catch(() => undefined);
	if (
		!directoryInfo ||
		!directoryInfo.isDirectory() ||
		directoryInfo.isSymbolicLink() ||
		!fileInfo ||
		!fileInfo.isFile() ||
		fileInfo.isSymbolicLink()
	) {
		throw Object.assign(new Error(`Skill ${skillId} was not found`), { protocolCode: "not_found" });
	}
	return candidate;
}

export class FileSkillCatalog implements SkillCatalog {
	constructor(private readonly components = [".wuming", "skills"]) {
		if (components.some((part) => !/^[a-zA-Z0-9._-]+$/.test(part) || part === "." || part === ".."))
			throw new Error("Invalid skill directory components");
	}
	async list(workspaceId: string, workspaceRoot: string): Promise<SkillSummary[]> {
		const root = resolve(workspaceRoot);
		const directory = await skillBase(root, this.components).catch(() => undefined);
		if (!directory) return [];
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		const skills: SkillSummary[] = [];
		for (const entry of entries.slice(0, MAX_SKILLS)) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || !safeId(entry.name)) continue;
			try {
				const path = await skillPath(root, entry.name, this.components);
				const { raw, updatedAt } = await readSkill(path);
				const metadata = parseSkillMetadata(raw, entry.name);
				const allow = await invocationPolicy(path, metadata.allowImplicitInvocation);
				if (allow !== undefined) metadata.allowImplicitInvocation = allow;
				skills.push({
					id: entry.name,
					workspaceId,
					name: metadata.name,
					description: metadata.description,
					path: relative(root, path).replaceAll("\\", "/"),
					updatedAt,
					...(metadata.allowImplicitInvocation === undefined
						? {}
						: { allowImplicitInvocation: metadata.allowImplicitInvocation }),
				});
			} catch {
				// Ignore malformed or unreadable skills while keeping discovery available.
			}
		}
		return skills.sort((left, right) => left.name.localeCompare(right.name));
	}

	async get(workspaceId: string, workspaceRoot: string, skillId: string): Promise<Skill> {
		const path = await skillPath(workspaceRoot, skillId, this.components);
		const { raw, updatedAt, truncated } = await readSkill(path);
		const metadata = parseSkillMetadata(raw, skillId);
		const allow = await invocationPolicy(path, metadata.allowImplicitInvocation);
		if (allow !== undefined) metadata.allowImplicitInvocation = allow;
		return {
			id: skillId,
			workspaceId,
			name: metadata.name,
			description: metadata.description,
			path: relative(resolve(workspaceRoot), path).replaceAll("\\", "/"),
			updatedAt,
			content: metadata.content,
			truncated,
			...(metadata.allowImplicitInvocation === undefined
				? {}
				: { allowImplicitInvocation: metadata.allowImplicitInvocation }),
		};
	}
}

import { mkdir, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Skill, SkillSummary } from "@wuming/protocol";
import { FileSkillCatalog, parseOpenAiSkillPolicy, parseSkillMetadata } from "./skills.js";
import {
	boundedFile,
	exists,
	removeSkillStage,
	safeDirectory,
	skillError,
	snapshotSkillPackage,
	validateSkillId,
} from "./skill-storage.js";

export type SkillSource = "builtin" | "user";
export interface InstalledSkill {
	id: string;
	name: string;
	source: SkillSource;
	enabled: boolean;
	version: string;
	installedAt: number;
	allowImplicitInvocation?: boolean;
}
interface State {
	skills: Record<string, InstalledSkill>;
}
const BUILTIN_SKILL_VERSION = "1.0.0";

function parseState(buffer: Buffer): State {
	try {
		const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!parsed.skills ||
			Array.isArray(parsed.skills) ||
			typeof parsed.skills !== "object"
		)
			throw new Error();
		const entries = Object.entries(parsed.skills);
		if (entries.length > 1000) throw new Error();
		for (const [id, raw] of entries) {
			validateSkillId(id);
			if (!raw || typeof raw !== "object") throw new Error();
			const item = raw as InstalledSkill;
			if (
				item.id !== id ||
				typeof item.name !== "string" ||
				!item.name.length ||
				item.name.length > 200 ||
				!["builtin", "user"].includes(item.source) ||
				typeof item.enabled !== "boolean" ||
				typeof item.version !== "string" ||
				!item.version.length ||
				item.version.length > 100 ||
				!Number.isSafeInteger(item.installedAt) ||
				item.installedAt < 0
			)
				throw new Error();
		}
		return { skills: Object.fromEntries(entries) as Record<string, InstalledSkill> };
	} catch {
		throw skillError("Skill state is corrupt; repair skills.json before making changes", "conflict");
	}
}

export class SkillManager {
	readonly #root: string;
	readonly #builtins: string;
	readonly #userSkillsEnabled: boolean;
	readonly #userCatalog = new FileSkillCatalog();
	readonly #builtinCatalog = new FileSkillCatalog([]);
	constructor(root: string, builtins: string, options: { userSkillsEnabled?: boolean } = {}) {
		this.#root = resolve(root);
		this.#builtins = resolve(builtins);
		this.#userSkillsEnabled = options.userSkillsEnabled ?? true;
	}
	private control() {
		return join(this.#root, ".wuming");
	}
	private statePath() {
		return join(this.control(), "skills.json");
	}
	private async readState(): Promise<State> {
		if (!(await exists(this.control()))) return { skills: {} };
		await safeDirectory(this.control());
		if (!(await exists(this.statePath()))) return { skills: {} };
		return parseState(await boundedFile(this.statePath(), 512 * 1024));
	}
	private async save(state: State): Promise<void> {
		await safeDirectory(this.control());
		const data = JSON.stringify(state, null, 2);
		if (Buffer.byteLength(data) > 512 * 1024) throw skillError("Too many installed skills");
		const temp = join(this.control(), `.skill-state-${randomUUID()}.json`);
		await writeFile(temp, data, { encoding: "utf8", flag: "wx" });
		try {
			await rename(temp, this.statePath());
		} finally {
			await unlink(temp).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}
	private async mutate<T>(action: () => Promise<T>): Promise<T> {
		await safeDirectory(this.control(), true);
		const lock = join(this.control(), "skills.lock");
		try {
			await mkdir(lock);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw skillError("Skill management is busy; inspect skills.lock after a crashed operation", "conflict");
			throw error;
		}
		try {
			return await action();
		} finally {
			await rmdir(lock);
		}
	}
	private async discovered(): Promise<Array<{ summary: SkillSummary; source: SkillSource }>> {
		const entries = new Map<string, { summary: SkillSummary; source: SkillSource }>();
		if (await exists(this.#builtins)) {
			await safeDirectory(this.#builtins);
			for (const summary of await this.#builtinCatalog.list("catalog", this.#builtins))
				entries.set(summary.id, { summary, source: "builtin" });
		}
		const userRoot = join(this.control(), "skills");
		if (this.#userSkillsEnabled && (await exists(userRoot))) {
			await safeDirectory(userRoot);
			for (const summary of await this.#userCatalog.list("catalog", this.#root))
				entries.set(summary.id, { summary, source: "user" });
		}
		return [...entries.values()];
	}
	async list(): Promise<InstalledSkill[]> {
		const state = await this.readState();
		return (await this.discovered())
			.map(({ summary, source }) => {
				const stored = Object.hasOwn(state.skills, summary.id) ? state.skills[summary.id] : undefined;
				return {
					id: summary.id,
					name: summary.name,
					source,
					enabled: stored?.source === source ? stored.enabled : true,
					version:
						source === "builtin" ? BUILTIN_SKILL_VERSION : stored?.source === source ? stored.version : "unversioned",
					installedAt: stored?.source === source ? stored.installedAt : source === "builtin" ? 0 : summary.updatedAt,
					...(summary.allowImplicitInvocation === undefined
						? {}
						: { allowImplicitInvocation: summary.allowImplicitInvocation }),
				};
			})
			.sort((a, b) => a.id.localeCompare(b.id));
	}
	async listEnabled(workspaceId: string): Promise<SkillSummary[]> {
		const enabled = new Set((await this.list()).filter((item) => item.enabled).map((item) => item.id));
		return (await this.discovered())
			.filter(({ summary }) => enabled.has(summary.id))
			.map(({ summary, source }) => ({ ...summary, workspaceId, source }));
	}
	async get(workspaceId: string, id: string, preview = false): Promise<Skill> {
		validateSkillId(id);
		const item = (await this.list()).find((skill) => skill.id === id);
		if (!item) throw skillError(`Skill ${id} was not found`, "not_found");
		if (!item.enabled && !preview) throw skillError(`Skill ${id} is disabled`, "forbidden");
		return item.source === "builtin"
			? this.#builtinCatalog.get(workspaceId, this.#builtins, id)
			: this.#userCatalog.get(workspaceId, this.#root, id);
	}
	async readResource(workspaceId: string, id: string, resourcePath: string): Promise<string> {
		await this.get(workspaceId, id);
		const item = (await this.list()).find((skill) => skill.id === id);
		if (!item) throw skillError("Skill is no longer available", "not_found");
		const root = item.source === "builtin" ? join(this.#builtins, id) : join(this.control(), "skills", id);
		const path = resolve(root, resourcePath);
		const suffix = relative(root, path);
		if (
			!resourcePath ||
			isAbsolute(resourcePath) ||
			/^[a-z]:/i.test(resourcePath) ||
			isAbsolute(suffix) ||
			suffix === ".." ||
			suffix.startsWith(`..${sep}`) ||
			!/^(references|scripts|assets)[\\/]/.test(suffix)
		) {
			throw skillError("Only relative references, scripts or assets inside the skill can be read", "forbidden");
		}
		await safeDirectory(dirname(path));
		const data = await boundedFile(path, 64 * 1024);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(data);
		} catch {
			throw skillError("Skill resource is not UTF-8 text; binary assets require an appropriate artifact tool");
		}
	}
	async install(sourceDir: string, options: { id?: string; version?: string } = {}): Promise<InstalledSkill> {
		if (!this.#userSkillsEnabled) throw skillError("User skill installation requires a local device host", "forbidden");
		const id = options.id ?? basename(resolve(sourceDir));
		validateSkillId(id);
		const version = options.version ?? "1.0.0";
		if (!version.trim() || version.length > 100) throw skillError("Invalid skill version");
		const files = await snapshotSkillPackage(sourceDir);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(files.get("SKILL.md")!);
		} catch {
			throw skillError("SKILL.md must be valid UTF-8");
		}
		if (!/^---\s*\r?\n/.test(text)) throw skillError("SKILL.md must contain YAML metadata");
		const metadata = parseSkillMetadata(text, id, true);
		const policyFile = files.get(join("agents", "openai.yaml"));
		if (policyFile) {
			if (policyFile.length > 32 * 1024) throw skillError("Skill invocation policy exceeds size limit");
			parseOpenAiSkillPolicy(
				new TextDecoder("utf-8", { fatal: true }).decode(policyFile),
				metadata.allowImplicitInvocation
			);
		}
		if (!metadata.description.trim() || !metadata.content.trim())
			throw skillError("Skill description and instructions are required");
		return this.mutate(async () => {
			const state = await this.readState();
			const target = join(this.control(), "skills", id);
			await safeDirectory(dirname(target), true);
			if ((await exists(target)) || (await this.list()).some((item) => item.id.toLowerCase() === id.toLowerCase()))
				throw skillError("Skill already exists; installation never overwrites an existing skill", "conflict");
			if ((await readdir(dirname(target))).length >= 100)
				throw skillError("Workspace skill directory limit of 100 entries reached");
			const item: InstalledSkill = {
				id,
				name: metadata.name,
				source: "user",
				enabled: true,
				version,
				installedAt: Date.now(),
			};
			const stage = join(this.control(), `.skill-stage-${randomUUID()}`);
			await mkdir(stage);
			try {
				for (const [name, data] of files) {
					await safeDirectory(dirname(join(stage, name)), true);
					await writeFile(join(stage, name), data, { flag: "wx" });
				}
				// Publish metadata first: a crash leaves no visible partial skill directory.
				await this.save({ skills: { ...state.skills, [id]: item } });
				try {
					await rename(stage, target);
				} catch (error) {
					await this.save(state);
					throw error;
				}
				return item;
			} finally {
				await removeSkillStage(this.control(), stage);
			}
		});
	}
	async installFromWorkspace(
		sourcePath: string,
		options: { id?: string; version?: string } = {}
	): Promise<InstalledSkill> {
		const source = resolve(this.#root, sourcePath);
		const suffix = relative(this.#root, source);
		if (
			!sourcePath.trim() ||
			isAbsolute(sourcePath) ||
			/^[a-z]:/i.test(sourcePath) ||
			!suffix ||
			isAbsolute(suffix) ||
			suffix === ".." ||
			suffix.startsWith(`..${sep}`)
		) {
			throw skillError("Installation source must be a relative directory inside the authorized workspace", "forbidden");
		}
		return this.install(source, options);
	}
	async setEnabled(id: string, enabled: boolean): Promise<InstalledSkill> {
		if (!this.#userSkillsEnabled) throw skillError("User skill management requires a local device host", "forbidden");
		validateSkillId(id);
		return this.mutate(async () => {
			const state = await this.readState();
			const item = (await this.list()).find((entry) => entry.id === id);
			if (!item) throw skillError(`Skill ${id} is not installed`, "not_found");
			const updated = { ...item, enabled };
			await this.save({ skills: { ...state.skills, [id]: updated } });
			return updated;
		});
	}
	async uninstall(id: string): Promise<void> {
		if (!this.#userSkillsEnabled) throw skillError("User skill management requires a local device host", "forbidden");
		validateSkillId(id);
		await this.mutate(async () => {
			const state = await this.readState();
			const item = (await this.list()).find((entry) => entry.id === id);
			if (!item || item.source !== "user") throw skillError("Only installed user skills can be removed", "forbidden");
			const target = join(this.control(), "skills", id);
			await safeDirectory(target);
			const stage = join(this.control(), `.skill-stage-${randomUUID()}`);
			await rename(target, stage);
			delete state.skills[id];
			try {
				await this.save(state);
			} catch (error) {
				await rename(stage, target);
				throw error;
			}
			await removeSkillStage(this.control(), stage);
		});
	}
}

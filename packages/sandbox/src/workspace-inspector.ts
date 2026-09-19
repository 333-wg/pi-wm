import { open, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import type {
	GitDiff,
	GitStatus,
	GitStatusEntry,
	WorkspaceDirectory,
	WorkspaceEntry,
	WorkspaceFileView,
	WorkspaceSearch,
} from "@wuming/protocol";
import { SandboxError } from "./errors.js";
import { WorkspacePathPolicy } from "./path-policy.js";
import { gitRepositoryFound } from "./git-diagnostics.js";

export interface WorkspaceInspectorOptions {
	maxEntries?: number;
	maxFileBytes?: number;
	maxGitBytes?: number;
	gitTimeoutMs?: number;
	ignoredNames?: Iterable<string>;
	/** Upper bound on files visited by a single searchFiles walk. */
	maxSearchVisits?: number;
}

interface GitResult {
	exitCode: number | null;
	stdout: Buffer;
	stderr: Buffer;
	truncated: boolean;
}

function slash(path: string): string {
	return path.split(sep).join("/");
}

function appendPrefix(
	chunks: Buffer[],
	size: number,
	chunk: Buffer,
	maxBytes: number
): { size: number; truncated: boolean } {
	const remaining = Math.max(0, maxBytes - size);
	if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
	return { size: size + Math.min(chunk.length, remaining), truncated: chunk.length > remaining };
}

function decodeUtf8(content: Buffer): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		return undefined;
	}
}

function isBoundary(character: string | undefined): boolean {
	return character === undefined || character === "/" || character === "." || character === "-" || character === "_";
}

/**
 * Case-insensitive subsequence score, higher is better, `undefined` when the
 * needle is not a subsequence of the haystack. Consecutive runs and matches
 * that land on a word boundary are rewarded while skipped characters cost, so
 * `wi` ranks `workspace-inspector.ts` above an incidental hit.
 */
function subsequenceScore(haystack: string, needle: string): number | undefined {
	if (needle === "") return 0;
	const hay = haystack.toLowerCase();
	let score = 0;
	let cursor = 0;
	let previous = -2;
	for (const character of needle.toLowerCase()) {
		const found = hay.indexOf(character, cursor);
		if (found === -1) return undefined;
		score += 12;
		if (found === previous + 1) score += 10;
		if (isBoundary(hay[found - 1])) score += 8;
		score -= Math.min(found - cursor, 10);
		previous = found;
		cursor = found + 1;
	}
	return score;
}

/** Paths score against their trailing name as well, which most queries target. */
function pathScore(path: string, needle: string): number | undefined {
	const depthPenalty = Math.min(path.length, 60) / 4;
	if (needle === "") return -depthPenalty;
	const whole = subsequenceScore(path, needle);
	const trailing = subsequenceScore(path.slice(path.lastIndexOf("/") + 1), needle);
	if (whole === undefined && trailing === undefined) return undefined;
	return Math.max(whole ?? 0, trailing === undefined ? 0 : trailing + 24) - depthPenalty;
}

export class WorkspaceInspector {
	readonly root: string;
	readonly #policy: WorkspacePathPolicy;
	readonly #maxEntries: number;
	readonly #maxFileBytes: number;
	readonly #maxGitBytes: number;
	readonly #gitTimeoutMs: number;
	readonly #ignoredNames: Set<string>;
	readonly #maxSearchVisits: number;

	private constructor(policy: WorkspacePathPolicy, options: WorkspaceInspectorOptions) {
		this.#policy = policy;
		this.root = policy.root;
		this.#maxEntries = options.maxEntries ?? 2000;
		this.#maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
		this.#maxGitBytes = options.maxGitBytes ?? 2 * 1024 * 1024;
		this.#gitTimeoutMs = options.gitTimeoutMs ?? 10_000;
		this.#ignoredNames = new Set(options.ignoredNames ?? [".git", ".wuming-data", "node_modules"]);
		this.#maxSearchVisits = options.maxSearchVisits ?? 20_000;
	}

	static async create(root: string, options: WorkspaceInspectorOptions = {}): Promise<WorkspaceInspector> {
		return new WorkspaceInspector(await WorkspacePathPolicy.create(root), options);
	}

	async listDirectory(input = "."): Promise<WorkspaceDirectory> {
		const path = this.#relativePath(input, true);
		const resolved = await this.#policy.existing(path);
		const directoryStats = await stat(resolved);
		if (!directoryStats.isDirectory()) throw new SandboxError("path_invalid", `${path} is not a directory`);
		const children = (await readdir(resolved, { withFileTypes: true }))
			.filter((entry) => !this.#ignoredNames.has(entry.name) && !entry.isSymbolicLink())
			.sort((left, right) => {
				const kind = Number(right.isDirectory()) - Number(left.isDirectory());
				return kind || left.name.localeCompare(right.name);
			});
		const selected = children.slice(0, this.#maxEntries);
		const entries: WorkspaceDirectory["entries"] = [];
		for (const child of selected) {
			if (!child.isDirectory() && !child.isFile()) continue;
			const childPath = path === "." ? child.name : `${path}/${child.name}`;
			let childResolved: string;
			try {
				childResolved = await this.#policy.existing(childPath);
			} catch {
				continue;
			}
			const childStats = await stat(childResolved);
			entries.push({
				path: childPath,
				name: child.name,
				kind: child.isDirectory() ? "directory" : "file",
				...(child.isFile() ? { size: childStats.size } : {}),
				modifiedAt: Math.floor(childStats.mtimeMs),
			});
		}
		return { path, entries, truncated: children.length > selected.length };
	}

	/**
	 * Breadth-first fuzzy path search used by the composer's `@` mentions. An
	 * empty query returns the shallowest entries, which makes the menu useful
	 * before the first keystroke. Only the entries that survive ranking are
	 * stat-ed, so a large tree costs one readdir per directory.
	 */
	async searchFiles(rawQuery = "", limit = 40): Promise<WorkspaceSearch> {
		const query = rawQuery.trim().replaceAll("\\", "/");
		if (query.includes("\0")) throw new SandboxError("path_invalid", "Search query is invalid");
		const bounded = Math.min(Math.max(Math.trunc(limit) || 0, 1), 200);
		const candidates: { path: string; score: number; order: number; directory: boolean }[] = [];
		const queue: string[] = ["."];
		let visits = 0;
		let truncated = false;
		while (queue.length > 0 && !truncated) {
			const current = queue.shift();
			if (current === undefined) break;
			let children;
			try {
				children = await readdir(await this.#policy.existing(current), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const child of children) {
				if (this.#ignoredNames.has(child.name) || child.isSymbolicLink()) continue;
				const directory = child.isDirectory();
				if (!directory && !child.isFile()) continue;
				const childPath = current === "." ? child.name : `${current}/${child.name}`;
				if (directory) queue.push(childPath);
				visits += 1;
				if (visits > this.#maxSearchVisits) {
					truncated = true;
					break;
				}
				const score = pathScore(childPath, query);
				if (score === undefined) continue;
				candidates.push({ path: childPath, score, order: visits, directory });
			}
		}
		candidates.sort((left, right) => right.score - left.score || left.order - right.order);
		const entries: WorkspaceEntry[] = [];
		for (const candidate of candidates) {
			if (entries.length >= bounded) {
				truncated = true;
				break;
			}
			let stats;
			try {
				stats = await stat(await this.#policy.existing(candidate.path));
			} catch {
				continue;
			}
			entries.push({
				path: candidate.path,
				name: candidate.path.slice(candidate.path.lastIndexOf("/") + 1),
				kind: candidate.directory ? "directory" : "file",
				...(candidate.directory ? {} : { size: stats.size }),
				modifiedAt: Math.floor(stats.mtimeMs),
			});
		}
		return { query, entries, truncated };
	}

	async readFile(input: string): Promise<WorkspaceFileView> {
		const path = this.#relativePath(input, false);
		const resolved = await this.#policy.existing(path);
		const fileStats = await stat(resolved);
		if (!fileStats.isFile()) throw new SandboxError("path_invalid", `${path} is not a file`);
		const bytesToRead = Math.min(fileStats.size, this.#maxFileBytes);
		const content = Buffer.alloc(bytesToRead);
		const handle = await open(resolved, "r");
		let bytesRead = 0;
		try {
			bytesRead = (await handle.read(content, 0, bytesToRead, 0)).bytesRead;
		} finally {
			await handle.close();
		}
		const selected = content.subarray(0, bytesRead);
		const decoded = selected.includes(0) ? undefined : decodeUtf8(selected);
		return {
			path,
			content: decoded ?? "",
			bytesRead,
			totalBytes: fileStats.size,
			truncated: fileStats.size > bytesRead,
			binary: decoded === undefined,
		};
	}

	async gitStatus(): Promise<GitStatus> {
		const repository = await this.#runGit(["rev-parse", "--is-inside-work-tree"], 4096);
		if (
			!gitRepositoryFound(repository.exitCode, repository.stderr.toString("utf8")) ||
			repository.stdout.toString("utf8").trim() !== "true"
		) {
			return { isRepository: false, entries: [], truncated: false };
		}
		const branchResult = await this.#runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], 4096);
		const fallbackBranch =
			branchResult.exitCode === 0 ? undefined : await this.#runGit(["rev-parse", "--short", "HEAD"], 4096);
		const branch = (branchResult.exitCode === 0 ? branchResult.stdout : fallbackBranch?.stdout)
			?.toString("utf8")
			.trim();
		const status = await this.#runGit(
			["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
			this.#maxGitBytes
		);
		if (status.exitCode !== 0 && !status.truncated)
			throw new SandboxError("process_failed", status.stderr.toString("utf8") || "git status failed");
		const records = status.stdout.toString("utf8").split("\0");
		const entries: GitStatusEntry[] = [];
		for (let index = 0; index < records.length; index += 1) {
			const record = records[index];
			if (!record || record.length < 4) continue;
			const indexStatus = record[0] ?? " ";
			const worktreeStatus = record[1] ?? " ";
			const path = record.slice(3);
			const renamed = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
			const originalPath = renamed ? records[++index] : undefined;
			entries.push({
				path,
				indexStatus,
				worktreeStatus,
				...(originalPath ? { originalPath } : {}),
			});
		}
		return {
			isRepository: true,
			...(branch ? { branch } : {}),
			entries,
			truncated: status.truncated,
		};
	}

	async gitDiff(input?: string, staged = false): Promise<GitDiff> {
		const path = input ? this.#relativePath(input, false) : undefined;
		const args = [
			"-c",
			"core.quotepath=false",
			"-c",
			"core.fsmonitor=false",
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			"--unified=3",
			...(staged ? ["--cached"] : []),
			"--",
			path ?? ".",
		];
		const diff = await this.#runGit(args, this.#maxGitBytes);
		if (diff.exitCode !== 0 && !diff.truncated)
			throw new SandboxError("process_failed", diff.stderr.toString("utf8") || "git diff failed");
		let content = diff.stdout.toString("utf8");
		let truncated = diff.truncated;
		if (!staged && path && !content) {
			const tracked = await this.#runGit(["ls-files", "--error-unmatch", "--", path], 4096);
			if (tracked.exitCode !== 0) {
				const file = await this.readFile(path);
				if (!file.binary) {
					const lines = file.content.split("\n");
					content = [
						`diff --git a/${path} b/${path}`,
						"new file mode 100644",
						"--- /dev/null",
						`+++ b/${path}`,
						`@@ -0,0 +1,${lines.length} @@`,
						...lines.map((line) => `+${line}`),
					].join("\n");
					const bounded = Buffer.from(content, "utf8");
					if (bounded.length > this.#maxGitBytes) {
						content = bounded.subarray(0, this.#maxGitBytes).toString("utf8");
						truncated = true;
					}
				}
			}
		}
		return { ...(path ? { path } : {}), staged, content, truncated };
	}

	#relativePath(input: string, allowRoot: boolean): string {
		const value = input.trim().replaceAll("\\", "/");
		if ((allowRoot && (value === "" || value === ".")) || value === ".") return ".";
		if (!value || value.includes("\0") || /^[a-zA-Z]:/.test(value) || value.startsWith("/") || value.startsWith("//")) {
			throw new SandboxError("path_invalid", "Workspace paths must be relative");
		}
		const absolute = resolve(this.root, value);
		const normalized = relative(this.root, absolute);
		if (!normalized || normalized === ".." || normalized.startsWith(`..${sep}`)) {
			throw new SandboxError("path_escape", `Path escapes workspace: ${input}`);
		}
		return slash(normalized);
	}

	#runGit(args: string[], maxBytes: number): Promise<GitResult> {
		return new Promise((resolveResult, reject) => {
			const child = spawn("git", args, {
				cwd: this.root,
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stdoutSize = 0;
			let stderrSize = 0;
			let truncated = false;
			let settled = false;
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, this.#gitTimeoutMs);
			child.stdout.on("data", (raw: Buffer) => {
				const appended = appendPrefix(stdout, stdoutSize, raw, maxBytes);
				stdoutSize = appended.size;
				truncated ||= appended.truncated;
				if (truncated) child.kill();
			});
			child.stderr.on("data", (raw: Buffer) => {
				const appended = appendPrefix(stderr, stderrSize, raw, 64 * 1024);
				stderrSize = appended.size;
			});
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(new SandboxError("process_unavailable", `Git is unavailable: ${error.message}`));
			});
			child.once("close", (exitCode) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (timedOut) return reject(new SandboxError("process_timeout", "Git 状态读取超时，请刷新后重试。"));
				resolveResult({
					exitCode,
					stdout: Buffer.concat(stdout, stdoutSize),
					stderr: Buffer.concat(stderr, stderrSize),
					truncated,
				});
			});
		});
	}
}

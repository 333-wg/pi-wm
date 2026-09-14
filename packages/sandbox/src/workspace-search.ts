import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { SandboxError } from "./errors.js";
import { WorkspacePathPolicy } from "./path-policy.js";

/**
 * Workspace-scoped directory listing, path globbing and content search.
 *
 * This is the half of a coding agent's toolkit that `read_file` cannot cover: a
 * model that can only read a path it already knows has to guess its way around a
 * repository. Everything here is deliberately read-only, bounded, and resolved
 * through {@link WorkspacePathPolicy} so a pattern cannot walk out of the
 * workspace.
 *
 * Ignore handling matches `.gitignore` semantics closely enough for the cases
 * real repositories use — nested ignore files, negation, directory-only rules,
 * anchoring, and `**` — plus a built-in name list so `.git` and `node_modules`
 * are skipped even in a workspace that is not a repository. It deliberately does
 * *not* consult git itself, so behaviour is identical inside and outside a
 * repository; the cost is that a global core.excludesFile and
 * `.git/info/exclude` are not honoured.
 */
export interface WorkspaceSearchLimits {
	/** Upper bound on entries enumerated by one walk. */
	maxFiles?: number;
	/** Files larger than this are listed but never read for content search. */
	maxFileBytes?: number;
	/** Total bytes one grep may read before it reports itself truncated. */
	maxTotalReadBytes?: number;
	/** Names skipped everywhere, regardless of ignore files. */
	ignoredNames?: Iterable<string>;
	/** Set false to walk the whole tree, honouring only {@link ignoredNames}. */
	followGitignore?: boolean;
}

export interface WorkspaceSearchEntry {
	path: string;
	kind: "file" | "directory";
	size?: number;
	modifiedAt: number;
}

export interface WorkspaceListing {
	path: string;
	entries: WorkspaceSearchEntry[];
	truncated: boolean;
}

export interface WorkspaceGlobResult {
	pattern: string;
	paths: string[];
	/** True when the walk hit its file budget or the result hit `limit`. */
	truncated: boolean;
	filesVisited: number;
}

export interface WorkspaceGrepMatch {
	path: string;
	line: number;
	text: string;
	/** Lines before/after when the caller asked for context. */
	before?: string[];
	after?: string[];
}

export interface WorkspaceGrepResult {
	pattern: string;
	matches: WorkspaceGrepMatch[];
	counts: Array<{ path: string; count: number }>;
	filesSearched: number;
	filesMatched: number;
	totalMatches: number;
	truncated: boolean;
	skippedLarge: number;
	skippedBinary: number;
}

export interface WorkspaceGrepOptions {
	path?: string;
	glob?: string;
	caseInsensitive?: boolean;
	literal?: boolean;
	context?: number;
	maxMatches?: number;
	signal?: AbortSignal;
}

interface IgnoreRule {
	negated: boolean;
	directoryOnly: boolean;
	matcher: RegExp;
}

interface IgnoreLayer {
	/** Workspace-relative directory the rules are anchored to; "" for the root. */
	base: string;
	rules: IgnoreRule[];
}

function slash(path: string): string {
	return path.split(sep).join("/");
}

/**
 * Translates one glob into regular-expression source.
 *
 * `*` and `?` stop at a separator, `**` crosses them, and `{a,b}` alternates.
 * `**` is handled together with its neighbouring slash so `**\/x` also matches a
 * bare `x` at the root — the behaviour every ignore file relies on.
 */
function globSource(glob: string): string {
	let source = "";
	let brace = 0;
	for (let index = 0; index < glob.length; index += 1) {
		const character = glob[index]!;
		if (character === "*") {
			const doubled = glob[index + 1] === "*";
			if (doubled) {
				index += 1;
				if (glob[index + 1] === "/") {
					index += 1;
					source += "(?:[^/]+/)*";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (character === "?") {
			source += "[^/]";
			continue;
		}
		if (character === "[") {
			const close = glob.indexOf("]", index + 1);
			if (close === -1) {
				source += "\\[";
				continue;
			}
			const body = glob.slice(index + 1, close);
			// A leading ! or ^ negates in both glob and regex, but only ^ in regex.
			const negated = body.startsWith("!") || body.startsWith("^");
			source += `[${negated ? "^" : ""}${body.slice(negated ? 1 : 0).replace(/\\/g, "\\\\")}]`;
			index = close;
			continue;
		}
		if (character === "{") {
			brace += 1;
			source += "(?:";
			continue;
		}
		if (character === "}" && brace > 0) {
			brace -= 1;
			source += ")";
			continue;
		}
		if (character === "," && brace > 0) {
			source += "|";
			continue;
		}
		source += character.replace(/[.+^$()|\\/]/g, "\\$&");
	}
	return source + ")".repeat(brace);
}

/** A caller-supplied glob, matched against whole workspace-relative paths. */
function compileGlob(glob: string): RegExp {
	const trimmed = glob.trim().replaceAll("\\", "/").replace(/^\.\//, "");
	if (trimmed === "" || trimmed === "**" || trimmed === "**/*") return /^/;
	// A bare `*.ts` is meant as "anywhere", which is what every caller expects
	// from a filter; an explicit `./` or leading `/` is what anchors it.
	const anchored = trimmed.includes("/");
	return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${globSource(trimmed)}$`);
}

function parseIgnoreFile(content: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const raw of content.split(/\r?\n/)) {
		// Trailing spaces are insignificant unless escaped; a bare `\` is not a rule.
		const line = raw.replace(/(?<!\\)\s+$/, "");
		if (line === "" || line.startsWith("#")) continue;
		const negated = line.startsWith("!");
		let body = negated ? line.slice(1) : line;
		if (body.startsWith("\\")) body = body.slice(1);
		const directoryOnly = body.endsWith("/");
		if (directoryOnly) body = body.slice(0, -1);
		const rooted = body.startsWith("/");
		if (rooted) body = body.slice(1);
		if (body === "") continue;
		// Git anchors a pattern to the ignore file's directory as soon as it
		// contains a slash anywhere but the end; otherwise it matches a basename
		// at any depth.
		const anchored = rooted || body.includes("/");
		let source = globSource(body);
		// `foo/**` covers everything below `foo`, which needs the `/` to be optional
		// only in the trailing-`**` form the converter already turned into `.*`.
		if (!body.endsWith("**")) source += "(?:/.*)?";
		rules.push({
			negated,
			directoryOnly,
			matcher: new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}$`),
		});
	}
	return rules;
}

/** Last matching rule wins, and deeper ignore files override shallower ones. */
function isIgnored(layers: IgnoreLayer[], path: string, directory: boolean): boolean {
	let ignored = false;
	for (const layer of layers) {
		if (layer.base !== "" && !path.startsWith(`${layer.base}/`)) continue;
		const scoped = layer.base === "" ? path : path.slice(layer.base.length + 1);
		for (const rule of layer.rules) {
			if (rule.directoryOnly && !directory) continue;
			if (rule.matcher.test(scoped)) ignored = !rule.negated;
		}
	}
	return ignored;
}

function looksBinary(content: Buffer): boolean {
	return content.subarray(0, 8000).includes(0);
}

export class WorkspaceSearcher {
	readonly root: string;
	readonly #policy: WorkspacePathPolicy;
	readonly #maxFiles: number;
	readonly #maxFileBytes: number;
	readonly #maxTotalReadBytes: number;
	readonly #ignoredNames: Set<string>;
	readonly #followGitignore: boolean;

	private constructor(policy: WorkspacePathPolicy, limits: WorkspaceSearchLimits) {
		this.#policy = policy;
		this.root = policy.root;
		this.#maxFiles = limits.maxFiles ?? 20_000;
		this.#maxFileBytes = limits.maxFileBytes ?? 2 * 1024 * 1024;
		this.#maxTotalReadBytes = limits.maxTotalReadBytes ?? 64 * 1024 * 1024;
		this.#ignoredNames = new Set(limits.ignoredNames ?? [".git", ".wuming-data", "node_modules"]);
		this.#followGitignore = limits.followGitignore ?? true;
	}

	static async create(root: string, limits: WorkspaceSearchLimits = {}): Promise<WorkspaceSearcher> {
		return new WorkspaceSearcher(await WorkspacePathPolicy.create(root), limits);
	}

	async list(input = ".", depth = 1): Promise<WorkspaceListing> {
		const start = this.#relative(input);
		const bounded = Math.min(Math.max(Math.trunc(depth) || 1, 1), 5);
		const walk = await this.#walk(start, { maxDepth: bounded, includeDirectories: true });
		return {
			path: start === "" ? "." : start,
			entries: walk.entries.sort((left, right) => {
				const kind = Number(right.kind === "directory") - Number(left.kind === "directory");
				return kind || left.path.localeCompare(right.path);
			}),
			truncated: walk.truncated,
		};
	}

	/**
	 * Paths matching `pattern`, newest first — the ordering that puts the file
	 * someone is currently working on at the top of a long list.
	 */
	async glob(pattern: string, options: { path?: string; limit?: number } = {}): Promise<WorkspaceGlobResult> {
		const start = this.#relative(options.path ?? ".");
		const matcher = compileGlob(pattern);
		const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200) || 1, 1), 1000);
		const walk = await this.#walk(start, { includeDirectories: false });
		const matched = walk.entries
			.filter((entry) => matcher.test(entry.path))
			.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
		return {
			pattern,
			paths: matched.slice(0, limit).map((entry) => entry.path),
			truncated: walk.truncated || matched.length > limit,
			filesVisited: walk.visited,
		};
	}

	async grep(pattern: string, options: WorkspaceGrepOptions = {}): Promise<WorkspaceGrepResult> {
		const start = this.#relative(options.path ?? ".");
		const context = Math.min(Math.max(Math.trunc(options.context ?? 0) || 0, 0), 5);
		const maxMatches = Math.min(Math.max(Math.trunc(options.maxMatches ?? 100) || 1, 1), 500);
		const source = options.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
		let expression: RegExp;
		try {
			expression = new RegExp(source, options.caseInsensitive ? "i" : "");
		} catch (error) {
			throw new SandboxError(
				"path_invalid",
				`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		const fileFilter = options.glob === undefined ? undefined : compileGlob(options.glob);
		const walk = await this.#walk(start, {
			includeDirectories: false,
			...(options.signal ? { signal: options.signal } : {}),
		});
		const candidates = fileFilter ? walk.entries.filter((entry) => fileFilter.test(entry.path)) : walk.entries;

		const matches: WorkspaceGrepMatch[] = [];
		const counts: Array<{ path: string; count: number }> = [];
		let filesSearched = 0;
		let totalMatches = 0;
		let readBytes = 0;
		let skippedLarge = 0;
		let skippedBinary = 0;
		let truncated = walk.truncated;
		for (const entry of candidates) {
			options.signal?.throwIfAborted();
			if ((entry.size ?? 0) > this.#maxFileBytes) {
				skippedLarge += 1;
				continue;
			}
			if (readBytes >= this.#maxTotalReadBytes) {
				truncated = true;
				break;
			}
			let content: Buffer;
			try {
				content = await readFile(await this.#policy.existing(entry.path));
			} catch {
				continue;
			}
			readBytes += content.length;
			if (looksBinary(content)) {
				skippedBinary += 1;
				continue;
			}
			filesSearched += 1;
			const lines = content.toString("utf8").split(/\r?\n/);
			let fileMatches = 0;
			for (let index = 0; index < lines.length; index += 1) {
				if (!expression.test(lines[index]!)) continue;
				fileMatches += 1;
				totalMatches += 1;
				if (matches.length < maxMatches) {
					matches.push({
						path: entry.path,
						line: index + 1,
						text: lines[index]!.slice(0, 2000),
						...(context > 0
							? {
									before: lines.slice(Math.max(0, index - context), index).map((line) => line.slice(0, 2000)),
									after: lines.slice(index + 1, index + 1 + context).map((line) => line.slice(0, 2000)),
								}
							: {}),
					});
				} else {
					truncated = true;
				}
			}
			if (fileMatches > 0) counts.push({ path: entry.path, count: fileMatches });
		}
		return {
			pattern,
			matches,
			counts: counts.sort((left, right) => right.count - left.count || left.path.localeCompare(right.path)),
			filesSearched,
			filesMatched: counts.length,
			totalMatches,
			truncated,
			skippedLarge,
			skippedBinary,
		};
	}

	/** "" for the workspace root, otherwise a slash-separated relative path. */
	#relative(input: string): string {
		const value = input.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
		if (value === "" || value === ".") return "";
		if (value.includes("\0") || /^[a-zA-Z]:/.test(value) || value.startsWith("/")) {
			throw new SandboxError("path_invalid", "Workspace paths must be relative");
		}
		const normalized = relative(this.root, resolve(this.root, value));
		if (!normalized || normalized === ".." || normalized.startsWith(`..${sep}`)) {
			throw new SandboxError("path_escape", `Path escapes workspace: ${input}`);
		}
		return slash(normalized);
	}

	async #loadLayer(base: string): Promise<IgnoreLayer | undefined> {
		if (!this.#followGitignore) return undefined;
		const path = base === "" ? ".gitignore" : `${base}/.gitignore`;
		let content: string;
		try {
			content = await readFile(resolve(this.root, path), "utf8");
		} catch {
			return undefined;
		}
		const rules = parseIgnoreFile(content);
		return rules.length === 0 ? undefined : { base, rules };
	}

	/** Ignore files from the root down to `directory`, which all still apply. */
	async #layersFor(directory: string): Promise<IgnoreLayer[]> {
		const layers: IgnoreLayer[] = [];
		const parts = directory === "" ? [] : directory.split("/");
		let base = "";
		for (let index = 0; ; index += 1) {
			const layer = await this.#loadLayer(base);
			if (layer) layers.push(layer);
			if (index >= parts.length) return layers;
			base = base === "" ? parts[index]! : `${base}/${parts[index]!}`;
		}
	}

	/**
	 * Breadth-first walk from `start`, pruning ignored directories rather than
	 * filtering their contents afterwards. `start` itself is never pruned: a
	 * caller that names a path explicitly means it, even when an ignore rule
	 * covers it.
	 */
	async #walk(
		start: string,
		options: { includeDirectories: boolean; maxDepth?: number; signal?: AbortSignal }
	): Promise<{ entries: WorkspaceSearchEntry[]; truncated: boolean; visited: number }> {
		const resolved = await this.#policy.existing(start === "" ? "." : start);
		const startStats = await stat(resolved);
		if (startStats.isFile()) {
			return {
				entries: [
					{
						path: start,
						kind: "file",
						size: startStats.size,
						modifiedAt: Math.floor(startStats.mtimeMs),
					},
				],
				truncated: false,
				visited: 1,
			};
		}
		if (!startStats.isDirectory()) throw new SandboxError("path_invalid", `${start || "."} is not a directory`);

		const entries: WorkspaceSearchEntry[] = [];
		const queue: Array<{ path: string; depth: number; layers: IgnoreLayer[] }> = [
			{ path: start, depth: 0, layers: await this.#layersFor(start) },
		];
		let visited = 0;
		let truncated = false;
		while (queue.length > 0 && !truncated) {
			const current = queue.shift()!;
			options.signal?.throwIfAborted();
			let children;
			try {
				children = await readdir(resolve(this.root, current.path || "."), { withFileTypes: true });
			} catch {
				continue;
			}
			// `start` and its ancestors were already loaded by #layersFor, so only a
			// directory the walk descended into can contribute a new layer.
			const layers =
				current.path !== start && children.some((child) => child.name === ".gitignore" && child.isFile())
					? [...current.layers, await this.#loadLayer(current.path)].filter(
							(layer): layer is IgnoreLayer => layer !== undefined
						)
					: current.layers;
			for (const child of children) {
				if (child.isSymbolicLink() || this.#ignoredNames.has(child.name)) continue;
				const directory = child.isDirectory();
				if (!directory && !child.isFile()) continue;
				const path = current.path === "" ? child.name : `${current.path}/${child.name}`;
				if (isIgnored(layers, path, directory)) continue;
				visited += 1;
				if (visited > this.#maxFiles) {
					truncated = true;
					break;
				}
				let stats;
				try {
					stats = await stat(resolve(this.root, path));
				} catch {
					continue;
				}
				const depth = current.depth + 1;
				if (directory && (options.maxDepth === undefined || depth < options.maxDepth)) {
					queue.push({ path, depth, layers });
				}
				if (directory && !options.includeDirectories) continue;
				entries.push({
					path,
					kind: directory ? "directory" : "file",
					...(directory ? {} : { size: stats.size }),
					modifiedAt: Math.floor(stats.mtimeMs),
				});
			}
		}
		return { entries, truncated, visited };
	}
}

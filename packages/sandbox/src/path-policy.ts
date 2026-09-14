import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SandboxError } from "./errors.js";

function isWithin(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export class WorkspacePathPolicy {
	readonly root: string;

	private constructor(root: string) {
		this.root = root;
	}

	static async create(root: string): Promise<WorkspacePathPolicy> {
		const resolved = await realpath(resolve(root));
		const stats = await lstat(resolved);
		if (!stats.isDirectory()) throw new SandboxError("path_invalid", "Workspace root is not a directory");
		return new WorkspacePathPolicy(resolved);
	}

	#candidate(input: string): string {
		if (!input || input.includes("\0") || isAbsolute(input) || /^[a-zA-Z]:/.test(input) || input.startsWith("\\\\")) {
			throw new SandboxError("path_invalid", "Tool paths must be non-empty workspace-relative paths");
		}
		const candidate = resolve(this.root, input);
		if (!isWithin(this.root, candidate)) throw new SandboxError("path_escape", `Path escapes workspace: ${input}`);
		return candidate;
	}

	async existing(input: string): Promise<string> {
		const candidate = this.#candidate(input);
		const resolved = await realpath(candidate);
		if (!isWithin(this.root, resolved))
			throw new SandboxError("path_escape", `Path resolves outside workspace: ${input}`);
		return resolved;
	}

	async writable(input: string): Promise<string> {
		const candidate = this.#candidate(input);
		try {
			const resolved = await realpath(candidate);
			if (!isWithin(this.root, resolved))
				throw new SandboxError("path_escape", `Path resolves outside workspace: ${input}`);
			return candidate;
		} catch (error) {
			if (error instanceof SandboxError) throw error;
			let parent = dirname(candidate);
			for (;;) {
				try {
					const resolvedParent = await realpath(parent);
					if (!isWithin(this.root, resolvedParent)) {
						throw new SandboxError("path_escape", `Parent resolves outside workspace: ${input}`);
					}
					return candidate;
				} catch (parentError) {
					if (parentError instanceof SandboxError) throw parentError;
					const next = dirname(parent);
					if (next === parent) throw new SandboxError("path_escape", `Cannot resolve workspace parent for: ${input}`);
					parent = next;
				}
			}
		}
	}
}

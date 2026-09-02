import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { SandboxError } from "./errors.js";
import type { ProcessResult, ProcessSandbox } from "./types.js";

export interface CommandRunOptions {
	signal?: AbortSignal;
	maxOutputBytes: number;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface CommandRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

export interface CommandRunner {
	run(executable: string, args: string[], options: CommandRunOptions): Promise<CommandRunResult>;
}

function appendBounded(current: string, chunk: string, maxBytes: number): { value: string; truncated: boolean } {
	const combined = current + chunk;
	const bytes = Buffer.byteLength(combined);
	if (bytes <= maxBytes) return { value: combined, truncated: false };
	const buffer = Buffer.from(combined);
	return { value: buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8"), truncated: true };
}

export class NodeCommandRunner implements CommandRunner {
	async run(executable: string, args: string[], options: CommandRunOptions): Promise<CommandRunResult> {
		return new Promise((resolve, reject) => {
			const child = spawn(executable, args, {
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let truncated = false;
			let settled = false;
			const abort = () => child.kill();
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (data: Buffer) => {
				const chunk = data.toString("utf8");
				options.onStdout?.(chunk);
				const appended = appendBounded(stdout, chunk, options.maxOutputBytes);
				stdout = appended.value;
				truncated ||= appended.truncated;
			});
			child.stderr.on("data", (data: Buffer) => {
				const chunk = data.toString("utf8");
				options.onStderr?.(chunk);
				const appended = appendBounded(stderr, chunk, options.maxOutputBytes);
				stderr = appended.value;
				truncated ||= appended.truncated;
			});
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", abort);
				reject(error);
			});
			child.once("close", (exitCode) => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", abort);
				resolve({ exitCode, stdout, stderr, truncated });
			});
		});
	}
}

export interface DockerProcessSandboxOptions {
	workspaceRoot: string;
	image: string;
	dockerExecutable?: string;
	runner?: CommandRunner;
	allowMutableImage?: boolean;
	defaultTimeoutMs?: number;
	maxTimeoutMs?: number;
	maxOutputBytes?: number;
	cpus?: number;
	memory?: string;
	pidsLimit?: number;
	tmpfsSize?: string;
	user?: string;
}

export class DockerProcessSandbox implements ProcessSandbox {
	readonly #workspaceRoot: string;
	readonly #image: string;
	readonly #dockerExecutable: string;
	readonly #runner: CommandRunner;
	readonly #defaultTimeoutMs: number;
	readonly #maxTimeoutMs: number;
	readonly #maxOutputBytes: number;
	readonly #cpus: number;
	readonly #memory: string;
	readonly #pidsLimit: number;
	readonly #tmpfsSize: string;
	readonly #user: string | undefined;

	constructor(options: DockerProcessSandboxOptions) {
		if (!options.allowMutableImage && !options.image.includes("@sha256:")) {
			throw new SandboxError("process_unavailable", "Docker image must be pinned by sha256 digest");
		}
		if (options.workspaceRoot.includes(",")) {
			throw new SandboxError("path_invalid", "Docker workspace paths containing commas are not supported");
		}
		this.#workspaceRoot = options.workspaceRoot;
		this.#image = options.image;
		this.#dockerExecutable = options.dockerExecutable ?? "docker";
		this.#runner = options.runner ?? new NodeCommandRunner();
		this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
		this.#maxTimeoutMs = options.maxTimeoutMs ?? 20 * 60_000;
		this.#maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
		this.#cpus = options.cpus ?? 1;
		this.#memory = options.memory ?? "768m";
		this.#pidsLimit = options.pidsLimit ?? 256;
		this.#tmpfsSize = options.tmpfsSize ?? "64m";
		this.#user = options.user;
	}

	async exec(
		command: string,
		options: { timeoutMs?: number; signal?: AbortSignal; onOutput?: (chunk: string) => void } = {},
	): Promise<ProcessResult> {
		if (!command.trim()) throw new SandboxError("process_failed", "Command must not be empty");
		if (command.length > 64 * 1024) throw new SandboxError("process_failed", "Command exceeds 64 KiB limit");
		const timeoutMs = Math.min(this.#maxTimeoutMs, Math.max(1, options.timeoutMs ?? this.#defaultTimeoutMs));
		const controller = new AbortController();
		let timedOut = false;
		const externalAbort = () => controller.abort(options.signal?.reason);
		if (options.signal?.aborted) externalAbort();
		else options.signal?.addEventListener("abort", externalAbort, { once: true });
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort(new SandboxError("process_timeout", `Command exceeded ${timeoutMs}ms`));
		}, timeoutMs);
		const name = `wuming-${randomUUID()}`;
		const args = [
			"run",
			"--rm",
			"--name",
			name,
			"--workdir",
			"/workspace",
			"--network",
			"none",
			"--cpus",
			String(this.#cpus),
			"--memory",
			this.#memory,
			"--pids-limit",
			String(this.#pidsLimit),
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--read-only",
			"--tmpfs",
			`/tmp:rw,noexec,nosuid,size=${this.#tmpfsSize}`,
			"--mount",
			`type=bind,source=${this.#workspaceRoot},target=/workspace`,
			...(this.#user ? ["--user", this.#user] : []),
			this.#image,
			"/bin/sh",
			"-lc",
			command,
		];

		try {
			const result = await this.#runner.run(this.#dockerExecutable, args, {
				signal: controller.signal,
				maxOutputBytes: this.#maxOutputBytes,
				...(options.onOutput ? { onStdout: options.onOutput, onStderr: options.onOutput } : {}),
			});
			if (controller.signal.aborted) {
				await this.#removeContainer(name);
				if (timedOut) throw new SandboxError("process_timeout", `Command exceeded ${timeoutMs}ms`);
				throw controller.signal.reason ?? new Error("Command aborted");
			}
			return { ...result, timedOut };
		} catch (error) {
			if (controller.signal.aborted) {
				await this.#removeContainer(name);
				if (timedOut) throw new SandboxError("process_timeout", `Command exceeded ${timeoutMs}ms`);
				throw controller.signal.reason ?? error;
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new SandboxError("process_unavailable", `Docker execution failed: ${message}`);
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", externalAbort);
		}
	}

	async #removeContainer(name: string): Promise<void> {
		try {
			await this.#runner.run(this.#dockerExecutable, ["rm", "-f", name], { maxOutputBytes: 64 * 1024 });
		} catch {
			// Best effort cleanup; the original timeout/abort remains authoritative.
		}
	}
}

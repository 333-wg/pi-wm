import { spawn, type ChildProcess } from "node:child_process";
import { SandboxError } from "./errors.js";
import type { ProcessResult, ProcessSandbox } from "./types.js";

function appendBounded(current: string, chunk: string, maxBytes: number): { value: string; truncated: boolean } {
	const combined = current + chunk;
	const bytes = Buffer.from(combined, "utf8");
	if (bytes.length <= maxBytes) return { value: combined, truncated: false };
	return {
		value: bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString("utf8"),
		truncated: true,
	};
}

function killTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "taskkill", "/pid", String(child.pid), "/t", "/f"], {
			windowsHide: true,
			stdio: "ignore",
		});
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

export interface LocalProcessSandboxOptions {
	workspaceRoot: string;
	defaultTimeoutMs?: number;
	maxTimeoutMs?: number;
	maxOutputBytes?: number;
	pythonExecutable?: string;
}

/** Executes in the user's existing workspace environment; approval is enforced above this layer. */
export class LocalProcessSandbox implements ProcessSandbox {
	readonly networkAccess = true;
	readonly pythonExecutable: string;
	readonly #workspaceRoot: string;
	readonly #defaultTimeoutMs: number;
	readonly #maxTimeoutMs: number;
	readonly #maxOutputBytes: number;

	constructor(options: LocalProcessSandboxOptions) {
		if (!options.workspaceRoot.trim())
			throw new SandboxError("process_unavailable", "Local process workspace is required");
		this.#workspaceRoot = options.workspaceRoot;
		this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
		this.#maxTimeoutMs = options.maxTimeoutMs ?? 30 * 60_000;
		this.#maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
		this.pythonExecutable = options.pythonExecutable ?? (process.platform === "win32" ? "python" : "python3");
	}

	async exec(
		command: string,
		options: { timeoutMs?: number; signal?: AbortSignal; onOutput?: (chunk: string) => void } = {}
	): Promise<ProcessResult> {
		if (!command.trim()) throw new SandboxError("process_failed", "Command must not be empty");
		if (command.length > 64 * 1024) throw new SandboxError("process_failed", "Command exceeds 64 KiB limit");
		const timeoutMs = Math.min(this.#maxTimeoutMs, Math.max(1, options.timeoutMs ?? this.#defaultTimeoutMs));
		const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
		const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
		const child = spawn(shell, args, {
			cwd: this.#workspaceRoot,
			env: process.env,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const terminate = () => killTree(child);
		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutMs);
		const abort = () => terminate();
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });

		return new Promise((resolve, reject) => {
			const finish = () => {
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", abort);
			};
			child.stdout?.on("data", (data: Buffer) => {
				const chunk = data.toString("utf8");
				options.onOutput?.(chunk);
				const appended = appendBounded(stdout, chunk, this.#maxOutputBytes);
				stdout = appended.value;
				truncated ||= appended.truncated;
			});
			child.stderr?.on("data", (data: Buffer) => {
				const chunk = data.toString("utf8");
				options.onOutput?.(chunk);
				const appended = appendBounded(stderr, chunk, this.#maxOutputBytes);
				stderr = appended.value;
				truncated ||= appended.truncated;
			});
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				finish();
				if (timedOut) reject(new SandboxError("process_timeout", `Command exceeded ${timeoutMs}ms`));
				else if (options.signal?.aborted) reject(options.signal.reason ?? error);
				else reject(new SandboxError("process_unavailable", `Local execution failed: ${error.message}`));
			});
			child.once("close", (exitCode) => {
				if (settled) return;
				settled = true;
				finish();
				if (timedOut) {
					reject(new SandboxError("process_timeout", `Command exceeded ${timeoutMs}ms`));
					return;
				}
				if (options.signal?.aborted) {
					reject(options.signal.reason ?? new Error("Command aborted"));
					return;
				}
				resolve({ exitCode, stdout, stderr, truncated, timedOut: false });
			});
		});
	}
}

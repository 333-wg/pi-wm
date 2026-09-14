import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxError } from "./errors.js";
import { WorkspacePathPolicy } from "./path-policy.js";
import type { PreviewServerAutomation, PreviewServerStatus } from "./types.js";

export interface HostPreviewServerManagerOptions {
	workspaceRoot: string;
	maxOutputBytes?: number;
	defaultReadyTimeoutMs?: number;
	idleTimeoutMs?: number;
}

interface PreviewRecord {
	child: ChildProcess;
	command: string;
	cwd: string;
	url: string;
	startedAt: number;
	state: "starting" | "running" | "exited";
	exitCode?: number | null;
	log: string;
	truncated: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
}

function appendBounded(record: PreviewRecord, chunk: Buffer | string, maxBytes: number): void {
	const combined = Buffer.from(record.log + chunk.toString(), "utf8");
	if (combined.length <= maxBytes) {
		record.log = combined.toString("utf8");
		return;
	}
	record.log = combined.subarray(combined.length - maxBytes).toString("utf8");
	record.truncated = true;
}

function safeEnvironment(): NodeJS.ProcessEnv {
	const allowed = [
		"PATH",
		"Path",
		"PATHEXT",
		"SystemRoot",
		"SYSTEMROOT",
		"ComSpec",
		"COMSPEC",
		"WINDIR",
		"USERPROFILE",
		"HOME",
		"HOMEDRIVE",
		"HOMEPATH",
		"TEMP",
		"TMP",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"SHELL",
		"TERM",
	];
	const environment: NodeJS.ProcessEnv = {};
	for (const name of allowed) if (process.env[name] !== undefined) environment[name] = process.env[name];
	environment.WUMING_PREVIEW = "1";
	return environment;
}

export function validatePreviewUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new SandboxError("network_denied", "Preview URL is invalid");
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
		throw new SandboxError("network_denied", "Preview readiness URL must use HTTP(S) on localhost");
	}
	if (url.username || url.password) throw new SandboxError("network_denied", "Preview URL cannot contain credentials");
	return url;
}

export class HostPreviewServerManager implements AsyncDisposable {
	readonly #policyPending: Promise<WorkspacePathPolicy>;
	readonly #records = new Map<string, PreviewRecord>();
	readonly #maxOutputBytes: number;
	readonly #defaultReadyTimeoutMs: number;
	readonly #idleTimeoutMs: number;
	#disposed = false;

	constructor(options: HostPreviewServerManagerOptions) {
		this.#policyPending = WorkspacePathPolicy.create(options.workspaceRoot);
		this.#maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
		this.#defaultReadyTimeoutMs = options.defaultReadyTimeoutMs ?? 30_000;
		this.#idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
	}

	session(sessionId: string): PreviewServerAutomation {
		if (!sessionId) throw new SandboxError("process_unavailable", "Preview session ID is required");
		return {
			start: (command, options) => this.#start(sessionId, command, options),
			status: () => this.#status(sessionId),
			stop: () => this.#stop(sessionId),
		};
	}

	async #start(
		sessionId: string,
		command: string,
		options: Parameters<PreviewServerAutomation["start"]>[1]
	): Promise<PreviewServerStatus> {
		if (this.#disposed) throw new SandboxError("process_unavailable", "Preview manager is closed");
		if (!command.trim() || command.length > 4096 || command.includes("\0")) {
			throw new SandboxError("process_failed", "Preview command must contain 1-4096 characters and no NUL bytes");
		}
		const current = this.#records.get(sessionId);
		if (current && current.state !== "exited")
			throw new SandboxError("process_failed", "A preview server is already running for this session; stop it first");
		if (current) await this.#stop(sessionId);
		const url = validatePreviewUrl(options.url);
		const policy = await this.#policyPending;
		const cwd = await policy.existing(options.cwd ?? ".");
		const child = spawn(command, [], {
			cwd,
			env: safeEnvironment(),
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
		});
		const record: PreviewRecord = {
			child,
			command,
			cwd,
			url: url.href,
			startedAt: Date.now(),
			state: "starting",
			log: "",
			truncated: false,
		};
		this.#records.set(sessionId, record);
		child.stdout?.on("data", (chunk: Buffer) => appendBounded(record, chunk, this.#maxOutputBytes));
		child.stderr?.on("data", (chunk: Buffer) => appendBounded(record, chunk, this.#maxOutputBytes));
		child.once("error", (error) => {
			appendBounded(record, `\n${error.message}\n`, this.#maxOutputBytes);
			record.state = "exited";
			record.exitCode = null;
		});
		child.once("exit", (exitCode) => {
			record.state = "exited";
			record.exitCode = exitCode;
			if (record.idleTimer) clearTimeout(record.idleTimer);
		});
		this.#touch(sessionId, record);

		const timeoutMs = Math.min(120_000, Math.max(1_000, options.timeoutMs ?? this.#defaultReadyTimeoutMs));
		const deadline = Date.now() + timeoutMs;
		try {
			while (Date.now() < deadline) {
				if (options.signal?.aborted) throw options.signal.reason ?? new Error("Preview start aborted");
				if (record.state === "exited")
					throw new SandboxError(
						"process_failed",
						`Preview process exited before becoming ready${record.log ? `:\n${record.log}` : ""}`
					);
				try {
					await fetch(url, {
						redirect: "manual",
						signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))),
					});
					record.state = "running";
					return this.#view(record);
				} catch (error) {
					if (error instanceof SandboxError) throw error;
				}
				await delay(200, undefined, options.signal ? { signal: options.signal } : undefined);
			}
			throw new SandboxError(
				"process_timeout",
				`Preview server did not become ready at ${url.href} within ${timeoutMs}ms`
			);
		} catch (error) {
			await this.#stop(sessionId);
			throw error;
		}
	}

	async #status(sessionId: string): Promise<PreviewServerStatus> {
		const record = this.#records.get(sessionId);
		if (!record) return { state: "stopped", log: "", truncated: false };
		this.#touch(sessionId, record);
		return this.#view(record);
	}

	async #stop(sessionId: string): Promise<PreviewServerStatus> {
		const record = this.#records.get(sessionId);
		if (!record) return { state: "stopped", log: "", truncated: false };
		this.#records.delete(sessionId);
		if (record.idleTimer) clearTimeout(record.idleTimer);
		await this.#terminate(record.child);
		return { ...this.#view(record), state: "stopped" };
	}

	#touch(sessionId: string, record: PreviewRecord): void {
		if (record.idleTimer) clearTimeout(record.idleTimer);
		if (record.state === "exited") return;
		record.idleTimer = setTimeout(() => void this.#stop(sessionId), this.#idleTimeoutMs);
		record.idleTimer.unref?.();
	}

	#view(record: PreviewRecord): PreviewServerStatus {
		return {
			state: record.state,
			command: record.command,
			cwd: record.cwd,
			url: record.url,
			...(record.child.pid === undefined ? {} : { pid: record.child.pid }),
			startedAt: record.startedAt,
			...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
			log: record.log,
			truncated: record.truncated,
		};
	}

	async #terminate(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.pid === undefined) return;
		if (process.platform === "win32") {
			await new Promise<void>((resolve) => {
				const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
					windowsHide: true,
					stdio: "ignore",
				});
				killer.once("error", () => {
					child.kill();
					resolve();
				});
				killer.once("exit", () => resolve());
			});
			return;
		}
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}
		await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(2000)]);
		if (child.exitCode === null)
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await Promise.all([...this.#records.keys()].map((sessionId) => this.#stop(sessionId)));
	}
}

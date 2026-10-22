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
	activeUsers: number;
}

type PreviewProbe = { state: "responding"; status: number } | { state: "closed" | "unknown" };

function connectionRefused(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if ("code" in error && error.code === "ECONNREFUSED") return true;
	if ("errors" in error && Array.isArray(error.errors))
		return error.errors.length > 0 && error.errors.every(connectionRefused);
	return "cause" in error && connectionRefused(error.cause);
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
	readonly #pendingOrigins = new Map<string, string>();
	readonly #stopping = new Set<Promise<void>>();
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
			status: (options) => this.#status(sessionId, options?.url),
			acquire: (url) => this.#acquire(url),
			stop: () => this.#stop(sessionId),
		};
	}

	async #start(
		sessionId: string,
		command: string,
		options: Parameters<PreviewServerAutomation["start"]>[1]
	): Promise<PreviewServerStatus> {
		if (this.#disposed) throw new SandboxError("process_unavailable", "Preview manager is closed");
		options.signal?.throwIfAborted();
		const url = validatePreviewUrl(options.url);
		const cwd = await (await this.#policyPending).existing(options.cwd ?? ".");
		const current = this.#records.get(sessionId);
		if (
			current?.state === "running" &&
			current.command === command &&
			current.cwd === cwd &&
			current.url === url.href
		) {
			const status = await this.#probe(url, options.signal);
			if (status.state === "responding" && status.status >= 200 && status.status < 400 && current.state === "running") {
				this.#touch(sessionId, current);
				return this.#view(current);
			}
			if (status.state === "unknown") {
				this.#touch(sessionId, current);
				throw new SandboxError(
					"process_timeout",
					"Preview health is unknown: the probe timed out or failed. The existing process was preserved. Inspect logs or retry its URL; do not restart it based on this probe alone"
				);
			}
			throw new SandboxError(
				"process_failed",
				"Existing preview is not healthy; inspect its status and logs before deciding whether to restart it"
			);
		}
		if (current && current.state !== "exited")
			throw new SandboxError(
				"process_failed",
				"A preview server is already running for this session; reuse its URL or stop it before changing its command"
			);
		for (const [owner, record] of this.#records) {
			if (owner !== sessionId && record.state !== "exited" && new URL(record.url).origin === url.origin)
				throw new SandboxError(
					"process_failed",
					`A workspace preview already uses ${url.origin}. Inspect preview_status and reuse its URL; do not stop another chat's server`
				);
		}
		if (this.#pendingOrigins.has(url.origin) || [...this.#pendingOrigins.values()].includes(sessionId))
			throw new SandboxError(
				"process_failed",
				"A preview start is already pending for this session or address; inspect status before retrying"
			);
		this.#pendingOrigins.set(url.origin, sessionId);
		try {
			const probe = await this.#probe(url, options.signal);
			if (probe.state === "unknown")
				throw new SandboxError(
					"process_timeout",
					`Preview address availability is unknown at ${url.origin}: the probe timed out or failed. No command was started. Inspect the existing service before retrying`
				);
			if (probe.state === "responding")
				throw new SandboxError(
					"process_failed",
					`A service already responds at ${url.origin}. Inspect and reuse it if it is the intended app, or choose another port. It was not started or stopped by this call`
				);
			options.signal?.throwIfAborted();
			return await this.#launch(sessionId, command, options);
		} finally {
			this.#pendingOrigins.delete(url.origin);
		}
	}

	async #probe(url: URL, signal?: AbortSignal): Promise<PreviewProbe> {
		try {
			const response = await fetch(url, {
				redirect: "manual",
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(500)]) : AbortSignal.timeout(500),
			});
			await response.body?.cancel().catch(() => undefined);
			return { state: "responding", status: response.status };
		} catch (error) {
			signal?.throwIfAborted();
			return { state: connectionRefused(error) ? "closed" : "unknown" };
		}
	}

	async #launch(
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
			activeUsers: 0,
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
		let lastHttpStatus: number | undefined;
		try {
			while (Date.now() < deadline) {
				if (options.signal?.aborted) throw options.signal.reason ?? new Error("Preview start aborted");
				if (record.state === "exited")
					throw new SandboxError(
						"process_failed",
						`Preview process exited before becoming ready${record.log ? `:\n${record.log}` : ""}`
					);
				try {
					const response = await fetch(url, {
						redirect: "manual",
						signal: AbortSignal.any([
							...(options.signal ? [options.signal] : []),
							AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))),
						]),
					});
					lastHttpStatus = response.status;
					await response.body?.cancel().catch(() => undefined);
					options.signal?.throwIfAborted();
					if (response.status >= 200 && response.status < 400 && record.child.exitCode === null) {
						record.state = "running";
						this.#touch(sessionId, record);
						return this.#view(record);
					}
				} catch (error) {
					if (error instanceof SandboxError) throw error;
				}
				await delay(200, undefined, options.signal ? { signal: options.signal } : undefined);
			}
			throw new SandboxError(
				"process_timeout",
				`Preview server did not become ready at ${url.href} within ${timeoutMs}ms${lastHttpStatus === undefined ? "" : ` (last HTTP status: ${lastHttpStatus})`}`
			);
		} catch (error) {
			await this.#stop(sessionId);
			throw error;
		}
	}

	#acquire(value: string): (() => void) | undefined {
		let origin: string;
		try {
			origin = new URL(value).origin;
		} catch {
			return undefined;
		}
		for (const [owner, record] of this.#records) {
			if (record.state === "exited" || new URL(record.url).origin !== origin) continue;
			record.activeUsers++;
			this.#touch(owner, record);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				record.activeUsers--;
				if (this.#records.get(owner) === record) this.#touch(owner, record);
			};
		}
		return undefined;
	}

	async #status(sessionId: string, url?: string): Promise<PreviewServerStatus> {
		// An explicit URL renews only the selected service, including for external browser skills.
		if (url) this.#acquire(url)?.();
		const record = this.#records.get(sessionId);
		const workspacePreviews = [...this.#records.entries()].flatMap(([ownerSessionId, other]) =>
			ownerSessionId !== sessionId && other.state !== "exited"
				? [{ ownerSessionId, url: other.url, cwd: other.cwd, command: other.command, state: other.state }]
				: []
		);
		const shared = workspacePreviews.length ? { workspacePreviews } : {};
		if (!record) return { state: "stopped", log: "", truncated: false, ...shared };
		this.#touch(sessionId, record);
		return { ...this.#view(record), ...shared };
	}

	async #stop(sessionId: string): Promise<PreviewServerStatus> {
		const record = this.#records.get(sessionId);
		if (!record) return { state: "stopped", log: "", truncated: false };
		this.#records.delete(sessionId);
		if (record.idleTimer) clearTimeout(record.idleTimer);
		const stopping = this.#terminate(record.child);
		this.#stopping.add(stopping);
		try {
			await stopping;
		} finally {
			this.#stopping.delete(stopping);
		}
		return { ...this.#view(record), state: "stopped" };
	}

	#touch(sessionId: string, record: PreviewRecord): void {
		if (record.idleTimer) clearTimeout(record.idleTimer);
		if (record.state !== "running" || record.activeUsers > 0) return;
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
		await Promise.all(this.#stopping);
	}
}

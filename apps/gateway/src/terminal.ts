import * as pty from "node-pty";
import type { TerminalServerMessage } from "@wuming/protocol";
import { discoverTerminalShells, type TerminalShell } from "./terminal-shells.js";

export interface TerminalOwner {
	principalId: string;
	workspaceId: string;
}

export interface TerminalManagerOptions {
	workspaceRoot: string;
	mode: "host" | "docker";
	dockerImage?: string;
	dockerExecutable?: string;
	idleTimeoutMs?: number;
	maxBufferBytes?: number;
	assertWorkspace: (workspaceId: string) => string;
	maxTerminals?: number;
}

interface TerminalRecord {
	id: string;
	owner: TerminalOwner;
	pty: pty.IPty;
	shell: TerminalShell;
	cwd: string;
	chunks: Array<{ seq: number; data: string }>;
	bufferBytes: number;
	firstSeq: number;
	seq: number;
	connections: Set<string>;
	lastUsedAt: number;
	disposables: Array<{ dispose(): void }>;
}

export type TerminalSend = (message: TerminalServerMessage) => void;

function boundedSize(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function safeEnv(): Record<string, string> {
	const keep = [
		"PATH",
		"Path",
		"PATHEXT",
		"SystemRoot",
		"SYSTEMROOT",
		"ComSpec",
		"COMSPEC",
		"WINDIR",
		"USERPROFILE",
		"APPDATA",
		"LOCALAPPDATA",
		"ProgramFiles",
		"ProgramFiles(x86)",
		"ProgramW6432",
		"PSModulePath",
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
	const env: Record<string, string> = {};
	for (const key of keep) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	if (!env.PATH && env.Path) env.PATH = env.Path;
	env.TERM ??= "xterm-256color";
	env.WUMING_TERMINAL = "1";
	return env;
}

function commandFor(
	options: TerminalManagerOptions,
	terminalId: string,
	workspace: string,
	shell: TerminalShell
): { file: string; args: string[]; cwd?: string; env: Record<string, string> } {
	if (options.mode === "host") {
		return { file: shell.file, args: shell.args, cwd: workspace, env: safeEnv() };
	}
	if (!options.dockerImage || !options.dockerImage.includes("@sha256:")) {
		throw Object.assign(new Error("Docker terminal requires a digest-pinned image"), {
			code: "process_unavailable",
		});
	}
	if (workspace.includes(","))
		throw Object.assign(new Error("Docker workspace paths containing commas are unsupported"), {
			code: "path_invalid",
		});
	const docker = options.dockerExecutable ?? "docker";
	return {
		file: docker,
		args: [
			"run",
			"--rm",
			"-i",
			"--name",
			`wuming-terminal-${terminalId}`,
			"--workdir",
			"/workspace",
			"--network",
			"none",
			"--cpus",
			"1",
			"--memory",
			"768m",
			"--pids-limit",
			"256",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--read-only",
			"--tmpfs",
			"/tmp:rw,noexec,nosuid,size=64m",
			"--mount",
			`type=bind,source=${workspace},target=/workspace`,
			options.dockerImage,
			"/bin/sh",
			"-l",
		],
		env: safeEnv(),
	};
}

export class TerminalManager implements AsyncDisposable {
	readonly #options: TerminalManagerOptions;
	readonly #terminals = new Map<string, TerminalRecord>();
	readonly #idleTimer: ReturnType<typeof setInterval>;
	readonly #shells: TerminalShell[];

	constructor(options: TerminalManagerOptions) {
		this.#options = options;
		this.#shells =
			options.mode === "docker"
				? [{ id: "container-sh", label: "Container sh", file: "/bin/sh", args: ["-l"] }]
				: discoverTerminalShells();
		this.#idleTimer = setInterval(() => this.#reapIdle(), Math.min(60_000, options.idleTimeoutMs ?? 15 * 60_000));
		this.#idleTimer.unref();
	}

	get enabled(): boolean {
		return true;
	}

	get activeCount(): number {
		return this.#terminals.size;
	}

	shells(requestId: string): TerminalServerMessage {
		const defaultShell = this.#shells[0];
		if (!defaultShell)
			throw Object.assign(new Error("未检测到可用的 Shell，请安装 PowerShell 或 Bash"), {
				code: "process_unavailable",
			});
		return {
			type: "terminal.shells",
			requestId,
			shells: this.#shells.map(({ id, label }) => ({ id, label })),
			defaultShellId: defaultShell.id,
		};
	}

	workspaceFor(terminalId: string, principalId: string): string {
		const record = this.#terminals.get(terminalId);
		if (!record) throw Object.assign(new Error("Terminal does not exist"), { code: "not_found" });
		if (record.owner.principalId !== principalId)
			throw Object.assign(new Error("Terminal access denied"), { code: "forbidden" });
		return record.owner.workspaceId;
	}

	create(input: {
		terminalId: string;
		requestId: string;
		owner: TerminalOwner;
		shellId?: string;
		cols: number;
		rows: number;
		connectionId: string;
		send: TerminalSend;
	}): TerminalServerMessage {
		if (this.#terminals.has(input.terminalId))
			throw Object.assign(new Error("Terminal already exists"), { code: "conflict" });
		if (this.#terminals.size >= (this.#options.maxTerminals ?? 8))
			throw Object.assign(new Error("终端数量已达上限，请先关闭其他工作区的终端"), { code: "capacity_reached" });
		const workspace = this.#options.assertWorkspace(input.owner.workspaceId);
		const shell = input.shellId ? this.#shells.find((candidate) => candidate.id === input.shellId) : this.#shells[0];
		if (!shell) throw Object.assign(new Error("所选 Shell 不可用，请重新选择"), { code: "process_unavailable" });
		const command = commandFor(this.#options, input.terminalId, workspace, shell);
		const child = pty.spawn(command.file, command.args, {
			name: "xterm-256color",
			cols: input.cols,
			rows: input.rows,
			...(command.cwd ? { cwd: command.cwd } : {}),
			env: command.env,
			encoding: "utf8",
			...(process.platform === "win32" ? { useConpty: true, conptyInheritCursor: false } : {}),
		});
		const record: TerminalRecord = {
			id: input.terminalId,
			owner: input.owner,
			pty: child,
			shell,
			cwd: this.#options.mode === "docker" ? "/workspace" : workspace,
			chunks: [],
			bufferBytes: 0,
			firstSeq: 1,
			seq: 0,
			connections: new Set([input.connectionId]),
			lastUsedAt: Date.now(),
			disposables: [],
		};
		this.#terminals.set(record.id, record);
		record.disposables.push(child.onData((data) => this.#output(record, data, input.send)));
		record.disposables.push(
			child.onExit(({ exitCode, signal }) => {
				this.#broadcast(record, {
					type: "terminal.exit",
					terminalId: record.id,
					exitCode,
					...(signal === undefined ? {} : { signal }),
				});
				this.#dispose(record.id);
			})
		);
		return {
			type: "terminal.ready",
			requestId: input.requestId,
			terminalId: record.id,
			shell: record.shell.label,
			shellId: record.shell.id,
			cwd: record.cwd,
			seq: record.seq,
		};
	}

	attach(input: {
		terminalId: string;
		owner: TerminalOwner;
		connectionId: string;
		sinceSeq: number;
		cols: number;
		rows: number;
		send: TerminalSend;
		requestId: string;
	}): TerminalServerMessage {
		const record = this.#owned(input.terminalId, input.owner);
		record.connections.add(input.connectionId);
		record.lastUsedAt = Date.now();
		try {
			record.pty.resize(input.cols, input.rows);
		} catch {
			/* process may exit between attach and resize */
		}
		if (input.sinceSeq < record.firstSeq - 1) {
			input.send({
				type: "terminal.reset",
				terminalId: record.id,
				seq: record.seq,
				data: record.chunks.map((chunk) => chunk.data).join(""),
			});
		} else {
			for (const chunk of record.chunks) {
				if (chunk.seq > input.sinceSeq) input.send({ type: "terminal.output", terminalId: record.id, ...chunk });
			}
		}
		return {
			type: "terminal.ready",
			requestId: input.requestId,
			terminalId: record.id,
			shell: record.shell.label,
			shellId: record.shell.id,
			cwd: record.cwd,
			seq: record.seq,
		};
	}

	input(input: { terminalId: string; owner: TerminalOwner; data: string }): void {
		const record = this.#owned(input.terminalId, input.owner);
		if (input.data.length > 65536) throw Object.assign(new Error("Terminal input is too large"), { code: "invalid" });
		record.lastUsedAt = Date.now();
		record.pty.write(input.data);
	}

	resize(input: { terminalId: string; owner: TerminalOwner; cols: number; rows: number }): void {
		const record = this.#owned(input.terminalId, input.owner);
		record.lastUsedAt = Date.now();
		record.pty.resize(input.cols, input.rows);
	}

	close(input: { terminalId: string; owner: TerminalOwner; requestId: string }): TerminalServerMessage {
		const record = this.#owned(input.terminalId, input.owner);
		this.#dispose(record.id);
		return { type: "terminal.closed", requestId: input.requestId, terminalId: input.terminalId };
	}

	detachConnection(connectionId: string): void {
		for (const record of this.#terminals.values()) {
			if (record.connections.delete(connectionId)) record.lastUsedAt = Date.now();
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		clearInterval(this.#idleTimer);
		for (const id of this.#terminals.keys()) this.#dispose(id);
	}

	#owned(id: string, owner: TerminalOwner): TerminalRecord {
		const record = this.#terminals.get(id);
		if (!record) throw Object.assign(new Error("Terminal does not exist"), { code: "not_found" });
		if (record.owner.principalId !== owner.principalId || record.owner.workspaceId !== owner.workspaceId) {
			throw Object.assign(new Error("Terminal access denied"), { code: "forbidden" });
		}
		return record;
	}

	#output(record: TerminalRecord, data: string, firstSend: TerminalSend): void {
		if (!data) return;
		record.seq += 1;
		record.lastUsedAt = Date.now();
		record.chunks.push({ seq: record.seq, data });
		record.bufferBytes += boundedSize(data);
		const maxBytes = this.#options.maxBufferBytes ?? 256 * 1024;
		while ((record.bufferBytes > maxBytes || record.chunks.length > 4096) && record.chunks.length > 1) {
			const removed = record.chunks.shift()!;
			record.bufferBytes -= boundedSize(removed.data);
			record.firstSeq = removed.seq + 1;
		}
		if (record.bufferBytes > maxBytes) {
			const bytes = Buffer.from(record.chunks[0]!.data, "utf8");
			let cut = bytes.length - maxBytes;
			while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut++;
			record.chunks[0]!.data = bytes.subarray(cut).toString("utf8");
			record.bufferBytes = bytes.length - cut;
			// A partial chunk cannot be replayed as an incremental event.
			record.firstSeq = record.seq + 1;
		}
		this.#broadcast(record, { type: "terminal.output", terminalId: record.id, seq: record.seq, data }, firstSend);
	}

	#broadcast(record: TerminalRecord, message: TerminalServerMessage, direct?: TerminalSend): void {
		const listeners = this.#listeners.get(record.id);
		if (listeners && listeners.size > 0) {
			for (const listener of listeners) listener(message);
			return;
		}
		if (direct) direct(message);
	}

	readonly #listeners = new Map<string, Set<TerminalSend>>();

	listen(terminalId: string, connectionId: string, send: TerminalSend): () => void {
		const listeners = this.#listeners.get(terminalId) ?? new Set<TerminalSend>();
		listeners.add(send);
		this.#listeners.set(terminalId, listeners);
		return () => {
			listeners.delete(send);
			if (listeners.size === 0) this.#listeners.delete(terminalId);
		};
	}

	#dispose(id: string): void {
		const record = this.#terminals.get(id);
		if (!record) return;
		this.#terminals.delete(id);
		this.#listeners.delete(id);
		for (const disposable of record.disposables) disposable.dispose();
		try {
			record.pty.kill();
		} catch {
			/* already exited */
		}
	}

	#reapIdle(): void {
		const cutoff = Date.now() - (this.#options.idleTimeoutMs ?? 15 * 60_000);
		for (const record of this.#terminals.values())
			if (record.connections.size === 0 && record.lastUsedAt < cutoff) this.#dispose(record.id);
	}
}

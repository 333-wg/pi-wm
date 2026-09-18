import type { ServerMessage, TerminalClientMessage } from "@wuming/protocol";
import { bearerProtocol, gatewayWebSocketUrl } from "./gateway-connection.js";

export interface TerminalState {
	status: "connecting" | "reconnecting" | "ready" | "closing" | "closed" | "error";
	error: string | undefined;
	shells: Array<{ id: string; label: string }>;
	shellId: string;
	shell: string;
	cwd: string;
	hasProcess: boolean;
}

interface TerminalSessionOptions {
	token: string;
	workspaceId: string;
	preferredShell?: string;
	onState: (state: TerminalState) => void;
	onOutput: (data: string, reset: boolean) => void;
	openSocket?: (url: string, protocols: string[]) => WebSocket;
}

export function terminalSize(cols: number, rows: number): { cols: number; rows: number } {
	return {
		cols: Math.max(20, Math.min(400, Math.floor(cols) || 80)),
		rows: Math.max(5, Math.min(200, Math.floor(rows) || 24)),
	};
}

// Owns the connection and process identity, independently of xterm's rendering.
export class TerminalSession {
	state: TerminalState = {
		status: "connecting",
		error: undefined,
		shells: [],
		shellId: "",
		shell: "",
		cwd: "",
		hasProcess: false,
	};
	readonly #options: TerminalSessionOptions;
	#terminalId = crypto.randomUUID();
	#socket: WebSocket | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#attempt = 0;
	#disposed = false;
	#automatic = true;
	#seq = 0;
	#size = terminalSize(80, 24);
	#pending: { requestId: string; mode: "shells" | "create" | "attach" | "close" } | undefined;
	#closeRequested = false;
	#restartRequested = false;
	#nextShell = "";

	constructor(options: TerminalSessionOptions) {
		this.#options = options;
		this.#nextShell = options.preferredShell ?? "";
	}

	connect(): void {
		if (this.#disposed) return;
		this.#disconnect();
		this.#automatic = true;
		this.#set({ status: this.state.hasProcess || this.#attempt ? "reconnecting" : "connecting", error: undefined });
		let socket: WebSocket;
		try {
			socket = (this.#options.openSocket ?? ((url, protocols) => new WebSocket(url, protocols)))(
				gatewayWebSocketUrl(),
				["wuming.v1", bearerProtocol(this.#options.token)]
			);
		} catch {
			this.#fail("无法创建终端连接，请检查网关地址或重新启动桌面应用");
			return;
		}
		this.#socket = socket;
		this.#deadline();
		socket.addEventListener("open", () => {
			if (this.#socket !== socket) return;
			socket.send(
				JSON.stringify({ type: "hello", protocolVersion: 1, clientId: crypto.randomUUID(), capabilities: ["terminal"] })
			);
		});
		socket.addEventListener("message", (event) => {
			if (this.#socket !== socket || this.#disposed) return;
			let message: ServerMessage;
			try {
				message = JSON.parse(String(event.data)) as ServerMessage;
			} catch {
				return;
			}
			this.#message(message);
		});
		socket.addEventListener("error", () => {
			if (this.#socket === socket) this.#set({ error: "无法连接网关，请检查本机服务、网络或访问凭据" });
		});
		socket.addEventListener("close", (event) => {
			if (this.#socket !== socket || this.#disposed) return;
			this.#socket = undefined;
			clearTimeout(this.#timer);
			if (!this.#automatic) return;
			if (event.code === 1002 || event.code === 1008) {
				this.#fail(event.code === 1008 ? "终端访问被拒绝，请重新连接主界面" : "终端协议不兼容，请更新前端和网关后重试");
				return;
			}
			this.#retry();
		});
	}

	retry(): void {
		this.#attempt = 0;
		this.connect();
	}

	start(shellId: string): void {
		if (this.state.hasProcess) return;
		this.#terminalId = crypto.randomUUID();
		this.#seq = 0;
		this.#nextShell = shellId;
		this.#closeRequested = false;
		this.#restartRequested = false;
		this.#options.onOutput("", true);
		this.retry();
	}

	close(restartShell?: string): void {
		this.#closeRequested = true;
		this.#restartRequested = restartShell !== undefined;
		if (restartShell !== undefined) this.#nextShell = restartShell;
		if (!this.state.hasProcess) {
			this.#closed();
			return;
		}
		if (this.state.status !== "ready") {
			this.retry();
			return;
		}
		this.#request("close");
	}

	input(data: string): void {
		if (this.state.status !== "ready") return;
		for (let offset = 0; offset < data.length;) {
			let end = Math.min(data.length, offset + 65536);
			const last = data.charCodeAt(end - 1);
			if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
			this.#send({ type: "terminal.input", terminalId: this.#terminalId, data: data.slice(offset, end) });
			offset = end;
		}
	}

	resize(cols: number, rows: number): void {
		this.#size = terminalSize(cols, rows);
		if (this.state.status === "ready")
			this.#send({ type: "terminal.resize", terminalId: this.#terminalId, ...this.#size });
	}

	dispose(): void {
		this.#disposed = true;
		this.#automatic = false;
		if (this.state.hasProcess)
			this.#send({ type: "terminal.close", requestId: crypto.randomUUID(), terminalId: this.#terminalId });
		this.#disconnect();
	}

	#message(message: ServerMessage): void {
		if (message.type === "hello_error") {
			this.#fail(message.error.message);
			return;
		}
		if (message.type === "hello") {
			if (!message.capabilities.includes("terminal")) {
				this.#fail("当前网关未启用终端功能");
				return;
			}
			this.#request(this.#closeRequested ? "close" : this.state.hasProcess ? "attach" : "shells");
			return;
		}
		if (message.type === "terminal.shells" && message.requestId === this.#pending?.requestId) {
			const shellId = message.shells.some((shell) => shell.id === this.#nextShell)
				? this.#nextShell
				: message.defaultShellId;
			this.#set({ shells: message.shells, shellId });
			this.#request("create");
			return;
		}
		if (message.type === "terminal.error") {
			if (message.terminalId && message.terminalId !== this.#terminalId) return;
			if (message.requestId && message.requestId !== this.#pending?.requestId) return;
			const mode = this.#pending?.mode;
			if (mode === "close" && message.code === "not_found") {
				this.#closed();
				return;
			}
			if (mode === "create" && message.code === "conflict") {
				this.#request("attach");
				return;
			}
			if (mode === "create" || message.code === "not_found") this.#set({ hasProcess: false });
			this.#fail(
				message.code === "not_found" ? "原终端已退出或被回收，请新建终端；之前的进程状态无法恢复" : message.message
			);
			return;
		}
		if (!("terminalId" in message) || message.terminalId !== this.#terminalId) return;
		if (message.type === "terminal.ready" && message.requestId === this.#pending?.requestId) {
			clearTimeout(this.#timer);
			this.#pending = undefined;
			this.#seq = Math.max(this.#seq, message.seq);
			this.#attempt = 0;
			this.#set({
				status: "ready",
				error: undefined,
				hasProcess: true,
				shell: message.shell,
				shellId: message.shellId ?? this.state.shellId,
				cwd: message.cwd ?? "",
			});
		} else if (message.type === "terminal.output" && message.seq > this.#seq) {
			this.#seq = message.seq;
			this.#options.onOutput(message.data, false);
		} else if (message.type === "terminal.reset") {
			this.#seq = message.seq;
			this.#options.onOutput(message.data, true);
		} else if (message.type === "terminal.exit") {
			this.#options.onOutput(`\r\n[进程已退出：${message.exitCode ?? "未知"}]\r\n`, false);
			this.#closed();
		} else if (message.type === "terminal.closed") {
			this.#closed();
		}
	}

	#request(mode: "shells" | "create" | "attach" | "close"): void {
		const requestId = crypto.randomUUID();
		this.#pending = { requestId, mode };
		this.#deadline();
		if (mode === "shells") this.#send({ type: "terminal.shells", requestId });
		else if (mode === "create") {
			// Mark uncertain creation before sending, so a lost response reattaches instead of duplicating.
			this.#set({ hasProcess: true });
			this.#send({
				type: "terminal.create",
				requestId,
				terminalId: this.#terminalId,
				workspaceId: this.#options.workspaceId,
				shellId: this.state.shellId,
				...this.#size,
			});
		} else if (mode === "attach")
			this.#send({
				type: "terminal.attach",
				requestId,
				terminalId: this.#terminalId,
				sinceSeq: this.#seq,
				...this.#size,
			});
		else {
			this.#set({ status: "closing" });
			this.#send({ type: "terminal.close", requestId, terminalId: this.#terminalId });
		}
	}

	#closed(): void {
		this.#automatic = false;
		this.#disconnect();
		this.#set({ status: "closed", error: undefined, hasProcess: false });
		if (this.#restartRequested) this.start(this.#nextShell);
	}

	#send(message: TerminalClientMessage): void {
		if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify(message));
	}

	#set(patch: Partial<TerminalState>): void {
		this.state = { ...this.state, ...patch };
		if (!this.#disposed) this.#options.onState(this.state);
	}

	#deadline(): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#disconnect();
			this.#retry();
		}, 12_000);
	}

	#retry(): void {
		if (!this.#automatic || this.#disposed) return;
		if (++this.#attempt > 4) {
			this.#fail("终端连接失败，已停止自动重试。请检查网关是否运行，或点击重新连接");
			return;
		}
		this.#set({ status: "reconnecting", error: `连接中断，正在尝试恢复（${this.#attempt}/4）` });
		this.#retryTimer = setTimeout(() => this.connect(), Math.min(4000, 500 * 2 ** (this.#attempt - 1)));
	}

	#fail(error: string): void {
		this.#automatic = false;
		this.#disconnect();
		this.#set({ status: "error", error });
	}

	#disconnect(): void {
		clearTimeout(this.#timer);
		clearTimeout(this.#retryTimer);
		this.#pending = undefined;
		const previous = this.#socket;
		this.#socket = undefined;
		previous?.close();
	}
}

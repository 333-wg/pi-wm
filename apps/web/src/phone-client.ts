import type { Command, CommandResult, ServerMessage } from "@wuming/protocol";

/** No bearer token: the phone listener authenticates an HttpOnly device cookie. */
export class PhoneClient {
	#socket: WebSocket | undefined;
	#pending = new Map<
		string,
		{ resolve: (result: CommandResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;
	#attempt = 0;
	#cursor: string | undefined;
	#ready = false;
	#revoked = false;
	#retryAfter = 0;
	constructor(
		private readonly onMessage: (message: ServerMessage) => void,
		private readonly onStatus: (status: string) => void,
		private readonly onReady: () => void
	) {}
	connect() {
		if (
			this.#closed ||
			this.#revoked ||
			Date.now() < this.#retryAfter ||
			(this.#socket && this.#socket.readyState < WebSocket.CLOSING)
		)
			return;
		this.#ready = false;
		this.onStatus(this.#attempt ? `正在重连 · 第 ${this.#attempt} 次` : "连接中");
		const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`, [
			"wuming.v1",
		]);
		this.#socket = ws;
		const helloTimeout = setTimeout(() => ws.close(), 15_000);
		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					type: "hello",
					protocolVersion: 1,
					clientId: "phone-browser",
					capabilities: ["session.resume"],
					...(this.#cursor ? { resumeCursor: this.#cursor } : {}),
				})
			);
		ws.onmessage = (event) => {
			if (this.#closed || this.#socket !== ws) return;
			let message: ServerMessage;
			try {
				message = JSON.parse(event.data) as ServerMessage;
			} catch {
				ws.close(1002);
				return;
			}
			if (message.type === "hello") {
				clearTimeout(helloTimeout);
				this.#attempt = 0;
				this.#ready = true;
				this.onStatus("已连接");
				this.onReady();
			}
			if (message.type === "response") {
				const p = this.#pending.get(message.requestId);
				if (p) {
					clearTimeout(p.timer);
					this.#pending.delete(message.requestId);
					if (message.ok) p.resolve(message.result);
					else p.reject(new Error(message.error.message));
				}
			}
			if (message.type === "event") this.#cursor = message.cursor;
			this.onMessage(message);
		};
		ws.onclose = (event) => {
			clearTimeout(helloTimeout);
			if (this.#socket !== ws) return;
			this.#ready = false;
			const rateLimited = event.code === 1013 || (event.code === 1008 && event.reason === "Phone request rate limit");
			this.#revoked = event.code === 1008 && event.reason === "Phone access revoked";
			for (const p of this.#pending.values()) {
				clearTimeout(p.timer);
				p.reject(new Error("连接中断，操作结果未知；请核对会话后再决定是否重发"));
			}
			this.#pending.clear();
			if (this.#closed) return;
			if (this.#revoked) this.onStatus("授权已撤销，请重新配对");
			else if (event.code === 1008 && !rateLimited) {
				this.onStatus("连接受限，请检查电脑端提示后重新连接");
			} else {
				const delay = rateLimited ? 60_000 : Math.min(30_000, 1000 * 2 ** Math.min(this.#attempt++, 5));
				this.#retryAfter = Date.now() + delay;
				this.onStatus(`${rateLimited ? "请求频繁" : "连接断开"} · ${delay / 1000} 秒后重连（不会重发指令）`);
				clearTimeout(this.#timer);
				this.#timer = setTimeout(() => this.connect(), delay);
			}
		};
	}
	request(command: Command, idempotencyKey: string = crypto.randomUUID()): Promise<CommandResult> {
		if (!this.#ready || this.#socket?.readyState !== WebSocket.OPEN)
			return Promise.reject(new Error("尚未连接，操作未发送"));
		const requestId = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(requestId);
				reject(new Error("响应超时，操作结果未知；请先核对会话，不会自动重发"));
				// A suspended mobile socket can remain OPEN after the network disappeared.
				// Reconnect for a fresh snapshot, never replay the timed-out command.
				this.#socket?.close();
			}, 20_000);
			this.#pending.set(requestId, { resolve, reject, timer });
			this.#socket!.send(JSON.stringify({ type: "request", requestId, idempotencyKey, command }));
		});
	}
	reconnect() {
		if (this.#closed || this.#revoked) return;
		// Manual reconnect must not cancel the scheduled rate-limit recovery.
		if (Date.now() < this.#retryAfter) return;
		clearTimeout(this.#timer);
		if (this.#socket && this.#socket.readyState < WebSocket.CLOSING) this.#socket.close();
		else this.connect();
	}
	close() {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#socket?.close();
	}
}

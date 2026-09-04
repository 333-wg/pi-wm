import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { ServerMessage, TerminalServerMessage } from "@wuming/protocol";
import { terminalTheme } from "./lib/terminal-theme.js";

function id(): string { return crypto.randomUUID(); }

function bearerProtocol(token: string): string {
	const bytes = new TextEncoder().encode(token);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `wuming.bearer.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function TerminalView({ token, workspaceId }: { token: string; workspaceId: string }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const readyRef = useRef(false);
	const [status, setStatus] = useState<"connecting" | "reconnecting" | "ready" | "closed" | "error">("connecting");
	const [error, setError] = useState<string>();

	useEffect(() => {
		let disposed = false;
		const terminalId = id();
		let socket: WebSocket | undefined;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let reconnectAttempt = 0;
		let reconnectEnabled = true;
		let terminalExists = false;
		let announcedReady = false;
		let lastSeq = 0;
		let handshake: { requestId: string; mode: "create" | "attach" } | undefined;
		const container = containerRef.current;
		if (!container) return;
		// Read off the element that hosts the terminal, so a scoped override counts.
		const readTheme = () => terminalTheme((name) => getComputedStyle(container).getPropertyValue(name));
		const term = new Terminal({
			allowProposedApi: false,
			convertEol: true,
			cursorBlink: true,
			fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
			fontSize: 12,
			lineHeight: 1.25,
			theme: readTheme(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		fit.fit();
		term.writeln("Wuming 终端");
		term.writeln("正在连接工作区...");
		const scheme = location.protocol === "https:" ? "wss" : "ws";
		const send = (message: object) => {
			if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
		};
		const resize = () => {
			fit.fit();
			if (readyRef.current) send({ type: "terminal.resize", terminalId, cols: term.cols, rows: term.rows });
		};
		const observer = new ResizeObserver(resize);
		observer.observe(container);
		// xterm keeps the colours it was constructed with, and the token block behind
		// them is swapped by `data-theme`. Watching the attribute instead of taking
		// the theme as a prop keeps this correct whoever owns the preference, and
		// re-theming in place leaves the scrollback and the running process alone.
		const themeObserver = new MutationObserver(() => {
			term.options.theme = readTheme();
		});
		themeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"] });
		const dataDisposable = term.onData((data) => {
			if (readyRef.current) send({ type: "terminal.input", terminalId, data });
		});
		const startHandshake = (mode: "create" | "attach") => {
			fit.fit();
			const requestId = id();
			handshake = { requestId, mode };
			if (mode === "create") {
				terminalExists = true;
				send({ type: "terminal.create", requestId, terminalId, workspaceId, cols: term.cols, rows: term.rows });
			} else {
				send({ type: "terminal.attach", requestId, terminalId, sinceSeq: lastSeq, cols: term.cols, rows: term.rows });
			}
		};
		const connect = () => {
			if (disposed) return;
			setStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");
			const current = new WebSocket(`${scheme}://${location.host}/api/ws`, ["wuming.v1", bearerProtocol(token)]);
			socket = current;
			current.addEventListener("open", () => {
				if (disposed || socket !== current) return;
				send({ type: "hello", protocolVersion: 1, clientId: id(), capabilities: ["terminal"] });
			});
			current.addEventListener("message", (raw) => {
				if (disposed || socket !== current) return;
				let message: ServerMessage | TerminalServerMessage;
				try { message = JSON.parse(String(raw.data)) as ServerMessage | TerminalServerMessage; } catch { return; }
				if (message.type === "hello") {
					if (!message.capabilities.includes("terminal")) {
						reconnectEnabled = false;
						setStatus("error");
						setError("当前网关未启用终端功能");
						term.writeln("\r\n当前网关未启用终端功能。");
						return;
					}
					startHandshake(terminalExists ? "attach" : "create");
					return;
				}
				if (!(message.type as string).startsWith("terminal.")) return;
				if (message.type === "terminal.ready" && message.terminalId === terminalId) {
					terminalExists = true;
					lastSeq = Math.max(lastSeq, message.seq);
					readyRef.current = true;
					reconnectAttempt = 0;
					handshake = undefined;
					setStatus("ready");
					setError(undefined);
					if (!announcedReady) {
						announcedReady = true;
						term.writeln(`\r\n${message.shell}`);
					}
					resize();
				} else if (message.type === "terminal.output" && message.terminalId === terminalId) {
					if (message.seq <= lastSeq) return;
					lastSeq = message.seq;
					term.write(message.data);
				} else if (message.type === "terminal.reset" && message.terminalId === terminalId) {
					lastSeq = message.seq;
					term.clear();
					term.write(message.data);
				} else if (message.type === "terminal.exit" && message.terminalId === terminalId) {
					reconnectEnabled = false;
					terminalExists = false;
					readyRef.current = false;
					setStatus("closed");
					term.writeln(`\r\n[进程已退出：${message.exitCode ?? "未知"}]`);
				} else if (message.type === "terminal.error" && (!message.terminalId || message.terminalId === terminalId)) {
					const currentHandshake = handshake;
					if (currentHandshake && currentHandshake.requestId === message.requestId && currentHandshake.mode === "attach" && message.code === "not_found") {
						terminalExists = false;
						startHandshake("create");
						return;
					}
					if (currentHandshake && currentHandshake.requestId === message.requestId && currentHandshake.mode === "create" && message.code === "conflict") {
						terminalExists = true;
						startHandshake("attach");
						return;
					}
					reconnectEnabled = false;
					setStatus("error");
					setError(message.message);
					term.writeln(`\r\n[终端错误] ${message.message}`);
				}
			});
			current.addEventListener("close", () => {
				if (disposed || socket !== current || !reconnectEnabled) return;
				readyRef.current = false;
				reconnectAttempt += 1;
				setStatus("reconnecting");
				reconnectTimer = setTimeout(connect, Math.min(4000, 250 * 2 ** Math.min(reconnectAttempt, 4)));
			});
			current.addEventListener("error", () => {
				if (!disposed && socket === current) setError("终端连接已中断");
			});
		};
		connect();
		return () => {
			disposed = true;
			reconnectEnabled = false;
			readyRef.current = false;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (socket?.readyState === WebSocket.OPEN && terminalExists) send({ type: "terminal.close", requestId: id(), terminalId });
			socket?.close();
			observer.disconnect();
			themeObserver.disconnect();
			dataDisposable.dispose();
			term.dispose();
		};
	}, [token, workspaceId]);

	return (
		<section className="terminal-workbench" aria-label="终端">
			<header className="terminal-heading"><strong>终端</strong><span className={`terminal-status terminal-${status}`}>{({ connecting: "连接中", reconnecting: "重新连接中", ready: "就绪", closed: "已关闭", error: "错误" } as const)[status]}</span></header>
			<div className="terminal-surface" ref={containerRef} />
			{error && <div className="terminal-error">{error}</div>}
		</section>
	);
}

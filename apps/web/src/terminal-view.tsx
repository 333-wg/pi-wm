import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Eraser, Play, RotateCcw, Square, Unplug, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { terminalTheme } from "./lib/terminal-theme.js";
import { TerminalSession, type TerminalState } from "./lib/terminal-session.js";
import "./terminal.css";

const labels = {
	connecting: "连接中",
	reconnecting: "重新连接中",
	ready: "就绪",
	closing: "正在关闭",
	closed: "已关闭",
	error: "错误",
};

function preferredShell(): string {
	try {
		return localStorage.getItem("wuming.terminal.shell") ?? "";
	} catch {
		return "";
	}
}

export function TerminalWorkbench({
	token,
	workspaceId,
	active,
}: {
	token: string;
	workspaceId?: string;
	active: boolean;
}) {
	const [workspaces, setWorkspaces] = useState<string[]>([]);
	useEffect(() => {
		if (active && workspaceId)
			setWorkspaces((current) => (current.includes(workspaceId) ? current : [...current, workspaceId]));
	}, [workspaceId, active]);
	return (
		<>
			{workspaces.map((workspace) => (
				<TerminalView
					key={workspace}
					token={token}
					workspaceId={workspace}
					active={active && workspaceId === workspace}
				/>
			))}
		</>
	);
}

export function TerminalView({
	token,
	workspaceId,
	active = true,
}: {
	token: string;
	workspaceId: string;
	active?: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const sessionRef = useRef<TerminalSession | undefined>(undefined);
	const termRef = useRef<Terminal | undefined>(undefined);
	const resizeRef = useRef<(() => void) | undefined>(undefined);
	const activeRef = useRef(active);
	activeRef.current = active;
	const [state, setState] = useState<TerminalState>({
		status: "connecting",
		error: undefined,
		shells: [],
		shellId: "",
		shell: "",
		cwd: "",
		hasProcess: false,
	});
	const [shellId, setShellId] = useState(preferredShell);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const readTheme = () => terminalTheme((name) => getComputedStyle(container).getPropertyValue(name));
		const term = new Terminal({
			convertEol: true,
			cursorBlink: true,
			disableStdin: true,
			fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
			fontSize: 12,
			lineHeight: 1.25,
			theme: readTheme(),
			scrollback: 5000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		termRef.current = term;
		const session = new TerminalSession({
			token,
			workspaceId,
			preferredShell: preferredShell(),
			onState: (next) => {
				setState(next);
				setShellId((current) => (next.shells.some((shell) => shell.id === current) ? current : next.shellId));
				term.options.disableStdin = next.status !== "ready";
			},
			onOutput: (data, reset) => {
				if (reset) term.reset();
				if (data) term.write(data);
			},
		});
		sessionRef.current = session;
		const resize = () => {
			// Hidden panels have no usable dimensions; retain the last PTY size.
			if (!activeRef.current || !container.clientWidth || !container.clientHeight) return;
			fit.fit();
			session.resize(term.cols, term.rows);
		};
		resizeRef.current = resize;
		resize();
		const observer = new ResizeObserver(resize);
		observer.observe(container);
		const themeObserver = new MutationObserver(() => {
			term.options.theme = readTheme();
		});
		themeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"] });
		const input = term.onData((data) => session.input(data));
		session.connect();
		return () => {
			// Only the owning workbench/authentication teardown disposes this view.
			session.dispose();
			observer.disconnect();
			themeObserver.disconnect();
			input.dispose();
			term.dispose();
			sessionRef.current = undefined;
			termRef.current = undefined;
			resizeRef.current = undefined;
		};
	}, [token, workspaceId]);

	useEffect(() => {
		if (!active) return;
		const frame = requestAnimationFrame(() => {
			resizeRef.current?.();
			termRef.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [active]);

	const selectShell = (value: string) => {
		setShellId(value);
		try {
			localStorage.setItem("wuming.terminal.shell", value);
		} catch {
			/* Storage is optional. */
		}
	};
	const close = (restart: boolean) => {
		if (
			!window.confirm(
				restart ? "重启会结束当前终端及其中运行的命令，是否继续？" : "关闭会结束当前终端及其中运行的命令，是否继续？"
			)
		)
			return;
		sessionRef.current?.close(restart ? shellId : undefined);
	};
	const busy = ["connecting", "reconnecting", "closing"].includes(state.status);

	return (
		<section className="terminal-workbench" aria-label="终端" hidden={!active} data-workspace-id={workspaceId}>
			<header className="terminal-heading">
				<strong>终端</strong>
				<span className={`terminal-status terminal-${state.status}`} role="status">
					{labels[state.status]}
				</span>
				<div className="terminal-actions">
					<select
						aria-label="新终端 Shell"
						title="新终端 Shell"
						value={shellId}
						onChange={(event) => selectShell(event.target.value)}
						disabled={!state.shells.length || busy}
					>
						{!state.shells.length && <option value="">Shell</option>}
						{state.shells.map((shell) => (
							<option key={shell.id} value={shell.id}>
								{shell.label}
							</option>
						))}
					</select>
					{state.status === "error" && (state.hasProcess || !state.shells.length) && (
						<button type="button" title="重新连接" aria-label="重新连接" onClick={() => sessionRef.current?.retry()}>
							<Unplug size={15} />
						</button>
					)}
					{!state.hasProcess && !busy && (
						<button
							type="button"
							title="新建终端"
							aria-label="新建终端"
							onClick={() => sessionRef.current?.start(shellId)}
						>
							<Play size={15} />
						</button>
					)}
					<button type="button" title="清屏" aria-label="清屏" onClick={() => termRef.current?.clear()}>
						<Eraser size={15} />
					</button>
					<button
						type="button"
						title="中断当前命令"
						aria-label="中断当前命令"
						disabled={state.status !== "ready"}
						onClick={() => sessionRef.current?.input("\x03")}
					>
						<Square size={14} />
					</button>
					<button
						type="button"
						title="重启终端"
						aria-label="重启终端"
						disabled={!state.hasProcess || busy}
						onClick={() => close(true)}
					>
						<RotateCcw size={15} />
					</button>
					<button
						type="button"
						title="关闭终端"
						aria-label="关闭终端"
						disabled={!state.hasProcess || busy}
						onClick={() => close(false)}
					>
						<X size={16} />
					</button>
				</div>
			</header>
			{state.cwd && (
				<div className="terminal-location">
					<span>{state.shell}</span>
					<span title={`初始目录：${state.cwd}`}>初始目录：{state.cwd}</span>
				</div>
			)}
			<div className="terminal-surface" ref={containerRef} />
			{state.error && (
				<div className="terminal-error" role="alert">
					{state.error}
				</div>
			)}
		</section>
	);
}

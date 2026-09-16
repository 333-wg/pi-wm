import { CircleAlert, Pencil, Plug, Plus, Power, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Command, CommandResult, McpServer, McpServerConfiguration, McpServerSummary } from "@wuming/protocol";
import { McpConfigDialog } from "./McpConfigDialog.js";
import { useFocusTrap } from "../use-focus-trap.js";
import "./mcp.css";

type McpCommand = Extract<
	Command,
	{ type: "mcp.configure" | "mcp.configuration.get" | "mcp.trust" | "mcp.untrust" | "mcp.remove" }
>;
interface Props {
	workspaceId: string;
	available: boolean;
	servers: McpServerSummary[];
	selectedServer: McpServer | undefined;
	onRefresh: () => Promise<McpServerSummary[]>;
	onSelect: (serverId: string) => Promise<McpServer | undefined>;
	onCommand: (command: McpCommand) => Promise<CommandResult>;
}

function Confirmation({
	server,
	action,
	busy,
	error,
	onConfirm,
	onClose,
}: {
	server: McpServerSummary;
	action: "trust" | "untrust" | "remove";
	busy: boolean;
	error: string | undefined;
	onConfirm: () => void;
	onClose: () => void;
}) {
	const dialog = useFocusTrap<HTMLDivElement>();
	const title = action === "trust" ? "授权并连接" : action === "untrust" ? "停用服务" : "删除服务";
	return (
		<div
			className="skill-manager-overlay"
			onKeyDown={(event) => {
				if (event.key === "Escape" && !busy) {
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<div
				className="mcp-confirm-dialog"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="mcp-confirm-title"
				aria-describedby="mcp-confirm-description"
				ref={dialog}
			>
				<header>
					<h2 id="mcp-confirm-title">{title}</h2>
					<button className="icon-button" title="关闭确认" disabled={busy} onClick={onClose}>
						<X size={17} />
					</button>
				</header>
				<strong className="mcp-confirm-name">{server.name}</strong>
				{error && (
					<div className="workbench-error" role="alert">
						{error}
					</div>
				)}
				<p id="mcp-confirm-description">
					{action === "trust"
						? server.transport === "stdio"
							? "此操作将在本机启动该服务进程。仅授权你信任的服务。"
							: "此操作将连接远程服务并发送已配置的请求头。仅授权你信任的服务。"
						: action === "untrust"
							? "将撤销本地授权并关闭连接，保留服务配置。"
							: "将关闭连接并删除该服务配置及本地授权。此操作不可撤销。"}
				</p>
				<footer>
					<button className="secondary-button" disabled={busy} onClick={onClose}>
						取消
					</button>
					<button className="primary-button" disabled={busy} onClick={onConfirm}>
						{busy ? "处理中" : "确认" + title}
					</button>
				</footer>
			</div>
		</div>
	);
}

export function McpView({ workspaceId, available, servers, selectedServer, onRefresh, onSelect, onCommand }: Props) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [editor, setEditor] = useState<{ initial?: McpServerConfiguration }>();
	const [confirmation, setConfirmation] = useState<{
		server: McpServerSummary;
		action: "trust" | "untrust" | "remove";
	}>();
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const run = async (action: () => Promise<void>, message: string) => {
		if (busy) return;
		setBusy(true);
		setError(undefined);
		try {
			await action();
		} catch {
			if (alive.current) setError(message);
		} finally {
			if (alive.current) setBusy(false);
		}
	};
	const select = async (id: string) => {
		setError(undefined);
		try {
			await onSelect(id);
		} catch {
			if (alive.current) setError("MCP 工具发现失败。请检查服务启动、协议响应及目录上限，然后刷新或点击服务重试。");
		}
	};
	const edit = (id: string) =>
		run(async () => {
			const result = await onCommand({ type: "mcp.configuration.get", workspaceId, serverId: id });
			if (result.type !== "mcp.configuration" || result.serverId !== id || result.workspaceId !== workspaceId)
				throw new Error("Unexpected response");
			if (alive.current) setEditor({ initial: result.config });
		}, "读取配置失败，请检查管理权限及网关连接。");
	const act = () => {
		if (!confirmation) return;
		const { server, action } = confirmation;
		void run(async () => {
			const result = await onCommand({
				type: action === "trust" ? "mcp.trust" : action === "untrust" ? "mcp.untrust" : "mcp.remove",
				workspaceId,
				serverId: server.id,
			});
			if (result.type !== "mcp.updated" && result.type !== "mcp.removed") throw new Error("Unexpected response");
			if (alive.current) setConfirmation(undefined);
		}, "操作未完成。请检查配置、服务依赖和管理权限，再刷新确认状态。");
	};
	return (
		<section className="skills-workbench mcp-workbench" aria-label="MCP 服务">
			<aside className="skills-sidebar">
				<div className="workbench-heading">
					<div>
						<strong>MCP</strong>
						<span>已配置 {servers.length} 个</span>
					</div>
					<div className="mcp-actions">
						<button
							className="icon-button"
							title="新增 MCP 服务"
							disabled={busy || !available}
							onClick={() => setEditor({})}
						>
							<Plus size={16} />
						</button>
						<button
							className="icon-button"
							title="刷新 MCP 服务"
							disabled={busy || !available}
							onClick={() =>
								void run(async () => {
									await onRefresh();
								}, "刷新失败，请检查工作区配置和网关连接。")
							}
						>
							<RefreshCw size={15} />
						</button>
					</div>
				</div>
				{error && !confirmation && (
					<div className="workbench-error" role="alert">
						<CircleAlert size={14} />
						{error}
					</div>
				)}
				{servers.map((server) => (
					<button
						className={"skill-entry " + (selectedServer?.id === server.id ? "selected" : "")}
						key={server.id}
						disabled={busy}
						onClick={() => void select(server.id)}
					>
						<Plug size={14} />
						<span>
							<strong>{server.name}</strong>
							<small>
								{server.discoveryStatus === "disabled"
									? "已禁用 · 不会启动"
									: server.discoveryStatus === "failed"
										? "工具发现失败 · 点击重试"
										: server.trusted
											? server.toolCount + " 个工具 · " + (server.readOnly ? "只读" : "需要批准")
											: "待授权 · 不会启动"}
							</small>
						</span>
					</button>
				))}
				{servers.length === 0 && (
					<div className="workbench-empty">{available ? "尚未配置 MCP 服务" : "当前运行模式不支持 MCP"}</div>
				)}
			</aside>
			<div className="skills-content">
				{selectedServer ? (
					<>
						<div className="editor-heading">
							<Plug size={15} />
							<strong>{selectedServer.name}</strong>
							<span>{selectedServer.transport}</span>
						</div>
						<div className="mcp-toolbar">
							<button
								className="icon-button"
								title="编辑服务"
								disabled={busy || !available}
								onClick={() => void edit(selectedServer.id)}
							>
								<Pencil size={16} />
							</button>
							{selectedServer.discoveryStatus !== "disabled" && (
								<button
									className="secondary-button"
									disabled={busy || !available}
									onClick={() =>
										setConfirmation({ server: selectedServer, action: selectedServer.trusted ? "untrust" : "trust" })
									}
								>
									{selectedServer.trusted ? <Power size={14} /> : <ShieldCheck size={14} />}
									{selectedServer.trusted ? "停用" : "授权并连接"}
								</button>
							)}
							<button
								className="icon-button"
								title="删除服务"
								disabled={busy || !available}
								onClick={() => setConfirmation({ server: selectedServer, action: "remove" })}
							>
								<Trash2 size={16} />
							</button>
						</div>
						<div className="mcp-tool-list">
							{selectedServer.tools.map((tool) => (
								<article className="mcp-tool" key={tool.name}>
									<div>
										<strong>{tool.name}</strong>
										<span>{tool.description || "暂无说明"}</span>
									</div>
									{tool.inputSchema && <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>}
								</article>
							))}
							{selectedServer.tools.length === 0 && (
								<div className="workbench-empty">
									{selectedServer.discoveryStatus === "disabled"
										? "服务已禁用，不会启动"
										: selectedServer.discoveryStatus === "failed"
											? "工具发现失败"
											: selectedServer.trusted
												? "该服务未提供工具"
												: "服务未授权，不会启动"}
								</div>
							)}
						</div>
					</>
				) : (
					<div className="workbench-empty">
						<Plug size={24} />
						<span>{servers.length ? "选择一个 MCP 服务" : "暂无 MCP 服务"}</span>
						{available && !servers.length && (
							<button className="secondary-button" onClick={() => setEditor({})}>
								<Plus size={14} />
								新增服务
							</button>
						)}
					</div>
				)}
			</div>
			{editor && (
				<McpConfigDialog
					{...(editor.initial ? { initial: editor.initial } : {})}
					existingIds={servers.map((server) => server.id)}
					onClose={() => setEditor(undefined)}
					onSave={async (config) => {
						const result = await onCommand({ type: "mcp.configure", workspaceId, config });
						if (result.type !== "mcp.updated") throw new Error("Unexpected response");
					}}
				/>
			)}
			{confirmation && (
				<Confirmation
					{...confirmation}
					busy={busy}
					error={error}
					onClose={() => setConfirmation(undefined)}
					onConfirm={act}
				/>
			)}
		</section>
	);
}

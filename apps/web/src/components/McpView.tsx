import {
	Check,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	Code2,
	Globe,
	LoaderCircle,
	Pencil,
	Plug,
	Plus,
	RefreshCw,
	Search,
	ShieldCheck,
	Terminal,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
	Command,
	CommandResult,
	McpScope,
	McpServer,
	McpServerConfiguration,
	McpServerSummary,
} from "@wuming/protocol";
import { McpConfigDialog } from "./McpConfigDialog.js";
import { useFocusTrap } from "../use-focus-trap.js";
import "./mcp.css";

type McpCommand = Extract<
	Command,
	{ type: "mcp.configure" | "mcp.configuration.get" | "mcp.trust" | "mcp.untrust" | "mcp.remove" | "mcp.setEnabled" }
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

type Action = "trust" | "untrust" | "remove";
type DetailTab = "tools" | "config" | "diagnostics";

function statusOf(server: McpServerSummary) {
	if (server.discoveryStatus === "disabled") return { tone: "muted", label: "已停用" };
	if (server.discoveryStatus === "failed") return { tone: "error", label: "连接异常" };
	if (!server.trusted) return { tone: "pending", label: "待授权" };
	return { tone: "ready", label: "已连接" };
}

function Status({ server }: { server: McpServerSummary }) {
	const status = statusOf(server);
	return (
		<span className={`mcp-status mcp-status-${status.tone}`}>
			<span />
			{status.label}
		</span>
	);
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
	action: Action;
	busy: boolean;
	error: string | undefined;
	onConfirm: () => void;
	onClose: () => void;
}) {
	const dialog = useFocusTrap<HTMLDivElement>();
	const title = action === "trust" ? "授权并连接" : action === "untrust" ? "撤销授权" : "删除服务";
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
					{server.scope === "global" && "此操作影响所有工作区。"}
					{action === "trust"
						? server.transport === "stdio"
							? "此操作将在本机启动该服务进程。仅授权你信任的服务。"
							: "此操作将连接远程服务并发送已配置的请求头。仅授权你信任的服务。"
						: action === "untrust"
							? "将撤销本地授权并关闭连接，保留服务配置。由管理员预授权的服务将停用。"
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

function ServerDetails({
	server,
	tab,
	onTab,
	busy,
	available,
	onEdit,
	onRetry,
	onAction,
}: {
	server: McpServer;
	tab: DetailTab;
	onTab: (tab: DetailTab) => void;
	busy: boolean;
	available: boolean;
	onEdit: () => void;
	onRetry: () => void;
	onAction: (action: Action) => void;
}) {
	const tabs = [
		["tools", "工具"],
		["config", "配置"],
		["diagnostics", "诊断"],
	] as const;
	const disabled = server.discoveryStatus === "disabled";
	const failed = server.discoveryStatus === "failed";
	const toolMessage = disabled
		? "服务已停用"
		: failed
			? "工具发现失败"
			: !server.trusted
				? "服务尚未授权"
				: "该服务未提供工具";
	return (
		<div className="mcp-detail" id={`mcp-detail-${server.id}`}>
			<div className="mcp-detail-bar">
				<div
					className="mcp-tabs"
					role="tablist"
					aria-label={`${server.name}详情`}
					onKeyDown={(event) => {
						const index = tabs.findIndex(([id]) => id === tab);
						const next =
							event.key === "ArrowRight"
								? (index + 1) % tabs.length
								: event.key === "ArrowLeft"
									? (index + tabs.length - 1) % tabs.length
									: event.key === "Home"
										? 0
										: event.key === "End"
											? tabs.length - 1
											: undefined;
						if (next === undefined) return;
						event.preventDefault();
						onTab(tabs[next]![0]);
						(event.currentTarget.children[next] as HTMLButtonElement).focus();
					}}
				>
					{tabs.map(([id, label]) => (
						<button
							key={id}
							id={`mcp-tab-${server.id}-${id}`}
							role="tab"
							aria-selected={tab === id}
							aria-controls={`mcp-panel-${server.id}`}
							tabIndex={tab === id ? 0 : -1}
							onClick={() => onTab(id)}
						>
							{label}
							{id === "tools" && <span>{server.toolCount}</span>}
						</button>
					))}
				</div>
				{server.trusted && !disabled && (
					<button className="icon-button" title="重新检查连接" disabled={busy || !available} onClick={onRetry}>
						<RefreshCw size={15} />
					</button>
				)}
			</div>
			<div
				className="mcp-detail-body"
				role="tabpanel"
				id={`mcp-panel-${server.id}`}
				aria-labelledby={`mcp-tab-${server.id}-${tab}`}
			>
				{tab === "tools" &&
					(server.tools.length ? (
						<div className="mcp-tool-list">
							{server.tools.map((tool) => (
								<article className="mcp-tool" key={tool.name}>
									<Code2 size={16} />
									<div>
										<strong>{tool.name}</strong>
										<p>{tool.description || "暂无说明"}</p>
										{tool.inputSchema && (
											<details>
												<summary>参数结构</summary>
												<pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
											</details>
										)}
									</div>
								</article>
							))}
						</div>
					) : (
						<div className="mcp-detail-empty">
							<Plug size={22} />
							<span>{toolMessage}</span>
							{!disabled && !server.trusted && (
								<button className="secondary-button" disabled={busy || !available} onClick={() => onAction("trust")}>
									<ShieldCheck size={15} />
									授权并连接
								</button>
							)}
							{failed && server.trusted && (
								<button className="secondary-button" disabled={busy || !available} onClick={onRetry}>
									<RefreshCw size={15} />
									重试连接
								</button>
							)}
						</div>
					))}
				{tab === "config" && (
					<>
						<dl className="mcp-facts">
							<div>
								<dt>服务 ID</dt>
								<dd>{server.id}</dd>
							</div>
							<div>
								<dt>传输方式</dt>
								<dd>{server.transport === "stdio" ? "本地进程 · stdio" : server.transport}</dd>
							</div>
							<div>
								<dt>作用范围</dt>
								<dd>{server.scope === "global" ? "全局（所有工作区）" : "当前工作区"}</dd>
							</div>
							<div>
								<dt>工具权限</dt>
								<dd>{server.readOnly ? "只读" : "执行前需要批准"}</dd>
							</div>
						</dl>
						<div className="mcp-detail-actions">
							<button className="secondary-button" disabled={busy || !available} onClick={onEdit}>
								<Pencil size={14} />
								编辑配置
							</button>
							{server.trusted && (
								<button className="secondary-button" disabled={busy || !available} onClick={() => onAction("untrust")}>
									<ShieldCheck size={14} />
									撤销授权
								</button>
							)}
							<button
								className="icon-button mcp-danger"
								title="删除服务"
								disabled={busy || !available}
								onClick={() => onAction("remove")}
							>
								<Trash2 size={16} />
							</button>
						</div>
					</>
				)}
				{tab === "diagnostics" && (
					<>
						<dl className="mcp-facts">
							<div>
								<dt>配置</dt>
								<dd>
									<Check size={14} />
									已保存
								</dd>
							</div>
							<div>
								<dt>授权</dt>
								<dd>{server.trusted ? "已授权" : "待授权"}</dd>
							</div>
							<div>
								<dt>连接</dt>
								<dd>
									<Status server={server} />
								</dd>
							</div>
							<div>
								<dt>工具发现</dt>
								<dd>{disabled || !server.trusted ? "未执行" : failed ? "未完成" : `${server.toolCount} 个工具`}</dd>
							</div>
						</dl>
						{failed && (
							<div className="mcp-diagnostic-note">
								<CircleAlert size={17} />
								<p>
									{server.transport === "stdio"
										? "未能取得工具目录。请检查本机启动命令、工作目录和运行依赖。"
										: "未能取得工具目录。请检查服务地址、网络和认证配置。"}
								</p>
							</div>
						)}
						{!server.trusted && (
							<p className="mcp-diagnostic-note">
								{disabled ? "服务已停用，且未获得本地授权。" : "尚未获得本地授权，不会启动服务或发送凭据。"}
							</p>
						)}
						{server.trusted && !disabled && (
							<button className="secondary-button" disabled={busy || !available} onClick={onRetry}>
								<RefreshCw size={14} />
								重新检查连接
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}

export function McpView({ workspaceId, available, servers, selectedServer, onRefresh, onSelect, onCommand }: Props) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [editor, setEditor] = useState<{
		initial?: McpServerConfiguration;
		scope?: McpScope;
		mode?: "form" | "import";
	}>();
	const [confirmation, setConfirmation] = useState<{ server: McpServerSummary; action: Action }>();
	const [expanded, setExpanded] = useState<string>();
	const [loading, setLoading] = useState<string>();
	const [tab, setTab] = useState<DetailTab>("tools");
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState("all");
	const alive = useRef(true);
	const selection = useRef(0);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			++selection.current;
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
	const select = async (id: string, nextTab: DetailTab = "tools") => {
		const revision = ++selection.current;
		setExpanded(id);
		setTab(nextTab);
		setLoading(id);
		setError(undefined);
		try {
			await onSelect(id);
		} catch {
			if (alive.current && revision === selection.current)
				setError("MCP 工具发现失败。请在诊断中检查配置，然后重试连接。");
		} finally {
			if (alive.current && revision === selection.current) setLoading(undefined);
		}
	};
	const refresh = () =>
		run(async () => {
			++selection.current;
			setExpanded(undefined);
			setLoading(undefined);
			await onRefresh();
		}, "刷新失败，请检查工作区配置和网关连接。");
	const edit = (id: string) =>
		run(async () => {
			const result = await onCommand({ type: "mcp.configuration.get", workspaceId, serverId: id });
			if (result.type !== "mcp.configuration" || result.serverId !== id || result.workspaceId !== workspaceId)
				throw new Error("Unexpected response");
			if (alive.current)
				setEditor({ initial: result.config, scope: servers.find((server) => server.id === id)?.scope ?? "workspace" });
		}, "读取配置失败，请检查管理权限及网关连接。");
	const toggle = (server: McpServerSummary) =>
		run(async () => {
			const result = await onCommand({
				type: "mcp.setEnabled",
				workspaceId,
				serverId: server.id,
				enabled: server.discoveryStatus === "disabled",
			});
			if (result.type !== "mcp.updated") throw new Error("Unexpected response");
		}, "启停未完成，请刷新确认状态。");
	const act = () => {
		if (!confirmation) return;
		const { server, action } = confirmation;
		void run(async () => {
			try {
				const result = await onCommand({
					type: action === "trust" ? "mcp.trust" : action === "untrust" ? "mcp.untrust" : "mcp.remove",
					workspaceId,
					serverId: server.id,
				});
				if (result.type !== "mcp.updated" && result.type !== "mcp.removed") throw new Error("Unexpected response");
				if (alive.current) {
					setConfirmation(undefined);
					if (action === "remove") setExpanded(undefined);
				}
			} catch (cause) {
				await onRefresh().catch(() => {});
				throw cause;
			}
		}, "操作未完成，配置或授权可能已保存。请检查服务依赖，并刷新确认状态。");
	};
	const connected = servers.filter((server) => statusOf(server).tone === "ready").length;
	const attention = servers.filter((server) => ["pending", "error"].includes(statusOf(server).tone)).length;
	const visible = servers.filter(
		(server) =>
			`${server.name} ${server.id} ${server.transport}`.toLowerCase().includes(query.toLowerCase()) &&
			(filter === "all" ||
				(filter === "attention" && ["pending", "error"].includes(statusOf(server).tone)) ||
				(filter === "disabled" && server.discoveryStatus === "disabled"))
	);
	const beginCreate = (mode: "form" | "import") => {
		setError(undefined);
		setEditor({ mode });
	};
	return (
		<section className="mcp-workbench" aria-label="MCP 服务">
			<div className="mcp-page">
				<header className="mcp-page-header">
					<div>
						<div className="mcp-page-title">
							<Plug size={22} />
							<h2>MCP 服务</h2>
							<span className="mcp-scope">全局与当前工作区</span>
						</div>
						<div className="mcp-overview">
							<span>{servers.length} 个服务</span>
							<span>
								<i className="mcp-ready-dot" />
								{connected} 已连接
							</span>
							{attention > 0 && (
								<span>
									<i className="mcp-attention-dot" />
									{attention} 待处理
								</span>
							)}
						</div>
					</div>
					<div className="mcp-actions">
						<button
							className="icon-button"
							title="刷新 MCP 服务"
							disabled={busy || !available}
							onClick={() => void refresh()}
						>
							<RefreshCw size={16} className={busy ? "mcp-spin" : ""} />
						</button>
						<button className="secondary-button" disabled={busy || !available} onClick={() => beginCreate("import")}>
							<Upload size={15} />
							导入 JSON
						</button>
						<button
							className="primary-button"
							aria-label="新增 MCP 服务"
							disabled={busy || !available}
							onClick={() => beginCreate("form")}
						>
							<Plus size={16} />
							新增服务
						</button>
					</div>
				</header>
				{error && !confirmation && (
					<div className="workbench-error" role="alert">
						<CircleAlert size={16} />
						{error}
					</div>
				)}
				{!available ? (
					<div className="mcp-empty">
						<Plug size={36} strokeWidth={1.3} />
						<h3>当前运行模式不支持 MCP</h3>
					</div>
				) : !servers.length ? (
					<div className="mcp-empty">
						<span className="mcp-empty-icon">
							<Plug size={34} strokeWidth={1.4} />
						</span>
						<h3>尚未添加 MCP 服务</h3>
						<div className="mcp-actions">
							<button className="primary-button" disabled={busy} onClick={() => beginCreate("form")}>
								<Plus size={16} />
								添加服务
							</button>
							<button className="secondary-button" disabled={busy} onClick={() => beginCreate("import")}>
								<Upload size={15} />从 JSON 导入
							</button>
						</div>
					</div>
				) : (
					<>
						<div className="mcp-list-toolbar">
							<div className="mcp-filters" role="group" aria-label="筛选服务">
								{[
									["all", "全部"],
									["attention", "待处理"],
									["disabled", "已停用"],
								].map(([value, label]) => (
									<button key={value} aria-pressed={filter === value} onClick={() => setFilter(value!)}>
										{label}
									</button>
								))}
							</div>
							<label className="mcp-search">
								<Search size={15} />
								<input
									type="search"
									aria-label="搜索 MCP 服务"
									placeholder="搜索服务"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
								/>
							</label>
						</div>
						<div className="mcp-server-list">
							{visible.map((server) => {
								const open = expanded === server.id;
								const detail = selectedServer?.id === server.id ? selectedServer : undefined;
								return (
									<article className={`mcp-server${open ? " is-expanded" : ""}`} key={server.id}>
										<div className="mcp-server-row">
											<button
												className="mcp-server-open"
												aria-label={`${open ? "收起" : "查看"} ${server.name}`}
												aria-expanded={open}
												aria-controls={open && detail ? `mcp-detail-${server.id}` : undefined}
												disabled={busy}
												onClick={() => {
													if (open && server.discoveryStatus !== "failed") {
														++selection.current;
														setExpanded(undefined);
														setLoading(undefined);
													} else void select(server.id);
												}}
											>
												<span className="mcp-server-icon">
													{server.transport === "stdio" ? <Terminal size={19} /> : <Globe size={19} />}
												</span>
												<span className="mcp-server-copy">
													<span className="mcp-server-name">
														<strong title={server.name}>{server.name}</strong>
														<Status server={server} />
													</span>
													<span className="mcp-server-meta">
														<span>{server.scope === "global" ? "全局" : "当前工作区"}</span>
														<span>
															{server.transport === "stdio" ? "本地进程" : server.transport === "sse" ? "SSE" : "HTTP"}
														</span>
														<span>{server.toolCount} 个工具</span>
														<span>{server.readOnly ? "只读" : "需要批准"}</span>
													</span>
												</span>
												{loading === server.id ? (
													<LoaderCircle size={16} className="mcp-spin" />
												) : open ? (
													<ChevronDown size={16} />
												) : (
													<ChevronRight size={16} />
												)}
											</button>
											<div className="mcp-row-actions">
												<button
													className="icon-button"
													title={`编辑 ${server.name}`}
													disabled={busy || !available}
													onClick={() => void edit(server.id)}
												>
													<Pencil size={15} />
												</button>
												<button
													className="mcp-switch"
													role="switch"
													aria-label={`启用 ${server.name}`}
													aria-checked={server.discoveryStatus !== "disabled"}
													disabled={busy || !available}
													onClick={() => void toggle(server)}
												>
													<span />
												</button>
											</div>
										</div>
										{open &&
											(loading === server.id ? (
												<div className="mcp-detail-loading" role="status">
													<LoaderCircle size={16} className="mcp-spin" />
													正在检查服务
												</div>
											) : (
												detail && (
													<ServerDetails
														server={detail}
														tab={tab}
														onTab={setTab}
														busy={busy}
														available={available}
														onEdit={() => void edit(server.id)}
														onRetry={() => void select(server.id, tab)}
														onAction={(action) => setConfirmation({ server, action })}
													/>
												)
											))}
									</article>
								);
							})}
						</div>
						{!visible.length && (
							<div className="mcp-detail-empty">
								<Search size={24} />
								<span>没有匹配的服务</span>
								<button
									className="secondary-button"
									onClick={() => {
										setQuery("");
										setFilter("all");
									}}
								>
									清除筛选
								</button>
							</div>
						)}
					</>
				)}
			</div>
			{editor && (
				<McpConfigDialog
					{...(editor.initial ? { initial: editor.initial } : {})}
					initialMode={editor.mode ?? "form"}
					initialScope={editor.scope ?? "global"}
					existingIds={servers.map((server) => server.id)}
					onClose={() => setEditor(undefined)}
					onSave={async (config, scope) => {
						const result = await onCommand({
							type: "mcp.configure",
							workspaceId,
							config,
							scope,
							...(editor.initial ? { previousScope: editor.scope ?? "workspace" } : {}),
						});
						if (result.type !== "mcp.updated") throw new Error("Unexpected response");
						if (alive.current) {
							setExpanded(result.server.id);
							setTab("tools");
							setFilter("all");
							setQuery("");
						}
					}}
				/>
			)}
			{confirmation && (
				<Confirmation
					{...confirmation}
					busy={busy}
					error={error}
					onClose={() => {
						setConfirmation(undefined);
						setError(undefined);
					}}
					onConfirm={act}
				/>
			)}
		</section>
	);
}

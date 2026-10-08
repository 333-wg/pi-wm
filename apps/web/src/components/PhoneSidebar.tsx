import { useState, type ReactNode } from "react";
import { Archive, ChevronDown, ChevronRight, Folder, RefreshCw, Search } from "lucide-react";
import type { SessionSummary, WorkspaceSummary } from "@wuming/protocol";

const phaseNames: Record<string, string> = {
	idle: "空闲",
	turn: "执行中",
	awaiting_approval: "等待审批",
	compaction: "整理上下文",
	retry: "重试中",
	error: "发生错误",
};

export function PhoneSidebar({
	workspaces,
	workspaceId,
	sessions,
	selectedId,
	busy,
	loading,
	loadError,
	connected,
	query,
	archived,
	onQuery,
	onArchive,
	onWorkspace,
	onRefresh,
	onSession,
	children,
}: {
	workspaces: WorkspaceSummary[];
	workspaceId: string;
	sessions: SessionSummary[];
	selectedId: string | undefined;
	busy: boolean;
	loading: boolean;
	loadError: string;
	connected: boolean;
	query: string;
	archived: boolean;
	onQuery: (query: string) => void;
	onArchive: (archived: boolean) => void;
	onWorkspace: (id: string) => void;
	onRefresh: () => void;
	onSession: (session: SessionSummary) => void;
	children: ReactNode;
}) {
	const [collapsed, setCollapsed] = useState(false);
	const filtered = sessions.filter((s) =>
		(s.name || "未命名会话").toLocaleLowerCase().includes(query.toLocaleLowerCase())
	);
	return (
		<aside className="phone-sidebar">
			{children}
			<div className="phone-projects-heading">
				<span>项目</span>
				<button
					className="phone-icon"
					aria-label="刷新会话"
					title="刷新会话"
					disabled={busy || loading || !connected || !workspaceId}
					onClick={onRefresh}
				>
					<RefreshCw size={16} aria-hidden="true" />
				</button>
			</div>
			<div className="phone-project-tree">
				{workspaces.map((workspace) => {
					const expanded = workspace.id === workspaceId && !collapsed;
					return (
						<section className={`phone-project-node ${expanded ? "expanded" : ""}`} key={workspace.id}>
							<button
								className="phone-project-row"
								aria-expanded={expanded}
								aria-controls={`phone-project-${workspace.id}`}
								title={workspace.name}
								disabled={busy || !connected}
								onClick={() => {
									if (workspace.id === workspaceId) setCollapsed(!collapsed);
									else {
										setCollapsed(false);
										onWorkspace(workspace.id);
									}
								}}
							>
								{expanded ? (
									<ChevronDown size={14} aria-hidden="true" />
								) : (
									<ChevronRight size={14} aria-hidden="true" />
								)}
								<Folder size={18} aria-hidden="true" />
								<span>{workspace.name}</span>
							</button>
							<div id={`phone-project-${workspace.id}`} className="phone-project-contents" hidden={!expanded}>
								{expanded && (
									<>
										<label className="phone-session-search">
											<Search size={15} aria-hidden="true" />
											<input
												type="search"
												aria-label="搜索会话"
												placeholder="搜索会话名称"
												title="按名称筛选最近 200 条"
												value={query}
												onChange={(e) => onQuery(e.target.value)}
											/>
										</label>
										{loading && (
											<p className="phone-session-empty" role="status">
												正在加载会话…
											</p>
										)}
										{loadError && (
											<p className="phone-session-empty" role="alert">
												会话加载失败：{loadError}，请点击上方刷新重试。
											</p>
										)}
										<nav aria-label="会话列表" aria-busy={loading}>
											{filtered.map((session) => (
												<button
													key={session.id}
													className={selectedId === session.id ? "active" : ""}
													aria-current={selectedId === session.id ? "page" : undefined}
													title={`${session.name || "未命名会话"} · ${phaseNames[session.phase] ?? session.phase}`}
													disabled={busy}
													onClick={() => onSession(session)}
												>
													<span>{session.name || "未命名会话"}</span>
													{session.phase !== "idle" && (
														<small className={`phone-session-phase ${session.phase}`}>
															{phaseNames[session.phase] ?? session.phase}
														</small>
													)}
												</button>
											))}
										</nav>
										{!loading && !loadError && !filtered.length && (
											<p className="phone-session-empty" role="status">
												{query ? "没有找到匹配的会话" : archived ? "暂无已归档会话" : "此项目暂无会话"}
											</p>
										)}
										<button
											className="phone-archive-toggle"
											aria-pressed={archived}
											disabled={busy || !connected}
											onClick={() => onArchive(!archived)}
										>
											<Archive size={14} aria-hidden="true" />
											{archived ? "返回当前聊天" : "查看归档聊天"}
										</button>
									</>
								)}
							</div>
						</section>
					);
				})}
				{!workspaces.length && <p className="phone-session-empty">暂无已授权项目</p>}
			</div>
		</aside>
	);
}

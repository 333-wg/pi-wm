import {
	ArrowRight,
	Check,
	ChevronLeft,
	ChevronRight,
	History,
	List,
	MessageSquare,
	Network,
	Pause,
	Play,
	RefreshCw,
	Search,
	Send,
	Square,
	Users,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTeam, AgentTeamSummary, Command } from "@wuming/protocol";
import { useLocale } from "../lib/locale";
import type { TeamTask } from "../lib/agent-teams";
import { AgentTeamsCanvas } from "./AgentTeamsCanvas";
import { teamText } from "./agent-teams-messages";
import leadAvatar from "../assets/agent-teams/team-lead.png";
import serverAvatar from "../assets/agent-teams/server-engineer.png";
import designAvatar from "../assets/agent-teams/ui-designer.png";
import qaAvatar from "../assets/agent-teams/qa-engineer.png";
import dataAvatar from "../assets/agent-teams/data-analyst.png";
import "./agent-teams.css";
import "./persistent-agent-teams.css";

type TeamCommand = Exclude<Extract<Command, { type: `team.${string}` }>, { type: "team.list" }>;
type Props = {
	workspaceId: string;
	connected: boolean;
	available: boolean;
	listTeams: (workspaceId: string) => Promise<AgentTeamSummary[]>;
	command: (command: TeamCommand) => Promise<AgentTeam | null>;
	onOpen: (id: string) => Promise<unknown>;
	onChat: () => void;
};
const avatars = [serverAvatar, designAvatar, qaAvatar, dataAvatar];
const templateColors = {
	green: "var(--green)",
	blue: "var(--blue)",
	amber: "var(--amber)",
	red: "var(--red)",
	purple: "#9c62bb",
	cyan: "#198c9e",
};
const emptyUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
};

export function PersistentAgentTeams({ workspaceId, connected, available, listTeams, command, onOpen, onChat }: Props) {
	const { locale } = useLocale();
	const en = locale === "en";
	const label = (zh: string, english: string) => (en ? english : zh);
	const [projectTeams, setProjectTeams] = useState<AgentTeamSummary[]>([]);
	const selectedTeam = useRef<string | undefined>(localStorage.getItem(`wuming.teamId.${workspaceId}`) ?? undefined);
	const [live, setLive] = useState<AgentTeam | null>();
	const teamId = live?.id ?? "";
	const [frame, setFrame] = useState<AgentTeam | null>(null);
	const [revision, setRevision] = useState<number>();
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState(1);
	const [selectedMember, setSelectedMember] = useState<string>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState<string>();
	const [query, setQuery] = useState("");
	const [view, setView] = useState<"lanes" | "list">("lanes");
	const [zoom, setZoom] = useState(1);
	const [recipient, setRecipient] = useState("lead");
	const [message, setMessage] = useState("");
	const generation = useRef(0);
	const refreshSequence = useRef(0);
	const refresh = useCallback(async () => {
		const epoch = generation.current;
		const sequence = ++refreshSequence.current;
		const teams = await listTeams(workspaceId);
		if (epoch !== generation.current || sequence !== refreshSequence.current) return;
		const chosen = teams.find((value) => value.id === selectedTeam.current) ?? teams[0];
		const value = chosen ? await command({ type: "team.get", teamId: chosen.id }) : null;
		if (epoch !== generation.current || sequence !== refreshSequence.current) return;
		selectedTeam.current = chosen?.id;
		if (chosen) localStorage.setItem(`wuming.teamId.${workspaceId}`, chosen.id);
		setProjectTeams(teams);
		setLive((current) =>
			!current || !value || current.id !== value.id || value.revision >= current.revision ? value : current
		);
	}, [command, listTeams, workspaceId]);
	useEffect(() => {
		if (!connected || !available) return;
		let active = true;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				await refresh();
			} catch (cause) {
				if (active) setError(String(cause));
			}
			if (active) timer = setTimeout(() => void poll(), 1000);
		};
		void poll();
		return () => {
			active = false;
			generation.current += 1;
			clearTimeout(timer);
		};
	}, [available, connected, refresh]);
	useEffect(() => {
		if (revision === undefined || !teamId) {
			setFrame(null);
			return;
		}
		let active = true;
		void command({ type: "team.get", teamId, revision })
			.then((value) => {
				if (active) setFrame(value);
			})
			.catch((cause) => {
				if (active) setError(String(cause));
			});
		return () => {
			active = false;
		};
	}, [command, revision, teamId]);
	useEffect(() => {
		if (!playing || revision === undefined || !live || frame?.revision !== revision) return;
		if (revision >= live.revision) {
			setPlaying(false);
			return;
		}
		const timer = setTimeout(() => setRevision(revision + 1), 720 / speed);
		return () => clearTimeout(timer);
	}, [playing, revision, frame?.revision, live?.revision, speed]);
	const run = async (action: TeamCommand) => {
		const epoch = ++generation.current;
		setBusy(true);
		setError("");
		try {
			const value = await command(action);
			if (epoch !== generation.current) return false;
			setLive((current) => (!current || !value || value.revision >= current.revision ? value : current));
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const team = revision === undefined ? live : frame;
	const readOnly =
		busy || !connected || projectTeams.find((value) => value.id === live?.id)?.archived || revision !== undefined;
	const canWrite = !readOnly && live?.status === "running";
	const statuses: Record<string, string> = {
		running: label("运行中", "Running"),
		completed: label("已完成", "Completed"),
		stopped: label("已停止", "Stopped"),
		pending: label("待领取", "Pending"),
		in_progress: label("执行中", "In progress"),
		failed: label("失败", "Failed"),
		idle: label("空闲", "Idle"),
		working: label("工作中", "Working"),
		awaiting_approval: label("等待审批", "Awaiting approval"),
		error: label("异常", "Error"),
		delivered: label("已投递", "Delivered"),
		cancelled: label("已取消", "Cancelled"),
	};
	const task = team?.tasks.find((value) => value.id === selected);
	const inspectedMember = team?.members.find((value) => value.id === selectedMember);
	const visibleMessages =
		team?.messages.filter(
			(value) => !inspectedMember || value.from === inspectedMember.id || value.to === inspectedMember.id
		) ?? [];
	const memberName = (id?: string) =>
		team?.members.find((value) => value.id === id)?.name ??
		(id === "user"
			? label("你", "You")
			: id === "scheduler"
				? label("调度器", "Scheduler")
				: label("未分配", "Unassigned"));
	const tasks = (team?.tasks ?? []).filter((value) =>
		`${value.title} ${value.description} ${memberName(value.owner)}`.toLowerCase().includes(query.toLowerCase())
	);
	const canvasTasks: TeamTask[] = tasks.map((value) => ({
		id: value.id,
		title: value.title,
		objective: value.description,
		status:
			value.status === "in_progress"
				? "running"
				: value.status === "pending"
					? value.dependsOn.some((id) => team?.tasks.find((item) => item.id === id)?.status !== "completed")
						? "blocked"
						: "queued"
					: value.status,
		dependsOn: value.dependsOn,
		...(value.owner ? { memberId: value.owner } : {}),
		group: team?.name ?? "",
		createdAt: value.createdAt,
		usage: emptyUsage,
		pendingApprovals: [],
		...(value.result ? { result: value.result } : {}),
	}));
	return (
		<section
			className="teams-workbench persistent-teams"
			aria-label={label("团队协作工作台", "Team collaboration workbench")}
		>
			<header className="teams-heading">
				<div>
					<Users size={22} />
					<h2>Agent Teams</h2>
					{projectTeams.length > 0 && (
						<select
							aria-label={label("项目团队", "Project teams")}
							value={selectedTeam.current ?? ""}
							disabled={busy}
							onChange={(event) => {
								generation.current += 1;
								selectedTeam.current = event.target.value;
								setLive(undefined);
								setFrame(null);
								setRevision(undefined);
								setPlaying(false);
								setSelectedMember(undefined);
								setSelected(undefined);
								setRecipient("lead");
								setMessage("");
								setError("");
								void refresh().catch((cause) => setError(String(cause)));
							}}
						>
							{projectTeams.map((value) => (
								<option key={value.id} value={value.id}>
									{value.name} · {statuses[value.status]}
								</option>
							))}
						</select>
					)}
					{team && <span>{statuses[team.status]}</span>}
				</div>
				<div>
					<span className={connected ? "teams-live connected" : "teams-live"}>
						{connected ? label("已连接", "Connected") : label("已断开", "Disconnected")}
					</span>
					<button
						type="button"
						className="icon-button"
						title={label("刷新", "Refresh")}
						aria-label={label("刷新", "Refresh")}
						disabled={!connected || !available}
						onClick={() => void refresh().catch((cause) => setError(String(cause)))}
					>
						<RefreshCw size={15} />
					</button>
					{live?.status === "running" && (
						<button type="button" disabled={!canWrite} onClick={() => void run({ type: "team.stop", teamId })}>
							<Square size={14} />
							{label("停止团队", "Stop team")}
						</button>
					)}
				</div>
			</header>
			{error && (
				<div className="persistent-team-error" role="alert">
					{error}
				</div>
			)}
			{!available ? (
				<div className="teams-empty">
					{label("当前网关未启用团队协作", "Agent Teams is unavailable on this gateway")}
				</div>
			) : live === undefined ? (
				<div className="teams-empty">{label("加载团队…", "Loading team…")}</div>
			) : live === null ? (
				<div className="teams-empty">
					<Users size={32} />
					<h3>{label("此项目暂无团队", "No teams in this project")}</h3>
					<button type="button" onClick={onChat}>
						<MessageSquare size={15} />
						{label("对话", "Chat")}
					</button>
				</div>
			) : (
				team && (
					<>
						<div className="persistent-team-objective">
							<p>{team.objective}</p>
							<span>
								{team.tasks.filter((value) => value.status === "completed").length}/{team.tasks.length}{" "}
								{label("任务", "tasks")} · {team.members.length} {label("成员", "members")} · $
								{team.members.reduce((sum, value) => sum + value.costUsd, 0).toFixed(4)}
							</span>
						</div>
						<div className="persistent-team-members">
							{team.members.map((member, index) => (
								<article
									key={member.id}
									className={`persistent-team-member member-${member.state}`}
									style={member.template ? { borderTopColor: templateColors[member.template.color] } : undefined}
								>
									<img src={member.lead ? leadAvatar : avatars[(index - 1) % avatars.length]} alt="" />
									<div>
										<button
											className="persistent-member-inspect"
											type="button"
											aria-label={`${label("查看成员", "Inspect member")} ${member.name}`}
											aria-pressed={selectedMember === member.id}
											onClick={() => {
												setSelectedMember(member.id);
												setRecipient(member.id);
											}}
										>
											<strong>{member.name}</strong>
										</button>
										<span>{statuses[team.status === "completed" ? "completed" : member.state]}</span>
										<small title={member.role}>{member.role}</small>
									</div>
									<button
										type="button"
										className="icon-button"
										aria-label={`${label("打开对话", "Open conversation")} ${member.name}`}
										title={label("打开对话", "Open conversation")}
										onClick={() => void onOpen(member.sessionId).catch((cause) => setError(String(cause)))}
									>
										<ArrowRight size={14} />
									</button>
									{member.error && (
										<p role="status" title={member.error}>
											{member.error}
										</p>
									)}
									{member.state === "error" && (
										<button
											type="button"
											disabled={!canWrite}
											onClick={() => void run({ type: "team.retry", teamId, memberId: member.id })}
										>
											<RefreshCw size={13} />
											{label("重试", "Retry")}
										</button>
									)}
								</article>
							))}
						</div>
						<div className="persistent-team-history">
							<History size={15} />
							<button
								type="button"
								className="icon-button"
								title={label("上一帧", "Previous frame")}
								aria-label={label("上一帧", "Previous frame")}
								disabled={(revision ?? live.revision) <= 1}
								onClick={() => {
									setPlaying(false);
									setRevision(Math.max(1, (revision ?? live.revision) - 1));
								}}
							>
								<ChevronLeft size={14} />
							</button>
							<button
								type="button"
								className="icon-button"
								title={playing ? label("暂停回放", "Pause replay") : label("播放回放", "Play replay")}
								aria-label={playing ? label("暂停回放", "Pause replay") : label("播放回放", "Play replay")}
								disabled={live.revision <= 1}
								onClick={() => {
									if (!playing && (revision === undefined || revision >= live.revision)) setRevision(1);
									setPlaying(!playing);
								}}
							>
								{playing ? <Pause size={14} /> : <Play size={14} />}
							</button>
							<button
								type="button"
								className="icon-button"
								title={label("下一帧", "Next frame")}
								aria-label={label("下一帧", "Next frame")}
								disabled={revision === undefined || revision >= live.revision}
								onClick={() => {
									setPlaying(false);
									setRevision(Math.min(live.revision, (revision ?? live.revision) + 1));
								}}
							>
								<ChevronRight size={14} />
							</button>
							<select
								aria-label={label("回放速度", "Replay speed")}
								value={speed}
								onChange={(event) => setSpeed(Number(event.target.value))}
							>
								{[0.5, 1, 2, 4].map((value) => (
									<option key={value} value={value}>
										{value}x
									</option>
								))}
							</select>
							<span>{revision === undefined ? label("实时", "Live") : `#${revision}`}</span>
							<input
								type="range"
								aria-label={label("历史版本", "History revision")}
								min={1}
								max={live.revision}
								value={revision ?? live.revision}
								onChange={(event) => {
									setPlaying(false);
									setRevision(Number(event.target.value));
								}}
							/>
							<span>{new Date(team.updatedAt).toLocaleTimeString()}</span>
							{revision !== undefined && (
								<button
									type="button"
									onClick={() => {
										setPlaying(false);
										setRevision(undefined);
									}}
								>
									{label("回到实时", "Back to live")}
								</button>
							)}
						</div>
						<div className="persistent-team-content">
							<div className="persistent-team-board">
								<div className="persistent-team-toolbar">
									<label>
										<Search size={14} />
										<input
											aria-label={label("搜索任务", "Search tasks")}
											placeholder={label("搜索任务", "Search tasks")}
											value={query}
											onChange={(event) => setQuery(event.target.value)}
										/>
									</label>
									<button
										type="button"
										className="icon-button"
										title={label("依赖泳道", "Dependency lanes")}
										aria-label={label("依赖泳道", "Dependency lanes")}
										aria-pressed={view === "lanes"}
										onClick={() => setView("lanes")}
									>
										<Network size={15} />
									</button>
									<button
										type="button"
										className="icon-button"
										title={label("任务列表", "Task list")}
										aria-label={label("任务列表", "Task list")}
										aria-pressed={view === "list"}
										onClick={() => setView("list")}
									>
										<List size={15} />
									</button>
									<button
										type="button"
										className="icon-button"
										title={label("缩小", "Zoom out")}
										aria-label={label("缩小", "Zoom out")}
										disabled={zoom <= 0.6}
										onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))}
									>
										<ZoomOut size={15} />
									</button>
									<button
										type="button"
										className="icon-button"
										title={label("放大", "Zoom in")}
										aria-label={label("放大", "Zoom in")}
										disabled={zoom >= 1.4}
										onClick={() => setZoom((value) => Math.min(1.4, value + 0.1))}
									>
										<ZoomIn size={15} />
									</button>
								</div>
								{tasks.length === 0 ? (
									<div className="teams-empty">{label("暂无任务", "No tasks")}</div>
								) : view === "lanes" ? (
									<AgentTeamsCanvas
										tasks={canvasTasks}
										members={team.members.map(({ model, ...value }) => ({
											...value,
											status: value.state,
											...(model ? { model: `${model.provider}/${model.id}` } : {}),
										}))}
										selected={selected}
										onSelect={setSelected}
										zoom={zoom}
										t={teamText(locale)}
									/>
								) : (
									<div className="persistent-team-task-list">
										{tasks.map((value) => (
											<button
												type="button"
												key={value.id}
												aria-pressed={selected === value.id}
												onClick={() => setSelected(value.id)}
											>
												<strong>{value.title}</strong>
												<span>{memberName(value.owner)}</span>
												<span>{statuses[value.status]}</span>
											</button>
										))}
									</div>
								)}
								{task && (
									<section className="persistent-team-detail">
										<h3>{task.title}</h3>
										<p>{task.description}</p>
										<dl>
											<dt>{label("负责人", "Owner")}</dt>
											<dd>{memberName(task.owner)}</dd>
											<dt>{label("写入范围", "Write scope")}</dt>
											<dd>{task.writePaths.join(", ") || "—"}</dd>
											<dt>{label("前置任务", "Dependencies")}</dt>
											<dd>
												{task.dependsOn
													.map((id) => team.tasks.find((value) => value.id === id)?.title ?? id)
													.join(", ") || "—"}
											</dd>
										</dl>
										{task.result && <pre>{task.result}</pre>}
									</section>
								)}
								{team.result && (
									<section className="persistent-team-detail">
										<h3>
											<Check size={16} />
											{label("负责人验收", "Lead acceptance")}
										</h3>
										<pre>{team.result}</pre>
									</section>
								)}
							</div>
							<aside className="persistent-team-mailbox">
								{inspectedMember && (
									<section className="persistent-member-detail" aria-label={label("成员详情", "Member details")}>
										<header>
											<h3>{inspectedMember.name}</h3>
											<button
												type="button"
												className="icon-button"
												title={label("关闭成员详情", "Close member details")}
												aria-label={label("关闭成员详情", "Close member details")}
												onClick={() => setSelectedMember(undefined)}
											>
												<X size={14} />
											</button>
										</header>
										<p>{inspectedMember.role}</p>
										{inspectedMember.error && <p role="status">{inspectedMember.error}</p>}
										<dl>
											{inspectedMember.template && (
												<>
													<dt>{label("模板", "Template")}</dt>
													<dd>
														{inspectedMember.template.name} · #{inspectedMember.template.revision}
													</dd>
												</>
											)}
											{inspectedMember.model && (
												<>
													<dt>{label("模型", "Model")}</dt>
													<dd>
														{inspectedMember.model.provider}/{inspectedMember.model.id}
													</dd>
												</>
											)}
											{inspectedMember.thinkingLevel && (
												<>
													<dt>{label("思考", "Effort")}</dt>
													<dd>{inspectedMember.thinkingLevel}</dd>
												</>
											)}
											{inspectedMember.template && (
												<>
													<dt>{label("业务工具", "Domain tools")}</dt>
													<dd>
														{inspectedMember.template.tools.mode === "custom"
															? inspectedMember.template.tools.names.join(", ")
															: inspectedMember.template.tools.mode === "none"
																? label("无", "None")
																: label("全部", "All")}
													</dd>
												</>
											)}
											<dt>{label("状态", "State")}</dt>
											<dd>{statuses[team.status === "completed" ? "completed" : inspectedMember.state]}</dd>
											<dt>Tokens</dt>
											<dd>{inspectedMember.totalTokens.toLocaleString()}</dd>
											<dt>{label("费用", "Cost")}</dt>
											<dd>${inspectedMember.costUsd.toFixed(4)}</dd>
										</dl>
										<ul>
											{team.tasks
												.filter((value) => value.owner === inspectedMember.id)
												.map((value) => (
													<li key={value.id}>
														<button type="button" onClick={() => setSelected(value.id)}>
															{value.title}
															<span>{statuses[value.status]}</span>
														</button>
													</li>
												))}
										</ul>
									</section>
								)}
								<h3>
									<MessageSquare size={16} />
									{label("通信流", "Communication")}
								</h3>
								<div className="persistent-team-messages">
									{visibleMessages.length === 0 && <p className="teams-muted">{label("暂无消息", "No messages")}</p>}
									{visibleMessages.map((value) => (
										<article key={value.id} data-message-id={value.id}>
											<header>
												<strong>
													{memberName(value.from)} → {memberName(value.to)}
												</strong>
												<time>{new Date(value.createdAt).toLocaleTimeString()}</time>
											</header>
											<p>{value.text}</p>
											<span>
												{value.delivery === "pending" ? label("待投递", "Pending delivery") : statuses[value.delivery]}
											</span>
										</article>
									))}
								</div>
								<form
									onSubmit={(event) => {
										event.preventDefault();
										void run({ type: "team.message", teamId, recipient, text: message }).then((ok) => {
											if (ok) setMessage("");
										});
									}}
								>
									<select
										aria-label={label("收件人", "Recipient")}
										disabled={!canWrite}
										value={recipient}
										onChange={(event) => setRecipient(event.target.value)}
									>
										{team.members.map((value) => (
											<option key={value.id} value={value.id}>
												{value.name}
											</option>
										))}
										<option value="all">{label("全体成员", "All members")}</option>
									</select>
									<textarea
										rows={2}
										aria-label={label("团队消息", "Team message")}
										value={message}
										onChange={(event) => setMessage(event.target.value)}
										maxLength={20000}
										disabled={!canWrite}
									/>
									<button
										type="submit"
										disabled={!canWrite || !message.trim()}
										title={label("发送消息", "Send message")}
										aria-label={label("发送消息", "Send message")}
									>
										<Send size={15} />
									</button>
								</form>
							</aside>
						</div>
					</>
				)
			)}
		</section>
	);
}

import {
	ArrowRight,
	ChevronLeft,
	ChevronRight,
	History,
	List,
	Network,
	Pause,
	Play,
	RefreshCw,
	Search,
	Send,
	SlidersHorizontal,
	Square,
	Users,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTeam, AgentTeamMember, AgentTeamSummary, Command, ModelMetadata, ModelRef } from "@wuming/protocol";
import { useLocale } from "../lib/locale";
import { memberProblem, modelKey, readableTeamMessage, teamObjective } from "../lib/team-studio";
import { TeamStudioCanvas } from "./TeamStudioCanvas";
import { TeamModelDialog, TeamModelPicker } from "./TeamModelControls";
import "./agent-teams.css";
import "./persistent-agent-teams.css";
import "./team-studio.css";

type TeamCommand = Exclude<Extract<Command, { type: `team.${string}` }>, { type: "team.list" }>;
type Props = {
	workspaceId: string;
	connected: boolean;
	available: boolean;
	models: ModelMetadata[];
	listTeams: (workspaceId: string) => Promise<AgentTeamSummary[]>;
	command: (command: TeamCommand) => Promise<AgentTeam | null>;
	onOpen: (id: string) => Promise<unknown>;
	onChat: () => void;
};
export function PersistentAgentTeams({
	workspaceId,
	connected,
	available,
	models,
	listTeams,
	command,
	onOpen,
	onChat,
}: Props) {
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
	const [historyOpen, setHistoryOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [rawMessages, setRawMessages] = useState(false);
	const [importantOnly, setImportantOnly] = useState(false);
	const [messageMember, setMessageMember] = useState("");
	const [mobilePanel, setMobilePanel] = useState<"flow" | "messages">("flow");
	const [choices, setChoices] = useState<Record<string, ModelRef>>({});
	const [mailWidth, setMailWidth] = useState(32);
	const section = useRef<HTMLElement>(null);
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
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (selected) {
					setSelected(undefined);
					e.preventDefault();
				} else if (selectedMember) {
					setSelectedMember(undefined);
					e.preventDefault();
				}
			}
		};

		if (selected || selectedMember) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [selected, selectedMember]);
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
	const canExecute = canWrite && !live?.modelPolicy?.awaitingConfiguration;
	const statuses: Record<string, string> = {
		running: label("运行中", "Running"),
		completed: label("已完成", "Completed"),
		stopped: label("已停止", "Stopped"),
		pending: label("待开始", "Pending"),
		in_progress: label("进行中", "In progress"),
		failed: label("失败", "Failed"),
		idle: label("等待任务", "Idle"),
		working: label("工作中", "Working"),
		awaiting_model: label("待选模型", "Choose model"),
		awaiting_approval: label("等待审批", "Awaiting approval"),
		error: label("需要处理", "Needs attention"),
		delivered: label("已投递", "Delivered"),
		cancelled: label("已取消", "Cancelled"),
	};
	const task = team?.tasks.find((value) => value.id === selected);
	const inspectedMember = team?.members.find((value) => value.id === selectedMember);
	const leader = team?.members.find((value) => value.lead);
	const pending = team?.status === "running" ? team.members.filter((member) => member.state === "awaiting_model") : [];
	const memberName = (id?: string) => {
		const member = team?.members.find((value) => value.id === id);
		return member
			? member.lead
				? label("负责人", "Leader")
				: member.name
			: id === "user"
				? label("你", "You")
				: id === "scheduler"
					? label("团队动态", "Team activity")
					: label("未分配", "Unassigned");
	};
	const modelName = (model?: ModelRef) =>
		models.find((value) => modelKey(value.model) === modelKey(model))?.name ?? model?.id ?? "—";
	const tasks = (team?.tasks ?? []).filter((value) =>
		`${value.title} ${value.description} ${memberName(value.owner)}`.toLowerCase().includes(query.toLowerCase())
	);
	const visibleMessages =
		team?.messages.filter(
			(value) =>
				(!messageMember || value.from === messageMember || value.to === messageMember) &&
				(!importantOnly || value.kind !== "message")
		) ?? [];
	const chosenModel = (member: AgentTeamMember) =>
		choices[member.id] ?? member.pendingModel ?? member.model ?? leader?.pendingModel ?? leader?.model;
	const assign = (members: AgentTeamMember[]) => {
		const assignments = members.flatMap((member) => {
			const model = chosenModel(member);
			return model ? [{ memberId: member.id, model }] : [];
		});
		if (assignments.length !== members.length || !assignments.length) return;
		void run({ type: "team.models.assign", teamId, expectedVersion: live?.modelPolicy?.version ?? 0, assignments });
	};
	const usable = (member: AgentTeamMember) =>
		models.some((entry) => entry.authenticated && modelKey(entry.model) === modelKey(chosenModel(member)));
	const assignment = (member: AgentTeamMember) => (
		<div className="studio-assignment-controls">
			<TeamModelPicker
				models={models}
				value={chosenModel(member)}
				onChange={(model) => setChoices((current) => ({ ...current, [member.id]: model }))}
				disabled={!canExecute}
				label={`${label("成员模型", "Member model")} ${member.name}`}
			/>
			<small>{label("确认前不会调用该成员模型", "No member model calls before confirmation")}</small>
			<button className="teams-primary" disabled={!canExecute || !usable(member)} onClick={() => assign([member])}>
				{label("确认并启动", "Confirm and start")}
				<ArrowRight size={13} />
			</button>
		</div>
	);
	const switchTeam = (id: string) => {
		generation.current++;
		selectedTeam.current = id;
		setLive(undefined);
		setFrame(null);
		setRevision(undefined);
		setPlaying(false);
		setSelectedMember(undefined);
		setSelected(undefined);
		setRecipient("lead");
		setMessage("");
		setError("");
		setSettingsOpen(false);
		setChoices({});
		setMessageMember("");
		setQuery("");
		void refresh().catch((cause) => setError(String(cause)));
	};
	return (
		<section
			ref={section}
			className="teams-workbench persistent-teams team-studio"
			aria-label={label("团队协作工作台", "Team collaboration workbench")}
		>
			<header className="teams-heading">
				<div>
					<Users size={18} />
					<span className="studio-eyebrow">Agent Teams</span>
					{projectTeams.length > 0 && (
						<select
							aria-label={label("项目团队", "Project teams")}
							value={selectedTeam.current ?? ""}
							disabled={busy}
							onChange={(event) => switchTeam(event.target.value)}
						>
							{projectTeams.map((value) => (
								<option key={value.id} value={value.id}>
									{value.name} · {statuses[value.status]}
								</option>
							))}
						</select>
					)}
				</div>
				<div>
					{team && (
						<>
							<button disabled={!canWrite} onClick={() => setSettingsOpen(true)}>
								<SlidersHorizontal size={15} />
								{team.modelPolicy?.mode === "manual"
									? label("自主选择", "Manual models")
									: label("模型分配", "Model assignment")}
							</button>
							<button aria-pressed={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>
								<History size={15} />
								{label("历史回放", "History")}
							</button>
						</>
					)}
					<button
						className="icon-button"
						aria-label={label("刷新", "Refresh")}
						disabled={!connected || !available || busy}
						onClick={() => void refresh().catch((cause) => setError(String(cause)))}
					>
						<RefreshCw size={15} />
					</button>
					{live?.status === "running" && (
						<button disabled={!canWrite} onClick={() => void run({ type: "team.stop", teamId })}>
							<Square size={13} />
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
				<div className="teams-empty">{label("当前网关未启用团队协作", "Agent Teams is unavailable")}</div>
			) : live === undefined ? (
				<div className="teams-empty">{label("加载团队…", "Loading team…")}</div>
			) : !team ? (
				<div className="teams-empty">
					<Users size={32} />
					<h3>{label("从对话开启团队协作", "Start a team from a conversation")}</h3>
					<p>
						{label(
							"在对话中选择 team 技能并描述目标，Leader 会根据任务创建成员。",
							"Select the team skill and describe your objective. The Leader creates members as needed."
						)}
					</p>
					<button onClick={onChat}>
						{label("前往对话", "Go to chat")}
						<ArrowRight size={15} />
					</button>
				</div>
			) : (
				<>
					<div className="studio-title">
						<div>
							<h2 title={team.name}>{team.name}</h2>
							<span className="studio-state">
								<i data-active={team.status === "running" && !team.modelPolicy?.awaitingConfiguration} />
								{team.modelPolicy?.awaitingConfiguration
									? label("等待选择模型分配方式", "Choose model assignment")
									: statuses[team.status]}
								{pending.length > 0 && ` · ${pending.length} ${label("位成员待分配模型", "members need models")}`}
							</span>
						</div>
						<span className="studio-progress">
							{team.tasks.filter((value) => value.status === "completed").length}
							<small>
								/{team.tasks.length} {label("项已完成", "completed")}
							</small>
						</span>
					</div>
					<div className="persistent-team-objective">
						<details className="persistent-team-objective-copy" key={team.id}>
							<summary>
								<strong>{label("团队目标", "Team objective")}</strong>
								<span>{teamObjective(team.objective)}</span>
							</summary>
							<p>{teamObjective(team.objective)}</p>
						</details>
						<span>
							{team.members.length} {label("位成员", "members")} · $
							{team.members.reduce((sum, value) => sum + value.costUsd, 0).toFixed(4)}
						</span>
					</div>
					{team.result && (
						<details className="studio-team-result">
							<summary>{label("团队交付结果", "Team deliverable")}</summary>
							<p>{team.result}</p>
						</details>
					)}
					{historyOpen && (
						<div className="persistent-team-history">
							<History size={15} />
							<button
								aria-label={label("上一帧", "Previous frame")}
								disabled={(revision ?? live!.revision) <= 1}
								onClick={() => {
									setPlaying(false);
									setRevision(Math.max(1, (revision ?? live!.revision) - 1));
								}}
							>
								<ChevronLeft size={14} />
							</button>
							<button
								aria-label={label(playing ? "暂停回放" : "播放回放", playing ? "Pause replay" : "Play replay")}
								disabled={live!.revision <= 1}
								onClick={() => {
									if (!playing && (revision === undefined || revision >= live!.revision)) setRevision(1);
									setPlaying(!playing);
								}}
							>
								{playing ? <Pause size={14} /> : <Play size={14} />}
							</button>
							<button
								aria-label={label("下一帧", "Next frame")}
								disabled={revision === undefined || revision >= live!.revision}
								onClick={() => {
									setPlaying(false);
									setRevision(Math.min(live!.revision, (revision ?? live!.revision) + 1));
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
								max={live!.revision}
								value={revision ?? live!.revision}
								onChange={(event) => {
									setPlaying(false);
									setRevision(Number(event.target.value));
								}}
							/>
							{revision !== undefined && (
								<button
									onClick={() => {
										setPlaying(false);
										setRevision(undefined);
									}}
								>
									{label("回到实时", "Back to live")}
								</button>
							)}
						</div>
					)}
					{revision !== undefined && (
						<div className="studio-replay-note">
							{label(
								"正在查看历史记录，模型设置和发送消息已禁用。",
								"Viewing history. Model changes and messages are disabled."
							)}
						</div>
					)}
					<nav className="studio-mobile-tabs">
						<button aria-pressed={mobilePanel === "flow"} onClick={() => setMobilePanel("flow")}>
							{label("任务流程", "Task flow")}
						</button>
						<button aria-pressed={mobilePanel === "messages"} onClick={() => setMobilePanel("messages")}>
							{label("通信流", "Activity")}
						</button>
					</nav>
					<div
						className="persistent-team-content"
						data-panel={mobilePanel}
						style={{ gridTemplateColumns: `minmax(0,1fr) 8px minmax(260px,${mailWidth}%)` }}
					>
						<div className="persistent-team-board">
							<div className="persistent-team-toolbar">
								<button
									aria-label={label("依赖泳道", "Dependency lanes")}
									aria-pressed={view === "lanes"}
									onClick={() => setView("lanes")}
								>
									<Network size={15} />
									{label("流程", "Flow")}
								</button>
								<button
									aria-label={label("任务列表", "Task list")}
									aria-pressed={view === "list"}
									onClick={() => setView("list")}
								>
									<List size={15} />
									{label("列表", "List")}
								</button>
								<label>
									<Search size={14} />
									<input
										aria-label={label("搜索任务", "Search tasks")}
										placeholder={label("搜索任务或成员", "Search tasks or members")}
										value={query}
										onChange={(event) => setQuery(event.target.value)}
									/>
								</label>
							</div>
							{pending.length > 0 && (
								<div className="studio-pending-banner">
									<span>
										<i />
										{pending.length} {label("位新成员待选模型", "new members need models")}
									</span>
									<button disabled={!canExecute || !pending.every(usable)} onClick={() => assign(pending)}>
										{label(`启动这 ${pending.length} 位成员`, `Start ${pending.length} members`)}
										<ArrowRight size={13} />
									</button>
								</div>
							)}
							{!team.tasks.length && !pending.length ? (
								<div className="studio-start-state">
									<span className="team-avatar">L</span>
									<h3>{label("负责人 Leader", "Leader")}</h3>
									<p>
										{team.modelPolicy?.awaitingConfiguration
											? label("选择分配方式后开始分析任务", "Choose a model policy to begin")
											: team.status === "running"
												? label("正在准备任务，成员将按需加入", "Preparing tasks. Members will join as needed.")
												: statuses[team.status]}
									</p>
									<small>{modelName(leader?.pendingModel ?? leader?.model)}</small>
									{leader?.error && <p className="persistent-team-error">{memberProblem(leader.error, en)}</p>}
								</div>
							) : view === "lanes" ? (
								<TeamStudioCanvas
									key={team.id}
									team={team}
									query={query}
									selected={selected}
									onSelect={(id) => {
										setSelected(id);
										setSelectedMember(undefined);
										setMobilePanel("messages");
									}}
									renderAssignment={assignment}
								/>
							) : (
								<div className="persistent-team-task-list">
									{pending.map((member) => (
										<article className="studio-list-assignment" key={member.id}>
											<strong>{member.name}</strong>
											<p>{member.role}</p>
											{assignment(member)}
										</article>
									))}
									{tasks.map((value) => (
										<button
											key={value.id}
											aria-pressed={selected === value.id}
											onClick={() => {
												setSelected(value.id);
												setSelectedMember(undefined);
												setMobilePanel("messages");
											}}
										>
											<strong>{value.title}</strong>
											<span>{memberName(value.owner)}</span>
											<span>{statuses[value.status]}</span>
										</button>
									))}
								</div>
							)}
						</div>
						<div
							className="studio-resizer"
							role="separator"
							aria-label={label("调整通信流宽度", "Resize activity panel")}
							aria-orientation="vertical"
							aria-valuemin={26}
							aria-valuemax={48}
							aria-valuenow={mailWidth}
							tabIndex={0}
							onKeyDown={(event) => {
								if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
									event.preventDefault();
									setMailWidth((value) => Math.max(26, Math.min(48, value + (event.key === "ArrowLeft" ? 2 : -2))));
								}
							}}
							onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
							onPointerMove={(event) => {
								if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
								const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
								setMailWidth(Math.max(26, Math.min(48, ((bounds.right - event.clientX) / bounds.width) * 100)));
							}}
							onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
						/>
						<aside className="persistent-team-mailbox">
							{task ? (
								<section className="persistent-team-detail" aria-label={label("任务详情", "Task details")}>
									<header>
										<h3>{task.title}</h3>
										<button aria-label={label("关闭", "Close")} onClick={() => setSelected(undefined)}>
											<X size={15} />
										</button>
									</header>
									<p>{task.description}</p>
									<dl>
										<dt>{label("负责人", "Owner")}</dt>
										<dd>{memberName(task.owner)}</dd>
										<dt>{label("状态", "Status")}</dt>
										<dd>{statuses[task.status]}</dd>
										<dt>{label("写入范围", "Write scope")}</dt>
										<dd>{task.writePaths.join(", ") || "—"}</dd>
										<dt>{label("前置任务", "Dependencies")}</dt>
										<dd>
											{task.dependsOn
												.map((id) => team.tasks.find((value) => value.id === id)?.title ?? id)
												.join(", ") || "—"}
										</dd>
									</dl>
									{task.result && (
										<>
											<h4>{label("交付结果", "Result")}</h4>
											<p>{task.result}</p>
										</>
									)}
								</section>
							) : inspectedMember ? (
								<section className="persistent-member-detail" aria-label={label("成员详情", "Member details")}>
									<header>
										<h3>{memberName(inspectedMember.id)}</h3>
										<button aria-label={label("关闭", "Close")} onClick={() => setSelectedMember(undefined)}>
											<X size={15} />
										</button>
									</header>
									<p>{inspectedMember.role}</p>
									<dl>
										<dt>{label("状态", "Status")}</dt>
										<dd>{statuses[inspectedMember.state]}</dd>
										<dt>{label("当前模型", "Current model")}</dt>
										<dd>{modelName(inspectedMember.model)}</dd>
										{inspectedMember.pendingModel && (
											<>
												<dt>{label("下一轮", "Next turn")}</dt>
												<dd>{modelName(inspectedMember.pendingModel)}</dd>
											</>
										)}
										<dt>Tokens</dt>
										<dd>{inspectedMember.totalTokens.toLocaleString()}</dd>
										<dt>{label("费用", "Cost")}</dt>
										<dd>${inspectedMember.costUsd.toFixed(4)}</dd>
									</dl>
									{inspectedMember.error && (
										<p className="persistent-team-error">{memberProblem(inspectedMember.error, en)}</p>
									)}
									{canExecute && team.modelPolicy?.mode === "manual" && (
										<div className="studio-member-model">
											<TeamModelPicker
												models={models}
												value={chosenModel(inspectedMember)}
												onChange={(model) => setChoices((current) => ({ ...current, [inspectedMember.id]: model }))}
												label={label("调整成员模型", "Change member model")}
											/>
											<button disabled={!usable(inspectedMember)} onClick={() => assign([inspectedMember])}>
												{inspectedMember.state === "awaiting_model"
													? label("确认并启动", "Confirm and start")
													: label("下一轮使用", "Apply next turn")}
											</button>
										</div>
									)}
									{inspectedMember.template && (
										<details>
											<summary>{label("角色模板", "Role template")}</summary>
											<p>
												{inspectedMember.template.name} · {inspectedMember.template.scope} · #
												{inspectedMember.template.revision}
											</p>
											<p>{inspectedMember.template.systemPrompt}</p>
										</details>
									)}
									<button
										disabled={
											inspectedMember.state === "awaiting_model" || Boolean(team.modelPolicy?.awaitingConfiguration)
										}
										onClick={() => void onOpen(inspectedMember.sessionId).catch((cause) => setError(String(cause)))}
									>
										{label("打开对话", "Open conversation")}
										<ArrowRight size={14} />
									</button>
									<ul>
										{team.tasks
											.filter((value) => value.owner === inspectedMember.id)
											.map((value) => (
												<li key={value.id}>
													<button onClick={() => setSelected(value.id)}>
														{value.title}
														<span>{statuses[value.status]}</span>
													</button>
												</li>
											))}
									</ul>
								</section>
							) : null}
							{!task && (
								<>
									<div className="studio-feed-heading">
										<h3>
											{label("团队动态", "Team activity")}
											<i />
										</h3>
										<div>
											<button aria-pressed={!rawMessages} onClick={() => setRawMessages(false)}>
												{label("简洁", "Simple")}
											</button>
											<button aria-pressed={rawMessages} onClick={() => setRawMessages(true)}>
												{label("原始消息", "Original")}
											</button>
										</div>
									</div>
									<div className="studio-feed-filters">
										<select
											aria-label={label("筛选成员", "Filter member")}
											value={messageMember}
											onChange={(event) => setMessageMember(event.target.value)}
										>
											<option value="">{label("全部成员", "All members")}</option>
											{team.members.map((member) => (
												<option key={member.id} value={member.id}>
													{memberName(member.id)}
												</option>
											))}
										</select>
										<label>
											<input
												type="checkbox"
												checked={importantOnly}
												onChange={(event) => setImportantOnly(event.target.checked)}
											/>
											{label("只看任务事件", "Task events")}
										</label>
									</div>
									<div className="persistent-team-messages">
										{!visibleMessages.length && (
											<p className="teams-muted">
												{team.modelPolicy?.awaitingConfiguration
													? label("准备开始，等待选择模型分配方式。", "Ready when you choose the model policy.")
													: label("暂无通信记录", "No messages yet")}
											</p>
										)}
										{visibleMessages.map((value) => (
											<article key={value.id} data-message-id={value.id}>
												<span className="team-avatar">{memberName(value.from).slice(0, 1).toUpperCase()}</span>
												<div>
													<header>
														<strong>
															{memberName(value.from)} → {memberName(value.to)}
														</strong>
														<time>
															{new Date(value.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
														</time>
													</header>
													<p className={rawMessages ? "" : "studio-message-summary"}>
														{rawMessages ? value.text : readableTeamMessage(value, team, en)}
													</p>
													{value.taskId && team.tasks.some((task) => task.id === value.taskId) && (
														<button
															className="studio-result-link"
															onClick={() => {
																setSelected(value.taskId);
																setSelectedMember(undefined);
															}}
														>
															{label("查看任务与结果", "View task and result")} →
														</button>
													)}
													{!rawMessages && (
														<details>
															<summary>{label("展开原文", "Original message")}</summary>
															<p>{value.text}</p>
														</details>
													)}
													<small>
														{value.delivery === "pending"
															? label("待投递", "Pending delivery")
															: (statuses[value.delivery] ?? value.delivery)}
													</small>
												</div>
											</article>
										))}
									</div>
								</>
							)}
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
									disabled={!canExecute}
									value={recipient}
									onChange={(event) => setRecipient(event.target.value)}
								>
									{team.members.map((member) => (
										<option key={member.id} value={member.id}>
											{memberName(member.id)}
										</option>
									))}
									<option value="all">{label("全体成员", "All members")}</option>
								</select>
								<textarea
									aria-label={label("团队消息", "Team message")}
									placeholder={
										canExecute
											? label("补充要求或调整方向…", "Add requirements or adjust direction…")
											: label("当前状态不可发送", "Messages unavailable in this state")
									}
									rows={2}
									maxLength={20000}
									value={message}
									disabled={!canExecute}
									onChange={(event) => setMessage(event.target.value)}
								/>
								<button
									className="teams-primary"
									aria-label={label("发送消息", "Send message")}
									disabled={!canExecute || !message.trim()}
								>
									<Send size={16} />
								</button>
							</form>
						</aside>
					</div>
					<div className="persistent-team-members" aria-label={label("团队成员", "Team members")}>
						{team.members.map((member) => (
							<article key={member.id} className={`persistent-team-member member-${member.state}`}>
								<span className="team-avatar">{member.lead ? "L" : member.name.slice(0, 1).toUpperCase()}</span>
								<div>
									<button
										className="persistent-member-inspect"
										aria-label={`${label("查看成员", "Inspect member")} ${member.name}`}
										aria-pressed={selectedMember === member.id}
										onClick={() => {
											setSelected(undefined);
											setSelectedMember(member.id);
											setRecipient(member.id);
											setMobilePanel("messages");
										}}
									>
										<strong>{memberName(member.id)}</strong>
									</button>
									<button
										className="studio-model-chip"
										title={
											member.pendingModel
												? `${label("下一轮", "Next turn")}: ${modelName(member.pendingModel)}`
												: modelName(member.model)
										}
										disabled={!canWrite}
										onClick={() => {
											if (member.lead || team.modelPolicy?.mode !== "manual") setSettingsOpen(true);
											else {
												setSelected(undefined);
												setSelectedMember(member.id);
												setMobilePanel("messages");
											}
										}}
									>
										{member.state === "awaiting_model"
											? label("分配模型", "Assign model")
											: modelName(member.pendingModel ?? member.model)}
										{member.pendingModel ? ` · ${label("待生效", "Pending")}` : " ▾"}
									</button>
									<small>{team.status === "completed" ? label("已结束", "Finished") : statuses[member.state]}</small>
								</div>
								{member.state === "error" && (
									<button
										disabled={!canExecute}
										title={member.error}
										onClick={() => void run({ type: "team.retry", teamId, memberId: member.id })}
									>
										<RefreshCw size={12} />
										{label("重试", "Retry")}
									</button>
								)}
							</article>
						))}
					</div>
				</>
			)}
			{live &&
				revision === undefined &&
				live.status === "running" &&
				(settingsOpen || live.modelPolicy?.awaitingConfiguration) && (
					<TeamModelDialog
						key={live.id}
						team={live}
						models={models}
						busy={busy}
						error={error}
						onClose={() => {
							setSettingsOpen(false);
							if (live.modelPolicy?.awaitingConfiguration) onChat();
						}}
						onSave={async (mode, leaderModel, expectedVersion) => {
							const ok = await run({
								type: "team.models.configure",
								teamId: live.id,
								mode,
								leaderModel,
								expectedVersion,
							});
							if (ok) setSettingsOpen(false);
							return ok;
						}}
					/>
				)}
		</section>
	);
}

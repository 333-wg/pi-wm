import {
	ArrowRight,
	Check,
	ChevronRight,
	GitBranch,
	List,
	Maximize,
	MessageSquare,
	Network,
	Pause,
	Play,
	Plus,
	Radio,
	RefreshCw,
	Search,
	Square,
	Users,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { GoalPlanSpec, GoalSummary, SessionSnapshot, SubagentSummary } from "@wuming/protocol";
import {
	buildTeamFrame,
	teamTaskState,
	type TeamFrame,
	type TeamMessage,
	type TeamTaskState,
} from "../lib/agent-teams";
import { useLocale } from "../lib/locale";
import { useFocusTrap } from "../use-focus-trap";
import { GoalPlanEditor, newGoalPlan } from "./GoalPlan";
import { ApprovalPanel } from "./ApprovalPanel";
import { AgentTeamsCanvas, TeamStatus } from "./AgentTeamsCanvas";
import { teamText, type TeamText } from "./agent-teams-messages";
import leadAvatar from "../assets/agent-teams/team-lead.png";
import serverAvatar from "../assets/agent-teams/server-engineer.png";
import designAvatar from "../assets/agent-teams/ui-designer.png";
import qaAvatar from "../assets/agent-teams/qa-engineer.png";
import dataAvatar from "../assets/agent-teams/data-analyst.png";
import "./agent-teams.css";

type Props = {
	snapshot: SessionSnapshot;
	subagents: SubagentSummary[];
	goals: GoalSummary[];
	connected: boolean;
	canCreate: boolean;
	canPlan: boolean;
	onCreateMember: (input: { name?: string; task: string }) => Promise<SubagentSummary>;
	onCreatePlan: (input: { title?: string; objective: string; plan: GoalPlanSpec }) => Promise<GoalSummary>;
	onStartPlan: (id: string) => Promise<unknown>;
	onStopPlan: (id: string) => Promise<unknown>;
	onStopMember: (id: string) => Promise<unknown>;
	onOpen: (id: string) => Promise<unknown>;
	onRefresh: () => Promise<unknown>;
	onApprove: (sessionId: string, approvalId: string, decision: "approve" | "deny") => Promise<void>;
};
const avatars = [serverAvatar, designAvatar, qaAvatar, dataAvatar];
const accents = ["var(--blue)", "var(--amber)", "var(--green)", "var(--tok-keyword)"];
const active = new Set(["queued", "running", "awaiting_approval", "cancelling"]);
const clock = (time: number) =>
	new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function CreateTeamDialog({
	mode,
	disabled,
	t,
	onClose,
	onMember,
	onPlan,
}: {
	mode: "member" | "plan";
	disabled: boolean;
	t: TeamText;
	onClose: () => void;
	onMember: Props["onCreateMember"];
	onPlan: Props["onCreatePlan"];
}) {
	const ref = useFocusTrap<HTMLDivElement>();
	const [name, setName] = useState("");
	const [objective, setObjective] = useState("");
	const [plan, setPlan] = useState(newGoalPlan);
	const [busy, setBusy] = useState(false);
	const pending = useRef(false);
	const [error, setError] = useState<string>();
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (disabled || pending.current || !objective.trim() || !name.trim()) return;
		pending.current = true;
		setBusy(true);
		setError(undefined);
		try {
			if (mode === "member") await onMember({ name: name.trim(), task: objective.trim() });
			else await onPlan({ title: name.trim(), objective: objective.trim(), plan });
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	};
	return (
		<div className="teams-modal-backdrop">
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t(mode === "member" ? "add" : "plan")}
				className="teams-modal"
				ref={ref}
				onKeyDown={(event) => {
					if (event.key === "Escape" && !busy) {
						event.stopPropagation();
						onClose();
					}
				}}
			>
				<header>
					<h2>{t(mode === "member" ? "add" : "plan")}</h2>
					<button
						type="button"
						className="icon-button"
						disabled={busy}
						title={t("close")}
						aria-label={t("close")}
						onClick={onClose}
					>
						<X size={18} />
					</button>
				</header>
				<form onSubmit={(event) => void submit(event)}>
					<fieldset disabled={disabled || busy} className="teams-form-fields">
						<label>
							{t(mode === "member" ? "name" : "planName")}
							<input required maxLength={500} value={name} onChange={(event) => setName(event.target.value)} />
						</label>
						<label>
							{t("objective")}
							<textarea
								required
								maxLength={20000}
								rows={3}
								value={objective}
								onChange={(event) => setObjective(event.target.value)}
							/>
						</label>
						{mode === "plan" && <GoalPlanEditor value={plan} onChange={setPlan} disabled={disabled || busy} />}
					</fieldset>
					{error && (
						<p className="teams-error" role="alert">
							{error}
						</p>
					)}
					<footer>
						<button type="button" disabled={busy} onClick={onClose}>
							{t("cancel")}
						</button>
						<button
							className="teams-primary"
							type="submit"
							disabled={disabled || busy || !name.trim() || !objective.trim()}
						>
							{busy ? <RefreshCw size={14} className="spin" /> : <Plus size={14} />}
							{t(mode === "member" ? "run" : "create")}
						</button>
					</footer>
				</form>
			</div>
		</div>
	);
}

export function AgentTeamsWorkbench(props: Props) {
	const { snapshot, subagents, goals, connected } = props;
	const { locale } = useLocale();
	const t = teamText(locale);
	const live = useMemo(() => buildTeamFrame(snapshot, subagents, goals), [snapshot, subagents, goals]);
	const [history, setHistory] = useState<Array<{ at: number; frame: TeamFrame }>>([]);
	const signature = useRef("");
	const [replay, setReplay] = useState<{ at: number; frame: TeamFrame }>();
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState(1);
	const [selectedTask, setSelectedTask] = useState<string>();
	const [selectedMember, setSelectedMember] = useState<string>();
	const [planId, setPlanId] = useState("");
	const [filter, setFilter] = useState<TeamTaskState | "all">("all");
	const [query, setQuery] = useState("");
	const [view, setView] = useState<"lanes" | "list">("lanes");
	const [zoom, setZoom] = useState(1);
	const [feedOpen, setFeedOpen] = useState(false);
	const [messageKind, setMessageKind] = useState<TeamMessage["kind"] | "all">("all");
	const [messageMember, setMessageMember] = useState("");
	const [dialog, setDialog] = useState<"member" | "plan">();
	const [busy, setBusy] = useState(false);
	const pending = useRef(false);
	const [error, setError] = useState<string>();
	const frame = replay?.frame ?? live;
	const readonly = !connected || Boolean(replay) || snapshot.session.archivedAt !== undefined;
	useEffect(() => {
		if (replay) return;
		const next = JSON.stringify(live);
		if (next === signature.current) return;
		signature.current = next;
		setHistory((current) => [...current.slice(-79), { at: Date.now(), frame: live }]);
	}, [live, replay]);
	useEffect(() => {
		if (!playing || !replay) return;
		const index = history.indexOf(replay);
		const next = history[index + 1];
		if (!next) {
			setPlaying(false);
			return;
		}
		const timer = setTimeout(() => setReplay(next), 1000 / speed);
		return () => clearTimeout(timer);
	}, [history, playing, replay, speed]);
	const perform = async (action: () => Promise<unknown>) => {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setError(undefined);
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	};
	const selectTask = (id: string) => {
		setSelectedTask(id);
		setSelectedMember(undefined);
		setFeedOpen(false);
	};
	const task = frame.tasks.find((entry) => entry.id === selectedTask);
	const member = frame.members.find((entry) => entry.id === selectedMember);
	const memberTasks = member ? frame.tasks.filter((entry) => entry.memberId === member.id) : [];
	const scoped = frame.tasks.filter((entry) => !planId || entry.goalId === planId);
	const search = query.trim().toLocaleLowerCase();
	const visible = scoped.filter(
		(entry) =>
			(filter === "all" || teamTaskState(entry.status) === filter) &&
			(!search ||
				`${entry.title} ${entry.objective} ${entry.group} ${frame.members.find((candidate) => candidate.id === entry.memberId)?.name ?? ""}`
					.toLocaleLowerCase()
					.includes(search))
	);
	const counts = { all: scoped.length, waiting: 0, running: 0, completed: 0, attention: 0 };
	for (const entry of scoped) counts[teamTaskState(entry.status)]++;
	const selectedGoal = goals.find((goal) => goal.id === planId);
	const messageLabels = {
		dispatch: "dispatch",
		result: "messageResult",
		error: "error",
		approval: "approval",
	} as const;
	const scopedIds = new Set(scoped.map((entry) => entry.id));
	const messages = frame.messages.filter(
		(message) =>
			scopedIds.has(message.taskId) &&
			(messageKind === "all" || message.kind === messageKind) &&
			(!messageMember || message.memberId === messageMember)
	);
	const inspectorOpen = Boolean(task || member || feedOpen);
	const resultMember = task ? frame.members.find((entry) => entry.id === task.memberId) : undefined;

	return (
		<section className="teams-workbench" aria-label={locale === "en" ? "Conversation subtasks" : "对话子任务"}>
			<header className="teams-heading">
				<div>
					<Network size={21} />
					<div>
						<h2>{locale === "en" ? "Conversation subtasks" : "对话子任务"}</h2>
						<span>{t("subtitle")}</span>
					</div>
				</div>
				<div className="teams-heading-actions">
					<span className={`teams-live ${connected && !replay ? "connected" : ""}`}>
						<Radio size={13} />
						{replay ? t("replay") : connected ? t("live") : t("offline")}
					</span>
					<button
						type="button"
						className="icon-button"
						disabled={!connected || busy}
						title={t("refresh")}
						aria-label={t("refresh")}
						onClick={() => void perform(props.onRefresh)}
					>
						<RefreshCw size={15} className={busy ? "spin" : ""} />
					</button>
					<button type="button" disabled={readonly || !props.canPlan} onClick={() => setDialog("plan")}>
						<GitBranch size={14} />
						{t("plan")}
					</button>
					<button
						type="button"
						className="teams-primary"
						disabled={readonly || !props.canCreate}
						onClick={() => setDialog("member")}
					>
						<Plus size={14} />
						{t("add")}
					</button>
				</div>
			</header>
			{error && (
				<p className="teams-error" role="alert">
					{error}
				</p>
			)}
			{(replay || snapshot.session.archivedAt !== undefined) && (
				<div className="teams-readonly" role="status">
					{t(replay ? "readonly" : "archived")}
				</div>
			)}
			<div className={`teams-body ${inspectorOpen ? "with-inspector" : ""}`}>
				<div className="teams-main">
					<section className="teams-formation" aria-label={t("members")}>
						<div className="teams-section-heading">
							<h3>
								<Users size={14} />
								{t("members")} <span>{frame.members.length}</span>
							</h3>
							<span>
								{counts.completed}/{counts.all} {t("completed")}
							</span>
						</div>
						<div className="teams-members">
							{frame.members.map((entry, index) => {
								const owned = frame.tasks.filter((candidate) => candidate.memberId === entry.id);
								const completed = owned.filter((candidate) => candidate.status === "completed").length;
								return (
									<button
										type="button"
										className={`teams-member ${entry.lead ? "is-lead" : ""} ${selectedMember === entry.id ? "selected" : ""}`}
										key={entry.id}
										style={
											{
												"--member-accent": entry.lead ? "var(--green)" : accents[(index - 1) % accents.length],
											} as CSSProperties
										}
										aria-pressed={selectedMember === entry.id}
										onClick={() => {
											setSelectedMember(entry.id);
											setSelectedTask(undefined);
											setFeedOpen(false);
										}}
									>
										<img src={entry.lead ? leadAvatar : avatars[(index - 1) % avatars.length]} alt="" />
										<span className="teams-member-copy">
											<small>{entry.lead ? t("lead") : `AGENT ${String(index).padStart(2, "0")}`}</small>
											<strong title={entry.name}>{entry.name}</strong>
											<span>
												{entry.lead
													? t(entry.status === "idle" ? "idle" : "working")
													: t(entry.status as Parameters<TeamText>[0])}
											</span>
										</span>
										<span className="teams-member-progress">
											<span style={{ width: `${owned.length ? (completed / owned.length) * 100 : 0}%` }} />
										</span>
									</button>
								);
							})}
						</div>
					</section>
					<div className="teams-toolbar">
						<label className="teams-search">
							<Search size={14} />
							<input
								type="search"
								aria-label={t("search")}
								placeholder={t("search")}
								value={query}
								onChange={(event) => setQuery(event.target.value)}
							/>
						</label>
						<select aria-label={t("selectPlan")} value={planId} onChange={(event) => setPlanId(event.target.value)}>
							<option value="">{t("allPlans")}</option>
							{goals.map((goal) => (
								<option key={goal.id} value={goal.id}>
									{goal.title}
								</option>
							))}
						</select>
						{selectedGoal && !replay && (
							<button
								type="button"
								disabled={readonly || busy || (selectedGoal.status !== "pending" && !active.has(selectedGoal.status))}
								onClick={() =>
									void perform(() =>
										selectedGoal.status === "pending"
											? props.onStartPlan(selectedGoal.id)
											: props.onStopPlan(selectedGoal.id)
									)
								}
							>
								{selectedGoal.status === "pending" ? <Play size={13} /> : <Square size={13} />}
								{t(selectedGoal.status === "pending" ? "start" : "stopPlan")}
							</button>
						)}
						<button
							type="button"
							aria-pressed={feedOpen}
							onClick={() => {
								setFeedOpen(!feedOpen);
								setSelectedTask(undefined);
								setSelectedMember(undefined);
							}}
						>
							<MessageSquare size={14} />
							{t("communication")} <span>{frame.messages.length}</span>
						</button>
					</div>
					<div className="teams-filters">
						<div role="group" aria-label={t("tasks")}>
							{(["all", "waiting", "running", "completed", "attention"] as const).map((state) => (
								<button
									type="button"
									key={state}
									aria-pressed={filter === state}
									className={`state-${state}`}
									onClick={() => setFilter(state)}
								>
									{t(state)}
									<span>{counts[state]}</span>
								</button>
							))}
						</div>
						<div className="teams-view-controls">
							<button
								type="button"
								className="icon-button"
								title={t("lanes")}
								aria-label={t("lanes")}
								aria-pressed={view === "lanes"}
								onClick={() => setView("lanes")}
							>
								<Network size={15} />
							</button>
							<button
								type="button"
								className="icon-button"
								title={t("list")}
								aria-label={t("list")}
								aria-pressed={view === "list"}
								onClick={() => setView("list")}
							>
								<List size={15} />
							</button>
							{view === "lanes" && (
								<>
									<button
										type="button"
										className="icon-button"
										title={t("zoomOut")}
										aria-label={t("zoomOut")}
										disabled={zoom <= 0.5}
										onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}
									>
										<ZoomOut size={15} />
									</button>
									<button
										type="button"
										className="icon-button"
										title={t("resetZoom")}
										aria-label={t("resetZoom")}
										onClick={() => setZoom(1)}
									>
										<Maximize size={15} />
									</button>
									<button
										type="button"
										className="icon-button"
										title={t("zoomIn")}
										aria-label={t("zoomIn")}
										disabled={zoom >= 1.5}
										onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}
									>
										<ZoomIn size={15} />
									</button>
								</>
							)}
						</div>
					</div>
					{visible.length === 0 ? (
						<div className="teams-empty">
							<Network size={32} />
							<h3>{t(frame.tasks.length ? "noMatches" : "empty")}</h3>
							{!frame.tasks.length && (
								<button type="button" disabled={readonly || !props.canPlan} onClick={() => setDialog("plan")}>
									<Plus size={14} />
									{t("plan")}
								</button>
							)}
						</div>
					) : view === "lanes" ? (
						<AgentTeamsCanvas
							tasks={visible}
							members={frame.members}
							selected={selectedTask}
							onSelect={selectTask}
							zoom={zoom}
							t={t}
						/>
					) : (
						<div className="teams-task-list" role="list" aria-label={t("list")}>
							{visible.map((entry) => (
								<button
									type="button"
									role="listitem"
									key={entry.id}
									className={selectedTask === entry.id ? "selected" : ""}
									onClick={() => selectTask(entry.id)}
								>
									<span>
										<strong>{entry.title}</strong>
										<small>{entry.objective}</small>
									</span>
									<TeamStatus task={entry} t={t} />
									<ChevronRight size={14} />
								</button>
							))}
						</div>
					)}
				</div>
				{inspectorOpen && (
					<aside
						className="teams-inspector"
						aria-label={t(feedOpen ? "communication" : task ? "details" : "memberDetails")}
					>
						<header>
							<h3>{t(feedOpen ? "communication" : task ? "details" : "memberDetails")}</h3>
							<button
								type="button"
								className="icon-button"
								title={t("close")}
								aria-label={t("close")}
								onClick={() => {
									setSelectedTask(undefined);
									setSelectedMember(undefined);
									setFeedOpen(false);
								}}
							>
								<X size={16} />
							</button>
						</header>
						<div className="teams-inspector-scroll">
							{feedOpen && (
								<>
									<div className="teams-feed-filters">
										<select
											aria-label={t("allMembers")}
											value={messageMember}
											onChange={(event) => setMessageMember(event.target.value)}
										>
											<option value="">{t("allMembers")}</option>
											{frame.members
												.filter((entry) => !entry.lead)
												.map((entry) => (
													<option key={entry.id} value={entry.id}>
														{entry.name}
													</option>
												))}
										</select>
										<select
											aria-label={t("allMessages")}
											value={messageKind}
											onChange={(event) => setMessageKind(event.target.value as typeof messageKind)}
										>
											<option value="all">{t("allMessages")}</option>
											{Object.entries(messageLabels).map(([key, label]) => (
												<option key={key} value={key}>
													{t(label)}
												</option>
											))}
										</select>
									</div>
									{messages.length === 0 && <p className="teams-muted">{t("noMessages")}</p>}
									<ol className="teams-feed">
										{messages.map((message) => (
											<li key={message.id} className={`kind-${message.kind}`}>
												<div>
													<span>{t(messageLabels[message.kind])}</span>
													<time dateTime={new Date(message.timestamp).toISOString()}>{clock(message.timestamp)}</time>
												</div>
												<strong>
													{message.kind === "dispatch"
														? t("lead")
														: frame.members.find((entry) => entry.id === message.memberId)?.name}
													<ArrowRight size={12} />
													{message.kind === "dispatch"
														? frame.members.find((entry) => entry.id === message.memberId)?.name
														: t("lead")}
												</strong>
												<details>
													<summary>{message.text.slice(0, 100) || t("emptyResult")}</summary>
													<pre>{message.text || t("emptyResult")}</pre>
												</details>
												<button type="button" onClick={() => selectTask(message.taskId)}>
													{t("details")}
													<ChevronRight size={12} />
												</button>
											</li>
										))}
									</ol>
								</>
							)}
							{member && (
								<>
									<img
										className="teams-inspector-avatar"
										alt=""
										src={
											member.lead
												? leadAvatar
												: avatars[Math.max(0, frame.members.indexOf(member) - 1) % avatars.length]
										}
									/>
									<h4>{member.name}</h4>
									<p className="teams-muted">
										{member.lead ? t("lead") : "Agent"}
										{member.model ? ` · ${member.model}` : ""}
									</p>
									<button
										type="button"
										disabled={!connected || busy}
										onClick={() => void perform(() => props.onOpen(member.sessionId))}
									>
										<MessageSquare size={14} />
										{t("open")}
									</button>
									<h5>{t("tasks")}</h5>
									{memberTasks.length === 0 && <p className="teams-muted">{t("noMemberTasks")}</p>}
									{memberTasks.map((entry) => (
										<button
											className="teams-member-task"
											type="button"
											key={entry.id}
											onClick={() => selectTask(entry.id)}
										>
											<span>{entry.title}</span>
											<TeamStatus task={entry} t={t} />
										</button>
									))}
								</>
							)}
							{task && (
								<>
									<TeamStatus task={task} t={t} />
									<h4>{task.title}</h4>
									<p className="teams-muted">
										{resultMember?.name ?? t("unassigned")}
										{task.group ? ` · ${task.group}` : ""}
									</p>
									<p className="teams-objective">{task.objective}</p>
									<div className="teams-detail-actions">
										{task.sessionId && (
											<button
												type="button"
												disabled={!connected || busy}
												onClick={() => void perform(() => props.onOpen(task.sessionId!))}
											>
												<MessageSquare size={14} />
												{t("open")}
											</button>
										)}
										{task.subagentId && active.has(task.status) && (
											<button
												type="button"
												disabled={readonly || busy}
												onClick={() => void perform(() => props.onStopMember(task.subagentId!))}
											>
												<Square size={13} />
												{t("stop")}
											</button>
										)}
										{task.goalId && (
											<button
												type="button"
												onClick={() => {
													setPlanId(task.goalId!);
													setSelectedTask(undefined);
												}}
											>
												{t("taskScope")}
												<ArrowRight size={13} />
											</button>
										)}
									</div>
									{task.dependsOn.length > 0 && (
										<>
											<h5>{t("dependencies")}</h5>
											{task.dependsOn.map((id) => {
												const dependency = frame.tasks.find((entry) => entry.id === id);
												return (
													<button
														className="teams-dependency"
														type="button"
														key={id}
														disabled={!dependency}
														onClick={() => selectTask(id)}
													>
														{dependency?.status === "completed" ? <Check size={13} /> : <GitBranch size={13} />}
														{dependency?.title ?? id}
													</button>
												);
											})}
										</>
									)}
									<dl className="teams-metrics">
										<div>
											<dt>{t("tokens")}</dt>
											<dd>{task.usage.totalTokens.toLocaleString()}</dd>
										</div>
										<div>
											<dt>{t("cost")}</dt>
											<dd>${task.usage.costUsd.toFixed(4)}</dd>
										</div>
										{task.startedAt !== undefined && task.finishedAt !== undefined && (
											<div>
												<dt>{t("elapsed")}</dt>
												<dd>{Math.max(0, (task.finishedAt - task.startedAt) / 1000).toFixed(1)}s</dd>
											</div>
										)}
									</dl>
									{!readonly &&
										task.pendingApprovals.map((approval) => (
											<ApprovalPanel
												key={approval.id}
												approval={approval}
												onRespond={(decision) => props.onApprove(approval.sessionId, approval.id, decision)}
											/>
										))}
									{task.error && <p className="teams-error">{task.error}</p>}
									<h5>{t("result")}</h5>
									<pre className="teams-result">{task.result ?? t("noResult")}</pre>
								</>
							)}
						</div>
					</aside>
				)}
			</div>
			<footer className="teams-timeline">
				<button
					type="button"
					className="icon-button"
					title={t(playing ? "pause" : "play")}
					aria-label={t(playing ? "pause" : "play")}
					disabled={history.length < 2}
					onClick={() => {
						if (playing) setPlaying(false);
						else {
							if (!replay || history.indexOf(replay) === history.length - 1) setReplay(history[0]);
							setPlaying(true);
						}
					}}
				>
					{playing ? <Pause size={14} /> : <Play size={14} />}
				</button>
				<span>{t("history")}</span>
				<input
					type="range"
					aria-label={t("history")}
					min={0}
					max={Math.max(0, history.length - 1)}
					value={replay ? Math.max(0, history.indexOf(replay)) : Math.max(0, history.length - 1)}
					disabled={history.length < 2}
					onChange={(event) => {
						setPlaying(false);
						setReplay(history[Number(event.target.value)]);
					}}
				/>
				<time>{clock(replay?.at ?? history.at(-1)?.at ?? Date.now())}</time>
				<select aria-label={t("replay")} value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
					{[0.5, 1, 2, 4].map((value) => (
						<option key={value} value={value}>
							{value}x
						</option>
					))}
				</select>
				<button
					type="button"
					aria-pressed={!replay}
					onClick={() => {
						setReplay(undefined);
						setPlaying(false);
					}}
				>
					<Radio size={13} />
					{t("live")}
				</button>
			</footer>
			{dialog && (
				<CreateTeamDialog
					mode={dialog}
					disabled={readonly}
					t={t}
					onClose={() => setDialog(undefined)}
					onMember={props.onCreateMember}
					onPlan={async (input) => {
						const goal = await props.onCreatePlan(input);
						setPlanId(goal.id);
						setFilter("all");
						setQuery("");
						return goal;
					}}
				/>
			)}
		</section>
	);
}

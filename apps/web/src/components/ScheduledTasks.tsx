import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
	CalendarClock,
	Plus,
	Play,
	Pause,
	Power,
	Pencil,
	Trash2,
	History,
	X,
	RefreshCw,
	ShieldAlert,
	ExternalLink,
} from "lucide-react";
import {
	validateCalendarSchedule,
	type AutomationRunSummary,
	type AutomationSchedule,
	type Command,
	type CommandResult,
	type GoalAutomationSummary,
	type ModelMetadata,
	type ScheduledTaskInput,
	type WorkspaceSummary,
} from "@wuming/protocol";
import { CalendarScheduleEditor, SchedulePreview, scheduleLabel } from "./AutomationScheduleEditor";

type Request = (
	command: Extract<Command, { type: `scheduled.${string}` }>,
	idempotencyKey?: string
) => Promise<CommandResult>;
type Props = {
	request: Request;
	workspaces: WorkspaceSummary[];
	models: ModelMetadata[];
	connected: boolean;
	onOpenSession: (id: string) => Promise<void>;
};
const formatTime = (time?: number) =>
	time === undefined ? "--" : new Date(time).toLocaleString("zh-CN", { hour12: false });
const runLabels: Record<string, string> = {
	dispatching: "正在分派",
	pending: "待执行",
	queued: "排队中",
	running: "运行中",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
	cancelling: "取消中",
	paused: "已暂停",
	awaiting_approval: "等待审批",
};
const terminal = new Set(["completed", "failed", "cancelled"]);

function Modal({
	title,
	children,
	onClose,
	busy = false,
}: {
	title: string;
	children: ReactNode;
	onClose: () => void;
	busy?: boolean;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current!;
		dialog.showModal();
		return () => dialog.close();
	}, []);
	return createPortal(
		<dialog
			className="scheduled-modal"
			ref={ref}
			aria-label={title}
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
		>
			<header>
				<h2>{title}</h2>
				<button type="button" className="icon-button" title="关闭" aria-label="关闭" disabled={busy} onClick={onClose}>
					<X size={18} />
				</button>
			</header>
			{children}
		</dialog>,
		document.body
	);
}

function TaskForm({
	task,
	models,
	workspaces,
	request,
	onClose,
	onSaved,
}: Pick<Props, "models" | "workspaces" | "request"> & {
	task?: GoalAutomationSummary;
	onClose: () => void;
	onSaved: () => void;
}) {
	const usableModels = models.filter((model) => model.authenticated);
	const [title, setTitle] = useState(task?.title ?? "");
	const [description, setDescription] = useState(task?.execution?.description ?? "");
	const [objective, setObjective] = useState(task?.objective ?? "");
	const [workspaceId, setWorkspaceId] = useState(
		task?.execution?.workspaceId ?? workspaces.find((item) => item.status === "ready")?.id ?? ""
	);
	const modelKey = (model: { provider: string; id: string }) => JSON.stringify([model.provider, model.id]);
	const [selectedModel, setSelectedModel] = useState(
		task?.execution ? modelKey(task.execution.model) : usableModels[0] ? modelKey(usableModels[0].model) : ""
	);
	const [schedule, setSchedule] = useState<AutomationSchedule>(
		task?.schedule ?? {
			kind: "calendar",
			frequency: "daily",
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			hour: 9,
			minute: 0,
		}
	);
	const [busy, setBusy] = useState(false);
	const pending = useRef(false);
	const [error, setError] = useState("");
	const retry = useRef<{ payload: string; key: string } | undefined>(undefined);
	useEffect(() => {
		if (!task && !selectedModel && models.some((item) => item.authenticated)) {
			const available = models.find((item) => item.authenticated)!;
			setSelectedModel(JSON.stringify([available.model.provider, available.model.id]));
		}
	}, [task, models, selectedModel]);
	useEffect(() => {
		if (!task && !workspaceId) setWorkspaceId(workspaces.find((item) => item.status === "ready")?.id ?? "");
	}, [task, workspaces, workspaceId]);
	const model = usableModels.find((item) => modelKey(item.model) === selectedModel);
	const workspace = workspaces.find((item) => item.id === workspaceId && item.status === "ready");
	const kind = schedule.kind === "calendar" ? "calendar" : schedule.kind;
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (pending.current || !model || !workspace) return;
		try {
			if (schedule.kind === "calendar") validateCalendarSchedule(schedule);
			if (
				schedule.kind === "interval" &&
				(!Number.isSafeInteger(schedule.everyMinutes) ||
					schedule.everyMinutes < 1 ||
					schedule.everyMinutes > 525600 ||
					!Number.isFinite(schedule.startsAt))
			)
				throw new Error("请填写有效的间隔和开始时间");
			if (schedule.kind === "once" && (!Number.isFinite(schedule.runAt) || schedule.runAt <= Date.now()))
				throw new Error("请选择未来的运行时间");
			if (!title.trim() || !description.trim() || !objective.trim()) throw new Error("请填写名称、描述和提示词");
			const input: ScheduledTaskInput = {
				title: title.trim(),
				objective: objective.trim(),
				schedule,
				execution: {
					description: description.trim(),
					workspaceId,
					model: model.model,
					permission: "full_access",
					missedRuns: "skip",
				},
			};
			const command = task
				? { type: "scheduled.update" as const, automationId: task.id, expectedUpdatedAt: task.updatedAt, input }
				: { type: "scheduled.create" as const, input };
			const payload = JSON.stringify(command);
			if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
			pending.current = true;
			setBusy(true);
			setError("");
			await request(command, retry.current.key);
			onSaved();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	};
	const localTime = (value: number) =>
		Number.isFinite(value)
			? new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
			: "";
	return (
		<Modal title={task ? "编辑定时任务" : "新建定时任务"} onClose={onClose} busy={busy}>
			<form onSubmit={(event) => void submit(event)} className="scheduled-form">
				<fieldset disabled={busy}>
					<label>
						名称
						<input
							required
							maxLength={500}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							autoFocus
						/>
					</label>
					<label>
						描述
						<input
							required
							maxLength={2000}
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</label>
					<label>
						提示词
						<textarea
							required
							rows={5}
							maxLength={20000}
							value={objective}
							onChange={(event) => setObjective(event.target.value)}
						/>
					</label>
					<div className="scheduled-form-row">
						<label>
							模型
							<select required value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
								<option value="" disabled>
									选择模型
								</option>
								{usableModels.map((item) => (
									<option key={modelKey(item.model)} value={modelKey(item.model)}>
										{item.name} · {item.model.provider}
									</option>
								))}
							</select>
						</label>
						<label>
							工作项目
							<select required value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
								<option value="" disabled>
									选择项目
								</option>
								{workspaces
									.filter((item) => item.status === "ready")
									.map((item) => (
										<option key={item.id} value={item.id}>
											{item.name === "Local workspace" ? "本地工作区" : item.name}
										</option>
									))}
							</select>
						</label>
					</div>
					<div className="scheduled-permission">
						<ShieldAlert size={16} />
						<span>
							所有权限（固定） · 不逐次审批
							<br />
							<small>工作项目：{workspace?.name ?? "未选择"}。工作目录不是安全隔离边界。</small>
						</span>
					</div>
					<label>
						执行方式
						<select
							value={kind}
							onChange={(event) =>
								setSchedule(
									event.target.value === "calendar"
										? {
												kind: "calendar",
												frequency: "daily",
												timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
												hour: 9,
												minute: 0,
											}
										: event.target.value === "interval"
											? {
													kind: "interval",
													everyMinutes: 60,
													startsAt: Math.ceil((Date.now() + 60000) / 60000) * 60000,
												}
											: { kind: "once", runAt: Math.ceil((Date.now() + 60000) / 60000) * 60000 }
								)
							}
						>
							<option value="calendar">日历日程</option>
							<option value="interval">固定间隔</option>
							<option value="once">一次性</option>
						</select>
					</label>
					{schedule.kind === "calendar" ? (
						<CalendarScheduleEditor value={schedule} onChange={setSchedule} disabled={busy} />
					) : (
						<>
							{schedule.kind === "interval" && (
								<label>
									间隔（分钟）
									<input
										type="number"
										required
										min={1}
										max={525600}
										value={schedule.everyMinutes}
										onChange={(event) => setSchedule({ ...schedule, everyMinutes: Number(event.target.value) })}
									/>
								</label>
							)}
							<label>
								{schedule.kind === "once" ? "运行时间" : "开始时间"}
								<input
									type="datetime-local"
									required
									value={localTime(schedule.kind === "once" ? schedule.runAt : schedule.startsAt)}
									onChange={(event) =>
										setSchedule(
											schedule.kind === "once"
												? { ...schedule, runAt: new Date(event.target.value).getTime() }
												: { ...schedule, startsAt: new Date(event.target.value).getTime() }
										)
									}
								/>
							</label>
						</>
					)}
					<SchedulePreview schedule={schedule} />
				</fieldset>
				{(!model || !workspace) && <p role="alert">{!model ? "请先添加并验证模型" : "请选择可用项目"}</p>}
				{error && (
					<p className="scheduled-error" role="alert">
						{error}
					</p>
				)}
				<footer>
					<button type="button" onClick={onClose} disabled={busy}>
						取消
					</button>
					<button className="scheduled-primary" type="submit" disabled={busy || !model || !workspace}>
						{busy ? "正在保存..." : task ? "保存修改" : "创建任务"}
					</button>
				</footer>
			</form>
		</Modal>
	);
}

function RunLog({
	task,
	request,
	onClose,
	onOpenSession,
}: {
	task: GoalAutomationSummary;
	request: Request;
	onClose: () => void;
	onOpenSession: Props["onOpenSession"];
}) {
	const [runs, setRuns] = useState<AutomationRunSummary[]>([]);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		let stopped = false,
			inFlight = false;
		const refresh = async () => {
			if (inFlight) return;
			inFlight = true;
			try {
				const result = await request({ type: "scheduled.run.list", automationId: task.id });
				if (!stopped && result.type === "automation.run.list") {
					setRuns(result.runs);
					setError("");
				}
			} catch (cause) {
				if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				inFlight = false;
				if (!stopped) setLoading(false);
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 1500);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [request, task.id]);
	return (
		<Modal title={task.title + " · 执行日志"} onClose={onClose}>
			<div className="scheduled-logs">
				{error && <p role="alert">{error}</p>}
				{runs.length === 0 && <p>{loading ? "正在读取..." : "暂无执行记录"}</p>}
				{runs.map((run) => (
					<article className="scheduled-run" key={run.id}>
						<header>
							<strong>{runLabels[run.status] ?? run.status}</strong>
							<span>{run.trigger === "manual" ? "手动执行" : "定时执行"}</span>
						</header>
						<p>
							{formatTime(run.triggeredAt)} ·{" "}
							{run.finishedAt === undefined
								? terminal.has(run.status)
									? "--"
									: "执行中"
								: Math.max(0, Math.round((run.finishedAt - run.triggeredAt) / 1000)) + " 秒"}
						</p>
						{run.error && <p className="scheduled-error">{run.error}</p>}
						{run.result && (
							<details>
								<summary>摘要</summary>
								<pre>{run.result}</pre>
							</details>
						)}
						{run.runSessionId && (
							<button
								onClick={() =>
									void onOpenSession(run.runSessionId!)
										.then(onClose)
										.catch((cause) => setError(String(cause)))
								}
							>
								<ExternalLink size={14} />
								查看完整对话
							</button>
						)}
					</article>
				))}
			</div>
		</Modal>
	);
}

export function ScheduledTasks(props: Props) {
	const { request, connected } = props;
	const [tasks, setTasks] = useState<GoalAutomationSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [form, setForm] = useState<GoalAutomationSummary | "new">();
	const [logs, setLogs] = useState<GoalAutomationSummary>();
	const [deleting, setDeleting] = useState<GoalAutomationSummary>();
	const [busy, setBusy] = useState<string>();
	const generation = useRef(0);
	const refresh = useCallback(async () => {
		const revision = ++generation.current;
		try {
			const collected: GoalAutomationSummary[] = [];
			for (let offset = 0; ; offset += 100) {
				const result = await request({ type: "scheduled.list", offset, limit: 100 });
				if (result.type !== "scheduled.list") throw new Error("定时任务读取失败");
				collected.push(...result.tasks);
				if (collected.length >= result.total || result.tasks.length === 0) break;
			}
			if (revision === generation.current) setTasks(collected);
		} catch (cause) {
			if (revision === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (revision === generation.current) setLoading(false);
		}
	}, [request]);
	useEffect(() => {
		if (!connected) return;
		void refresh();
		const timer = setInterval(() => void refresh(), 5000);
		return () => {
			++generation.current;
			clearInterval(timer);
		};
	}, [connected, refresh]);
	const act = async (task: GoalAutomationSummary, action: "run" | "toggle" | "delete") => {
		if (busy) return;
		setBusy(task.id);
		setError("");
		try {
			if (action === "delete") {
				await request({ type: "scheduled.delete", automationId: task.id, expectedUpdatedAt: task.updatedAt });
				setDeleting(undefined);
			} else if (action === "toggle")
				await request({ type: "scheduled.set_enabled", automationId: task.id, enabled: task.status !== "active" });
			else {
				await request({ type: "scheduled.trigger", automationId: task.id });
				setLogs(task);
			}
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(undefined);
		}
	};
	return (
		<section className="scheduled-tasks" aria-label="定时任务">
			<header className="scheduled-heading">
				<div>
					<h1>定时任务</h1>
					<span>
						总任务 {tasks.length} · 活跃 {tasks.filter((task) => task.status === "active").length} · 已禁用{" "}
						{tasks.filter((task) => task.status === "paused").length}
					</span>
				</div>
				<div>
					<button
						className="icon-button"
						title="刷新任务"
						aria-label="刷新任务"
						disabled={!connected}
						onClick={() => {
							setError("");
							void refresh();
						}}
					>
						<RefreshCw size={16} />
					</button>
					<button className="scheduled-primary" disabled={!connected} onClick={() => setForm("new")}>
						<Plus size={16} />
						新建任务
					</button>
				</div>
			</header>
			<p className="scheduled-notice">
				仅在本地服务运行且电脑唤醒时执行。退出、关机或休眠期间错过的计划不会补跑。任务固定使用所有权限。
			</p>
			{error && (
				<p role="alert" className="scheduled-error">
					{error}
				</p>
			)}
			{!connected && <p role="status">服务未连接</p>}
			<div className="scheduled-list">
				{tasks.map((task) => (
					<article className="scheduled-task" key={task.id}>
						<header>
							<CalendarClock size={20} />
							<h2>{task.title}</h2>
							<span className={task.status === "active" ? "scheduled-active" : ""}>
								{task.status === "active" ? "活跃" : task.status === "completed" ? "已结束" : "已禁用"}
							</span>
						</header>
						<p>{task.execution?.description}</p>
						<dl>
							<div>
								<dt>日程</dt>
								<dd>{scheduleLabel(task.schedule)}</dd>
							</div>
							<div>
								<dt>模型</dt>
								<dd>
									{task.execution?.model.provider} / {task.execution?.model.id}
								</dd>
							</div>
							<div>
								<dt>项目</dt>
								<dd>
									{props.workspaces.find((item) => item.id === task.execution?.workspaceId)?.name ??
										task.execution?.workspaceId}
								</dd>
							</div>
							<div>
								<dt>下次执行</dt>
								<dd>{task.status === "paused" ? "已禁用" : formatTime(task.nextRunAt)}</dd>
							</div>
						</dl>
						<footer>
							<button disabled={!connected || !!busy} onClick={() => void act(task, "run")}>
								<Play size={14} />
								立即执行
							</button>
							<button onClick={() => setLogs(task)}>
								<History size={14} />
								日志
							</button>
							<button title="编辑" aria-label="编辑" disabled={!connected || !!busy} onClick={() => setForm(task)}>
								<Pencil size={14} />
							</button>
							<button
								title={task.status === "active" ? "禁用" : "启用"}
								aria-label={task.status === "active" ? "禁用" : "启用"}
								disabled={!connected || !!busy || task.status === "completed"}
								onClick={() => void act(task, "toggle")}
							>
								{task.status === "active" ? <Pause size={14} /> : <Power size={14} />}
							</button>
							<button title="删除" aria-label="删除" disabled={!connected || !!busy} onClick={() => setDeleting(task)}>
								<Trash2 size={14} />
							</button>
						</footer>
					</article>
				))}
			</div>
			{tasks.length === 0 && (
				<div className="scheduled-empty">
					<CalendarClock size={28} />
					<p>{loading ? "正在读取定时任务..." : "暂无定时任务"}</p>
				</div>
			)}
			{form && (
				<TaskForm
					{...props}
					{...(form === "new" ? {} : { task: form })}
					onClose={() => setForm(undefined)}
					onSaved={() => {
						setForm(undefined);
						void refresh();
					}}
				/>
			)}
			{logs && (
				<RunLog task={logs} request={request} onClose={() => setLogs(undefined)} onOpenSession={props.onOpenSession} />
			)}
			{deleting && (
				<Modal title="删除定时任务" onClose={() => setDeleting(undefined)} busy={!!busy}>
					<div className="scheduled-confirm">
						<p>删除“{deleting.title}”及其执行日志？历史对话保留，此操作不可撤销。</p>
						{error && <p role="alert">{error}</p>}
						<footer>
							<button disabled={!!busy} onClick={() => setDeleting(undefined)}>
								取消
							</button>
							<button disabled={!!busy} onClick={() => void act(deleting, "delete")}>
								确认删除
							</button>
						</footer>
					</div>
				</Modal>
			)}
		</section>
	);
}

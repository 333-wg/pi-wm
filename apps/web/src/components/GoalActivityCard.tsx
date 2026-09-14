import {
	Activity,
	AlertCircle,
	Check,
	ExternalLink,
	Maximize2,
	Pause,
	Play,
	Target,
	Trash2,
	Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { GoalSummary } from "@wuming/protocol";
import type { LiveGoalActivity } from "../use-wuming-client.js";

const RUNNING_STATUSES: readonly GoalSummary["status"][] = ["queued", "running", "awaiting_approval", "cancelling"];

function isRunning(status: GoalSummary["status"]): boolean {
	return RUNNING_STATUSES.includes(status);
}

export function goalElapsedMs(goal: GoalSummary, now: number): number {
	const accumulated = goal.accumulatedRunMs ?? 0;
	if (goal.pausedAt !== undefined || goal.startedAt === undefined) return accumulated;
	const end = goal.finishedAt ?? (isRunning(goal.status) ? now : goal.updatedAt);
	return accumulated + Math.max(0, end - goal.startedAt);
}

function formatElapsed(milliseconds: number): string {
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function statusText(goal: GoalSummary): string {
	if (goal.status === "pending") return "已设置的目标";
	if (goal.status === "paused") return "已暂停的目标";
	if (goal.status === "completed") return "已完成的目标";
	if (goal.status === "failed") return "目标执行失败";
	if (goal.status === "cancelled") return "已取消的目标";
	return "进行中的目标";
}

export function GoalActivityCard({
	goal,
	skill,
	onStart,
	onPause,
	onResume,
	onCancel,
	onDelete,
	onOpen,
	onOpenRun,
	activity,
}: {
	goal: GoalSummary;
	skill: { name: string } | undefined;
	activity: LiveGoalActivity | undefined;
	onStart: (goalId: string) => Promise<GoalSummary>;
	onPause: (goalId: string) => Promise<GoalSummary>;
	onResume: (goalId: string) => Promise<GoalSummary>;
	onCancel: (goalId: string) => Promise<GoalSummary>;
	onDelete: (goalId: string) => Promise<string>;
	onOpen: () => void;
	onOpenRun: (sessionId: string) => Promise<void>;
}) {
	const active = isRunning(goal.status);
	const [now, setNow] = useState(() => Date.now());
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [active, goal.id]);
	const act = async (action: () => Promise<unknown>) => {
		if (busy) return;
		setBusy(true);
		try {
			await action();
		} finally {
			setBusy(false);
		}
	};
	const elapsed = formatElapsed(goalElapsedMs(goal, now));
	const runsInCurrentSession = goal.executionMode === "session";
	const activityLabel =
		activity?.phase === "tool"
			? activity.toolStatus === "error"
				? "工具调用失败"
				: activity.toolStatus === "complete"
					? "工具调用完成"
					: "正在调用工具"
			: activity?.phase === "retrying"
				? "正在重试"
				: "正在分析和执行";
	return (
		<article
			className={`goal-activity-card goal-activity-${goal.status}`}
			aria-label={`${statusText(goal)}：${goal.objective}`}
		>
			<div className="goal-activity-icon" aria-hidden="true">
				{goal.status === "completed" ? (
					<Check size={16} />
				) : goal.status === "failed" ? (
					<AlertCircle size={16} />
				) : (
					<Target size={16} />
				)}
			</div>
			<div className="goal-activity-copy">
				<div className="goal-activity-heading">
					<strong>{statusText(goal)}</strong>
					<span className="goal-activity-elapsed">{goal.objective}</span>
					<span className="goal-activity-dot">•</span>
					<span className="goal-activity-elapsed">{elapsed}</span>
				</div>
				{skill && <span className="goal-activity-skill">技能：{skill.name}</span>}
				{activity && (
					<div className="goal-activity-live" role="status" aria-live="polite">
						<div className="goal-activity-live-heading">
							<Activity size={13} />
							<strong>{activityLabel}</strong>
							{runsInCurrentSession && <span className="goal-activity-location">当前对话中执行</span>}
							{!runsInCurrentSession && goal.runSessionId && (
								<button
									type="button"
									className="goal-activity-run-link"
									title="打开目标执行会话"
									onClick={() => void act(() => onOpenRun(goal.runSessionId!))}
								>
									<ExternalLink size={12} />
									查看执行会话
								</button>
							)}
						</div>
						{!runsInCurrentSession && activity.phase === "tool" && activity.toolName && (
							<div className="goal-activity-tool">
								<Wrench size={12} />
								<code>{activity.toolName}</code>
							</div>
						)}
						{!runsInCurrentSession && activity.message && <p className="goal-activity-message">{activity.message}</p>}
						{!runsInCurrentSession && activity.text && <p className="goal-activity-text">{activity.text}</p>}
						{!runsInCurrentSession && activity.toolPreview && (
							<pre className="goal-activity-preview">{activity.toolPreview}</pre>
						)}
					</div>
				)}
			</div>
			<div className="goal-activity-actions">
				<button
					type="button"
					className="goal-activity-icon-button"
					title="删除目标"
					aria-label="删除目标"
					disabled={busy}
					onClick={() => void act(() => onDelete(goal.id))}
				>
					<Trash2 size={15} />
				</button>
				{active && (
					<button
						type="button"
						className="goal-activity-icon-button"
						title="暂停目标"
						aria-label="暂停目标"
						disabled={busy}
						onClick={() => void act(() => onPause(goal.id))}
					>
						<Pause size={15} />
					</button>
				)}
				{goal.status === "paused" && (
					<button
						type="button"
						className="goal-activity-icon-button"
						title="继续目标"
						aria-label="继续目标"
						disabled={busy}
						onClick={() => void act(() => onResume(goal.id))}
					>
						<Play size={15} />
					</button>
				)}
				{goal.status === "pending" && (
					<button
						type="button"
						className="goal-activity-icon-button"
						title="启动目标"
						aria-label="启动目标"
						disabled={busy}
						onClick={() => void act(() => onStart(goal.id))}
					>
						<Play size={15} />
					</button>
				)}
				{active && (
					<button
						type="button"
						className="goal-activity-icon-button"
						title="取消目标"
						aria-label="取消目标"
						disabled={busy}
						onClick={() => void act(() => onCancel(goal.id))}
					>
						<span className="goal-activity-stop" />
					</button>
				)}
				<button
					type="button"
					className="goal-activity-icon-button"
					title="打开目标详情"
					aria-label="打开目标详情"
					onClick={onOpen}
				>
					<Maximize2 size={15} />
				</button>
			</div>
		</article>
	);
}

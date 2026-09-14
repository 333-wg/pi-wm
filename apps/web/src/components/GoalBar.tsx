import { useMemo, useEffect, useState } from "react";
import { Target, X, Play, Pause, Trash2 } from "lucide-react";
import type { GoalSummary, Skill } from "@wuming/protocol";
export function GoalBar({
	goals,
	selectedSkill,
	onStart,
	onPause,
	onResume,
	onCancel,
	onDelete,
}: {
	goals: GoalSummary[];
	selectedSkill?: Skill;
	onStart: (id: string) => Promise<GoalSummary>;
	onPause: (id: string) => Promise<GoalSummary>;
	onResume: (id: string) => Promise<GoalSummary>;
	onCancel: (id: string) => Promise<GoalSummary>;
	onDelete: (id: string) => Promise<GoalSummary>;
}) {
	const current = useMemo(
		() =>
			goals.find((g) =>
				["pending", "queued", "running", "awaiting_approval", "paused", "cancelling"].includes(g.status)
			),
		[goals]
	);
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		if (!current?.startedAt) {
			setElapsed(0);
			return;
		}
		const update = () => setElapsed(Math.max(0, Date.now() - current.startedAt!));
		update();
		const timer = window.setInterval(update, 1000);
		return () => window.clearInterval(timer);
	}, [current?.id, current?.startedAt]);
	if (!current) return null;
	const seconds = Math.floor(elapsed / 1000);
	const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	const running = current.status === "running" || current.status === "queued" || current.status === "awaiting_approval";
	return (
		<div className={`goalbar goalbar-active goalbar-${current.status}`} role="status">
			<Target size={15} />
			<div className="goalbar-copy">
				<strong>{current.title || "当前目标"}</strong>
				<span>{current.objective}</span>
			</div>
			{selectedSkill && (
				<span className="goalbar-skill" title={`目标技能：${selectedSkill.name}`}>
					{selectedSkill.name}
				</span>
			)}
			<span className="goalbar-status">
				<i />
				{current.status === "pending" ? (
					"待启动"
				) : current.status === "paused" ? (
					"已暂停"
				) : running ? (
					<>
						进行中的目标 <em>{time}</em>
					</>
				) : (
					"正在处理"
				)}
			</span>
			{current.status === "pending" && (
				<button className="goalbar-action" onClick={() => void onStart(current.id)}>
					<Play size={13} />
					启动
				</button>
			)}
			{running && (
				<button className="goalbar-icon" title="暂停目标" onClick={() => void onPause(current.id)}>
					<Pause size={14} />
				</button>
			)}
			{current.status === "paused" && (
				<button className="goalbar-icon" title="继续目标" onClick={() => void onResume(current.id)}>
					<Play size={14} />
				</button>
			)}
			<button className="goalbar-icon" title="取消目标" onClick={() => void onCancel(current.id)}>
				<X size={14} />
			</button>
			<button className="goalbar-icon" title="删除目标" onClick={() => void onDelete(current.id)}>
				<Trash2 size={14} />
			</button>
		</div>
	);
}

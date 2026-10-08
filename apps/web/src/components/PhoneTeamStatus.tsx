import { useEffect, useState } from "react";
import type { AgentTeam, Command, CommandResult } from "@wuming/protocol";

/** Read-only status: stopping a chat is not stopping an independent team. */
export function PhoneTeamStatus({
	sessionId,
	workspaceId,
	connected,
	request,
}: {
	sessionId: string;
	workspaceId: string;
	connected: boolean;
	request: (command: Command) => Promise<CommandResult>;
}) {
	const [teams, setTeams] = useState<AgentTeam[]>([]);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [retry, setRetry] = useState(0);
	useEffect(() => {
		setTeams([]);
		setError("");
		setLoading(true);
	}, [sessionId, workspaceId]);
	useEffect(() => {
		if (!connected) return;
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			try {
				if (document.visibilityState === "hidden") return;
				const result = await request({ type: "team.list", workspaceId });
				if (!active || result.type !== "team.list") return;
				const related = result.teams.filter((t) => t.sourceSessionId === sessionId || t.sessionId === sessionId);
				const values: AgentTeam[] = [];
				for (const summary of related) {
					if (!active) return;
					const detail = await request({ type: "team.get", teamId: summary.id });
					if (detail.type === "team.snapshot" && detail.team) values.push(detail.team);
				}
				if (active) {
					setTeams(values);
					setError("");
				}
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (active) {
					setLoading(false);
					timer = setTimeout(() => void refresh(), 15000);
				}
			}
		};
		void refresh();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [sessionId, workspaceId, connected, request, retry]);
	return (
		<section className="phone-team-status" aria-label="团队状态">
			<div className="phone-team-heading">
				<strong>团队任务 · 由电脑执行</strong>
				<button
					type="button"
					disabled={!connected || loading}
					onClick={() => {
						setLoading(true);
						setRetry((n) => n + 1);
					}}
				>
					刷新团队状态
				</button>
			</div>
			{!connected && <p role="status">连接已断开，以下是上次同步的状态。</p>}
			{loading && <p role="status">正在同步团队状态…</p>}
			{error && <p role="alert">团队状态同步失败：{error}</p>}
			{!loading && !error && !teams.length && <p>暂未找到关联团队，请稍后刷新或在电脑端查看。</p>}
			{teams.map((team) => (
				<details key={team.id}>
					<summary>
						{team.name} ·{" "}
						{team.status === "completed"
							? "已完成"
							: team.status === "stopped"
								? "已停止"
								: team.members.some((m) => m.state === "awaiting_approval")
									? "等待审批"
									: team.tasks.some((t) => t.status === "failed") || team.members.some((m) => m.state === "error")
										? "需要处理"
										: "执行中"}
					</summary>
					<p>
						任务 {team.tasks.filter((t) => t.status === "completed").length}/{team.tasks.length} 已完成 ·{" "}
						{team.members.length} 位成员
					</p>
					{team.tasks.map((task) => (
						<p key={task.id}>
							{task.title} ·{" "}
							{
								{ pending: "待处理", in_progress: "执行中", completed: "已完成", failed: "失败", cancelled: "已取消" }[
									task.status
								]
							}
						</p>
					))}
					{team.result && <p className="phone-team-result">{team.result}</p>}
				</details>
			))}
			<small>会话空闲不代表团队完成；此处只查看状态。团队管理和停止请到电脑端操作。</small>
		</section>
	);
}

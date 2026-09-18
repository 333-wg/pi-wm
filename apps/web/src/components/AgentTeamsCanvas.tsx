import { Check, CircleAlert, Clock3, GitBranch, LoaderCircle } from "lucide-react";
import { useId, useMemo } from "react";
import { layoutTeamTasks, TEAM_LAYOUT, teamTaskState, type TeamMember, type TeamTask } from "../lib/agent-teams";
import type { TeamText } from "./agent-teams-messages";

export function TeamStatus({ task, t }: { task: TeamTask; t: TeamText }) {
	const state = teamTaskState(task.status);
	const Icon =
		state === "completed" ? Check : state === "attention" ? CircleAlert : state === "running" ? LoaderCircle : Clock3;
	return (
		<span className={`teams-status state-${state}`}>
			<Icon size={12} />
			<span>{t(task.status)}</span>
		</span>
	);
}

export function AgentTeamsCanvas({
	tasks,
	members,
	selected,
	onSelect,
	zoom,
	t,
}: {
	tasks: TeamTask[];
	members: TeamMember[];
	selected: string | undefined;
	onSelect: (id: string) => void;
	zoom: number;
	t: TeamText;
}) {
	const layout = useMemo(() => layoutTeamTasks(tasks), [tasks]);
	const marker = useId().replace(/:/g, "");
	const byId = new Map(layout.positions.map((position) => [position.task.id, position]));
	return (
		<div className="teams-canvas-scroll" tabIndex={0} role="region" aria-label={t("lanes")}>
			<div className="teams-canvas-size" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
				<div
					className="teams-canvas"
					style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
				>
					<div className="teams-lane-title">{t("members")}</div>
					{Array.from({ length: layout.columns }, (_, column) => (
						<div
							className="teams-stage"
							key={column}
							style={{ left: TEAM_LAYOUT.label + column * TEAM_LAYOUT.pitch, width: TEAM_LAYOUT.pitch }}
						>
							{t("stage")} {column + 1}
						</div>
					))}
					{layout.positions.map(({ task, y }) => (
						<div className="teams-lane" key={task.id} style={{ top: y, height: TEAM_LAYOUT.row, width: layout.width }}>
							<div className="teams-lane-owner">
								<strong>{members.find((member) => member.id === task.memberId)?.name ?? t("unassigned")}</strong>
								<span>{task.group || t("independent")}</span>
							</div>
						</div>
					))}
					<svg className="teams-edges" width={layout.width} height={layout.height} aria-hidden="true">
						<defs>
							<marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
								<path d="M 0 0 L 7 3.5 L 0 7 z" fill="currentColor" />
							</marker>
						</defs>
						{layout.positions.flatMap((target) =>
							target.task.dependsOn.map((id) => {
								const source = byId.get(id);
								if (!source) return null;
								const x = source.x + TEAM_LAYOUT.width;
								const y = source.y + TEAM_LAYOUT.height / 2;
								const endY = target.y + TEAM_LAYOUT.height / 2;
								return (
									<path
										key={`${id}:${target.task.id}`}
										data-dependency={`${id}:${target.task.id}`}
										className={source.task.status === "completed" ? "satisfied" : ""}
										d={`M ${x} ${y} C ${x + 22} ${y}, ${target.x - 22} ${endY}, ${target.x - 5} ${endY}`}
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
										markerEnd={`url(#${marker})`}
									/>
								);
							})
						)}
					</svg>
					{layout.positions.map(({ task, x, y }) => (
						<button
							type="button"
							key={task.id}
							className={`teams-task state-${teamTaskState(task.status)} ${selected === task.id ? "selected" : ""}`}
							style={{ left: x, top: y, width: TEAM_LAYOUT.width, height: TEAM_LAYOUT.height }}
							aria-pressed={selected === task.id}
							title={task.title + "\n" + task.objective}
							onClick={() => onSelect(task.id)}
						>
							<strong>{task.title}</strong>
							<span className="teams-task-objective">{task.objective}</span>
							<span className="teams-task-footer">
								<TeamStatus task={task} t={t} />
								{task.dependsOn.length > 0 && (
									<span>
										<GitBranch size={12} />
										{task.dependsOn.length}
									</span>
								)}
							</span>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

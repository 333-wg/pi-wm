import { Check, CircleAlert, Clock3, GitBranch, LoaderCircle, LocateFixed } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { layoutTeamTasks, TEAM_LAYOUT, teamTaskState, type TeamMember, type TeamTask } from "../lib/agent-teams";
import type { TeamText } from "./agent-teams-messages";
import "./agent-teams-enhanced.css";
import "./agent-teams-flow.css";

export function TeamStatus({ task, t }: { task: TeamTask; t: TeamText }) {
	const state = teamTaskState(task.status);
	const Icon =
		state === "completed" ? Check : state === "attention" ? CircleAlert : state === "running" ? LoaderCircle : Clock3;
	return (
		<span className={`teams-status-enhanced state-${state}`}>
			<Icon size={12} />
			<span>{t(task.status)}</span>
		</span>
	);
}

export function AgentTeamsCanvas({
	tasks,
	visibleIds,
	members,
	selected,
	onSelect,
	zoom,
	t,
}: {
	tasks: TeamTask[];
	visibleIds?: ReadonlySet<string>;
	members: TeamMember[];
	selected: string | undefined;
	onSelect: (id: string) => void;
	zoom: number;
	t: TeamText;
}) {
	const layout = useMemo(() => layoutTeamTasks(tasks, visibleIds), [tasks, visibleIds]);
	const marker = useId().replace(/:/g, "");
	const scroll = useRef<HTMLDivElement>(null);
	const [hovered, setHovered] = useState<string>();
	const firstMatch = visibleIds && visibleIds.size < tasks.length ? layout.positions[0] : undefined;
	const matchX = firstMatch?.x;
	const matchY = firstMatch?.y;
	useEffect(() => {
		if (matchX === undefined || matchY === undefined) return;
		// Reveal filtered results without stealing the search field's keyboard focus.
		scroll.current?.scrollTo({
			left: Math.max(0, (matchX - 24) * zoom),
			top: Math.max(0, (matchY - TEAM_LAYOUT.top) * zoom),
			behavior: "instant",
		});
	}, [matchX, matchY, zoom]);
	const focus = hovered ?? selected;
	const byId = new Map(layout.positions.map((position) => [position.task.id, position]));
	const related = new Set([focus]);
	for (const link of layout.links) {
		if (link.source === focus || link.target === focus) {
			related.add(link.source);
			related.add(link.target);
		}
	}
	const stages = Array.from({ length: layout.columns }, (_, column) => {
		const entries = layout.allPositions.filter((position) => position.column === column);
		return { column, entries, completed: entries.filter(({ task }) => task.status === "completed").length };
	});
	const locate = (column: number, taskId?: string) => {
		const position = taskId ? byId.get(taskId) : layout.positions.find((entry) => entry.column === column);
		if (!position) return;
		scroll.current?.scrollTo({
			left: Math.max(0, (position.x - 24) * zoom),
			top: Math.max(0, (position.y - TEAM_LAYOUT.top) * zoom),
			behavior: "instant",
		});
		scroll.current
			?.querySelector<HTMLButtonElement>(`[data-task-id="${CSS.escape(position.task.id)}"]`)
			?.focus({ preventScroll: true });
	};
	const running = layout.positions.find(({ task }) => teamTaskState(task.status) === "running");
	return (
		<div className="teams-flow-view">
			<nav className="teams-stage-nav" aria-label={t("stageNavigation")}>
				{stages.map(({ column, entries, completed }) => {
					const active = entries.some(({ task }) => teamTaskState(task.status) === "running");
					const matches = layout.positions.some((position) => position.column === column);
					return (
						<button
							key={column}
							type="button"
							className={`teams-stage-stop ${active ? "is-running" : ""} ${completed === entries.length ? "is-complete" : ""}`}
							disabled={!matches}
							title={matches ? t("stageHint") : t("noStageMatches")}
							onClick={() => locate(column)}
						>
							<span className="teams-stage-number">
								{completed === entries.length ? <Check size={12} /> : column + 1}
							</span>
							<span>
								{t("stage")} {column + 1}
								<small>
									{completed}/{entries.length} {t("completed")}
								</small>
							</span>
							<span
								className="teams-stage-progress"
								style={{ width: `${(completed / Math.max(1, entries.length)) * 100}%` }}
							/>
						</button>
					);
				})}
			</nav>
			<div className="teams-flow-legend">
				<span>
					<i className="dependency" />
					{t("dependencyLink")}
				</span>
				<span>
					<i className="continuation" />
					{t("continuationLink")}
				</span>
				<span>
					<i className="flowing" />
					{t("flowing")}
				</span>
				<button type="button" disabled={!running} onClick={() => running && locate(running.column, running.task.id)}>
					<LocateFixed size={13} />
					{t("locateRunning")}
				</button>
			</div>
			<div ref={scroll} className="teams-canvas-scroll" tabIndex={0} role="region" aria-label={t("lanes")}>
				<div className="teams-canvas-size" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
					<div
						className="teams-canvas"
						style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
					>
						<div className="teams-lane-title">{t("members")}</div>
						{stages.map(({ column, entries, completed }) => (
							<div
								className="teams-stage-column"
								key={column}
								style={{
									left: TEAM_LAYOUT.label + column * TEAM_LAYOUT.pitch,
									width: TEAM_LAYOUT.pitch,
									height: layout.height,
								}}
							>
								<div className="teams-stage">
									{t("stage")} {column + 1}
									<span>
										{completed}/{entries.length}
									</span>
								</div>
							</div>
						))}
						{layout.positions.map(({ task, y }) => (
							<div
								className="teams-lane"
								key={task.id}
								style={{ top: y, height: TEAM_LAYOUT.row, width: layout.width }}
							>
								<div className="teams-lane-owner">
									<strong>{members.find((member) => member.id === task.memberId)?.name ?? t("unassigned")}</strong>
									<span>{task.group || t("independent")}</span>
								</div>
							</div>
						))}
						<svg
							className="teams-edges teams-flow-edges"
							width={layout.width}
							height={layout.height}
							aria-hidden="true"
						>
							<defs>
								<marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
									<path d="M 0 0 L 7 3.5 L 0 7 z" fill="context-stroke" />
								</marker>
							</defs>
							{layout.links.map((link) => {
								const source = byId.get(link.source)!;
								const target = byId.get(link.target)!;
								const x = source.x + TEAM_LAYOUT.width;
								const y = source.y + TEAM_LAYOUT.height / 2;
								const endY = target.y + TEAM_LAYOUT.height / 2;
								// Route backwards links around the rows rather than through the task cards.
								const d =
									target.x > x
										? `M ${x} ${y} C ${x + 24} ${y}, ${target.x - 24} ${endY}, ${target.x - 6} ${endY}`
										: `M ${x} ${y} H ${x + 16} V ${source.y - 10} H ${target.x - 16} V ${endY} H ${target.x - 6}`;
								const highlighted = link.source === focus || link.target === focus;
								const flowing = source.task.status === "completed" && teamTaskState(target.task.status) === "running";
								const state =
									teamTaskState(source.task.status) === "attention" || teamTaskState(target.task.status) === "attention"
										? "attention"
										: flowing
											? "running"
											: source.task.status === "completed"
												? "completed"
												: "waiting";
								return (
									<g
										key={`${link.source}:${link.target}`}
										data-link-kind={link.kind}
										data-dependency={link.kind === "dependency" ? `${link.source}:${link.target}` : undefined}
										className={`teams-flow-link state-${state} ${highlighted ? "highlighted" : ""} ${focus && !highlighted ? "dimmed" : ""}`}
									>
										<path className="teams-link-halo" d={d} />
										<path className={`teams-link-line ${link.kind}`} d={d} markerEnd={`url(#${marker})`} />
										{flowing && <path className="teams-link-pulse" d={d} />}
										<circle cx={x} cy={y} r="3" />
										<circle cx={target.x - 6} cy={endY} r="3" />
									</g>
								);
							})}
						</svg>
						{layout.positions.map(({ task, x, y, column }) => (
							<button
								type="button"
								key={task.id}
								data-task-id={task.id}
								data-stage={column + 1}
								className={`teams-task-enhanced state-${teamTaskState(task.status)} ${selected === task.id ? "selected" : ""} ${focus && !related.has(task.id) ? "flow-dimmed" : ""}`}
								style={{ left: x, top: y, width: TEAM_LAYOUT.width, height: TEAM_LAYOUT.height }}
								aria-pressed={selected === task.id}
								title={task.title + "\n" + task.objective}
								onMouseEnter={() => setHovered(task.id)}
								onMouseLeave={() => setHovered(undefined)}
								onFocus={() => setHovered(task.id)}
								onBlur={() => setHovered(undefined)}
								onClick={() => onSelect(task.id)}
							>
								<strong>{task.title}</strong>
								<span className="teams-task-objective-enhanced">{task.objective}</span>
								<span className="teams-task-footer-enhanced">
									<TeamStatus task={task} t={t} />
									{task.dependsOn.length > 0 && (
										<span className="teams-dependency-badge">
											<GitBranch size={10} />
											{task.dependsOn.length}
										</span>
									)}
								</span>
							</button>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

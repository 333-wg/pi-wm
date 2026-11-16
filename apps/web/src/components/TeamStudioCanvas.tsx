import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Circle, CircleAlert, Focus, Maximize, Minus, Plus } from "lucide-react";
import type { AgentTeam, AgentTeamMember, AgentTeamTask } from "@wuming/protocol";
import { layoutStudioTasks } from "../lib/team-studio";
import { useLocale } from "../lib/locale";

export function TeamStudioCanvas({
	team,
	query,
	selected,
	onSelect,
	renderAssignment,
}: {
	team: AgentTeam;
	query: string;
	selected?: string | undefined;
	onSelect: (id: string) => void;
	renderAssignment: (member: AgentTeamMember) => ReactNode;
}) {
	const { locale } = useLocale();
	const label = (zh: string, en: string) => (locale === "en" ? en : zh);
	const viewport = useRef<HTMLDivElement>(null);
	const marker = useId().replace(/:/g, "");
	const [scale, setScale] = useState(1);
	const [autoFit, setAutoFit] = useState(true);
	const [expanded, setExpanded] = useState(false);
	const [stage, setStage] = useState<number>();
	const [aggregate, setAggregate] = useState<boolean | undefined>(undefined);
	const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
	const pending = team.status === "running" ? team.members.filter((member) => member.state === "awaiting_model") : [];
	const pendingFirst = new Map(
		pending.map((member) => [
			member.id,
			team.tasks.find((task) => task.owner === member.id)?.id ?? `member:${member.id}`,
		])
	);
	const extra: AgentTeamTask[] = pending
		.filter((member) => !team.tasks.some((task) => task.owner === member.id))
		.map((member) => ({
			id: `member:${member.id}`,
			title: member.name,
			description: member.role,
			owner: member.id,
			status: "pending",
			dependsOn: [],
			writePaths: [],
			createdAt: team.createdAt,
			updatedAt: team.updatedAt,
		}));
	const all = useMemo(
		() => layoutStudioTasks([...team.tasks, ...extra], new Set(pendingFirst.values())),
		[team.tasks, pending.map((member) => member.id).join(",")]
	);
	const matches = (task: AgentTeamTask) =>
		`${task.title} ${task.description} ${team.members.find((member) => member.id === task.owner)?.name ?? ""}`
			.toLowerCase()
			.includes(query.toLowerCase());
	const visibleStage = query ? undefined : stage;
	const positions = all.positions.filter(
		(position) => matches(position.task) && (visibleStage === undefined || position.column === visibleStage)
	);
	const byId = new Map(positions.map((position) => [position.task.id, position]));
	const width = visibleStage === undefined ? all.width : 270;
	const originX = visibleStage === undefined ? 0 : visibleStage * 270;
	const aggregated = aggregate ?? team.tasks.length > 18;
	const showAggregate = aggregated && stage === undefined && !query;
	const fit = () => {
		setAutoFit(true);
		viewport.current?.scrollTo({ left: 0, top: 0 });
	};
	useEffect(() => {
		const node = viewport.current;
		if (!node || !autoFit) return;
		const resize = () =>
			setScale(Math.max(0.75, Math.min(1, (node.clientWidth - 16) / width, (node.clientHeight - 16) / all.height)));
		resize();
		const observer = new ResizeObserver(resize);
		observer.observe(node);
		return () => observer.disconnect();
	}, [autoFit, width, all.height, expanded, showAggregate]);
	useEffect(() => {
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setExpanded(false);
		};
		window.addEventListener("keydown", escape);
		return () => window.removeEventListener("keydown", escape);
	}, []);
	useEffect(() => {
		if (!query) return;
		const first = positions[0];
		if (first)
			viewport.current?.scrollTo({
				left: Math.max(0, (first.x - originX - 20) * scale),
				top: Math.max(0, (first.y - 40) * scale),
			});
	}, [query]);
	const locate = () => {
		const target =
			all.positions.find((position) => position.task.status === "in_progress") ??
			all.positions.find((position) => pendingFirst.has(position.task.owner ?? ""));
		if (!target) return;
		setAggregate(false);
		setStage(undefined);
		requestAnimationFrame(() =>
			viewport.current?.scrollTo({
				left: Math.max(0, (target.x - 24) * scale),
				top: Math.max(0, (target.y - 60) * scale),
				behavior: "smooth",
			})
		);
	};
	const status = (task: AgentTeamTask) =>
		task.status === "completed"
			? label("已完成", "Completed")
			: task.status === "in_progress"
				? label("进行中", "Working")
				: task.status === "failed"
					? label("失败", "Failed")
					: task.status === "cancelled"
						? label("已取消", "Cancelled")
						: pendingFirst.has(task.owner ?? "")
							? label("待选模型", "Choose model")
							: task.dependsOn.some((id) => team.tasks.find((value) => value.id === id)?.status !== "completed")
								? label("等待前置任务", "Waiting for dependencies")
								: label("待开始", "Pending");
	return (
		<div className={`team-studio-canvas${expanded ? " is-expanded" : ""}`}>
			<nav className="team-stage-strip" aria-label={label("阶段导航", "Stage navigation")}>
				{all.columns.map((tasks, index) => (
					<button
						key={index}
						className={visibleStage === index ? "selected" : ""}
						disabled={!!query}
						onClick={() => {
							setStage(stage === index ? undefined : index);
							fit();
						}}
					>
						<span>{String(index + 1).padStart(2, "0")}</span>
						<strong>
							{label("阶段", "Stage")} {index + 1}
						</strong>
						<small>
							{tasks.filter((task) => task.status === "completed").length}/{tasks.length}
						</small>
					</button>
				))}
				{stage !== undefined && (
					<button
						onClick={() => {
							setStage(undefined);
							fit();
						}}
					>
						{label("全部阶段", "All stages")}
					</button>
				)}
			</nav>
			<div
				ref={viewport}
				className="teams-canvas-scroll studio-canvas-scroll"
				role="region"
				aria-label={label("任务流程画布", "Task flow canvas")}
				tabIndex={0}
				onPointerDown={(event) => {
					if (event.button || (event.target as HTMLElement).closest("button,select,input,a")) return;
					setAutoFit(false);
					const node = viewport.current!;
					drag.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop };
					node.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					if (!drag.current) return;
					const node = viewport.current!;
					node.scrollLeft = drag.current.left - event.clientX + drag.current.x;
					node.scrollTop = drag.current.top - event.clientY + drag.current.y;
				}}
				onPointerUp={() => {
					drag.current = undefined;
				}}
				onPointerCancel={() => {
					drag.current = undefined;
				}}
			>
				{showAggregate ? (
					<div className="team-stage-overview">
						{all.columns.map((tasks, index) => (
							<button
								key={index}
								onClick={() => {
									setStage(index);
									fit();
								}}
							>
								<span>{String(index + 1).padStart(2, "0")}</span>
								<strong>
									{label("阶段", "Stage")} {index + 1}
								</strong>
								<p>
									{tasks.filter((task) => task.status === "completed").length}/{tasks.length}{" "}
									{label("项已完成", "completed")}
								</p>
								<small>{label("展开此阶段", "Explore stage")} →</small>
							</button>
						))}
					</div>
				) : (
					<div className="studio-canvas-size" style={{ width: width * scale, height: all.height * scale }}>
						<div className="studio-canvas-nodes" style={{ width, height: all.height, transform: `scale(${scale})` }}>
							<svg className="studio-edges" width={width} height={all.height} aria-hidden="true">
								<defs>
									<marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
										<path d="M0 0 L7 3.5 L0 7Z" fill="context-stroke" />
									</marker>
								</defs>
								{positions.flatMap((target) =>
									target.task.dependsOn.flatMap((id) => {
										const source = byId.get(id);
										if (!source) return [];
										const x = source.x + source.width - originX;
										const y = source.y + source.height / 2;
										const endX = target.x - originX - 6;
										const endY = target.y + target.height / 2;
										return [
											<path
												key={`${id}:${target.task.id}`}
												data-dependency={`${id}:${target.task.id}`}
												className={source.task.status === "completed" ? "complete" : ""}
												d={`M${x} ${y} C${x + 30} ${y},${endX - 30} ${endY},${endX} ${endY}`}
												markerEnd={`url(#${marker})`}
											/>,
										];
									})
								)}
							</svg>
							{positions.map(({ task, x, y, width: cardWidth, height, column }) => {
								const member = team.members.find((member) => member.id === task.owner);
								const assignment =
									member?.state === "awaiting_model" &&
									pendingFirst.get(member.id) === task.id &&
									team.status === "running";
								const style = { left: x - originX, top: y, width: cardWidth, height };
								const Icon = task.status === "completed" ? Check : task.status === "failed" ? CircleAlert : Circle;
								return assignment ? (
									<article
										className="studio-task studio-assignment"
										key={task.id}
										style={style}
										data-task-id={task.id}
										data-member-id={member.id}
									>
										<header>
											<span className="team-avatar">{member.name.slice(0, 1).toUpperCase()}</span>
											<strong>{member.name}</strong>
											<small>{label("待选模型", "Choose model")}</small>
										</header>
										<p title={member.role}>{member.role}</p>
										{renderAssignment(member)}
									</article>
								) : (
									<button
										type="button"
										key={task.id}
										style={style}
										data-task-id={task.id}
										data-stage={column + 1}
										className={`studio-task teams-task-enhanced state-${task.status} ${selected === task.id ? "selected" : ""}`}
										onClick={() => onSelect(task.id)}
										title={task.title}
									>
										<span className="team-avatar">{member?.name.slice(0, 1).toUpperCase() ?? "·"}</span>
										<div>
											<strong>{task.title}</strong>
											<span>
												{member?.lead ? label("负责人", "Leader") : (member?.name ?? label("未分配", "Unassigned"))}
											</span>
											<small>
												<Icon size={12} />
												{status(task)}
											</small>
										</div>
									</button>
								);
							})}
						</div>
					</div>
				)}
			</div>
			<footer className="studio-canvas-controls">
				<span>
					{team.tasks.filter((task) => task.status === "completed").length}/{team.tasks.length}{" "}
					{label("项已完成", "completed")}
				</span>
				{team.tasks.length > 18 && (
					<button
						onClick={() => {
							setAggregate(!aggregated);
							setStage(undefined);
							fit();
						}}
					>
						{aggregated ? label("展开任务", "Expand tasks") : label("阶段概览", "Stage overview")}
					</button>
				)}
				<button
					title={label("定位执行中", "Locate active task")}
					aria-label={label("定位执行中", "Locate active task")}
					onClick={locate}
				>
					<Focus size={15} />
				</button>
				<button
					aria-label={label("缩小", "Zoom out")}
					disabled={scale <= 0.75}
					onClick={() => {
						setAutoFit(false);
						setScale((value) => Math.max(0.75, value - 0.1));
					}}
				>
					<Minus size={14} />
				</button>
				<button onClick={fit}>{label("适应画布", "Fit canvas")}</button>
				<button
					aria-label={label("放大", "Zoom in")}
					disabled={scale >= 1.5}
					onClick={() => {
						setAutoFit(false);
						setScale((value) => Math.min(1.5, value + 0.1));
					}}
				>
					<Plus size={14} />
				</button>
				<button
					aria-label={label(
						expanded ? "退出全屏画布" : "全屏画布",
						expanded ? "Exit fullscreen canvas" : "Fullscreen canvas"
					)}
					onClick={() => setExpanded(!expanded)}
				>
					<Maximize size={15} />
				</button>
			</footer>
		</div>
	);
}

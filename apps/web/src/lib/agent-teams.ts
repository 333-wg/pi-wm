import type { ApprovalRequest, GoalSummary, SessionSnapshot, SubagentSummary, Usage } from "@wuming/protocol";

export type TeamTaskStatus = GoalSummary["status"] | "blocked" | "skipped";
export type TeamTaskState = "waiting" | "running" | "completed" | "attention";
export type TeamTask = {
	id: string;
	title: string;
	objective: string;
	status: TeamTaskStatus;
	dependsOn: string[];
	memberId?: string;
	sessionId?: string;
	goalId?: string;
	subagentId?: string;
	group: string;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	result?: string;
	error?: string;
	usage: Usage;
	pendingApprovals: ApprovalRequest[];
};
export type TeamMember = {
	id: string;
	name: string;
	sessionId: string;
	lead: boolean;
	model?: string;
	status: string;
};
export type TeamMessage = {
	id: string;
	taskId: string;
	memberId: string;
	kind: "dispatch" | "result" | "error" | "approval";
	timestamp: number;
	text: string;
};
export type TeamFrame = {
	sessionId: string;
	members: TeamMember[];
	tasks: TeamTask[];
	messages: TeamMessage[];
};

export function teamTaskState(status: TeamTaskStatus): TeamTaskState {
	if (status === "completed") return "completed";
	if (["failed", "awaiting_approval", "cancelled", "skipped"].includes(status)) return "attention";
	if (status === "running" || status === "cancelling") return "running";
	return "waiting";
}

/** A projection of durable execution records, never a second task scheduler. */
export function buildTeamFrame(
	snapshot: SessionSnapshot,
	subagents: SubagentSummary[],
	goals: GoalSummary[]
): TeamFrame {
	const parentId = snapshot.session.id;
	const children = subagents.filter((child) => child.parentSessionId === parentId);
	const scopedGoals = goals.filter((goal) => goal.parentSessionId === parentId);
	const tasks: TeamTask[] = [];
	const coveredSessions = new Set<string>();
	const members = new Map<string, TeamMember>([
		[
			parentId,
			{
				id: parentId,
				sessionId: parentId,
				name: snapshot.session.name || "Team Lead",
				lead: true,
				model: snapshot.model.id,
				status: snapshot.session.phase,
			},
		],
	]);
	for (const goal of scopedGoals) {
		const entries = goal.plan ? goal.plan.steps : [goal];
		for (const entry of entries) {
			const id = goal.plan ? `goal:${goal.id}:${entry.id}` : `goal:${goal.id}`;
			const sessionId = entry.runSessionId;
			if (sessionId) {
				coveredSessions.add(sessionId);
				if (sessionId !== parentId)
					members.set(sessionId, {
						id: sessionId,
						sessionId,
						name: entry.title,
						lead: false,
						status: entry.status,
					});
			}
			tasks.push({
				id,
				title: entry.title,
				objective: entry.objective,
				status: entry.status,
				dependsOn: "dependsOn" in entry ? entry.dependsOn.map((dependency) => `goal:${goal.id}:${dependency}`) : [],
				...(sessionId ? { memberId: sessionId, sessionId } : {}),
				goalId: goal.id,
				group: goal.title,
				createdAt: goal.createdAt,
				...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
				...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
				...(entry.result === undefined ? {} : { result: entry.result }),
				...(entry.error
					? { error: entry.error }
					: "skipReason" in entry && entry.skipReason
						? { error: entry.skipReason }
						: {}),
				usage: entry.usage,
				pendingApprovals: entry.pendingApprovals,
			});
		}
	}
	for (const child of children) {
		members.set(child.sessionId, {
			id: child.sessionId,
			sessionId: child.sessionId,
			name: child.name,
			lead: false,
			model: child.model.id,
			status: child.status,
		});
		if (coveredSessions.has(child.sessionId)) continue;
		tasks.push({
			id: `agent:${child.id}`,
			title: child.name,
			objective: child.task,
			status: child.status,
			dependsOn: [],
			memberId: child.sessionId,
			sessionId: child.sessionId,
			subagentId: child.id,
			group: "",
			createdAt: child.createdAt,
			...(child.startedAt === undefined ? {} : { startedAt: child.startedAt }),
			...(child.finishedAt === undefined ? {} : { finishedAt: child.finishedAt }),
			...(child.result === undefined ? {} : { result: child.result }),
			...(child.error === undefined ? {} : { error: child.error }),
			usage: child.usage,
			pendingApprovals: child.pendingApprovals,
		});
	}
	// Stable sorting preserves authored step order when a plan shares one creation time.
	tasks.sort((a, b) => a.createdAt - b.createdAt);
	const messages: TeamMessage[] = [];
	for (const task of tasks) {
		// A blocked plan step has not been dispatched and has no recipient yet.
		if (!task.memberId) continue;
		if (task.startedAt !== undefined || task.subagentId)
			messages.push({
				id: `${task.id}:dispatch`,
				taskId: task.id,
				memberId: task.memberId,
				kind: "dispatch",
				timestamp: task.startedAt ?? task.createdAt,
				text: task.objective,
			});
		if (task.finishedAt !== undefined && task.result !== undefined)
			messages.push({
				id: `${task.id}:result`,
				taskId: task.id,
				memberId: task.memberId,
				kind: "result",
				timestamp: task.finishedAt,
				text: task.result,
			});
		if (task.error && task.finishedAt !== undefined)
			messages.push({
				id: `${task.id}:error`,
				taskId: task.id,
				memberId: task.memberId,
				kind: "error",
				timestamp: task.finishedAt,
				text: task.error,
			});
		for (const approval of task.pendingApprovals)
			messages.push({
				id: `${task.id}:approval:${approval.id}`,
				taskId: task.id,
				memberId: task.memberId,
				kind: "approval",
				timestamp: approval.createdAt,
				text: approval.summary,
			});
	}
	messages.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
	return { sessionId: parentId, members: [...members.values()], tasks, messages };
}

export const TEAM_LAYOUT = { label: 164, pitch: 264, row: 152, top: 42, width: 224, height: 128 };

export type TeamTaskLink = { source: string; target: string; kind: "dependency" | "continuation" };

/** Recorded handoffs are visual hints only, never scheduler dependencies. */
export function teamTaskLinks(tasks: TeamTask[]): TeamTaskLink[] {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const links: TeamTaskLink[] = [];
	for (const task of tasks) {
		for (const source of task.dependsOn) {
			if (source !== task.id && byId.has(source)) links.push({ source, target: task.id, kind: "dependency" });
		}
		if (!task.memberId || task.dependsOn.length) continue;
		const previous = tasks
			.filter(
				(candidate) =>
					candidate.id !== task.id &&
					candidate.memberId === task.memberId &&
					candidate.group === task.group &&
					candidate.createdAt < task.createdAt &&
					candidate.finishedAt !== undefined &&
					candidate.finishedAt <= task.createdAt &&
					["completed", "failed", "cancelled", "skipped"].includes(candidate.status)
			)
			.sort((a, b) => b.finishedAt! - a.finishedAt! || b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];
		// Do not add a continuation that would close an authored dependency cycle.
		const reachesTask = (id: string, seen = new Set<string>()): boolean => {
			if (id === task.id) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			return (byId.get(id)?.dependsOn ?? []).some((dependency) => reachesTask(dependency, seen));
		};
		if (previous && !reachesTask(previous.id))
			links.push({ source: previous.id, target: task.id, kind: "continuation" });
	}
	return links;
}

/** Lay out the whole snapshot before filtering so stage numbers never collapse during search. */
export function layoutTeamTasks(tasks: TeamTask[], visibleIds?: ReadonlySet<string>) {
	const links = teamTaskLinks(tasks);
	const incoming = new Map<string, string[]>();
	for (const link of links) incoming.set(link.target, [...(incoming.get(link.target) ?? []), link.source]);
	const depths = new Map<string, number>();
	const visiting = new Set<string>();
	const depth = (id: string): number => {
		if (depths.has(id)) return depths.get(id)!;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const dependencies = incoming.get(id) ?? [];
		const value = dependencies.length ? 1 + Math.max(...dependencies.map(depth)) : 0;
		visiting.delete(id);
		depths.set(id, value);
		return value;
	};
	const allPositions = tasks.map((task, row) => ({
		task,
		row,
		column: depth(task.id),
		x: TEAM_LAYOUT.label + depth(task.id) * TEAM_LAYOUT.pitch,
		y: TEAM_LAYOUT.top + row * TEAM_LAYOUT.row,
	}));
	const columns = Math.max(1, ...allPositions.map((position) => position.column + 1));
	const positions = allPositions.filter(({ task }) => !visibleIds || visibleIds.has(task.id));
	return {
		positions,
		allPositions,
		links: links.filter((link) => !visibleIds || (visibleIds.has(link.source) && visibleIds.has(link.target))),
		columns,
		width: TEAM_LAYOUT.label + columns * TEAM_LAYOUT.pitch,
		height: TEAM_LAYOUT.top + Math.max(1, tasks.length) * TEAM_LAYOUT.row,
	};
}

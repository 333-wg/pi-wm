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

export const TEAM_LAYOUT = { label: 164, pitch: 264, row: 120, top: 42, width: 224, height: 92 };

/** Dependency depth determines columns; separate rows keep arbitrary fan-in readable. */
export function layoutTeamTasks(tasks: TeamTask[]) {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const depths = new Map<string, number>();
	const visiting = new Set<string>();
	const depth = (id: string): number => {
		if (depths.has(id)) return depths.get(id)!;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const dependencies = (byId.get(id)?.dependsOn ?? []).filter((dependency) => byId.has(dependency));
		const value = dependencies.length ? 1 + Math.max(...dependencies.map(depth)) : 0;
		visiting.delete(id);
		depths.set(id, value);
		return value;
	};
	const positions = tasks.map((task, row) => ({
		task,
		row,
		column: depth(task.id),
		x: TEAM_LAYOUT.label + depth(task.id) * TEAM_LAYOUT.pitch,
		y: TEAM_LAYOUT.top + row * TEAM_LAYOUT.row,
	}));
	const columns = Math.max(1, ...positions.map((position) => position.column + 1));
	return {
		positions,
		columns,
		width: TEAM_LAYOUT.label + columns * TEAM_LAYOUT.pitch,
		height: TEAM_LAYOUT.top + Math.max(1, tasks.length) * TEAM_LAYOUT.row,
	};
}

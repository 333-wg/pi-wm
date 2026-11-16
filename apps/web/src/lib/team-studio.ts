import type { AgentTeam, AgentTeamMessage, AgentTeamTask, ModelRef } from "@wuming/protocol";

export const modelKey = (model?: ModelRef) => (model ? JSON.stringify([model.provider, model.id]) : "");
export const teamObjective = (objective: string) =>
	objective
		.replace(/^Current explicit team objective:\s*/, "")
		.split("\n\nPrior conversation reference")[0]!
		.trim();

/** Compact columns preserve authored dependencies; no inferred handoffs become dependencies. */
export function layoutStudioTasks(tasks: AgentTeamTask[], tall: ReadonlySet<string> = new Set()) {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const depths = new Map<string, number>();
	const depth = (id: string, path = new Set<string>()): number => {
		if (depths.has(id)) return depths.get(id)!;
		if (path.has(id)) return 0;
		const next = new Set(path).add(id);
		const dependencies = byId.get(id)?.dependsOn.filter((value) => byId.has(value) && !next.has(value)) ?? [];
		const value = dependencies.length ? 1 + Math.max(...dependencies.map((value) => depth(value, next))) : 0;
		depths.set(id, value);
		return value;
	};
	const columns: AgentTeamTask[][] = [];
	for (const task of tasks) (columns[depth(task.id)] ??= []).push(task);
	const heightOf = (task: AgentTeamTask) => (tall.has(task.id) ? 198 : 104);
	const heights = columns.map((column) => column.reduce((sum, task) => sum + heightOf(task) + 24, -24));
	const height = Math.max(160, ...heights) + 56;
	const positions = columns.flatMap((column, index) => {
		let y = 28 + (height - 56 - heights[index]!) / 2;
		return column.map((task) => {
			const position = { task, column: index, x: 16 + index * 270, y, width: 224, height: heightOf(task) };
			y += position.height + 24;
			return position;
		});
	});
	return { columns, positions, width: Math.max(270, columns.length * 270), height };
}

/** Historical free text stays literal. Only structured events get deterministic summaries. */
export function readableTeamMessage(message: AgentTeamMessage, team: AgentTeam, en = false) {
	if (message.summary) return message.summary;
	if (message.from === "user" && message.kind === "system" && message.text === team.objective)
		return teamObjective(team.objective);
	if (message.kind === "assignment" && message.from === "scheduler") {
		const task = team.tasks.find((task) => task.id === message.taskId || message.text.startsWith(`Task ${task.id}:`));
		if (task) return `${en ? "Assigned task" : "分配任务"}：${task.title}`;
	}
	// Fold long legacy messages in the UI without inventing progress or completion.
	return message.text;
}

export function memberProblem(error: string, en = false) {
	if (/concurrency limit|too many concurrent/i.test(error))
		return en
			? "The model service's concurrent request limit was reached."
			: "模型服务的同时请求数已达上限，暂时无法继续。";
	return error;
}

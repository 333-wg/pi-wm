import type { SubagentSummary } from "@wuming/protocol";

export function findToolSubagent(
	subagents: SubagentSummary[],
	toolCallId: string,
	input: unknown
): SubagentSummary | undefined {
	const linked = subagents.find((child) => child.sourceToolCallId === toolCallId || child.id === toolCallId);
	if (linked) return linked;
	if (!input || typeof input !== "object" || !("task" in input) || typeof input.task !== "string") return;
	// Old sessions have no durable call link. Never guess between duplicate tasks.
	const task = input.task.trim();
	const name = "name" in input && typeof input.name === "string" ? input.name.trim() : undefined;
	const candidates = subagents.filter(
		(child) => !child.sourceToolCallId && child.task === task && (!name || child.name === name)
	);
	return candidates.length === 1 ? candidates[0] : undefined;
}

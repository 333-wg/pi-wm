import type { ContextUsageState, SessionSnapshot } from "@wuming/protocol";

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	/** Clamped to 1 so an over-budget estimate cannot overflow the bar. */
	ratio: number | null;
	basis: ContextUsageState["basis"];
}

export function estimateContext(
	snapshot: SessionSnapshot | undefined,
	contextWindow: number | undefined
): ContextUsage | undefined {
	if (!snapshot || contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0)
		return undefined;
	const sameModel = (model: SessionSnapshot["model"]) =>
		model.provider === snapshot.model.provider && model.id === snapshot.model.id;
	const occupancy = (tokens: number | null, basis: ContextUsageState["basis"]): ContextUsage => ({
		tokens,
		contextWindow,
		ratio: tokens === null ? null : Math.min(1, tokens / contextWindow),
		basis,
	});
	// Explicit unknown values invalidate historical usage after compaction/model changes.
	if (snapshot.contextUsage) {
		const current = snapshot.contextUsage;
		return sameModel(current.model)
			? occupancy(current.basis === "unknown" ? null : current.tokens, current.basis)
			: occupancy(null, "unknown");
	}
	const turn = snapshot.usageByTurn?.at(-1);
	if (!turn) return undefined;
	const request = turn.requests.at(-1);
	// Compatibility with older snapshots. Whole-turn totals sum many requests and
	// cannot represent the occupancy of any single context window.
	if (!request || !sameModel(request.model)) return occupancy(null, "unknown");
	const usage = request.usage;
	const tokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
	return tokens > 0 ? occupancy(tokens, "request") : occupancy(null, "unknown");
}

/** Thresholds mirror the budget warnings: comfortable, tight, nearly full. */
export function contextLevel(ratio: number): "ok" | "warn" | "high" {
	if (ratio >= 0.9) return "high";
	if (ratio >= 0.75) return "warn";
	return "ok";
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
	return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

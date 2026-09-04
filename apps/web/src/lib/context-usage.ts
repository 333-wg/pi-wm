/**
 * Context-window occupancy, estimated from reported usage. The gateway does not
 * report how full the context is, so the closest honest proxy is what the model
 * last had to read (input + cache) plus what it wrote in the same request.
 */

import type { SessionSnapshot } from "@wuming/protocol";

export interface ContextUsage {
	tokens: number;
	contextWindow: number;
	/** Clamped to 1 so an over-budget estimate cannot overflow the bar. */
	ratio: number;
	/** Set when only whole-turn usage was available, which sums tool loops. */
	coarse: boolean;
}

export function estimateContext(snapshot: SessionSnapshot | undefined, contextWindow: number | undefined): ContextUsage | undefined {
	if (!snapshot || contextWindow === undefined || contextWindow <= 0) return undefined;
	const turn = snapshot.usageByTurn?.at(-1);
	if (!turn) return undefined;
	const request = turn.requests.at(-1);
	const usage = request?.usage ?? turn.usage;
	const tokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
	return { tokens, contextWindow, ratio: Math.min(1, tokens / contextWindow), coarse: request === undefined };
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

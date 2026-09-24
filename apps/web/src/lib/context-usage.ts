import type {
	ContextUsageState,
	PromptCacheDiagnostic,
	SessionSnapshot,
	Usage,
	UsageRequestSummary,
} from "@wuming/protocol";
import { sessionUsageRequests } from "@wuming/protocol";

export interface CacheUsage {
	inputTokens: number;
	readTokens: number;
	writeTokens: number;
	readKnown?: boolean;
	writeKnown?: boolean;
	/** Share of input tokens served from cache, not the share of requests that hit. */
	hitRatio: number | null;
}

export function cacheUsage(usage: Pick<Usage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">): CacheUsage {
	const inputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	return {
		inputTokens,
		readTokens: usage.cacheReadTokens,
		writeTokens: usage.cacheWriteTokens,
		hitRatio: inputTokens > 0 ? usage.cacheReadTokens / inputTokens : null,
	};
}

function requestCacheUsage(request: UsageRequestSummary): CacheUsage {
	const value = cacheUsage(request.usage);
	// Historical positive counts prove observation; historical zeros do not prove a miss.
	const readKnown =
		request.cacheUsageEvidence?.read === "reported" ||
		request.usage.cacheReadTokens > 0 ||
		request.dataSource === "demo";
	const writeKnown =
		request.cacheUsageEvidence?.write === "reported" ||
		request.usage.cacheWriteTokens > 0 ||
		request.dataSource === "demo";
	return { ...value, readKnown, writeKnown, hitRatio: readKnown ? value.hitRatio : null };
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	/** Clamped to 1 so an over-budget estimate cannot overflow the bar. */
	ratio: number | null;
	basis: ContextUsageState["basis"];
	cache?: {
		latest: CacheUsage | undefined;
		session: CacheUsage;
		requestCount: number;
		knownRequestCount: number;
		knownInputTokens: number;
		compactionCount: number;
		demo: boolean;
		awaitingRequest?: boolean;
		diagnostic?: PromptCacheDiagnostic;
	};
}

export function estimateContext(
	snapshot: SessionSnapshot | undefined,
	contextWindow: number | undefined
): ContextUsage | undefined {
	if (!snapshot || contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0)
		return undefined;
	const sameModel = (model: SessionSnapshot["model"]) =>
		model.provider === snapshot.model.provider && model.id === snapshot.model.id;
	const allRequests = sessionUsageRequests(snapshot).filter((request) => request.status !== "pending");
	const requests = allRequests.filter((request) => request.purpose !== "compaction");
	const latest = requests.at(-1);
	const values = requests.map(requestCacheUsage);
	const known = values.filter((value) => value.readKnown);
	const knownInputTokens = known.reduce((sum, value) => sum + value.inputTokens, 0);
	// Sum model requests only: session billing can also include media/tool usage.
	const session = cacheUsage(
		requests.reduce(
			(total, request) => ({
				inputTokens: total.inputTokens + request.usage.inputTokens,
				cacheReadTokens: total.cacheReadTokens + request.usage.cacheReadTokens,
				cacheWriteTokens: total.cacheWriteTokens + request.usage.cacheWriteTokens,
			}),
			{ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
		)
	);
	// Keep total token accounting intact; calculate the ratio only over observed reads.
	session.hitRatio =
		knownInputTokens > 0 ? known.reduce((sum, value) => sum + value.readTokens, 0) / knownInputTokens : null;
	session.readKnown = values.length > 0 && values.every((value) => value.readKnown);
	session.writeKnown = values.length > 0 && values.every((value) => value.writeKnown);
	const occupancy = (tokens: number | null, basis: ContextUsageState["basis"]): ContextUsage => ({
		tokens,
		contextWindow,
		ratio: tokens === null ? null : Math.min(1, tokens / contextWindow),
		basis,
		cache: {
			latest: latest && sameModel(latest.model) ? requestCacheUsage(latest) : undefined,
			session,
			requestCount: requests.length,
			knownRequestCount: known.length,
			knownInputTokens,
			compactionCount: allRequests.length - requests.length,
			demo: requests.some((request) => request.dataSource === "demo" || request.model.provider === "demo"),
			awaitingRequest: requests.length === 0 && snapshot.session.phase === "turn",
			...(latest && sameModel(latest.model) && latest.cacheDiagnostic ? { diagnostic: latest.cacheDiagnostic } : {}),
		},
	});
	// Explicit unknown values invalidate historical usage after compaction/model changes.
	if (snapshot.contextUsage) {
		const current = snapshot.contextUsage;
		return sameModel(current.model)
			? occupancy(current.basis === "unknown" ? null : current.tokens, current.basis)
			: occupancy(null, "unknown");
	}
	const request = allRequests.at(-1);
	if (request?.purpose === "compaction") return occupancy(null, "compaction");
	if (!request && !snapshot.usageByTurn?.length && snapshot.session.phase !== "turn") return undefined;
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

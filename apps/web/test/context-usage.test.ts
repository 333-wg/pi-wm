import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionSnapshot, Usage } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { estimateContext } from "../src/lib/context-usage.js";
import { ContextMeter, ContextPill } from "../src/components/ContextMeter.js";

const model = { provider: "test", id: "large" };
const usage: Usage = {
	inputTokens: 90000,
	outputTokens: 6000,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 96000,
	costUsd: 1,
};
const snapshot: SessionSnapshot = {
	session: { id: "s", workspaceId: "w", phase: "idle", createdAt: 1, updatedAt: 1 },
	revision: 1,
	model,
	thinkingLevel: "medium",
	sandboxMode: "workspace_write",
	approvalPolicy: "never",
	transcript: [],
	pendingApprovals: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	usage,
	usageByTurn: [
		{ turnId: "t", mode: "prompt", model, attempts: 1, usage, tools: [], requests: [{ requestId: "r", model, usage }] },
	],
};

describe("context occupancy", () => {
	it("prefers compacted occupancy over expensive summary request usage", () => {
		const value = estimateContext({ ...snapshot, contextUsage: { model, tokens: 12000, basis: "compaction" } }, 128000);
		expect(value).toEqual({ tokens: 12000, contextWindow: 128000, ratio: 0.09375, basis: "compaction" });
	});
	it("does not fall back to stale requests when compaction has no estimate", () => {
		expect(
			estimateContext({ ...snapshot, contextUsage: { model, tokens: null, basis: "compaction" } }, 128000)
		).toMatchObject({ tokens: null, ratio: null, basis: "compaction" });
	});
	it("does not apply old-model counts to a new window", () => {
		expect(
			estimateContext(
				{ ...snapshot, model: { ...model, id: "small" }, contextUsage: { model, tokens: 12000, basis: "request" } },
				8000
			)
		).toMatchObject({ tokens: null, ratio: null });
		expect(estimateContext({ ...snapshot, model: { ...model, id: "small" } }, 8000)).toMatchObject({ tokens: null });
	});
	it("can display legacy request estimates, but never sums a whole tool loop", () => {
		expect(estimateContext(snapshot, 128000)).toMatchObject({ tokens: 96000, ratio: 0.75, basis: "request" });
		const turn = snapshot.usageByTurn![0]!;
		expect(estimateContext({ ...snapshot, usageByTurn: [{ ...turn, requests: [] }] }, 128000)).toMatchObject({
			tokens: null,
		});
	});
	it("preserves raw over-limit counts while clamping the bar", () => {
		expect(
			estimateContext({ ...snapshot, contextUsage: { model, tokens: 130000, basis: "request" } }, 128000)
		).toMatchObject({ tokens: 130000, ratio: 1 });
	});
	it.each([undefined, 0, -1, NaN, Infinity])("rejects an invalid window %s", (window) => {
		expect(estimateContext(snapshot, window)).toBeUndefined();
	});
	it("renders unknown, estimated and zero values honestly in both controls", () => {
		const unknown = estimateContext(
			{ ...snapshot, contextUsage: { model, tokens: null, basis: "compaction" } },
			128000
		)!;
		const html = renderToStaticMarkup(createElement(ContextMeter, { usage: unknown }));
		expect(html).toContain("待更新");
		expect(html).toContain("已压缩");
		expect(html).not.toContain("NaN");
		expect(html).not.toContain("建议 /compact");
		expect(renderToStaticMarkup(createElement(ContextPill, { usage: unknown }))).toContain("待更新");
		const compacted = estimateContext(
			{ ...snapshot, contextUsage: { model, tokens: 12000, basis: "compaction" } },
			128000
		)!;
		expect(renderToStaticMarkup(createElement(ContextMeter, { usage: compacted }))).toContain("压缩后估算");
		const zero = estimateContext({ ...snapshot, contextUsage: { model, tokens: 0, basis: "compaction" } }, 128000)!;
		expect(zero.ratio).toBe(0);
		expect(renderToStaticMarkup(createElement(ContextMeter, { usage: zero }))).toContain("width:0%");
	});
});

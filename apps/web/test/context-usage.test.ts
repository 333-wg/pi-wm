import { createElement } from "react";
import { renderLocalized as renderToStaticMarkup } from "./render-localized.js";
import type { PromptCacheDiagnostic, SessionSnapshot, Usage } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { cacheUsage, estimateContext } from "../src/lib/context-usage.js";
import { ContextDetails, ContextMeter, ContextPill } from "../src/components/ContextMeter.js";

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
	it("retains completed cache observations while a new request is pending", () => {
		const hash = `sha256:${"a".repeat(64)}`;
		const cacheDiagnostic: PromptCacheDiagnostic = {
			basis: "provider_payload",
			change: "append_only",
			systemDigest: hash,
			toolsDigest: hash,
			historyDigest: hash,
			parametersDigest: hash,
			messageCount: 3,
			sharedPrefixMessages: 1,
		};
		const requests = [
			{ requestId: "done", model, usage, status: "complete" as const, cacheDiagnostic },
			{
				requestId: "waiting",
				model,
				usage: { ...usage, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				status: "pending" as const,
			},
		];
		const value = estimateContext({ ...snapshot, usageByTurn: [], usageRequests: requests }, 128000)!;
		expect(value.cache).toMatchObject({ requestCount: 1, diagnostic: cacheDiagnostic, latest: { inputTokens: 90000 } });
		expect(renderToStaticMarkup(createElement(ContextDetails, { usage: value }))).toContain("仅追加历史");
		expect(
			estimateContext({ ...snapshot, model: { ...model, id: "another" }, usageRequests: requests }, 128000)?.cache
				?.diagnostic
		).toBeUndefined();
	});
	it("prefers compacted occupancy over expensive summary request usage", () => {
		const value = estimateContext({ ...snapshot, contextUsage: { model, tokens: 12000, basis: "compaction" } }, 128000);
		expect(value).toMatchObject({ tokens: 12000, contextWindow: 128000, ratio: 0.09375, basis: "compaction" });
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

describe("context cache details", () => {
	it("shows live request observations before turn billing and keeps them after abort", () => {
		const request = { requestId: "live", model, usage: { ...usage, inputTokens: 100, cacheReadTokens: 900 } };
		for (const phase of ["turn", "idle"] as const) {
			const value = estimateContext(
				{
					...snapshot,
					session: { ...snapshot.session, phase },
					usageByTurn: [],
					usageRequests: [request],
					contextUsage: { model, tokens: 7000, basis: "request" },
				},
				128000
			)!;
			expect(value.cache).toMatchObject({ requestCount: 1, latest: { hitRatio: 0.9 }, session: { hitRatio: 0.9 } });
			const html = renderToStaticMarkup(createElement(ContextDetails, { usage: value }));
			expect(html).toContain("最近完成请求");
			expect(html).toContain("90.0%");
		}
	});
	it("labels the first pending request without presenting a zero request count", () => {
		const value = estimateContext(
			{
				...snapshot,
				usageByTurn: [],
				session: { ...snapshot.session, phase: "turn" },
				contextUsage: { model, tokens: null, basis: "unknown" },
			},
			128000
		)!;
		const html = renderToStaticMarkup(createElement(ContextDetails, { usage: value }));
		expect(html).toContain("等待首个请求用量");
		expect(html).not.toContain("0 次");
	});
	it("exposes the waiting state before a new session has any context observation", () => {
		const value = estimateContext(
			{ ...snapshot, usageByTurn: [], session: { ...snapshot.session, phase: "turn" } },
			128000
		)!;
		expect(value).toMatchObject({ tokens: null, cache: { awaitingRequest: true, requestCount: 0 } });
	});
	it("never counts finalized requests a second time after a live observation", () => {
		const request = snapshot.usageByTurn![0]!.requests[0]!;
		const value = estimateContext({ ...snapshot, usageRequests: [request] }, 128000)!;
		expect(value.cache?.requestCount).toBe(1);
		expect(value.cache?.session.inputTokens).toBe(90000);
	});
	it("uses all input categories but excludes output from the hit ratio", () => {
		expect(cacheUsage({ inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 })).toEqual({
			inputTokens: 1000,
			readTokens: 800,
			writeTokens: 100,
			hitRatio: 0.8,
		});
		expect(cacheUsage({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).hitRatio).toBeNull();
		expect(cacheUsage({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }).hitRatio).toBe(0);
		expect(cacheUsage({ inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 }).hitRatio).toBe(1);
	});
	it("separates latest request from token-weighted session totals and tool billing", () => {
		const first = { ...usage, inputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 };
		const last = { ...usage, inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 };
		const turn = snapshot.usageByTurn![0]!;
		const value = estimateContext(
			{
				...snapshot,
				usageByTurn: [
					{
						...turn,
						requests: [
							{ requestId: "r1", model, usage: first },
							{ requestId: "r2", model, usage: last },
						],
					},
				],
			},
			128000
		)!;
		expect(value.cache).toMatchObject({
			requestCount: 2,
			latest: { hitRatio: 1 },
			session: { inputTokens: 1000, hitRatio: 0.1 },
		});
		const html = renderToStaticMarkup(createElement(ContextDetails, { usage: value }));
		expect(html).toContain("100.0%");
		expect(html).toContain("10.0%");
		expect(html).toContain("缓存写入</th><td>0</td><td>0</td>");
		expect(html).toContain("输入总量</th><td>100</td><td>1,000</td>");
		expect(html).toContain('<details class="context-detail-disclosure">');
	});
	it("retains historical session statistics but never labels old-model usage as the current request", () => {
		const value = estimateContext({ ...snapshot, model: { ...model, id: "small" } }, 8000)!;
		expect(value.cache?.latest).toBeUndefined();
		expect(value.cache?.session.inputTokens).toBe(90000);
		expect(renderToStaticMarkup(createElement(ContextDetails, { usage: value }))).toContain("暂无数据");
	});
	it("keeps native tooltips empty and makes both triggers accessible buttons", () => {
		const value = estimateContext(snapshot, 128000)!;
		for (const component of [ContextPill, ContextMeter]) {
			const html = renderToStaticMarkup(createElement(component, { usage: value }));
			expect(html).toContain('<button type="button"');
			expect(html).toContain('aria-haspopup="dialog"');
			expect(html).toContain('aria-expanded="false"');
			expect(html).not.toContain("title=");
			expect(html).not.toContain("缓存命中率");
		}
	});
	it("does not invent request statistics from legacy session totals", () => {
		const value = estimateContext(
			{ ...snapshot, usageByTurn: [], contextUsage: { model, tokens: 12000, basis: "compaction" } },
			128000
		)!;
		expect(value.cache).toMatchObject({ latest: undefined, requestCount: 0, session: { hitRatio: null } });
		expect(renderToStaticMarkup(createElement(ContextPill, { usage: value }))).not.toContain("NaN");
	});
});

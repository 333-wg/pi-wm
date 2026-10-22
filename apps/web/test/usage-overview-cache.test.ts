import { describe, expect, it, vi } from "vitest";
import type { UsageOverview } from "@wuming/protocol";
import { UsageOverviewCache, USAGE_FRESH_MS } from "../src/lib/usage-overview-cache.js";

function overview(tokens = 10, workspaceId?: string, days = 7): UsageOverview {
	const usage = {
		inputTokens: tokens,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: tokens,
		costUsd: 0,
	};
	return {
		...(workspaceId ? { workspaceId } : {}),
		generatedAt: Date.now(),
		total: usage,
		today: usage,
		month: usage,
		totalTurnCount: 1,
		totalRequestCount: 1,
		daily: Array.from({ length: days }, () => ({ date: "2026-10-21", usage, turnCount: 1, requestCount: 1 })),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("usage overview cache", () => {
	it("shares in-flight requests and reuses fresh results when a panel reopens", async () => {
		const response = deferred<UsageOverview>();
		const fetch = vi.fn(() => response.promise);
		const cache = new UsageOverviewCache(fetch);
		const first = cache.load();
		expect(cache.load()).toBe(first);
		expect(cache.load(undefined, 7, true)).toBe(first);
		response.resolve(overview());
		const data = await first;
		expect(cache.getState().data).toBe(data);
		expect(await cache.load()).toBe(data);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("retains data during expired/forced refresh and after a failure, then retries", async () => {
		let now = new Date(2026, 9, 21, 12).getTime();
		const response = deferred<UsageOverview>();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(overview())
			.mockImplementationOnce(() => response.promise)
			.mockResolvedValue(overview(20));
		const cache = new UsageOverviewCache(fetch, () => now);
		const previous = await cache.load();
		now += USAGE_FRESH_MS;
		const refresh = cache.load();
		expect(cache.getState()).toMatchObject({ data: previous, loading: true });
		const rejected = expect(refresh).rejects.toThrow("offline");
		response.reject(new Error("offline"));
		await rejected;
		expect(cache.getState()).toMatchObject({ data: previous, loading: false, error: "offline" });
		await cache.load(undefined, 7, true);
		expect(cache.getState().data?.total.totalTokens).toBe(20);
		expect(cache.getState().error).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(3);
		await cache.load(undefined, 7, true);
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it("keeps workspaces, all-workspace totals and ranges separate even with late responses", async () => {
		const slow = deferred<UsageOverview>();
		const fetch = vi.fn((workspaceId?: string, days = 7) =>
			workspaceId === "slow" ? slow.promise : Promise.resolve(overview(20, workspaceId, days))
		);
		const cache = new UsageOverviewCache(fetch);
		const pending = cache.load("slow");
		await cache.load();
		await cache.load("fast", 30);
		expect(cache.getState("fast", 7).data).toBeUndefined();
		expect(cache.getState("fast", 30).data?.daily).toHaveLength(30);
		slow.resolve(overview(100, "slow"));
		await pending;
		expect(cache.getState().data?.total.totalTokens).toBe(20);
		expect(cache.getState("fast", 30).data?.total.totalTokens).toBe(20);
		expect(cache.getState("slow").data?.total.totalTokens).toBe(100);
	});

	it("refreshes after a usage event and does not accept a response invalidated in flight", async () => {
		const response = deferred<UsageOverview>();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(overview())
			.mockImplementationOnce(() => response.promise)
			.mockResolvedValue(overview(30));
		const cache = new UsageOverviewCache(fetch);
		await cache.load();
		cache.invalidate();
		const refresh = cache.load();
		await Promise.resolve();
		cache.invalidate();
		response.resolve(overview(20));
		expect((await refresh)?.total.totalTokens).toBe(30);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(cache.getState().data?.total.totalTokens).toBe(30);
	});

	it("drops old connection responses after clearing the cache", async () => {
		const response = deferred<UsageOverview>();
		const fetch = vi
			.fn()
			.mockImplementationOnce(() => response.promise)
			.mockResolvedValue(overview(40));
		const cache = new UsageOverviewCache(fetch);
		const old = cache.load();
		await Promise.resolve();
		cache.clear();
		expect(cache.getState().data).toBeUndefined();
		await cache.load();
		response.resolve(overview(10));
		expect(await old).toBeUndefined();
		expect(cache.getState().data?.total.totalTokens).toBe(40);
		const otherClient = new UsageOverviewCache(fetch);
		expect(otherClient.getState().data).toBeUndefined();
	});

	it("refreshes across midnight even within the freshness interval", async () => {
		let now = new Date(2026, 9, 31, 23, 59, 59).getTime();
		const fetch = vi.fn(async () => overview());
		const cache = new UsageOverviewCache(fetch, () => now);
		await cache.load();
		now += 2_000;
		await cache.load();
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

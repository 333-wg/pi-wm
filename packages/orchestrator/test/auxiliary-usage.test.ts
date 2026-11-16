import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SqliteOrchestratorStore } from "../src/store.js";

it("persists auxiliary usage, invalidates caches and respects workspace and calendar scopes", async () => {
	const root = await mkdtemp(join(tmpdir(), "auxiliary-usage-"));
	const path = join(root, "usage.db");
	let store = new SqliteOrchestratorStore(path);
	const reader = new SqliteOrchestratorStore(path);
	const now = new Date(2026, 10, 16, 12).getTime();
	const usage = {
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 2,
		cacheWriteTokens: 1,
		totalTokens: 18,
		costUsd: 0.01,
	};
	const record = {
		requestId: "today",
		workspaceId: "visible",
		purpose: "prompt_optimization" as const,
		model: { provider: "test", id: "model" },
		usage,
		timestamp: now,
	};
	try {
		expect(store.usageOverview(undefined, now).totalRequestCount).toBe(0);
		expect(reader.usageOverview(undefined, now).totalRequestCount).toBe(0);
		expect(store.recordAuxiliaryUsage(record)).toBe(true);
		expect(store.recordAuxiliaryUsage(record)).toBe(false);
		store.recordAuxiliaryUsage({ ...record, requestId: "yesterday", timestamp: new Date(2026, 10, 15, 12).getTime() });
		store.recordAuxiliaryUsage({ ...record, requestId: "last-month", timestamp: new Date(2026, 9, 16, 12).getTime() });
		store.recordAuxiliaryUsage({ ...record, requestId: "hidden", workspaceId: "hidden" });
		store.recordAuxiliaryUsage({ ...record, requestId: "future", timestamp: new Date(2026, 10, 17, 12).getTime() });
		const overview = store.usageOverview("visible", now);
		expect(overview).toMatchObject({
			total: { totalTokens: 54 },
			today: usage,
			month: { totalTokens: 36 },
			totalTurnCount: 0,
			totalRequestCount: 3,
			auxiliary: { requestCount: 3, usage: { totalTokens: 54 } },
		});
		expect(overview.daily.at(-1)).toMatchObject({ usage, requestCount: 1, turnCount: 0 });
		expect(reader.usageOverview(undefined, now).totalRequestCount).toBe(4);
		expect(store.usageOverview(["hidden"], now).total).toEqual(usage);
		expect(store.usageOverview([], now).totalRequestCount).toBe(0);
		store.close();
		store = new SqliteOrchestratorStore(path);
		expect(store.usageOverview("visible", now)).toEqual(overview);
		expect(store.usageOverview("visible", new Date(2026, 10, 17, 12).getTime()).totalRequestCount).toBe(4);
		expect(() =>
			store.recordAuxiliaryUsage({ ...record, requestId: "invalid", usage: { ...usage, costUsd: -1 } })
		).toThrow("Invalid auxiliary usage");
	} finally {
		reader.close();
		store.close();
		await rm(root, { recursive: true, force: true });
	}
});

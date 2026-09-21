import { reduceSessionEvent, type SessionEvent } from "@wuming/domain";
import type { AgentRuntime } from "../src/types.js";
import { describe, expect, it } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore } from "../src/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const usage = (totalTokens: number, costUsd: number) => ({
	inputTokens: totalTokens,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens,
	costUsd,
});

describe("workspace usage overview", () => {
	it("retains all-workspace totals across archive, scope changes, and database reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "usage-overview-"));
		let store = new SqliteOrchestratorStore(join(root, "usage.db"));
		try {
			let sequence = 0;
			const now = new Date(2026, 8, 20, 12).getTime();
			const orchestrator = new SessionOrchestrator(
				store,
				{
					async executeTurn() {
						return { items: [] };
					},
				},
				{
					clock: () => now,
					idFactory: () => `usage-${++sequence}`,
				}
			);
			for (const [workspaceId, tokens] of [
				["visible", 100],
				["hidden", 200],
				["unregistered", 300],
			] as const) {
				const { snapshot } = await orchestrator.createSession({
					principalId: "user",
					idempotencyKey: workspaceId,
					workspaceId,
					model: { provider: "test", id: "model" },
					thinkingLevel: "medium",
					sandboxMode: "workspace_write",
					approvalPolicy: "on_risk",
				});
				const event: SessionEvent = {
					type: "session.usage.recorded",
					eventId: `event-${++sequence}`,
					sessionId: snapshot.session.id,
					revision: snapshot.revision + 1,
					timestamp: now,
					turnId: `turn-${sequence}`,
					mode: "prompt",
					model: snapshot.model,
					attempt: 1,
					usage: usage(tokens, tokens / 1000),
					tools: [],
					requests: [{ requestId: `request-${sequence}`, model: snapshot.model, usage: usage(tokens, tokens / 1000) }],
				};
				store.commitMutation({
					sessionId: snapshot.session.id,
					expectedRevision: snapshot.revision,
					events: [event],
					snapshot: reduceSessionEvent(snapshot, event),
				});
				await orchestrator.archiveSession({
					principalId: "user",
					idempotencyKey: `archive-${workspaceId}`,
					sessionId: snapshot.session.id,
					archived: true,
				});
			}
			const total = store.usageOverview(undefined, now);
			expect(total.workspaceId).toBeUndefined();
			expect(total).toMatchObject({
				total: { totalTokens: 600, costUsd: expect.closeTo(0.6) },
				today: { totalTokens: 600 },
				month: { totalTokens: 600 },
				totalTurnCount: 3,
				totalRequestCount: 3,
			});
			expect(total.daily.at(-1)).toMatchObject({ usage: { totalTokens: 600 }, turnCount: 3, requestCount: 3 });
			expect(store.usageOverview("visible", now)).toMatchObject({
				workspaceId: "visible",
				total: { totalTokens: 100 },
			});
			expect(store.usageOverview(["visible", "hidden"], now).total.totalTokens).toBe(300);
			expect(store.usageOverview([], now).total.totalTokens).toBe(0);
			store.close();
			store = new SqliteOrchestratorStore(join(root, "usage.db"));
			expect(store.usageOverview(undefined, now)).toEqual(total);
			expect(store.usageOverview(undefined, now, 30).total).toEqual(total.total);
		} finally {
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("aggregates local calendar periods and avoids double counting child sessions", async () => {
		let sequence = 0;
		const now = new Date(2026, 8, 4, 12).getTime();
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime: AgentRuntime = {
			async executeTurn() {
				return { items: [] };
			},
		};
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => now,
			idFactory: () => `usage-${++sequence}`,
		});
		const parent = await orchestrator.createSession({
			principalId: "user-1",
			idempotencyKey: "create-parent",
			workspaceId: "workspace-1",
			model: { provider: "test", id: "model" },
			thinkingLevel: "medium",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		});

		const record = (sessionId: string, timestamp: number, totalTokens: number, costUsd: number) => {
			const current = store.loadSnapshot(sessionId)!;
			const eventUsage = usage(totalTokens, costUsd);
			const event: SessionEvent = {
				type: "session.usage.recorded",
				eventId: `event-${++sequence}`,
				sessionId,
				revision: current.revision + 1,
				timestamp,
				turnId: `turn-${sequence}`,
				mode: "prompt",
				model: { provider: "test", id: "model" },
				attempt: 1,
				usage: eventUsage,
				tools: [],
				requests: [
					{
						requestId: `request-${sequence}`,
						model: { provider: "test", id: "model" },
						usage: eventUsage,
					},
				],
			};
			store.commitMutation({
				sessionId,
				expectedRevision: current.revision,
				events: [event],
				snapshot: reduceSessionEvent(current, event),
			});
		};

		record(parent.snapshot.session.id, new Date(2025, 11, 1, 9).getTime(), 4_000, 0.4);
		record(parent.snapshot.session.id, new Date(2026, 8, 3, 16).getTime(), 1_000, 0.1);
		record(parent.snapshot.session.id, new Date(2026, 8, 4, 9).getTime(), 2_000, 0.2);
		const child = await orchestrator.createSubagent({
			principalId: "user-1",
			idempotencyKey: "create-child",
			sessionId: parent.snapshot.session.id,
			task: "Check usage",
		});
		record(child.subagent.sessionId, new Date(2026, 8, 4, 10).getTime(), 2_000, 0.2);

		const overview = store.usageOverview("workspace-1", now, 7);
		expect(overview.total).toMatchObject({ totalTokens: 7_000, costUsd: expect.closeTo(0.7) });
		expect(overview.totalTurnCount).toBe(3);
		expect(overview.totalRequestCount).toBe(3);
		expect(store.usageOverview(undefined, now, 7).total).toEqual(overview.total);
		expect(overview.today).toMatchObject({ totalTokens: 2_000, costUsd: 0.2 });
		expect(overview.month).toMatchObject({ totalTokens: 3_000, costUsd: expect.closeTo(0.3) });
		expect(overview.daily).toHaveLength(7);
		expect(overview.daily.at(-2)).toMatchObject({
			date: "2026-09-03",
			usage: { totalTokens: 1_000 },
			turnCount: 1,
			requestCount: 1,
		});
		expect(overview.daily.at(-1)).toMatchObject({
			date: "2026-09-04",
			usage: { totalTokens: 2_000 },
			turnCount: 1,
			requestCount: 1,
		});
		store.close();
	});
});

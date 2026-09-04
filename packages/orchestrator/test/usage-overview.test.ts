import { reduceSessionEvent, type SessionEvent } from "@wuming/domain";
import type { AgentRuntime } from "../src/types.js";
import { describe, expect, it } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore } from "../src/index.js";

const usage = (totalTokens: number, costUsd: number) => ({
	inputTokens: totalTokens,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens,
	costUsd,
});

describe("workspace usage overview", () => {
	it("aggregates local calendar periods and avoids double counting child sessions", async () => {
		let sequence = 0;
		const now = new Date(2026, 8, 4, 12).getTime();
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime: AgentRuntime = { async executeTurn() { return { items: [] }; } };
		const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => now, idFactory: () => `usage-${++sequence}` });
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
				requests: [{ requestId: `request-${sequence}`, model: { provider: "test", id: "model" }, usage: eventUsage }],
			};
			store.commitMutation({ sessionId, expectedRevision: current.revision, events: [event], snapshot: reduceSessionEvent(current, event) });
		};

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
		expect(overview.today).toMatchObject({ totalTokens: 2_000, costUsd: 0.2 });
		expect(overview.month).toMatchObject({ totalTokens: 3_000, costUsd: expect.closeTo(0.3) });
		expect(overview.daily).toHaveLength(7);
		expect(overview.daily.at(-2)).toMatchObject({ date: "2026-09-03", usage: { totalTokens: 1_000 }, turnCount: 1, requestCount: 1 });
		expect(overview.daily.at(-1)).toMatchObject({ date: "2026-09-04", usage: { totalTokens: 2_000 }, turnCount: 1, requestCount: 1 });
		store.close();
	});
});

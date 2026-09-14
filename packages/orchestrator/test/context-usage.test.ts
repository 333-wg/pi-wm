import { afterEach, describe, expect, it } from "vitest";
import { replaySessionEvents } from "@wuming/domain";
import { SessionOrchestrator, SqliteOrchestratorStore, type AgentRuntime } from "../src/index.js";

const stores: SqliteOrchestratorStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function setup(runtime: AgentRuntime) {
	const store = new SqliteOrchestratorStore(":memory:");
	stores.push(store);
	let seq = 0;
	const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => 100, idFactory: () => `id-${++seq}` });
	const created = await orchestrator.createSession({
		principalId: "u",
		idempotencyKey: "create",
		workspaceId: "w",
		model: { provider: "test", id: "large" },
		thinkingLevel: "medium",
		sandboxMode: "workspace_write",
		approvalPolicy: "never",
	});
	return { store, orchestrator, sessionId: created.snapshot.session.id, model: created.snapshot.model };
}

describe("durable context occupancy", () => {
	it("forwards preflight compaction progress even when context preparation fails", async () => {
		const statuses: string[] = [];
		const { orchestrator, sessionId } = await setup({
			resolveContext: async (input) => {
				input.onProgress?.({ type: "context.compaction", sessionId: input.snapshot.session.id, status: "running" });
				input.onProgress?.({ type: "context.compaction", sessionId: input.snapshot.session.id, status: "failed" });
				throw new Error("Compaction failed during preflight");
			},
			executeTurn: async () => {
				throw new Error("Must not execute after failed preflight");
			},
		});
		orchestrator.subscribeProgress((event) => {
			if (event.type === "context.compaction") statuses.push(event.status);
		});
		await orchestrator.acceptTurn({
			principalId: "u",
			idempotencyKey: "turn",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "continue" }],
		});
		await orchestrator.drainSession(sessionId, "worker");
		expect(statuses).toEqual(["running", "failed"]);
	});
	it.each([220, undefined])(
		"persists manual compaction occupancy %s without altering consumption",
		async (estimatedTokensAfter) => {
			const { store, orchestrator, sessionId, model } = await setup({
				executeTurn: async () => ({ items: [] }),
				compact: async () => ({
					summary: "Keep the decision",
					...(estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter }),
				}),
			});
			const result = await orchestrator.compactSession({ principalId: "u", idempotencyKey: "compact", sessionId });
			expect(result.snapshot.contextUsage).toEqual({
				model,
				tokens: estimatedTokensAfter ?? null,
				basis: "compaction",
			});
			expect(result.snapshot.usage.totalTokens).toBe(0);
			expect(replaySessionEvents(store.loadEvents(sessionId))?.contextUsage).toEqual(result.snapshot.contextUsage);
			expect(
				(await orchestrator.compactSession({ principalId: "u", idempotencyKey: "compact", sessionId })).snapshot
			).toEqual(result.snapshot);
		}
	);

	it("makes occupancy durable during execution, even when a later request fails", async () => {
		let readDuringRun: (() => void) | undefined;
		const { store, orchestrator, sessionId, model } = await setup({
			executeTurn: async (input) => {
				input.onContextUsage?.({ model: input.snapshot.model, tokens: 96000, basis: "request" });
				input.onContextUsage?.({ model: input.snapshot.model, tokens: 12000, basis: "compaction" });
				readDuringRun?.();
				throw new Error("Provider failed after compaction");
			},
		});
		readDuringRun = () =>
			expect(store.loadSnapshot(sessionId)?.contextUsage).toEqual({ model, tokens: 12000, basis: "compaction" });
		await orchestrator.acceptTurn({
			principalId: "u",
			idempotencyKey: "turn",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "continue" }],
		});
		await orchestrator.drainSession(sessionId, "worker");
		expect(store.loadSnapshot(sessionId)?.contextUsage).toEqual({ model, tokens: 12000, basis: "compaction" });
		expect(replaySessionEvents(store.loadEvents(sessionId))?.contextUsage).toEqual(
			store.loadSnapshot(sessionId)?.contextUsage
		);
		const changed = await orchestrator.setSessionModel({
			principalId: "u",
			idempotencyKey: "model",
			sessionId,
			model: { provider: "test", id: "small" },
		});
		expect(changed.snapshot.contextUsage).toEqual({ model: changed.snapshot.model, tokens: null, basis: "unknown" });
	});

	it("ignores mismatched-model updates and deduplicates identical observations", async () => {
		const { store, orchestrator, sessionId, model } = await setup({
			executeTurn: async (input) => {
				const context = { model: input.snapshot.model, tokens: 40, basis: "request" as const };
				input.onContextUsage?.(context);
				input.onContextUsage?.(context);
				input.onContextUsage?.({ ...context, model: { ...context.model, id: "other" }, tokens: 999 });
				return { items: [] };
			},
		});
		await orchestrator.acceptTurn({
			principalId: "u",
			idempotencyKey: "turn",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "continue" }],
		});
		await orchestrator.drainSession(sessionId, "worker");
		expect(store.loadSnapshot(sessionId)?.contextUsage).toEqual({ model, tokens: 40, basis: "request" });
		expect(store.loadEvents(sessionId).filter((event) => event.type === "session.context.updated")).toHaveLength(1);
	});
});

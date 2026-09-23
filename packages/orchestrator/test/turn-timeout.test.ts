import { afterEach, expect, it, vi } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore } from "../src/index.js";
import type { AgentRuntime, RuntimeTurnResult } from "../src/types.js";

const stores: SqliteOrchestratorStore[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const store of stores.splice(0)) store.close();
});

async function setup(turnTimeoutMs?: number) {
	// Advance deadlines without expiring the real-time writer lease or polling thousands of times.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const store = new SqliteOrchestratorStore(":memory:");
	stores.push(store);
	let finish!: () => void;
	let signal!: AbortSignal;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const runtime: AgentRuntime = {
		async executeTurn(input): Promise<RuntimeTurnResult> {
			signal = input.signal;
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				finish = () => {
					signal.removeEventListener("abort", abort);
					resolve();
				};
				started();
			});
			return { items: [] };
		},
	};
	const orchestrator = new SessionOrchestrator(store, runtime, turnTimeoutMs === undefined ? {} : { turnTimeoutMs });
	const created = await orchestrator.createSession({
		principalId: "user",
		idempotencyKey: "create",
		workspaceId: "workspace",
		model: { provider: "test", id: "test" },
		thinkingLevel: "off",
		sandboxMode: "workspace_write",
		approvalPolicy: "never",
	});
	const sessionId = created.snapshot.session.id;
	await orchestrator.acceptTurn({
		principalId: "user",
		idempotencyKey: "prompt",
		sessionId,
		mode: "prompt",
		content: [{ type: "text", text: "long task" }],
	});
	const draining = orchestrator.drainSession(sessionId);
	await ready;
	return { store, orchestrator, sessionId, draining, signal, finish };
}

it.each([undefined, 0])("does not abort long turns when the deadline is %s", async (timeout) => {
	const { store, sessionId, draining, signal, finish } = await setup(timeout);
	await vi.advanceTimersByTimeAsync(60 * 60_000);
	expect(signal.aborted).toBe(false);
	expect(store.listOperations(sessionId)[0]?.status).toBe("running");
	finish();
	await draining;
	expect(store.listOperations(sessionId)[0]?.status).toBe("completed");
	expect(vi.getTimerCount()).toBe(0);
});

it("still allows the user to stop a turn without a deadline", async () => {
	const { store, orchestrator, sessionId, draining, signal } = await setup();
	await vi.advanceTimersByTimeAsync(60 * 60_000);
	await orchestrator.abortTurn({ principalId: "user", idempotencyKey: "stop", sessionId });
	await draining;
	expect(signal.aborted).toBe(true);
	expect(store.listOperations(sessionId)[0]).toMatchObject({
		status: "interrupted",
		failureKind: "user_abort",
	});
	expect(vi.getTimerCount()).toBe(0);
});

it("honors an explicitly configured positive deadline", async () => {
	const { store, sessionId, draining, signal } = await setup(1_000);
	await vi.advanceTimersByTimeAsync(999);
	expect(signal.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	await draining;
	expect(signal.aborted).toBe(true);
	expect(store.listOperations(sessionId)[0]).toMatchObject({ status: "failed", error: "Turn timed out" });
	expect(vi.getTimerCount()).toBe(0);
});

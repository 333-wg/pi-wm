import { afterEach, expect, it, vi } from "vitest";
import { reduceSessionEvent, replaySessionEvents } from "@wuming/domain";
import { CapabilityRegistry } from "@wuming/capability-kernel";
import { SessionOrchestrator, SqliteOrchestratorStore } from "../src/index.js";
import type { AgentRuntime, RuntimeTurnResult } from "../src/types.js";

class ControlledRuntime implements AgentRuntime {
	readonly calls: Array<Parameters<AgentRuntime["executeTurn"]>[0]> = [];
	readonly finish: Array<() => void> = [];
	readonly injectTurn = vi.fn(async () => {});
	readonly forceTerminate = vi.fn(async () => {});
	ignoreFirstAbort = false;
	store!: SqliteOrchestratorStore;

	async resolveCapabilities(input: Parameters<NonNullable<AgentRuntime["resolveCapabilities"]>>[0]) {
		return new CapabilityRegistry().resolve({
			workspaceId: input.snapshot.session.workspaceId,
			sessionId: input.snapshot.session.id,
			turnId: input.operation.id,
			model: input.snapshot.model,
			sandboxMode: input.snapshot.sandboxMode,
			approvalPolicy: input.snapshot.approvalPolicy,
		});
	}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		expect(this.store.getOperation(input.operation.id)?.capabilityPlan).toEqual(input.capabilityPlan);
		const index = this.calls.push(input) - 1;
		input.onTranscriptItem?.({
			id: input.operation.id + ":partial",
			type: "assistant",
			status: "streaming",
			createdAt: Date.now(),
			content: [{ type: "text", text: "retained progress" }],
			model: input.snapshot.model,
		});
		await new Promise<void>((resolve, reject) => {
			const abort = () => reject(input.signal.reason);
			this.finish.push(() => {
				input.signal.removeEventListener("abort", abort);
				resolve();
			});
			if (!(index === 0 && this.ignoreFirstAbort)) {
				if (input.signal.aborted) abort();
				else input.signal.addEventListener("abort", abort, { once: true });
			}
		});
		return { items: [] };
	}
}

const stores: SqliteOrchestratorStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function setup() {
	const store = new SqliteOrchestratorStore(":memory:");
	stores.push(store);
	const runtime = new ControlledRuntime();
	runtime.store = store;
	const worker = new SessionOrchestrator(store, runtime, { abortGraceMs: 15, forceTerminateTimeoutMs: 15 });
	const controller = new SessionOrchestrator(store, runtime);
	const created = await worker.createSession({
		principalId: "user",
		idempotencyKey: "create",
		workspaceId: "workspace",
		model: { provider: "test", id: "test" },
		thinkingLevel: "off",
		sandboxMode: "workspace_write",
		approvalPolicy: "never",
	});
	const sessionId = created.snapshot.session.id;
	const send = (mode: "prompt" | "steer" | "follow_up", text: string, target = controller) =>
		target.acceptTurn({
			principalId: "user",
			idempotencyKey: text,
			sessionId,
			mode,
			content: [{ type: "text", text }],
		});
	const waitCalls = (count: number) => vi.waitFor(() => expect(runtime.calls).toHaveLength(count));
	return { store, runtime, worker, controller, sessionId, send, waitCalls };
}

it.each([false, true])(
	"interrupts immediately, preserves context and prioritizes steer (remote=%s)",
	async (remote) => {
		const { store, runtime, worker, controller, sessionId, send, waitCalls } = await setup();
		await send("prompt", "original");
		const draining = worker.drainSession(sessionId);
		await waitCalls(1);
		await send("follow_up", "later");
		expect(runtime.calls[0]!.signal.aborted).toBe(false);
		await send("steer", "change direction", remote ? controller : worker);
		expect(store.getOperation(runtime.calls[0]!.operation.id)?.abortRequested).toBe(true);
		if (!remote) expect(runtime.calls[0]!.signal.aborted).toBe(true);
		await waitCalls(2);
		expect(runtime.calls[1]!.operation.payload.mode).toBe("steer");
		expect(store.getOperation(runtime.calls[0]!.operation.id)?.status).toBe("interrupted");
		expect(runtime.calls[1]!.snapshot.transcript).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: runtime.calls[0]!.operation.id + ":partial", status: "aborted" }),
			])
		);
		expect(store.listOperations(sessionId).find((op) => op.payload.mode === "follow_up")?.status).toBe("queued");
		expect(runtime.injectTurn).not.toHaveBeenCalled();
		// A retried command must not interrupt the replacement execution.
		await send("steer", "change direction", remote ? controller : worker);
		expect(runtime.calls[1]!.signal.aborted).toBe(false);
		runtime.finish[1]!();
		await waitCalls(3);
		expect(runtime.calls[2]!.operation.payload.mode).toBe("follow_up");
		runtime.finish[2]!();
		await expect(draining).resolves.toBe(3);
		expect(store.loadSnapshot(sessionId)).toMatchObject({
			session: { phase: "idle" },
			queuedSteerCount: 0,
			queuedFollowUpCount: 0,
		});
		expect(store.loadSnapshot(sessionId)).toEqual(replaySessionEvents(store.loadEvents(sessionId)));
	}
);

it("runs follow-ups only after completion, in acceptance order even at identical timestamps", async () => {
	const { store, runtime, worker, sessionId, send, waitCalls } = await setup();
	await send("prompt", "original");
	const draining = worker.drainSession(sessionId);
	await waitCalls(1);
	const acceptedAt = Date.now();
	const controller = new SessionOrchestrator(store, runtime, { clock: () => acceptedAt });
	await send("follow_up", "first", controller);
	await send("follow_up", "second", controller);
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(runtime.calls).toHaveLength(1);
	expect(runtime.injectTurn).not.toHaveBeenCalled();
	expect(store.loadSnapshot(sessionId)?.queuedFollowUpCount).toBe(2);
	runtime.finish[0]!();
	await waitCalls(2);
	expect(runtime.calls[1]!.operation.payload.content).toEqual([{ type: "text", text: "first" }]);
	runtime.finish[1]!();
	await waitCalls(3);
	expect(runtime.calls[2]!.operation.payload.content).toEqual([{ type: "text", text: "second" }]);
	runtime.finish[2]!();
	await expect(draining).resolves.toBe(3);
	expect(store.listOperations(sessionId).every((op) => op.status === "completed")).toBe(true);
});

it.each(["steer", "follow_up"] as const)("accepts %s when the preceding turn just finished", async (mode) => {
	const { store, runtime, worker, sessionId, send, waitCalls } = await setup();
	await send(mode, "arrived after completion");
	expect(store.loadSnapshot(sessionId)?.session.phase).toBe("turn");
	const draining = worker.drainSession(sessionId);
	await waitCalls(1);
	runtime.finish[0]!();
	await expect(draining).resolves.toBe(1);
	expect(store.loadSnapshot(sessionId)).toMatchObject({
		session: { phase: "idle" },
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
	});
});

it("interrupts consecutive active steers without losing pending follow-ups", async () => {
	const { runtime, worker, sessionId, send, waitCalls } = await setup();
	await send("prompt", "original");
	const draining = worker.drainSession(sessionId);
	await waitCalls(1);
	await send("follow_up", "later");
	await send("steer", "first correction", worker);
	await waitCalls(2);
	await send("steer", "second correction", worker);
	await waitCalls(3);
	expect(runtime.calls[1]!.signal.aborted).toBe(true);
	expect(runtime.calls[2]!.operation.payload.content).toEqual([{ type: "text", text: "second correction" }]);
	runtime.finish[2]!();
	await waitCalls(4);
	expect(runtime.calls[3]!.operation.payload.mode).toBe("follow_up");
	runtime.finish[3]!();
	await expect(draining).resolves.toBe(4);
});

it("does not wait for an original request that has not started yet", async () => {
	const { store, runtime, worker, sessionId, send, waitCalls } = await setup();
	await send("prompt", "not started");
	await send("follow_up", "later");
	await send("steer", "correction before startup");
	const draining = worker.drainSession(sessionId);
	await waitCalls(1);
	expect(runtime.calls[0]!.operation.payload.mode).toBe("steer");
	expect(store.listOperations(sessionId).find((op) => op.payload.mode === "prompt")?.status).toBe("interrupted");
	expect(runtime.calls[0]!.snapshot.transcript).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "user", content: [{ type: "text", text: "not started" }] }),
		])
	);
	runtime.finish[0]!();
	await waitCalls(2);
	runtime.finish[1]!();
	await expect(draining).resolves.toBe(3);
});

it("force-terminates an uncooperative turn before starting the immediate input", async () => {
	const { runtime, worker, sessionId, send, waitCalls } = await setup();
	runtime.ignoreFirstAbort = true;
	await send("prompt", "original");
	const draining = worker.drainSession(sessionId);
	await waitCalls(1);
	await send("steer", "replace stalled execution", worker);
	await waitCalls(2);
	expect(runtime.forceTerminate).toHaveBeenCalledWith(sessionId);
	runtime.finish[1]!();
	await expect(draining).resolves.toBe(2);
	// A late result from the cancelled request cannot replace the new result.
	runtime.finish[0]!();
});

it.each(["steer", "follow_up"] as const)(
	"handles %s while a recovered operation has no active runtime",
	async (mode) => {
		const { store, runtime, worker, sessionId, send, waitCalls } = await setup();
		await send("prompt", "waiting after restart");
		const previous = store.claimNextOperation(sessionId, Date.now())!;
		await send(mode, "new request");
		if (mode === "follow_up") {
			await expect(worker.drainSession(sessionId)).resolves.toBe(0);
			expect(runtime.calls).toHaveLength(0);
			expect(store.getOperation(previous.id)?.status).toBe("running");
		} else {
			const draining = worker.drainSession(sessionId);
			await waitCalls(1);
			expect(store.getOperation(previous.id)?.status).toBe("interrupted");
			runtime.finish[0]!();
			await expect(draining).resolves.toBe(1);
		}
	}
);

it("does not delay immediate input behind a recovered retry backoff", async () => {
	const { store, runtime, worker, sessionId, send, waitCalls } = await setup();
	await send("prompt", "retrying original");
	const previous = store.claimNextOperation(sessionId, Date.now())!;
	const snapshot = store.loadSnapshot(sessionId)!;
	const event = {
		type: "session.phase.changed" as const,
		eventId: "retry-event",
		sessionId,
		revision: snapshot.revision + 1,
		timestamp: Date.now(),
		phase: "retry" as const,
	};
	store.commitMutation({
		sessionId,
		expectedRevision: snapshot.revision,
		events: [event],
		snapshot: reduceSessionEvent(snapshot, event),
		retryOperation: { id: previous.id, error: "temporary failure", retryAfter: Date.now() + 60000, retryHistory: [] },
	});
	expect(store.recoverRetryOperation(previous.id, Date.now())).toBe(true);
	await send("steer", "correct the retry");
	const draining = worker.drainSession(sessionId);
	await waitCalls(1);
	expect(runtime.calls[0]!.operation.payload.mode).toBe("steer");
	runtime.finish[0]!();
	await expect(draining).resolves.toBe(2);
});

it("cancels pending approval state when immediate input interrupts an active turn", async () => {
	const { store, runtime, worker, sessionId, send, waitCalls } = await setup();
	await send("prompt", "original");
	const draining = worker.drainSession(sessionId);
	await waitCalls(1);
	const snapshot = store.loadSnapshot(sessionId)!;
	const event = {
		type: "approval.requested" as const,
		eventId: "approval-event",
		sessionId,
		revision: snapshot.revision + 1,
		timestamp: Date.now(),
		approval: {
			id: "approval",
			sessionId,
			workspaceId: "workspace",
			toolCallId: "tool",
			risk: "medium" as const,
			summary: "Write file",
			capabilities: [{ type: "filesystem.write" as const, paths: ["test.txt"] }],
			status: "pending" as const,
			createdAt: Date.now(),
			expiresAt: Date.now() + 60000,
		},
	};
	store.commitMutation({
		sessionId,
		expectedRevision: snapshot.revision,
		events: [event],
		snapshot: reduceSessionEvent(snapshot, event),
	});
	await send("steer", "change direction", worker);
	await waitCalls(2);
	expect(runtime.calls[1]!.snapshot.pendingApprovals).toEqual([]);
	runtime.finish[1]!();
	await expect(draining).resolves.toBe(2);
});

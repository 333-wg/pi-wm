import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceSessionEvent, replaySessionEvents, type SessionEvent } from "@wuming/domain";
import type { AgentRuntime, RuntimeTurnResult } from "../src/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorError, SessionOrchestrator, SqliteOrchestratorStore, type CommitMutationOptions } from "../src/index.js";

class RejectingGoalAttachStore extends SqliteOrchestratorStore {
	override commitMutation(options: CommitMutationOptions) {
		if (!options.attachGoalRun) return super.commitMutation(options);
		return super.commitMutation({
			...options,
			attachGoalRun: { ...options.attachGoalRun, expectedUpdatedAt: -1 },
		});
	}
}

class FakeRuntime implements AgentRuntime {
	calls = 0;

	async compact() {
		return { summary: "Keep the implementation focused.", usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, costUsd: 0.02 } };
	}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		this.calls += 1;
		input.onProgress({
			type: "assistant.delta",
			sessionId: input.operation.sessionId,
			itemId: `assistant-${this.calls}`,
			streamSeq: 0,
			contentIndex: 0,
			kind: "text",
			delta: "done",
		});
		return {
			items: [
				{
					id: `assistant-${this.calls}`,
					type: "assistant",
					createdAt: input.snapshot.session.updatedAt + 1,
					status: "complete",
					content: [{ type: "text", text: "done" }],
					model: input.snapshot.model,
				},
			],
			usage: {
				inputTokens: 10,
				outputTokens: 2,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 12,
				costUsd: 0.01,
			},
		};
	}
}

class FailingRuntime implements AgentRuntime {
	async executeTurn(): Promise<RuntimeTurnResult> {
		throw new Error("provider failed");
	}
}

class FlakyRuntime implements AgentRuntime {
		calls = 0;
		async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
			this.calls += 1;
			const usage = { inputTokens: this.calls, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: this.calls, costUsd: this.calls * 0.01 };
			if (this.calls === 1) return { items: [], usage, failure: { code: "runtime_error", message: "temporary provider failure", retryable: true } };
			return { items: [{ id: "assistant-flaky", type: "assistant", createdAt: 1, status: "complete", content: [{ type: "text", text: "recovered" }], model: input.snapshot.model }], usage };
		}
}

class BlockingRuntime implements AgentRuntime {
	readonly started: Promise<void>;
	#markStarted!: () => void;

	constructor() {
		this.started = new Promise((resolve) => {
			this.#markStarted = resolve;
		});
	}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		this.#markStarted();
		return new Promise((_, reject) => {
			const abort = () => reject(input.signal.reason ?? new Error("aborted"));
			if (input.signal.aborted) abort();
			else input.signal.addEventListener("abort", abort, { once: true });
		});
	}
}

class InjectableRuntime implements AgentRuntime {
	readonly started: Promise<void>;
	readonly injected: Array<{ mode: "steer" | "follow_up"; text: string }> = [];
	#markStarted!: () => void;
	#release!: () => void;
	readonly completion: Promise<void>;

	constructor() {
		this.started = new Promise((resolve) => {
			this.#markStarted = resolve;
		});
		this.completion = new Promise((resolve) => {
			this.#release = resolve;
		});
	}

	release(): void {
		this.#release();
	}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		this.#markStarted();
		await this.completion;
		return {
			items: [{
				id: "assistant-injected",
				type: "assistant",
				createdAt: Date.now(),
				status: "complete",
				content: [{ type: "text", text: "completed with injected instructions" }],
				model: input.snapshot.model,
			}],
		};
	}

	async injectTurn(input: Parameters<NonNullable<AgentRuntime["injectTurn"]>>[0]): Promise<void> {
		if (input.operation.payload.mode === "prompt") throw new Error("unexpected prompt injection");
		const text = input.operation.payload.content
			.filter((part): part is Extract<(typeof input.operation.payload.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join(" ");
		this.injected.push({ mode: input.operation.payload.mode, text });
	}
}

class UncooperativeRuntime implements AgentRuntime {
	readonly started: Promise<void>;
	forceTerminateCalls = 0;
	#markStarted!: () => void;

	constructor() {
		this.started = new Promise((resolve) => {
			this.#markStarted = resolve;
		});
	}

	async executeTurn(): Promise<RuntimeTurnResult> {
		this.#markStarted();
		return new Promise(() => {});
	}

	async forceTerminate(): Promise<void> {
		this.forceTerminateCalls += 1;
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function ids(prefix = "id"): () => string {
	let value = 0;
	return () => `${prefix}-${++value}`;
}

function createInput() {
	return {
		principalId: "user-1",
		idempotencyKey: "create-1",
		workspaceId: "workspace-1",
		name: "Test",
		model: { provider: "anthropic", id: "claude" },
		thinkingLevel: "medium" as const,
		sandboxMode: "workspace_write" as const,
		approvalPolicy: "on_risk" as const,
	};
}

function persistApprovalBoundary(
	store: SqliteOrchestratorStore,
	sessionId: string,
	operationId: string,
	state: "waiting" | "executing",
) {
	const current = store.loadSnapshot(sessionId)!;
	const approval = {
		id: `approval-${state}`,
		sessionId,
		workspaceId: current.session.workspaceId,
		toolCallId: `tool-${state}`,
		risk: "medium" as const,
		summary: "Write value.txt",
		capabilities: [{ type: "filesystem.write" as const, paths: ["value.txt"] }],
		status: "pending" as const,
		createdAt: 101,
		expiresAt: 1001,
	};
	const requested: SessionEvent = { type: "approval.requested", eventId: `approval-event-${state}`, sessionId, revision: current.revision + 1, timestamp: 101, approval };
	const afterApproval = reduceSessionEvent(current, requested);
	const phase: SessionEvent = { type: "session.phase.changed", eventId: `approval-phase-${state}`, sessionId, revision: current.revision + 2, timestamp: 101, phase: "awaiting_approval" };
	store.commitMutation({
		sessionId,
		expectedRevision: current.revision,
		events: [requested, phase],
		snapshot: reduceSessionEvent(afterApproval, phase),
		approvalExecution: { approvalId: approval.id, sessionId, operationId, toolCallId: approval.toolCallId, mode: "preflight", state, createdAt: 101, updatedAt: 101 },
	});
	return approval;
}

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("session orchestrator", () => {
	it("runs a durable child session and publishes its result and usage to the parent", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FakeRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => 100, idFactory: ids("subagent") });
		const parent = await orchestrator.createSession({ ...createInput(), costBudgetUsd: 1, tokenBudget: 100 });
		const created = await orchestrator.createSubagent({
			principalId: "user-1",
			idempotencyKey: "subagent-create-1",
			sessionId: parent.snapshot.session.id,
			task: "Inspect the authentication flow",
			costBudgetUsd: 0.25,
			tokenBudget: 50,
		});

		expect(created.subagent).toMatchObject({ parentSessionId: parent.snapshot.session.id, status: "queued", task: "Inspect the authentication flow", costBudgetUsd: 0.25, tokenBudget: 50 });
		expect(store.listSnapshots("workspace-1").map((snapshot) => snapshot.session.id)).toEqual([parent.snapshot.session.id]);
		expect(orchestrator.listSubagents(parent.snapshot.session.id)).toHaveLength(1);
		expect(await orchestrator.drainSession(created.subagent.sessionId, "subagent-worker")).toBe(1);
		const completed = await orchestrator.publishSubagentResult(parent.snapshot.session.id, created.subagent.sessionId);
		expect(completed).toMatchObject({ status: "completed", result: "done", usage: { totalTokens: 12, costUsd: 0.01 } });

		const parentAfter = store.loadSnapshot(parent.snapshot.session.id)!;
		expect(parentAfter.transcript.at(-1)).toMatchObject({ type: "tool", toolCallId: created.subagent.sessionId, toolName: "subagent", status: "complete", isError: false });
		expect(parentAfter.usage).toMatchObject({ totalTokens: 12, costUsd: 0.01 });
		expect(parentAfter.usageByTool).toEqual([expect.objectContaining({ toolName: "subagent", callCount: 1, succeededCount: 1 })]);
		await orchestrator.publishSubagentResult(parent.snapshot.session.id, created.subagent.sessionId);
		expect(store.loadSnapshot(parent.snapshot.session.id)?.usage.totalTokens).toBe(12);
		store.close();
	});

	it("cancels a running subagent and publishes an aborted result", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new BlockingRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => 100, idFactory: ids("cancel-subagent") });
		const parent = await orchestrator.createSession(createInput());
		const created = await orchestrator.createSubagent({ principalId: "user-1", idempotencyKey: "subagent-create-cancel", sessionId: parent.snapshot.session.id, task: "Wait for cancellation" });
		const draining = orchestrator.drainSession(created.subagent.sessionId, "subagent-cancel-worker");
		await runtime.started;

		const cancelled = await orchestrator.cancelSubagent({ principalId: "user-1", idempotencyKey: "subagent-cancel-1", sessionId: parent.snapshot.session.id, subagentId: created.subagent.id });
		expect(cancelled.subagent.status).toBe("cancelling");
		await draining;
		const summary = await orchestrator.publishSubagentResult(parent.snapshot.session.id, created.subagent.id);
		expect(summary.status).toBe("cancelled");
		expect(store.loadSnapshot(parent.snapshot.session.id)?.transcript.at(-1)).toMatchObject({ type: "tool", status: "aborted", isError: true });
		store.close();
	});

	it("persists, starts, and projects a completed background goal", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FakeRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => 100, idFactory: ids("goal") });
		const parent = await orchestrator.createSession(createInput());
		const input = {
			principalId: "user-1",
			idempotencyKey: "goal-create-1",
			sessionId: parent.snapshot.session.id,
			title: "Release review",
			objective: "Review the release and report blockers",
		};
		const created = await orchestrator.createGoal(input);
		expect(await orchestrator.createGoal(input)).toEqual(created);
		expect(created.goal).toMatchObject({ status: "pending", title: "Release review", objective: input.objective });
		expect(orchestrator.listGoals(parent.snapshot.session.id)).toHaveLength(1);

		const startInput = { principalId: "user-1", idempotencyKey: "goal-start-1", sessionId: parent.snapshot.session.id, goalId: created.goal.id };
		const started = await orchestrator.startGoal(startInput);
		expect(started.goal).toMatchObject({ status: "queued", runSessionId: expect.any(String), operationId: expect.any(String) });
		expect(await orchestrator.startGoal(startInput)).toEqual(started);
		expect(orchestrator.listSubagents(parent.snapshot.session.id)).toHaveLength(1);
		await expect(orchestrator.startGoal({ ...startInput, idempotencyKey: "goal-start-again" })).rejects.toMatchObject({ code: "conflict" });
		expect(orchestrator.listSubagents(parent.snapshot.session.id)).toHaveLength(1);
		expect(await orchestrator.drainSession(started.goal.runSessionId!, "goal-worker")).toBe(1);
		await orchestrator.publishSubagentResult(parent.snapshot.session.id, started.goal.runSessionId!);
		expect(orchestrator.listGoals(parent.snapshot.session.id)).toEqual([
			expect.objectContaining({ id: created.goal.id, status: "completed", result: "done", usage: expect.objectContaining({ totalTokens: 12 }) }),
		]);

		const restarted = new SessionOrchestrator(store, runtime, { clock: () => 200 });
		expect(restarted.listGoals(parent.snapshot.session.id)[0]).toMatchObject({ id: created.goal.id, status: "completed", result: "done" });
		store.close();
	});

	it("rolls back the child session when a goal run cannot be attached", async () => {
		const store = new RejectingGoalAttachStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => 100, idFactory: ids("atomic-goal") });
		const parent = await orchestrator.createSession(createInput());
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "atomic-goal-create",
			sessionId: parent.snapshot.session.id,
			objective: "Start atomically",
		});

		await expect(orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "atomic-goal-start",
			sessionId: parent.snapshot.session.id,
			goalId: created.goal.id,
		})).rejects.toMatchObject({ code: "conflict" });
		expect(store.listChildSnapshots(parent.snapshot.session.id)).toEqual([]);
		const goal = orchestrator.listGoals(parent.snapshot.session.id)[0];
		expect(goal).toMatchObject({ status: "pending" });
		expect(goal?.runSessionId).toBeUndefined();
		store.close();
	});

	it("cancels pending and running goals", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new BlockingRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => 100, idFactory: ids("cancel-goal") });
		const parent = await orchestrator.createSession(createInput());
		const pending = await orchestrator.createGoal({ principalId: "user-1", idempotencyKey: "goal-pending", sessionId: parent.snapshot.session.id, objective: "Do not start" });
		const pendingCancelled = await orchestrator.cancelGoal({ principalId: "user-1", idempotencyKey: "goal-pending-cancel", sessionId: parent.snapshot.session.id, goalId: pending.goal.id });
		expect(pendingCancelled.goal.status).toBe("cancelled");
		await expect(orchestrator.startGoal({ principalId: "user-1", idempotencyKey: "goal-pending-start", sessionId: parent.snapshot.session.id, goalId: pending.goal.id })).rejects.toMatchObject({ code: "conflict" });
		const queued = await orchestrator.createGoal({ principalId: "user-1", idempotencyKey: "goal-queued", sessionId: parent.snapshot.session.id, objective: "Cancel before worker claim" });
		await orchestrator.startGoal({ principalId: "user-1", idempotencyKey: "goal-queued-start", sessionId: parent.snapshot.session.id, goalId: queued.goal.id });
		await orchestrator.cancelGoal({ principalId: "user-1", idempotencyKey: "goal-queued-cancel", sessionId: parent.snapshot.session.id, goalId: queued.goal.id });
		expect(orchestrator.listGoals(parent.snapshot.session.id).find((goal) => goal.id === queued.goal.id)?.status).toBe("cancelled");

		const running = await orchestrator.createGoal({ principalId: "user-1", idempotencyKey: "goal-running", sessionId: parent.snapshot.session.id, objective: "Wait until cancelled" });
		const started = await orchestrator.startGoal({ principalId: "user-1", idempotencyKey: "goal-running-start", sessionId: parent.snapshot.session.id, goalId: running.goal.id });
		const draining = orchestrator.drainSession(started.goal.runSessionId!, "goal-cancel-worker");
		await runtime.started;
		const cancelled = await orchestrator.cancelGoal({ principalId: "user-1", idempotencyKey: "goal-running-cancel", sessionId: parent.snapshot.session.id, goalId: running.goal.id });
		expect(cancelled.goal.status).toBe("cancelling");
		await draining;
		expect(orchestrator.listGoals(parent.snapshot.session.id).find((goal) => goal.id === running.goal.id)?.status).toBe("cancelled");
		store.close();
	});

	it("deduplicates concurrent retries before they create a second turn", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FakeRuntime();
		const progress: string[] = [];
		const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => 100, idFactory: ids() });
		orchestrator.subscribeProgress((event) => progress.push(event.type));
		const created = await orchestrator.createSession(createInput());
		const turn = {
			principalId: "user-1",
			idempotencyKey: "turn-1",
			sessionId: created.snapshot.session.id,
			mode: "prompt" as const,
			content: [{ type: "text" as const, text: "hello" }],
		};

		const [first, retry] = await Promise.all([orchestrator.acceptTurn(turn), orchestrator.acceptTurn(turn)]);
		expect(retry).toEqual(first);
		expect(store.loadEvents(turn.sessionId)).toHaveLength(3);
		expect(await orchestrator.drainSession(turn.sessionId, "worker-1")).toBe(1);
		expect(runtime.calls).toBe(1);
		expect(progress).toEqual(["assistant.delta"]);
		const snapshot = store.loadSnapshot(turn.sessionId);
		expect(snapshot?.session.phase).toBe("idle");
		expect(snapshot?.transcript.map((item) => item.type)).toEqual(["user", "assistant"]);
		expect(snapshot?.usage.totalTokens).toBe(12);
		const runs = store.listOperations(turn.sessionId);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			status: "completed",
			attempt: 1,
			startedAt: 100,
			finishedAt: 100,
		});
		store.close();
	});

	it("rejects reuse of an idempotency key for a different command", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => 100, idFactory: ids() });
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "turn-1",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "one" }],
		});
		await expect(
			orchestrator.acceptTurn({
				principalId: "user-1",
				idempotencyKey: "turn-1",
				sessionId: created.snapshot.session.id,
				mode: "prompt",
				content: [{ type: "text", text: "two" }],
			}),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		store.close();
	});

	it("renames, searches, archives, and restores an idle session", async () => {
		let now = 100;
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => now, idFactory: ids() });
		const created = await orchestrator.createSession(createInput());
		const sessionId = created.snapshot.session.id;
		now = 110;
		const renamed = await orchestrator.renameSession({
			principalId: "user-1",
			idempotencyKey: "rename-1",
			sessionId,
			name: "  Release Review  ",
		});
		expect(renamed.snapshot.session.name).toBe("Release Review");
		expect(store.listSnapshots("workspace-1", { query: "release" }).map((snapshot) => snapshot.session.id)).toEqual([sessionId]);
		expect(store.listSnapshots("workspace-1", { query: "%" })).toEqual([]);

		now = 120;
		const archived = await orchestrator.archiveSession({
			principalId: "user-1",
			idempotencyKey: "archive-1",
			sessionId,
			archived: true,
		});
		expect(archived.snapshot.session.archivedAt).toBe(120);
		expect(store.listSnapshots("workspace-1")).toEqual([]);
		expect(store.listSnapshots("workspace-1", { archived: true, query: "review" })).toHaveLength(1);
		await expect(orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "archived-turn",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "should fail" }],
		})).rejects.toMatchObject({ code: "conflict" });

		now = 130;
		const restored = await orchestrator.archiveSession({
			principalId: "user-1",
			idempotencyKey: "restore-1",
			sessionId,
			archived: false,
		});
		expect(restored.snapshot.session.archivedAt).toBeUndefined();
		expect(store.listSnapshots("workspace-1")).toHaveLength(1);
		store.close();
	});

	it("recovers a queued operation after the store is reopened", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-orchestrator-"));
		cleanup.push(directory);
		const database = join(directory, "sessions.db");
		const firstStore = new SqliteOrchestratorStore(database);
		const first = new SessionOrchestrator(firstStore, new FakeRuntime(), { clock: () => 100, idFactory: ids("first") });
		const created = await first.createSession(createInput());
		await first.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "turn-1",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "survive restart" }],
		});
		firstStore.close();

		const secondStore = new SqliteOrchestratorStore(database);
		const runtime = new FakeRuntime();
		const second = new SessionOrchestrator(secondStore, runtime, { clock: () => 200, idFactory: ids("second") });
		expect(await second.drainSession(created.snapshot.session.id, "worker-after-restart")).toBe(1);
		expect(runtime.calls).toBe(1);
		const persisted = secondStore.loadSnapshot(created.snapshot.session.id);
		expect(persisted).toEqual(replaySessionEvents(secondStore.loadEvents(created.snapshot.session.id)));
		secondStore.close();
	});

	it("settles an interrupted running turn and resumes its queued work after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-orchestrator-running-"));
		cleanup.push(directory);
		const database = join(directory, "sessions.db");
		const firstStore = new SqliteOrchestratorStore(database);
		const first = new SessionOrchestrator(firstStore, new FakeRuntime(), { clock: () => 100, idFactory: ids("first") });
		const created = await first.createSession(createInput());
		const sessionId = created.snapshot.session.id;
		await first.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "prompt-1",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "running during restart" }],
		});
		await first.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "follow-up-1",
			sessionId,
			mode: "follow_up",
			content: [{ type: "text", text: "resume me" }],
		});
		const beforeApproval = firstStore.loadSnapshot(sessionId)!;
		const approvalEvent: SessionEvent = {
			type: "approval.requested",
			eventId: "approval-event",
			sessionId,
			revision: beforeApproval.revision + 1,
			timestamp: 101,
			approval: {
				id: "approval-1",
				sessionId,
				workspaceId: beforeApproval.session.workspaceId,
				toolCallId: "tool-1",
				risk: "medium",
				summary: "Interrupted write",
				capabilities: [{ type: "filesystem.write", paths: ["value.txt"] }],
				status: "pending",
				createdAt: 101,
				expiresAt: 1001,
			},
		};
		firstStore.commitMutation({
			sessionId,
			expectedRevision: beforeApproval.revision,
			events: [approvalEvent],
			snapshot: reduceSessionEvent(beforeApproval, approvalEvent),
		});
		const running = firstStore.claimNextOperation(sessionId, 102);
		expect(running?.status).toBe("running");
		firstStore.close();

		const secondStore = new SqliteOrchestratorStore(database);
		const runtime = new FakeRuntime();
		const second = new SessionOrchestrator(secondStore, runtime, { clock: () => 200, idFactory: ids("second") });
		secondStore.clearWriterLeases();
		expect(second.recoverInterruptedOperations()).toBe(1);
		const recovered = secondStore.loadSnapshot(sessionId)!;
		expect(recovered.session.phase).toBe("turn");
		expect(recovered.pendingApprovals).toEqual([]);
		expect(recovered.transcript.at(-1)).toMatchObject({ type: "assistant", status: "aborted" });
		expect(secondStore.getOperation(running!.id)?.status).toBe("interrupted");

		expect(await second.resumeQueuedSessions()).toBe(1);
		expect(runtime.calls).toBe(1);
		expect(secondStore.loadSnapshot(sessionId)?.session.phase).toBe("idle");
		secondStore.close();
	});

	it("preserves an unstarted approval across recovery and lets abort settle it safely", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => 200, idFactory: ids("approval-recovery") });
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({ principalId: "user-1", idempotencyKey: "approval-turn", sessionId: created.snapshot.session.id, mode: "prompt", content: [{ type: "text", text: "write" }] });
		const running = store.claimNextOperation(created.snapshot.session.id, 100)!;
		const approval = persistApprovalBoundary(store, created.snapshot.session.id, running.id, "waiting");

		expect(orchestrator.recoverInterruptedOperations()).toBe(1);
		expect(store.getOperation(running.id)?.status).toBe("running");
		expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([approval]);
		await orchestrator.abortTurn({ principalId: "user-1", idempotencyKey: "abort-recovered-approval", sessionId: created.snapshot.session.id });
		expect(store.getOperation(running.id)).toMatchObject({ status: "interrupted", abortRequested: true, failureKind: "user_abort" });
		expect(store.getApprovalExecution(approval.id)?.state).toBe("interrupted");
		expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
		store.close();
	});

	it("never replays a tool whose execution state was uncertain at restart", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => 200, idFactory: ids("unsafe-recovery") });
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({ principalId: "user-1", idempotencyKey: "unsafe-turn", sessionId: created.snapshot.session.id, mode: "prompt", content: [{ type: "text", text: "write" }] });
		const running = store.claimNextOperation(created.snapshot.session.id, 100)!;
		const approval = persistApprovalBoundary(store, created.snapshot.session.id, running.id, "executing");

		expect(orchestrator.recoverInterruptedOperations()).toBe(1);
		expect(store.getOperation(running.id)).toMatchObject({ status: "interrupted", error: expect.stringContaining("not replayed") });
		expect(store.getApprovalExecution(approval.id)?.state).toBe("interrupted");
		expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
		store.close();
	});

	it("fences an expired writer lease", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => 100, idFactory: ids() });
		const created = await orchestrator.createSession(createInput());
		const sessionId = created.snapshot.session.id;
		const first = store.acquireWriterLease(sessionId, "worker-1", 100, 50);
		expect(() => store.acquireWriterLease(sessionId, "worker-2", 120, 50)).toThrowError(OrchestratorError);
		const second = store.acquireWriterLease(sessionId, "worker-2", 151, 50);
		expect(second.fence).toBeGreaterThan(first.fence);
		expect(() => store.renewWriterLease(first, 152, 50)).toThrowError(OrchestratorError);
		store.close();
	});

	it("settles a failed turn back to idle so the session can recover", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FailingRuntime(), { clock: () => 100, idFactory: ids() });
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "turn-fails",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "fail" }],
		});
		await expect(orchestrator.drainSession(created.snapshot.session.id)).resolves.toBe(1);
		const failed = store.loadSnapshot(created.snapshot.session.id);
		expect(failed?.session.phase).toBe("idle");
		expect(failed?.transcript.at(-1)).toMatchObject({ type: "assistant", status: "error", error: "provider failed" });
		await expect(orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "turn-after-failure",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "try again" }],
		})).resolves.toMatchObject({ type: "turn.accepted", queue: "active" });
		store.close();
	});

	it("retries an explicitly retryable provider failure and persists the attempt", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FlakyRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => 100, idFactory: ids("retry"), maxRetries: 1, retryBaseDelayMs: 0 });
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({ principalId: "user-1", idempotencyKey: "retry-turn", sessionId: created.snapshot.session.id, mode: "prompt", content: [{ type: "text", text: "retry" }] });
		await expect(orchestrator.drainSession(created.snapshot.session.id, undefined, "trace-provider-retry")).resolves.toBe(1);
		expect(runtime.calls).toBe(2);
		expect(store.listOperations(created.snapshot.session.id)[0]).toMatchObject({
			status: "completed",
			attempt: 2,
			traceId: "trace-provider-retry",
			usage: { totalTokens: 2, costUsd: 0.02 },
			retryHistory: [{ attempt: 1, maxAttempts: 1, delayMs: 0, error: "temporary provider failure", timestamp: 100 }],
		});
		expect(store.loadSnapshot(created.snapshot.session.id)).toMatchObject({ session: { phase: "idle" }, usage: { costUsd: 0.02 } });
		store.close();
	});

	it("updates and removes idle session budgets without resetting unrelated limits", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => 100, idFactory: ids("budget-config") });
		const created = await orchestrator.createSession({ ...createInput(), costBudgetUsd: 2, tokenBudget: 10_000, budgetWarningThreshold: 0.8 });
		const threshold = await orchestrator.setSessionBudget({ principalId: "user-1", idempotencyKey: "budget-threshold", sessionId: created.snapshot.session.id, budgetWarningThreshold: 0.9 });
		expect(threshold.snapshot).toMatchObject({ costBudgetUsd: 2, tokenBudget: 10_000, budgetWarningThreshold: 0.9 });
		const removed = await orchestrator.setSessionBudget({ principalId: "user-1", idempotencyKey: "budget-remove", sessionId: created.snapshot.session.id, costBudgetUsd: null });
		expect(removed.snapshot.costBudgetUsd).toBeUndefined();
		expect(removed.snapshot.tokenBudget).toBe(10_000);
		store.close();
	});

	it("stops a turn after it exceeds the durable cost budget and keeps its usage", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => 100, idFactory: ids("budget"), defaultCostBudgetUsd: 0.005 });
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({ principalId: "user-1", idempotencyKey: "budget-turn", sessionId: created.snapshot.session.id, mode: "prompt", content: [{ type: "text", text: "budget" }] });
		await expect(orchestrator.drainSession(created.snapshot.session.id)).resolves.toBe(1);
		expect(store.loadSnapshot(created.snapshot.session.id)).toMatchObject({ usage: { costUsd: 0.01 }, session: { phase: "idle" } });
		expect(store.listOperations(created.snapshot.session.id)[0]).toMatchObject({ status: "failed", error: expect.stringContaining("budget") });
		await expect(orchestrator.acceptTurn({ principalId: "user-1", idempotencyKey: "budget-turn-2", sessionId: created.snapshot.session.id, mode: "prompt", content: [{ type: "text", text: "blocked" }] })).rejects.toMatchObject({ code: "budget_exceeded" });
		store.close();
	});

	it("records model/turn usage and emits a durable token warning once", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const events: SessionEvent[] = [];
		store.subscribeEvents(({ event }) => events.push(event));
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => 100, idFactory: ids("usage-warning") });
		const created = await orchestrator.createSession({ ...createInput(), costBudgetUsd: 2, tokenBudget: 10, budgetWarningThreshold: 0.8 });
		await orchestrator.acceptTurn({ principalId: "user-1", idempotencyKey: "usage-warning-turn", sessionId: created.snapshot.session.id, mode: "prompt", content: [{ type: "text", text: "usage" }], skills: ["review-code", "review-code"] });
		await expect(orchestrator.drainSession(created.snapshot.session.id)).resolves.toBe(1);
		const snapshot = store.loadSnapshot(created.snapshot.session.id)!;
		expect(snapshot.usageByTurn).toMatchObject([{ mode: "prompt", attempts: 1, usage: { totalTokens: 12, costUsd: 0.01 }, requests: [], skills: ["review-code"] }]);
		expect(snapshot.usageByModel).toMatchObject([{ model: { provider: "anthropic", id: "claude" }, usage: { totalTokens: 12 } }]);
		expect(snapshot.budgetWarnings).toHaveLength(1);
		expect(snapshot.budgetWarnings?.[0]).toMatchObject({ kind: "tokens", budget: 10, threshold: 0.8 });
		await waitUntil(() => events.length > 0);
		expect(events.filter((event) => event.type === "session.budget.warning")).toHaveLength(1);
		store.close();
	});

	it("attributes retry usage by delta instead of charging the cumulative result twice", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FlakyRuntime(), { clock: () => 100, idFactory: ids("usage-retry"), maxRetries: 1, retryBaseDelayMs: 0 });
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({ principalId: "user-1", idempotencyKey: "usage-retry-turn", sessionId: created.snapshot.session.id, mode: "prompt", content: [{ type: "text", text: "retry" }] });
		await expect(orchestrator.drainSession(created.snapshot.session.id)).resolves.toBe(1);
		const snapshot = store.loadSnapshot(created.snapshot.session.id)!;
		expect(snapshot.usage).toMatchObject({ totalTokens: 2, costUsd: 0.02 });
		expect(snapshot.usageByTurn).toMatchObject([{ attempts: 2, usage: { totalTokens: 2, costUsd: 0.02 } }]);
		store.close();
	});

	it("durably aborts a turn before a worker claims it", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => 100, idFactory: ids() });
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "queued-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "wait" }],
		});
		const request = {
			principalId: "user-1",
			idempotencyKey: "abort-queued",
			sessionId: created.snapshot.session.id,
		};
		const first = await orchestrator.abortTurn(request);
		await expect(orchestrator.abortTurn(request)).resolves.toEqual(first);
		await expect(orchestrator.drainSession(created.snapshot.session.id)).resolves.toBe(1);
		const snapshot = store.loadSnapshot(created.snapshot.session.id);
		expect(snapshot?.session.phase).toBe("idle");
		expect(snapshot?.transcript.at(-1)).toMatchObject({ type: "assistant", status: "aborted" });
		store.close();
	});

	it("observes a durable abort requested by another orchestrator instance", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const blocking = new BlockingRuntime();
		const nextId = ids();
		const worker = new SessionOrchestrator(store, blocking, { clock: Date.now, idFactory: nextId });
		const controller = new SessionOrchestrator(store, blocking, { clock: Date.now, idFactory: nextId });
		const created = await worker.createSession(createInput());
		await worker.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "active-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "block" }],
		});
		const draining = worker.drainSession(created.snapshot.session.id, "worker-1");
		await blocking.started;
		await controller.abortTurn({
			principalId: "user-1",
			idempotencyKey: "abort-active",
			sessionId: created.snapshot.session.id,
		});
		await expect(draining).resolves.toBe(1);
		const snapshot = store.loadSnapshot(created.snapshot.session.id);
		expect(snapshot?.session.phase).toBe("idle");
		expect(snapshot?.transcript.at(-1)).toMatchObject({ type: "assistant", status: "aborted" });
		store.close();
	});

	it("injects durable steer and follow-up operations into an active turn across orchestrator instances", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new InjectableRuntime();
		const nextId = ids("inject");
		const worker = new SessionOrchestrator(store, runtime, { clock: Date.now, idFactory: nextId });
		const controller = new SessionOrchestrator(store, runtime, { clock: Date.now, idFactory: nextId });
		const created = await worker.createSession(createInput());
		const sessionId = created.snapshot.session.id;
		await worker.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "primary-turn",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "start" }],
		});
		const draining = worker.drainSession(sessionId, "worker-inject");
		await runtime.started;
		await controller.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "steer-active",
			sessionId,
			mode: "steer",
			content: [{ type: "text", text: "change direction" }],
		});
		await controller.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "follow-up-active",
			sessionId,
			mode: "follow_up",
			content: [{ type: "text", text: "then summarize" }],
		});
		await waitUntil(() => runtime.injected.length === 2);
		expect(runtime.injected).toEqual([
			{ mode: "steer", text: "change direction" },
			{ mode: "follow_up", text: "then summarize" },
		]);
		expect(store.loadSnapshot(sessionId)).toMatchObject({ queuedSteerCount: 0, queuedFollowUpCount: 0 });
		runtime.release();
		await expect(draining).resolves.toBe(1);
		const snapshot = store.loadSnapshot(sessionId);
		expect(snapshot?.session.phase).toBe("idle");
		expect(snapshot?.transcript.filter((item) => item.type === "user")).toHaveLength(3);
		expect(snapshot?.transcript.filter((item) => item.type === "assistant")).toHaveLength(1);
		store.close();
	});

	it("force-terminates a runtime that ignores cooperative abort", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new UncooperativeRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: Date.now,
			idFactory: ids("force"),
			abortGraceMs: 10,
			forceTerminateTimeoutMs: 10,
		});
		const created = await orchestrator.createSession(createInput());
		const sessionId = created.snapshot.session.id;
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "uncooperative-turn",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "never returns" }],
		});
		const draining = orchestrator.drainSession(sessionId, "force-worker");
		await runtime.started;
		await orchestrator.abortTurn({
			principalId: "user-1",
			idempotencyKey: "force-abort",
			sessionId,
		});
		await expect(draining).resolves.toBe(1);
		expect(runtime.forceTerminateCalls).toBe(1);
		expect(store.loadSnapshot(sessionId)).toMatchObject({
			session: { phase: "idle" },
			transcript: expect.arrayContaining([expect.objectContaining({ type: "assistant", status: "aborted" })]),
		});
		store.close();
	});

	it("forks a transcript prefix and supports idempotent session configuration", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), { clock: () => 100, idFactory: ids("fork") });
		const created = await orchestrator.createSession(createInput());
		const sessionId = created.snapshot.session.id;
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "turn-fork",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "hello" }],
		});
		await orchestrator.drainSession(sessionId);
		const source = store.loadSnapshot(sessionId)!;
		const firstItemId = source.transcript[0]!.id;

		const forked = await orchestrator.forkSession({
			principalId: "user-1",
			idempotencyKey: "fork-1",
			sessionId,
			fromItemId: firstItemId,
		});
		expect(forked.snapshot.session.id).not.toBe(sessionId);
		expect(forked.snapshot.transcript).toHaveLength(1);
		expect(forked.snapshot.transcript[0]!.id).toBe(firstItemId);
		expect(forked.snapshot.usage.totalTokens).toBe(0);
		await expect(orchestrator.forkSession({
			principalId: "user-1",
			idempotencyKey: "fork-1",
			sessionId,
			fromItemId: firstItemId,
		})).resolves.toEqual(forked);

		const changed = await orchestrator.setSessionModel({
			principalId: "user-1",
			idempotencyKey: "model-1",
			sessionId,
			model: { provider: "openai", id: "gpt-test" },
		});
		expect(changed.snapshot.model).toEqual({ provider: "openai", id: "gpt-test" });
		const changedAgain = await orchestrator.setSessionThinking({
			principalId: "user-1",
			idempotencyKey: "thinking-1",
			sessionId,
			thinkingLevel: "high",
		});
		expect(changedAgain.snapshot.thinkingLevel).toBe("high");
		const compacted = await orchestrator.compactSession({
			principalId: "user-1",
			idempotencyKey: "compact-1",
			sessionId,
		});
		expect(compacted.snapshot.transcript.at(-1)?.content[0]).toMatchObject({ type: "text" });
		expect(compacted.snapshot.usage.totalTokens).toBe(17);
		store.close();
	});
});

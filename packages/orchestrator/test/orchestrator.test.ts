import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reduceSessionEvent, replaySessionEvents, type SessionEvent } from "@wuming/domain";
import {
	CapabilityRegistry,
	HookPipeline,
	verifyCapabilityPlan,
	type CapabilityManifest,
	type CapabilityPlan,
} from "@wuming/capability-kernel";
import { ContextEngine, verifyContextPlan, type ContextPlan } from "@wuming/context-engine";
import type { ProgressEvent } from "@wuming/protocol";
import type { AgentRuntime, RuntimeTurnResult } from "../src/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
	OrchestratorError,
	SessionOrchestrator,
	SqliteOrchestratorStore,
	type CommitMutationOptions,
} from "../src/index.js";

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
		return {
			summary: "Keep the implementation focused.",
			usage: {
				inputTokens: 3,
				outputTokens: 2,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 5,
				costUsd: 0.02,
			},
		};
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

class CapabilityRuntime extends FakeRuntime {
	resolveCalls = 0;
	receivedPlan: CapabilityPlan | undefined;
	receivedContextPlan: ContextPlan | undefined;
	persistedBeforeExecute = false;
	contextPersistedBeforeExecute = false;
	store?: SqliteOrchestratorStore;
	readonly contextEngine = new ContextEngine();

	async resolveCapabilities(input: Parameters<NonNullable<AgentRuntime["resolveCapabilities"]>>[0]) {
		this.resolveCalls += 1;
		const registry = new CapabilityRegistry();
		registry.register({
			id: "tool:read_file",
			version: "1",
			kind: "tool",
			provider: "test",
			scope: "session",
			tool: { name: "read_file", executionMode: "parallel", exposure: "direct" },
		});
		return registry.resolve({
			workspaceId: input.snapshot.session.workspaceId,
			sessionId: input.snapshot.session.id,
			turnId: input.operation.id,
			model: input.snapshot.model,
			sandboxMode: input.snapshot.sandboxMode,
			approvalPolicy: input.snapshot.approvalPolicy,
		});
	}

	async resolveContext(input: Parameters<NonNullable<AgentRuntime["resolveContext"]>>[0]) {
		return testContextPlan(this.contextEngine, input);
	}

	override async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		this.receivedPlan = input.capabilityPlan;
		this.receivedContextPlan = input.contextPlan;
		this.persistedBeforeExecute =
			this.store?.getOperation(input.operation.id)?.capabilityPlan?.digest === input.capabilityPlan?.digest;
		this.contextPersistedBeforeExecute =
			this.store?.getOperation(input.operation.id)?.contextPlan?.digest === input.contextPlan?.digest;
		const result = await super.executeTurn(input);
		return {
			...result,
			requests: [{ requestId: "request-capability-1", model: input.snapshot.model, usage: result.usage! }],
			tools: [
				{
					toolName: "read_file",
					callCount: 1,
					usage: {
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						totalTokens: 0,
						costUsd: 0,
					},
					durationMs: 2,
					succeededCount: 1,
				},
			],
		};
	}
}

class AutoCompactingRuntime extends FakeRuntime {
	override async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		const result = await super.executeTurn(input);
		input.onContextUsage?.({ model: input.snapshot.model, tokens: 220, basis: "compaction" });
		return {
			...result,
			usage: {
				inputTokens: 12,
				outputTokens: 3,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 15,
				costUsd: 0.02,
			},
			compactions: [
				{
					reason: "threshold",
					summary: "Remember the verified repository state and continue from the latest user request.",
					tokensBefore: 900,
					estimatedTokensAfter: 220,
					usage: {
						inputTokens: 2,
						outputTokens: 1,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						totalTokens: 3,
						costUsd: 0.01,
					},
				},
			],
		};
	}
}

function testContextPlan(
	engine: ContextEngine,
	input: Parameters<NonNullable<AgentRuntime["resolveContext"]>>[0]
): ContextPlan {
	return engine.assemble({
		workspaceId: input.snapshot.session.workspaceId,
		sessionId: input.snapshot.session.id,
		operationId: input.operation.id,
		model: input.snapshot.model,
		query: input.operation.payload.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n"),
		baseSystemPrompt: "Orchestrator test system prompt",
		fragments: [],
		budget: {
			contextWindowTokens: 1000,
			userInputTokens: 10,
			reservedOutputTokens: 100,
			maxSystemTokens: 250,
		},
	}).plan;
}

function operationHookManifest(): CapabilityManifest {
	return {
		id: "hook:operation-policy",
		version: "1",
		kind: "hook",
		provider: "test",
		scope: "system",
		priority: 20,
		hook: {
			points: ["operation.before_execute", "operation.after_execute", "operation.on_error"],
			mode: "enforce",
			timeoutMs: 100,
		},
	};
}

class HookAwareRuntime extends FakeRuntime {
	async resolveCapabilities(input: Parameters<NonNullable<AgentRuntime["resolveCapabilities"]>>[0]) {
		const registry = new CapabilityRegistry();
		registry.register(operationHookManifest());
		return registry.resolve({
			workspaceId: input.snapshot.session.workspaceId,
			sessionId: input.snapshot.session.id,
			turnId: input.operation.id,
			model: input.snapshot.model,
			sandboxMode: input.snapshot.sandboxMode,
			approvalPolicy: input.snapshot.approvalPolicy,
		});
	}
}

/**
 * Stands in for the gateway's `subagent` tool: it spawns an inline child from inside
 * the parent's own turn and waits for it, exactly as the tool does.
 */
class InlineSubagentRuntime extends FakeRuntime {
	orchestrator!: SessionOrchestrator;
	childSessionId?: string;
	// Reading the parent's usage mid-turn can come back empty, and
	// `exactOptionalPropertyTypes` treats an absent field and an undefined one as
	// different types, so the undefined case is declared rather than asserted away.
	parentUsageDuringTurn?: number | undefined;

	override async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		if (input.snapshot.session.parentSessionId === undefined && this.childSessionId === undefined) {
			const created = await this.orchestrator.createSubagent({
				principalId: `agent:${input.operation.sessionId}`,
				idempotencyKey: "subagent-tool:call-1",
				sessionId: input.operation.sessionId,
				task: "Find every caller of the approval broker",
				deliverInline: true,
			});
			this.childSessionId = created.subagent.sessionId;
			await this.orchestrator.drainSession(this.childSessionId, "inline-subagent-worker");
			this.parentUsageDuringTurn = this.orchestrator.store.loadSnapshot(input.operation.sessionId)?.usage.totalTokens;
		}
		return super.executeTurn(input);
	}
}

class GoalReviewRuntime implements AgentRuntime {
	calls = 0;
	workerCalls = 0;
	reviewerCalls = 0;

	constructor(
		readonly verdicts: Array<"pass" | "fail">,
		readonly inconsistent = false
	) {}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		this.calls += 1;
		const text = input.operation.payload.content
			.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const reviewing = text.startsWith("Review the candidate result");
		let result: string;
		if (reviewing) {
			this.reviewerCalls += 1;
			const verdict = this.verdicts.shift() ?? "pass";
			result = JSON.stringify({
				verdict,
				feedback: verdict === "pass" ? "All criteria are satisfied." : "Add concrete verification evidence.",
				checks: [
					{
						criterion: "The report includes concrete verification evidence.",
						status: this.inconsistent ? (verdict === "pass" ? "fail" : "pass") : verdict,
						evidence:
							verdict === "pass" ? "The report includes a verified command result." : "No command result was included.",
					},
				],
			});
		} else {
			this.workerCalls += 1;
			result = `candidate-${this.workerCalls}`;
		}
		return {
			items: [
				{
					id: `goal-review-assistant-${this.calls}`,
					type: "assistant",
					createdAt: input.snapshot.session.updatedAt + 1,
					status: "complete",
					content: [{ type: "text", text: result }],
					model: input.snapshot.model,
				},
			],
			usage: {
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 2,
				costUsd: 0.01,
			},
			...(reviewing
				? {
						tools: [
							{
								toolName: "read_file",
								callCount: 1,
								usage: {
									inputTokens: 0,
									outputTokens: 0,
									cacheReadTokens: 0,
									cacheWriteTokens: 0,
									totalTokens: 0,
									costUsd: 0,
								},
								succeededCount: 1,
							},
						],
					}
				: {}),
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
		const usage = {
			inputTokens: this.calls,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: this.calls,
			costUsd: this.calls * 0.01,
		};
		if (this.calls === 1)
			return {
				items: [],
				usage,
				failure: { code: "runtime_error", message: "temporary provider failure", retryable: true },
			};
		return {
			items: [
				{
					id: "assistant-flaky",
					type: "assistant",
					createdAt: 1,
					status: "complete",
					content: [{ type: "text", text: "recovered" }],
					model: input.snapshot.model,
				},
			],
			usage,
		};
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
	readonly injectedPlans: Array<{
		operationId: string;
		digest?: string;
		contextDigest?: string;
		persistedBeforeInject: boolean;
		contextPersistedBeforeInject: boolean;
	}> = [];
	resolveCalls = 0;
	contextResolveCalls = 0;
	store?: SqliteOrchestratorStore;
	readonly contextEngine = new ContextEngine();
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

	async resolveContext(input: Parameters<NonNullable<AgentRuntime["resolveContext"]>>[0]) {
		this.contextResolveCalls += 1;
		return testContextPlan(this.contextEngine, input);
	}

	release(): void {
		this.#release();
	}

	async resolveCapabilities(input: Parameters<NonNullable<AgentRuntime["resolveCapabilities"]>>[0]) {
		this.resolveCalls += 1;
		const registry = new CapabilityRegistry();
		registry.register({
			id: "tool:inject_test",
			version: "1",
			kind: "tool",
			provider: "test",
			scope: "turn",
			tool: { name: "inject_test", executionMode: "sequential", exposure: "direct" },
		});
		return registry.resolve({
			workspaceId: input.snapshot.session.workspaceId,
			sessionId: input.snapshot.session.id,
			turnId: input.operation.id,
			model: input.snapshot.model,
			sandboxMode: input.snapshot.sandboxMode,
			approvalPolicy: input.snapshot.approvalPolicy,
		});
	}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		this.#markStarted();
		await this.completion;
		return {
			items: [
				{
					id: "assistant-injected",
					type: "assistant",
					createdAt: Date.now(),
					status: "complete",
					content: [{ type: "text", text: "completed with injected instructions" }],
					model: input.snapshot.model,
				},
			],
		};
	}

	async injectTurn(input: Parameters<NonNullable<AgentRuntime["injectTurn"]>>[0]): Promise<void> {
		if (input.operation.payload.mode === "prompt") throw new Error("unexpected prompt injection");
		const persistedDigest = this.store?.getOperation(input.operation.id)?.capabilityPlan?.digest;
		const persistedContextDigest = this.store?.getOperation(input.operation.id)?.contextPlan?.digest;
		this.injectedPlans.push({
			operationId: input.operation.id,
			...(input.capabilityPlan ? { digest: input.capabilityPlan.digest } : {}),
			...(input.contextPlan ? { contextDigest: input.contextPlan.digest } : {}),
			persistedBeforeInject: persistedDigest !== undefined && persistedDigest === input.capabilityPlan?.digest,
			contextPersistedBeforeInject:
				persistedContextDigest !== undefined && persistedContextDigest === input.contextPlan?.digest,
		});
		const text = input.operation.payload.content
			.filter(
				(part): part is Extract<(typeof input.operation.payload.content)[number], { type: "text" }> =>
					part.type === "text"
			)
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
	state: "waiting" | "executing"
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
	const requested: SessionEvent = {
		type: "approval.requested",
		eventId: `approval-event-${state}`,
		sessionId,
		revision: current.revision + 1,
		timestamp: 101,
		approval,
	};
	const afterApproval = reduceSessionEvent(current, requested);
	const phase: SessionEvent = {
		type: "session.phase.changed",
		eventId: `approval-phase-${state}`,
		sessionId,
		revision: current.revision + 2,
		timestamp: 101,
		phase: "awaiting_approval",
	};
	store.commitMutation({
		sessionId,
		expectedRevision: current.revision,
		events: [requested, phase],
		snapshot: reduceSessionEvent(afterApproval, phase),
		approvalExecution: {
			approvalId: approval.id,
			sessionId,
			operationId,
			toolCallId: approval.toolCallId,
			mode: "preflight",
			state,
			createdAt: 101,
			updatedAt: 101,
		},
	});
	return approval;
}

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("session orchestrator", () => {
	it("projects a consistent plan when another connection attaches a child during the read", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-plan-snapshot-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		let interleave: (() => void) | undefined;
		class InterleavedStore extends SqliteOrchestratorStore {
			override listPlanStepGoals(goalId: string) {
				const action = interleave;
				interleave = undefined;
				action?.();
				return super.listPlanStepGoals(goalId);
			}
		}
		const store = new InterleavedStore(path);
		const writer = new SqliteOrchestratorStore(path);
		try {
			const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
				clock: () => 100,
				idFactory: ids("snapshot-plan"),
			});
			const parent = await orchestrator.createSession(createInput());
			const sessionId = parent.snapshot.session.id;
			const created = await orchestrator.createGoal({
				principalId: "user-1",
				idempotencyKey: "create",
				sessionId,
				objective: "Consistent projection",
				plan: { steps: [{ id: "a", title: "A", objective: "A", dependsOn: [] }] },
			});
			await orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "start",
				sessionId,
				goalId: created.goal.id,
			});
			interleave = () => {
				const goal = writer.loadGoal(created.goal.id)!;
				writer.attachPlanStepGoal({
					parentGoal: {
						...goal,
						updatedAt: goal.updatedAt + 1,
						plan: { ...goal.plan!, steps: [{ ...goal.plan!.steps[0]!, goalId: "snapshot-child" }] },
					},
					expectedUpdatedAt: goal.updatedAt,
					childGoal: {
						id: "snapshot-child",
						parentSessionId: sessionId,
						ownerGoalId: goal.id,
						planStepId: "a",
						title: "A",
						objective: "A",
						createdAt: 100,
						updatedAt: 100,
					},
					verifyBudgetReservation: () => {},
				});
			};
			const before = orchestrator.listGoals(sessionId)[0]!;
			expect(before.plan?.steps[0]?.goalId).toBeUndefined();
			const after = orchestrator.listGoals(sessionId)[0]!;
			expect(after.plan?.steps[0]?.goalId).toBe("snapshot-child");
			expect((await orchestrator.driveGoal(sessionId, created.goal.id)).status).toBe("completed");
		} finally {
			writer.close();
			store.close();
		}
	});

	it("pauses, resumes, and deletes a durable goal while preserving its runtime state", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-goal-controls-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		const store = new SqliteOrchestratorStore(path);
		let now = 100;
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => now,
			idFactory: ids("goal-controls"),
		});
		const parent = await orchestrator.createSession(createInput());
		const sessionId = parent.snapshot.session.id;
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "goal-controls-create",
			sessionId,
			objective: "Exercise durable goal controls",
		});

		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "goal-controls-start",
			sessionId,
			goalId: created.goal.id,
		});
		now = 125;
		const paused = await orchestrator.pauseGoal({
			principalId: "user-1",
			idempotencyKey: "goal-controls-pause",
			sessionId,
			goalId: created.goal.id,
		});
		expect(paused.goal.status).toBe("paused");
		expect(paused.goal.pausedAt).toBe(125);
		expect(paused.goal.accumulatedRunMs).toBeGreaterThanOrEqual(0);

		const resumed = await orchestrator.resumeGoal({
			principalId: "user-1",
			idempotencyKey: "goal-controls-resume",
			sessionId,
			goalId: created.goal.id,
		});
		expect(resumed.goal.status).not.toBe("paused");
		expect(resumed.goal.pausedAt).toBeUndefined();
		expect(store.loadGoal(created.goal.id)?.pausedAt).toBeUndefined();
		const reopened = new SqliteOrchestratorStore(path);
		try {
			expect(reopened.loadGoal(created.goal.id)?.startedAt).toBe(resumed.goal.startedAt);
		} finally {
			reopened.close();
		}

		const deleted = await orchestrator.deleteGoal({
			principalId: "user-1",
			idempotencyKey: "goal-controls-delete",
			sessionId,
			goalId: created.goal.id,
		});
		expect(deleted).toEqual({ type: "goal.deleted", goalId: created.goal.id });
		await expect(
			orchestrator.deleteGoal({
				principalId: "user-1",
				idempotencyKey: "goal-controls-delete",
				sessionId,
				goalId: created.goal.id,
			})
		).resolves.toEqual(deleted);
		expect(orchestrator.listGoals(sessionId)).toHaveLength(0);
		store.close();
	});

	it.each(["missing", "duplicate", "swapped", "foreign-session"])(
		"rejects %s child references when projecting a stored plan",
		async (corruption) => {
			const directory = mkdtempSync(join(tmpdir(), "wuming-plan-links-"));
			cleanup.push(directory);
			const path = join(directory, "orchestrator.sqlite");
			const store = new SqliteOrchestratorStore(path);
			const runtime = new FakeRuntime();
			const orchestrator = new SessionOrchestrator(store, runtime, {
				clock: () => 100,
				idFactory: ids("plan-links"),
			});
			const parent = await orchestrator.createSession(createInput());
			const foreign = await orchestrator.createSession({
				...createInput(),
				idempotencyKey: "foreign",
			});
			const sessionId = parent.snapshot.session.id;
			const created = await orchestrator.createGoal({
				principalId: "user-1",
				idempotencyKey: "create",
				sessionId,
				objective: "Verify links",
				plan: {
					steps: [
						{ id: "a", title: "A", objective: "A", dependsOn: [] },
						{ id: "b", title: "B", objective: "B", dependsOn: [] },
					],
				},
			});
			await orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "start",
				sessionId,
				goalId: created.goal.id,
			});
			await orchestrator.driveGoal(sessionId, created.goal.id);
			const plan = store.loadGoal(created.goal.id)!.plan!;
			store.close();
			const tamper = new DatabaseSync(path);
			if (corruption === "missing") plan.steps[0]!.goalId = "missing-child";
			else if (corruption === "duplicate") plan.steps[0]!.goalId = plan.steps[1]!.goalId!;
			else if (corruption === "swapped")
				[plan.steps[0]!.goalId, plan.steps[1]!.goalId] = [plan.steps[1]!.goalId!, plan.steps[0]!.goalId!];
			else
				tamper
					.prepare("UPDATE goals SET parent_session_id = ? WHERE goal_id = ?")
					.run(foreign.snapshot.session.id, plan.steps[0]!.goalId!);
			tamper.prepare("UPDATE goals SET plan_json = ? WHERE goal_id = ?").run(JSON.stringify(plan), created.goal.id);
			tamper.close();
			const reopened = new SqliteOrchestratorStore(path);
			try {
				const restarted = new SessionOrchestrator(reopened, runtime);
				expect(() => restarted.listGoals(sessionId)).toThrowError(expect.objectContaining({ code: "corrupt_storage" }));
				expect(runtime.calls).toBe(2);
			} finally {
				reopened.close();
			}
		}
	);

	it("keeps every dependency represented in bounded fan-in execution and review prompts", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const prompts: string[] = [];
		const roots = Array.from({ length: 19 }, (_, index) => ({
			id: String(index).padStart(2, "0") + "x".repeat(198),
			title: "Source " + index,
			objective: "Source",
			dependsOn: [] as string[],
		}));
		class FanInRuntime extends GoalReviewRuntime {
			override async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
				const text = input.operation.payload.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const result = await super.executeTurn(input);
				if (
					text.includes("Current step merge (") ||
					text.startsWith("Review the candidate result") ||
					text.startsWith("Continue working on this goal")
				)
					prompts.push(text);
				else
					return {
						...result,
						items: result.items.map((item) =>
							item.type === "assistant"
								? {
										...item,
										content: [{ type: "text" as const, text: "EVIDENCE " + "z".repeat(12000) }],
									}
								: item
						),
					};
				return result;
			}
		}
		try {
			const orchestrator = new SessionOrchestrator(store, new FanInRuntime(["fail", "pass"]), {
				clock: () => 100,
				idFactory: ids("fan-in"),
			});
			const parent = await orchestrator.createSession(createInput());
			const sessionId = parent.snapshot.session.id;
			const created = await orchestrator.createGoal({
				principalId: "user-1",
				idempotencyKey: "create",
				sessionId,
				objective: "O".repeat(20000),
				plan: {
					maxParallel: 4,
					steps: [
						...roots,
						{
							id: "merge",
							title: "Merge",
							objective: "M".repeat(20000),
							dependsOn: roots.map((step) => step.id),
							successCriteria: "C".repeat(4000),
							maxRounds: 2,
						},
					],
				},
			});
			await orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "start",
				sessionId,
				goalId: created.goal.id,
			});
			expect((await orchestrator.driveGoal(sessionId, created.goal.id)).status).toBe("completed");
			expect(prompts).toHaveLength(4);
			for (const prompt of prompts) {
				expect(prompt.length).toBeLessThanOrEqual(20000);
				for (const root of roots)
					expect(prompt).toContain("Dependency " + root.id + " (" + root.title + "):\nEVIDENCE");
				expect(prompt.match(/\[truncated\]/g)).toHaveLength(19);
			}
		} finally {
			store.close();
		}
	});

	it("cancels a blocked sibling and preserves a plan publication error", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const blocked = new BlockingRuntime();
		const original = new Error("publication storage unavailable");
		class PublicationFailure extends SessionOrchestrator {
			override async publishSubagentResult(...args: Parameters<SessionOrchestrator["publishSubagentResult"]>) {
				const child = store.findGoalByRunSessionId(args[1]);
				if (child?.planStepId === "a") throw original;
				return super.publishSubagentResult(...args);
			}
		}
		class Runtime extends FakeRuntime {
			override async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
				const prompt = input.operation.payload.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				if (prompt.includes("Current step b (")) return blocked.executeTurn(input);
				await blocked.started;
				return super.executeTurn(input);
			}
		}
		const orchestrator = new PublicationFailure(store, new Runtime(), {
			clock: () => 100,
			idFactory: ids("publication-failure"),
		});
		try {
			const parent = await orchestrator.createSession(createInput());
			const sessionId = parent.snapshot.session.id;
			const goal = await orchestrator.createGoal({
				principalId: "user-1",
				idempotencyKey: "create",
				sessionId,
				objective: "Publication failure",
				plan: {
					maxParallel: 2,
					steps: [
						{ id: "a", title: "A", objective: "A", dependsOn: [] },
						{ id: "b", title: "B", objective: "B", dependsOn: [] },
					],
				},
			});
			await orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "start",
				sessionId,
				goalId: goal.goal.id,
			});
			await expect(orchestrator.driveGoal(sessionId, goal.goal.id)).rejects.toBe(original);
			expect(orchestrator.listGoals(sessionId)[0]?.plan?.steps[1]?.status).toBe("cancelled");
		} finally {
			store.close();
		}
	});

	it.each([1, 2, 4])("executes twenty pipelined steps exactly once within concurrency %s", async (maxParallel) => {
		const store = new SqliteOrchestratorStore(":memory:");
		const entered = new Set<string>();
		const completed = new Set<string>();
		let active = 0;
		let peak = 0;
		const steps = Array.from({ length: 20 }, (_, index) => ({
			id: "step-" + index,
			title: "Step " + index,
			objective: "Execute " + index,
			dependsOn: index < 4 ? [] : ["step-" + (index - 4)],
		}));
		class PipelineRuntime extends FakeRuntime {
			override async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
				const prompt = input.operation.payload.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const id = /Current step (\S+) \(/.exec(prompt)![1]!;
				expect(entered.has(id)).toBe(false);
				for (const dependency of steps.find((step) => step.id === id)!.dependsOn)
					expect(completed.has(dependency)).toBe(true);
				entered.add(id);
				active += 1;
				peak = Math.max(peak, active);
				try {
					await new Promise((resolve) => setTimeout(resolve, 5));
					const result = await super.executeTurn(input);
					completed.add(id);
					return result;
				} finally {
					active -= 1;
				}
			}
		}
		const orchestrator = new SessionOrchestrator(store, new PipelineRuntime(), {
			clock: () => 100,
			idFactory: ids("pipeline-limit"),
		});
		try {
			const parent = await orchestrator.createSession(createInput());
			const sessionId = parent.snapshot.session.id;
			const goal = await orchestrator.createGoal({
				principalId: "user-1",
				idempotencyKey: "create-plan",
				sessionId,
				objective: "Pipeline limit",
				plan: { maxParallel, steps },
			});
			await orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "start-plan",
				sessionId,
				goalId: goal.goal.id,
			});
			const result = await orchestrator.driveGoal(sessionId, goal.goal.id);
			expect(result.status).toBe("completed");
			expect(result.usage.totalTokens).toBe(240);
			expect(entered.size).toBe(20);
			expect(completed.size).toBe(20);
			expect(peak).toBe(maxParallel);
			expect(active).toBe(0);
			expect(store.listPlanStepGoals(goal.goal.id)).toHaveLength(20);
		} finally {
			store.close();
		}
	});

	it("starts a ready descendant before an unrelated running branch finishes", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		let releaseSlow!: () => void;
		const descendantStarted = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const entered: string[] = [];
		let slowFinished = false;
		class StreamingPlanRuntime extends FakeRuntime {
			override async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
				const prompt = input.operation.payload.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const step = /Current step (\S+) \(/.exec(prompt)![1]!;
				entered.push(step);
				if (step === "b") {
					await descendantStarted;
					slowFinished = true;
				}
				if (step === "c") {
					expect(slowFinished).toBe(false);
					releaseSlow();
				}
				return super.executeTurn(input);
			}
		}
		const orchestrator = new SessionOrchestrator(store, new StreamingPlanRuntime(), {
			clock: () => 100,
			idFactory: ids("streaming-plan"),
		});
		const parent = await orchestrator.createSession({ ...createInput(), tokenBudget: 100 });
		const sessionId = parent.snapshot.session.id;
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "create-plan",
			sessionId,
			objective: "Pipeline branches",
			plan: {
				maxParallel: 2,
				steps: [
					{ id: "a", title: "Fast", objective: "Fast", dependsOn: [] },
					{ id: "b", title: "Slow", objective: "Slow", dependsOn: [] },
					{ id: "c", title: "Dependent", objective: "Dependent", dependsOn: ["a"] },
				],
			},
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "start-plan",
			sessionId,
			goalId: created.goal.id,
		});
		try {
			const result = await orchestrator.driveGoal(sessionId, created.goal.id);
			expect(result.status).toBe("completed");
			expect(entered).toEqual(["a", "b", "c"]);
			expect(result.usage.totalTokens).toBe(36);
		} finally {
			releaseSlow();
			store.close();
		}
	});

	it("retains dependency evidence through step review and retry before releasing descendants", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const prompts: string[] = [];
		class ReviewedPlanRuntime extends GoalReviewRuntime {
			override async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
				prompts.push(
					input.operation.payload.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n")
				);
				return super.executeTurn(input);
			}
		}
		const runtime = new ReviewedPlanRuntime(["fail", "pass"]);
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("reviewed-plan"),
		});
		const parent = await orchestrator.createSession({ ...createInput(), tokenBudget: 100 });
		const sessionId = parent.snapshot.session.id;
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "create-plan",
			sessionId,
			objective: "Reviewed dependency",
			plan: {
				steps: [
					{ id: "a", title: "Source", objective: "Collect evidence", dependsOn: [] },
					{
						id: "b",
						title: "Reviewable",
						objective: "Apply source evidence",
						dependsOn: ["a"],
						successCriteria: "Use verified evidence",
						maxRounds: 2,
					},
					{ id: "c", title: "Publish", objective: "Publish approved result", dependsOn: ["b"] },
				],
			},
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "start-plan",
			sessionId,
			goalId: created.goal.id,
		});
		const result = await orchestrator.driveGoal(sessionId, created.goal.id);
		expect(result.status).toBe("completed");
		expect(result.usage.totalTokens).toBe(12);
		expect(result.plan?.steps[1]).toMatchObject({
			round: 2,
			reviewPhase: "passed",
			usage: { totalTokens: 8 },
		});
		for (const prompt of prompts.slice(1, 5)) {
			expect(prompt).toContain("Dependency a (Source):\ncandidate-1");
			expect(prompt.length).toBeLessThanOrEqual(20000);
		}
		expect(prompts[5]).toContain("Current step c (Publish)");
		expect(prompts[5]).toContain("Dependency b (Reviewable):\ncandidate-3");
		store.close();
	});

	it("rechecks budget under the write transaction after a competing connection reserves it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-plan-race-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		let compete: (() => void) | undefined;
		class RacingStore extends SqliteOrchestratorStore {
			override attachPlanStepGoal(options: Parameters<SqliteOrchestratorStore["attachPlanStepGoal"]>[0]): void {
				const action = compete;
				compete = undefined;
				action?.();
				super.attachPlanStepGoal(options);
			}
		}
		const store = new RacingStore(path);
		const other = new SqliteOrchestratorStore(path);
		try {
			const runtime = new FakeRuntime();
			const orchestrator = new SessionOrchestrator(store, runtime, {
				clock: () => 100,
				idFactory: ids("race-budget"),
			});
			const parent = await orchestrator.createSession({ ...createInput(), tokenBudget: 100 });
			const sessionId = parent.snapshot.session.id;
			const plan = { steps: [{ id: "a", title: "A", objective: "A", dependsOn: [] }] };
			const first = await orchestrator.createGoal({
				principalId: "user-1",
				idempotencyKey: "first",
				sessionId,
				objective: "First",
				plan,
			});
			const second = await orchestrator.createGoal({
				principalId: "user-1",
				idempotencyKey: "second",
				sessionId,
				objective: "Second",
				plan,
			});
			await orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "start-first",
				sessionId,
				goalId: first.goal.id,
			});
			await orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "start-second",
				sessionId,
				goalId: second.goal.id,
			});
			compete = () => {
				const competing = other.loadGoal(second.goal.id)!;
				other.attachPlanStepGoal({
					parentGoal: {
						...competing,
						updatedAt: competing.updatedAt + 1,
						plan: {
							...competing.plan!,
							steps: [{ ...competing.plan!.steps[0]!, goalId: "competing-child", tokenBudget: 100 }],
						},
					},
					expectedUpdatedAt: competing.updatedAt,
					childGoal: {
						id: "competing-child",
						parentSessionId: sessionId,
						ownerGoalId: competing.id,
						planStepId: "a",
						title: "A",
						objective: "A",
						createdAt: 100,
						updatedAt: 100,
					},
					verifyBudgetReservation: () => {
						expect(other.listPlanStepGoals(first.goal.id)).toHaveLength(0);
					},
				});
			};
			const result = await orchestrator.driveGoal(sessionId, first.goal.id);
			expect(result.status).toBe("failed");
			expect(store.listPlanStepGoals(first.goal.id)).toHaveLength(0);
			expect(other.listPlanStepGoals(second.goal.id)).toHaveLength(1);
			expect(runtime.calls).toBe(0);
		} finally {
			other.close();
			store.close();
		}
	});

	it("does not allocate a sibling plan's active reservation twice", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new BlockingRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("shared-reservation"),
		});
		const parent = await orchestrator.createSession({
			...createInput(),
			tokenBudget: 100,
			costBudgetUsd: 1,
		});
		const sessionId = parent.snapshot.session.id;
		const plan = { steps: [{ id: "a", title: "A", objective: "A", dependsOn: [] }] };
		const first = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "first",
			sessionId,
			objective: "First",
			plan,
		});
		const second = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "second",
			sessionId,
			objective: "Second",
			plan,
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "start-first",
			sessionId,
			goalId: first.goal.id,
		});
		const driving = orchestrator.driveGoal(sessionId, first.goal.id);
		await runtime.started;
		try {
			await orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "start-second",
				sessionId,
				goalId: second.goal.id,
			});
			const result = await orchestrator.driveGoal(sessionId, second.goal.id);
			expect(result.status).toBe("failed");
			expect(result.plan?.steps[0]?.status).toBe("skipped");
			expect(result.plan?.steps[0]?.skipReason).toContain("allocated");
			expect(store.listPlanStepGoals(second.goal.id)).toHaveLength(0);
			expect(store.loadGoal(first.goal.id)?.plan?.steps[0]).toMatchObject({
				tokenBudget: 100,
				costBudgetUsd: 1,
			});
		} finally {
			await orchestrator.cancelGoal({
				principalId: "user-1",
				idempotencyKey: "cancel-first",
				sessionId,
				goalId: first.goal.id,
			});
			await driving;
			store.close();
		}
	});

	it.each([false, true])("recovers the persisted step attachment boundary (cancelled=%s)", async (cancelled) => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-plan-boundary-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		class InterruptedStore extends SqliteOrchestratorStore {
			override attachPlanStepGoal(options: Parameters<SqliteOrchestratorStore["attachPlanStepGoal"]>[0]): void {
				super.attachPlanStepGoal(options);
				throw new Error("interrupted after durable step attachment");
			}
		}
		const store = new InterruptedStore(path);
		const runtime = new FakeRuntime();
		const first = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("plan-boundary"),
		});
		const parent = await first.createSession({ ...createInput(), tokenBudget: 100 });
		const sessionId = parent.snapshot.session.id;
		const created = await first.createGoal({
			principalId: "user-1",
			idempotencyKey: "create-plan",
			sessionId,
			objective: "Recover attached step",
			plan: { steps: [{ id: "a", title: "A", objective: "A", dependsOn: [] }] },
		});
		await first.startGoal({
			principalId: "user-1",
			idempotencyKey: "start-plan",
			sessionId,
			goalId: created.goal.id,
		});
		await expect(first.driveGoal(sessionId, created.goal.id)).rejects.toThrow(
			"interrupted after durable step attachment"
		);
		const attached = store.listPlanStepGoals(created.goal.id);
		expect(attached).toHaveLength(1);
		expect(attached[0]?.runSessionId).toBeUndefined();
		if (cancelled) {
			await first.startGoal({
				principalId: "user-1",
				idempotencyKey: "queue-child",
				sessionId,
				goalId: attached[0]!.id,
			});
			const goal = store.loadGoal(created.goal.id)!;
			store.updateGoal(
				{
					...goal,
					updatedAt: goal.updatedAt + 1,
					cancelledAt: 200,
					plan: { ...goal.plan!, phase: "cancelled" },
				},
				goal.updatedAt
			);
		}
		store.close();
		const reopened = new SqliteOrchestratorStore(path);
		try {
			const restarted = new SessionOrchestrator(reopened, runtime, {
				clock: () => 300,
				idFactory: ids("plan-recovered"),
			});
			await restarted.resumeGoalPlans();
			const result = restarted.listGoals(sessionId)[0]!;
			expect(result.status).toBe(cancelled ? "cancelled" : "completed");
			expect(result.plan?.steps[0]?.status).toBe(cancelled ? "cancelled" : "completed");
			expect(result.plan?.steps[0]?.goalId).toBe(attached[0]!.id);
			expect(result.plan?.steps[0]?.tokenBudget).toBe(100);
			expect(runtime.calls).toBe(cancelled ? 0 : 1);
			await restarted.resumeGoalPlans();
			expect(runtime.calls).toBe(cancelled ? 0 : 1);
			expect(reopened.listPlanStepGoals(created.goal.id)).toHaveLength(1);
		} finally {
			reopened.close();
		}
	});

	it.each(["goal", "automation", "run"] as const)(
		"rejects a stored dependency cycle in a %s before execution",
		async (target) => {
			const directory = mkdtempSync(join(tmpdir(), "wuming-corrupt-plan-"));
			cleanup.push(directory);
			const path = join(directory, "orchestrator.sqlite");
			const store = new SqliteOrchestratorStore(path);
			const runtime = new FakeRuntime();
			const orchestrator = new SessionOrchestrator(store, runtime, {
				clock: () => 100,
				idFactory: ids("corrupt-plan"),
			});
			const parent = await orchestrator.createSession(createInput());
			const sessionId = parent.snapshot.session.id;
			const plan = {
				steps: [
					{ id: "a", title: "A", objective: "A", dependsOn: [] as string[] },
					{ id: "b", title: "B", objective: "B", dependsOn: ["a"] },
				],
			};
			const goal = await orchestrator.createGoal({
				principalId: "user-1",
				idempotencyKey: "goal",
				sessionId,
				objective: "Goal",
				plan,
			});
			const automation = await orchestrator.createAutomation({
				principalId: "user-1",
				idempotencyKey: "automation",
				sessionId,
				objective: "Automation",
				schedule: { kind: "once", runAt: 1000 },
				plan,
			});
			const run = await orchestrator.triggerAutomation({
				principalId: "user-1",
				idempotencyKey: "trigger",
				sessionId,
				automationId: automation.automation.id,
			});
			store.close();
			const database = new DatabaseSync(path);
			const table = target === "goal" ? "goals" : target === "automation" ? "goal_automations" : "automation_runs";
			const column = target === "run" ? "spec_json" : "plan_json";
			const row = database.prepare("SELECT " + column + " AS value FROM " + table).get() as {
				value: string;
			};
			const value = JSON.parse(row.value);
			const graph = target === "run" ? value.plan : value;
			graph.steps[0].dependsOn = ["b"];
			database.prepare("UPDATE " + table + " SET " + column + " = ?").run(JSON.stringify(value));
			database.close();
			const reopened = new SqliteOrchestratorStore(path);
			try {
				const load = () =>
					target === "goal"
						? reopened.loadGoal(goal.goal.id)
						: target === "automation"
							? reopened.loadAutomation(automation.automation.id)
							: reopened.loadAutomationRun(run.run.id);
				expect(load).toThrowError(expect.objectContaining({ code: "corrupt_storage" }));
				expect(runtime.calls).toBe(0);
			} finally {
				reopened.close();
			}
		}
	);

	it.each(["fail_fast", "continue_independent"] as const)(
		"honors %s while a sibling branch is active",
		async (failurePolicy) => {
			const store = new SqliteOrchestratorStore(":memory:");
			let markSiblingStarted!: () => void;
			const siblingStarted = new Promise<void>((resolve) => {
				markSiblingStarted = resolve;
			});
			let siblingAborted = false;
			class BranchRuntime extends FakeRuntime {
				override async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
					const prompt = input.operation.payload.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
					if (prompt.includes("Current step a (")) {
						await siblingStarted;
						throw new Error("Branch A failed");
					}
					markSiblingStarted();
					if (failurePolicy === "fail_fast") {
						await new Promise<void>((resolve, reject) => {
							const abort = () => {
								siblingAborted = true;
								reject(input.signal.reason ?? new Error("aborted"));
							};
							if (input.signal.aborted) abort();
							else input.signal.addEventListener("abort", abort, { once: true });
						});
					}
					return super.executeTurn(input);
				}
			}
			const orchestrator = new SessionOrchestrator(store, new BranchRuntime(), {
				clock: () => 100,
				idFactory: ids("dag-policy"),
				maxRetries: 0,
			});
			const parent = await orchestrator.createSession(createInput());
			const sessionId = parent.snapshot.session.id;
			const created = await orchestrator.createGoal({
				principalId: "user-1",
				idempotencyKey: "create-plan",
				sessionId,
				objective: "Concurrent failure",
				plan: {
					maxParallel: 2,
					failurePolicy,
					steps: [
						{ id: "a", title: "A", objective: "A", dependsOn: [] },
						{ id: "b", title: "B", objective: "B", dependsOn: [] },
						{ id: "c", title: "C", objective: "C", dependsOn: ["a"] },
						{ id: "d", title: "D", objective: "D", dependsOn: ["b"] },
					],
				},
			});
			await orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "start-plan",
				sessionId,
				goalId: created.goal.id,
			});
			const result = await orchestrator.driveGoal(sessionId, created.goal.id);
			expect(result.status).toBe("failed");
			expect(result.plan?.steps.map((step) => step.status)).toEqual(
				failurePolicy === "fail_fast"
					? ["failed", "cancelled", "skipped", "skipped"]
					: ["failed", "completed", "skipped", "completed"]
			);
			expect(siblingAborted).toBe(failurePolicy === "fail_fast");
			store.close();
		}
	);

	it("starts independent roots concurrently with split budgets and forwards both results", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		let release!: () => void;
		const rootsReady = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prompts: string[] = [];
		const budgets: Array<number | undefined> = [];
		class ParallelRuntime extends FakeRuntime {
			override async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
				const position = prompts.length;
				prompts.push(
					input.operation.payload.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n")
				);
				budgets.push(input.snapshot.tokenBudget);
				if (position < 2) {
					if (prompts.length === 2) release();
					await rootsReady;
				}
				return super.executeTurn(input);
			}
		}
		const orchestrator = new SessionOrchestrator(store, new ParallelRuntime(), {
			clock: () => 100,
			idFactory: ids("dag-parallel"),
		});
		const parent = await orchestrator.createSession({ ...createInput(), tokenBudget: 100 });
		const sessionId = parent.snapshot.session.id;
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "create-plan",
			sessionId,
			objective: "Parallel research",
			plan: {
				maxParallel: 2,
				steps: [
					{ id: "a", title: "A", objective: "A", dependsOn: [] },
					{ id: "b", title: "B", objective: "B", dependsOn: [] },
					{ id: "c", title: "C", objective: "C", dependsOn: ["a", "b"] },
				],
			},
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "start-plan",
			sessionId,
			goalId: created.goal.id,
		});
		const result = await orchestrator.driveGoal(sessionId, created.goal.id);
		expect(result.status).toBe("completed");
		expect(budgets).toEqual([50, 50, 76]);
		expect(prompts[2]).toContain("Dependency a (A):\ndone");
		expect(prompts[2]).toContain("Dependency b (B):\ndone");
		store.close();
	});

	it("settles a DAG when its remaining budget cannot launch a dependency", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FakeRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("dag-budget"),
		});
		const parent = await orchestrator.createSession({ ...createInput(), tokenBudget: 12 });
		const sessionId = parent.snapshot.session.id;
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "create-plan",
			sessionId,
			objective: "Budget boundary",
			plan: {
				steps: [
					{ id: "a", title: "A", objective: "A", dependsOn: [] },
					{ id: "b", title: "B", objective: "B", dependsOn: ["a"] },
				],
			},
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "start-plan",
			sessionId,
			goalId: created.goal.id,
		});
		const result = await orchestrator.driveGoal(sessionId, created.goal.id);
		expect(result.status).toBe("failed");
		expect(result.plan?.steps.map((step) => step.status)).toEqual(["completed", "skipped"]);
		expect(result.plan?.steps[1]?.skipReason).toContain("budget");
		expect(runtime.calls).toBe(1);
		expect(await orchestrator.resumeGoalPlans()).toBe(0);
		store.close();
	});

	it("cancels all active DAG branches while the parent driver is running", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new BlockingRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("dag-cancel"),
		});
		const parent = await orchestrator.createSession(createInput());
		const sessionId = parent.snapshot.session.id;
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "create-plan",
			sessionId,
			objective: "Cancel branches",
			plan: {
				maxParallel: 2,
				steps: [
					{ id: "a", title: "A", objective: "A", dependsOn: [] },
					{ id: "b", title: "B", objective: "B", dependsOn: [] },
					{ id: "c", title: "C", objective: "C", dependsOn: ["a", "b"] },
				],
			},
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "start-plan",
			sessionId,
			goalId: created.goal.id,
		});
		const driving = orchestrator.driveGoal(sessionId, created.goal.id);
		await runtime.started;
		await orchestrator.cancelGoal({
			principalId: "user-1",
			idempotencyKey: "cancel-plan",
			sessionId,
			goalId: created.goal.id,
		});
		await driving;
		const result = orchestrator.listGoals(sessionId)[0]!;
		expect(result.status).toBe("cancelled");
		expect(result.plan?.steps.map((step) => step.status)).toEqual(["cancelled", "cancelled", "skipped"]);
		store.close();
	});

	it("recovers a started DAG without creating duplicate steps", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const first = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("dag-first"),
		});
		const parent = await first.createSession(createInput());
		const sessionId = parent.snapshot.session.id;
		const created = await first.createGoal({
			principalId: "user-1",
			idempotencyKey: "create-plan",
			sessionId,
			objective: "Recover plan",
			plan: { steps: [{ id: "a", title: "A", objective: "A", dependsOn: [] }] },
		});
		await first.startGoal({
			principalId: "user-1",
			idempotencyKey: "start-plan",
			sessionId,
			goalId: created.goal.id,
		});
		const runtime = new FakeRuntime();
		const restarted = new SessionOrchestrator(store, runtime, {
			clock: () => 200,
			idFactory: ids("dag-restart"),
		});
		expect(await restarted.resumeGoalPlans()).toBe(1);
		expect(restarted.listGoals(sessionId)[0]?.status).toBe("completed");
		expect(await restarted.resumeGoalPlans()).toBe(0);
		expect(runtime.calls).toBe(1);
		expect(store.listPlanStepGoals(created.goal.id)).toHaveLength(1);
		store.close();
	});

	it("fails fast and skips unstarted DAG steps", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FailingRuntime(), {
			clock: () => 100,
			idFactory: ids("dag-fail"),
			maxRetries: 0,
		});
		const parent = await orchestrator.createSession(createInput());
		const sessionId = parent.snapshot.session.id;
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "create-plan",
			sessionId,
			objective: "Failure",
			plan: {
				maxParallel: 1,
				steps: [
					{ id: "a", title: "A", objective: "A", dependsOn: [] },
					{ id: "b", title: "B", objective: "B", dependsOn: [] },
					{ id: "c", title: "C", objective: "C", dependsOn: ["a"] },
				],
			},
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "start-plan",
			sessionId,
			goalId: created.goal.id,
		});
		const result = await orchestrator.driveGoal(sessionId, created.goal.id);
		expect(result.status).toBe("failed");
		expect(result.plan?.steps.map((step) => step.status)).toEqual(["failed", "skipped", "skipped"]);
		store.close();
	});

	it("rejects invalid DAG dependencies before persistence", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			idFactory: ids("dag-invalid"),
		});
		const parent = await orchestrator.createSession(createInput());
		for (const dependency of ["a", "missing"]) {
			await expect(
				orchestrator.createGoal({
					principalId: "user-1",
					idempotencyKey: dependency,
					sessionId: parent.snapshot.session.id,
					objective: "Invalid",
					plan: { steps: [{ id: "a", title: "A", objective: "A", dependsOn: [dependency] }] },
				})
			).rejects.toMatchObject({ code: "conflict" });
		}
		expect(orchestrator.listGoals(parent.snapshot.session.id)).toEqual([]);
		store.close();
	});

	it("executes an out-of-order DAG and hides internal goals", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FakeRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("dag"),
		});
		const parent = await orchestrator.createSession(createInput());
		const sessionId = parent.snapshot.session.id;
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "dag-create",
			sessionId,
			objective: "Combine research",
			plan: {
				maxParallel: 2,
				steps: [
					{ id: "c", title: "Combine", objective: "Combine both results", dependsOn: ["a", "b"] },
					{ id: "a", title: "Research A", objective: "Research A", dependsOn: [] },
					{ id: "b", title: "Research B", objective: "Research B", dependsOn: [] },
				],
			},
		});
		expect(created.goal.plan?.steps[0]?.status).toBe("blocked");
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "dag-start",
			sessionId,
			goalId: created.goal.id,
		});
		const completed = await orchestrator.driveGoal(sessionId, created.goal.id);
		expect(completed).toMatchObject({
			status: "completed",
			result: "done",
			usage: { totalTokens: 36 },
		});
		expect(runtime.calls).toBe(3);
		expect(orchestrator.listGoals(sessionId)).toHaveLength(1);
		expect(store.listPlanStepGoals(created.goal.id)).toHaveLength(3);
		store.close();
	});

	it("persists verifiable capability and context plans before execution and reloads them from SQLite", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-capability-plan-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		const store = new SqliteOrchestratorStore(path);
		const runtime = new CapabilityRuntime();
		runtime.store = store;
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("capability"),
		});
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "capability-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "inspect the repository" }],
		});
		const operationId = store.listOperations(created.snapshot.session.id)[0]!.id;
		let storeClosed = false;
		try {
			await orchestrator.drainSession(created.snapshot.session.id, "capability-worker");

			const stored = store.getOperation(operationId)?.capabilityPlan;
			const storedContext = store.getOperation(operationId)?.contextPlan;
			expect(runtime.resolveCalls).toBe(1);
			expect(runtime.persistedBeforeExecute).toBe(true);
			expect(runtime.contextPersistedBeforeExecute).toBe(true);
			expect(runtime.receivedPlan).toEqual(stored);
			expect(runtime.receivedContextPlan).toEqual(storedContext);
			expect(stored?.modelVisible.tools).toEqual(["read_file"]);
			expect(stored && verifyCapabilityPlan(stored)).toBe(true);
			expect(storedContext && verifyContextPlan(storedContext)).toBe(true);
			const report = store.trajectoryReport(operationId);
			expect(report.replay.integrity).toBe(true);
			expect(report.replay.events.map((event) => event.data.type)).toEqual([
				"operation.accepted",
				"operation.started",
				"capability.resolved",
				"context.resolved",
				"model.request",
				"tool.summary",
				"operation.finished",
			]);
			expect(report.evaluation).toMatchObject({
				algorithm: "structural-v1",
				verdict: "pass",
				score: 100,
				semanticCorrectness: "not_evaluated",
			});
			store.close();
			storeClosed = true;

			const reopened = new SqliteOrchestratorStore(path);
			try {
				const restored = reopened.getOperation(operationId)?.capabilityPlan;
				const restoredContext = reopened.getOperation(operationId)?.contextPlan;
				expect(restored).toEqual(stored);
				expect(restoredContext).toEqual(storedContext);
				expect(restored && verifyCapabilityPlan(restored)).toBe(true);
				expect(restoredContext && verifyContextPlan(restoredContext)).toBe(true);
				expect(reopened.trajectoryReport(operationId)).toEqual(report);
			} finally {
				reopened.close();
			}
		} finally {
			if (!storeClosed) store.close();
		}
	});

	it("persists automatic compaction memory and its trajectory evidence across SQLite restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-auto-memory-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		const store = new SqliteOrchestratorStore(path);
		const orchestrator = new SessionOrchestrator(store, new AutoCompactingRuntime(), {
			clock: () => 100,
			idFactory: ids("memory"),
		});
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "memory-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "retain this decision" }],
		});
		const operationId = store.listOperations(created.snapshot.session.id)[0]!.id;
		await orchestrator.drainSession(created.snapshot.session.id, "memory-worker");
		const memories = store.listMemories(created.snapshot.session.id);
		expect(memories).toMatchObject([
			{
				sessionId: created.snapshot.session.id,
				operationId,
				reason: "threshold",
				tokensBefore: 900,
				estimatedTokensAfter: 220,
				source: {
					revision: expect.any(Number),
					fromItemId: expect.any(String),
					throughItemId: expect.any(String),
				},
			},
		]);
		expect(
			store.trajectoryReport(operationId).replay.events.find((event) => event.data.type === "compaction.completed")
				?.data
		).toMatchObject({
			memoryId: memories[0]!.id,
			reason: "threshold",
			memoryDigest: memories[0]!.digest,
		});
		store.close();

		const reopened = new SqliteOrchestratorStore(path);
		try {
			expect(reopened.listMemories(created.snapshot.session.id)).toEqual(memories);
			expect(reopened.loadSnapshot(created.snapshot.session.id)?.contextUsage).toEqual({
				model: created.snapshot.model,
				tokens: 220,
				basis: "compaction",
			});
			expect(reopened.trajectoryReport(operationId).replay.integrity).toBe(true);
		} finally {
			reopened.close();
		}

		const tamper = new DatabaseSync(path);
		try {
			const row = tamper.prepare("SELECT memory_id, memory_json FROM session_memories LIMIT 1").get() as unknown as {
				memory_id: string;
				memory_json: string;
			};
			const changed = {
				...(JSON.parse(row.memory_json) as Record<string, unknown>),
				summary: "tampered summary",
			};
			tamper
				.prepare("UPDATE session_memories SET memory_json = ? WHERE memory_id = ?")
				.run(JSON.stringify(changed), row.memory_id);
		} finally {
			tamper.close();
		}
		const corrupted = new SqliteOrchestratorStore(path);
		try {
			expect(() => corrupted.listMemories(created.snapshot.session.id)).toThrowError(OrchestratorError);
		} finally {
			corrupted.close();
		}
	});

	it("retains, supersedes, releases, forgets, and idempotently manages session memories", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-memory-lifecycle-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		const store = new SqliteOrchestratorStore(path);
		const orchestrator = new SessionOrchestrator(store, new AutoCompactingRuntime(), {
			clock: () => 200,
			idFactory: ids("memory-life"),
		});
		const created = await orchestrator.createSession(createInput());
		const sessionId = created.snapshot.session.id;
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "memory-life-turn-1",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "first decision" }],
		});
		await orchestrator.drainSession(sessionId, "memory-life-worker-1");
		const first = store.listMemoryRecords(sessionId)[0]!;
		expect(first).toMatchObject({ status: "active", retention: "automatic" });

		const promoted = await orchestrator.manageMemory({
			principalId: "user-1",
			idempotencyKey: "memory-promote",
			sessionId,
			memoryId: first.memory.id,
			action: "promote",
		});
		expect(promoted).toMatchObject({ status: "active", retention: "retained" });
		expect(
			await orchestrator.manageMemory({
				principalId: "user-1",
				idempotencyKey: "memory-promote",
				sessionId,
				memoryId: first.memory.id,
				action: "promote",
			})
		).toEqual(promoted);

		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "memory-life-turn-2",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "second decision" }],
		});
		await orchestrator.drainSession(sessionId, "memory-life-worker-2");
		const activeAfterSecond = store.listMemoryRecords(sessionId);
		expect(activeAfterSecond).toHaveLength(2);
		const second = activeAfterSecond.find((record) => record.memory.id !== first.memory.id)!;

		const released = await orchestrator.manageMemory({
			principalId: "user-1",
			idempotencyKey: "memory-release",
			sessionId,
			memoryId: first.memory.id,
			action: "release",
		});
		expect(released).toMatchObject({ status: "superseded", retention: "automatic" });
		expect(store.listMemoryRecords(sessionId).map((record) => record.memory.id)).toEqual([second.memory.id]);
		expect(store.searchMemories(sessionId, "verified repository").map((match) => match.memory.memory.id)).toEqual([
			second.memory.id,
		]);

		const forgotten = await orchestrator.manageMemory({
			principalId: "user-1",
			idempotencyKey: "memory-forget",
			sessionId,
			memoryId: second.memory.id,
			action: "forget",
		});
		expect(forgotten).toMatchObject({ status: "forgotten", retention: "automatic" });
		expect(store.listMemoryRecords(sessionId)).toEqual([]);
		expect(store.searchMemories(sessionId, "verified repository")).toEqual([]);
		expect(store.listMemoryRecords(sessionId, { includeInactive: true })).toEqual([
			expect.objectContaining({
				memory: expect.objectContaining({ id: first.memory.id }),
				status: "superseded",
			}),
		]);
		expect(store.countOperationMemories(second.memory.operationId!)).toBe(1);
		expect(store.listMemoryLifecycleEvents(first.memory.id).map((event) => event.action)).toEqual([
			"created",
			"promote",
			"release",
		]);
		expect(store.listMemoryLifecycleEvents(first.memory.id).at(-1)).toMatchObject({
			actorId: "user-1",
			relatedMemoryId: second.memory.id,
		});
		expect(store.listMemoryLifecycleEvents(second.memory.id).map((event) => event.action)).toEqual([
			"created",
			"forget",
		]);
		store.close();
		const database = new DatabaseSync(path);
		try {
			expect(
				database.prepare("SELECT COUNT(*) AS count FROM session_memories WHERE memory_id = ?").get(second.memory.id)
			).toMatchObject({ count: 0 });
			const tombstone = database
				.prepare(
					"SELECT memory_id, memory_digest, source_revision, lifecycle_json FROM session_memory_tombstones WHERE memory_id = ?"
				)
				.get(second.memory.id) as unknown as Record<string, unknown>;
			expect(tombstone).toMatchObject({
				memory_id: second.memory.id,
				memory_digest: second.memory.digest,
				source_revision: second.memory.source.revision,
			});
			expect(JSON.stringify(tombstone)).not.toContain(second.memory.summary);
		} finally {
			database.close();
		}
	});

	it("automatically supersedes an unretained memory with a newer compaction covering its revision", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new AutoCompactingRuntime(), {
			clock: () => 250,
			idFactory: ids("memory-auto-life"),
		});
		const sessionId = (await orchestrator.createSession(createInput())).snapshot.session.id;
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "auto-life-1",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "first" }],
		});
		await orchestrator.drainSession(sessionId, "auto-life-worker-1");
		const first = store.listMemoryRecords(sessionId)[0]!;
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "auto-life-2",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "second" }],
		});
		await orchestrator.drainSession(sessionId, "auto-life-worker-2");
		const active = store.listMemoryRecords(sessionId);
		expect(active).toHaveLength(1);
		expect(active[0]!.memory.id).not.toBe(first.memory.id);
		const prior = store
			.listMemoryRecords(sessionId, { includeInactive: true })
			.find((record) => record.memory.id === first.memory.id);
		expect(prior).toMatchObject({ status: "superseded", supersededBy: active[0]!.memory.id });
		expect(store.listMemoryLifecycleEvents(first.memory.id).at(-1)).toMatchObject({
			action: "auto_superseded",
			actorId: "system:retention",
			relatedMemoryId: active[0]!.memory.id,
		});
	});

	it("runs planned operation hooks and preserves their audit trail across SQLite restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-hook-audit-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		const store = new SqliteOrchestratorStore(path);
		const runtime = new HookAwareRuntime();
		const pipeline = new HookPipeline({ clock: () => 101 });
		const seen: string[] = [];
		pipeline.register(operationHookManifest(), (invocation) => {
			seen.push(invocation.point);
			return { annotations: { operationId: invocation.operationId } };
		});
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("hook-audit"),
			hookPipeline: pipeline,
		});
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "hook-audit-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "run with hooks" }],
		});
		const operationId = store.listOperations(created.snapshot.session.id)[0]!.id;
		await orchestrator.drainSession(created.snapshot.session.id, "hook-audit-worker");
		expect(seen).toEqual(["operation.before_execute", "operation.after_execute"]);
		expect(store.listHookAuditRecords(operationId).map((record) => record.outcome)).toEqual(["completed", "completed"]);
		expect(
			store
				.trajectoryReport(operationId)
				.replay.events.filter((event) => event.data.type === "hook.executed")
				.map((event) => event.data)
		).toMatchObject([
			{ point: "operation.before_execute", outcome: "completed" },
			{ point: "operation.after_execute", outcome: "completed" },
		]);
		store.close();

		const reopened = new SqliteOrchestratorStore(path);
		try {
			expect(reopened.listHookAuditRecords(operationId).map((record) => record.point)).toEqual([
				"operation.before_execute",
				"operation.after_execute",
			]);
		} finally {
			reopened.close();
		}
	});

	it("fails closed before runtime execution and audits the hook denial", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new HookAwareRuntime();
		const pipeline = new HookPipeline({ clock: () => 101 });
		pipeline.register(operationHookManifest(), (invocation) =>
			invocation.point === "operation.before_execute"
				? { decision: "deny", code: "policy_block", reason: "operation denied by policy" }
				: undefined
		);
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("hook-deny"),
			hookPipeline: pipeline,
		});
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "hook-deny-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "must be denied" }],
		});
		const operationId = store.listOperations(created.snapshot.session.id)[0]!.id;
		await orchestrator.drainSession(created.snapshot.session.id, "hook-deny-worker");
		expect(runtime.calls).toBe(0);
		expect(store.getOperation(operationId)).toMatchObject({
			status: "failed",
			error: expect.stringContaining("operation denied by policy"),
		});
		expect(store.listHookAuditRecords(operationId).map((record) => [record.point, record.outcome])).toEqual([
			["operation.before_execute", "denied"],
			["operation.on_error", "completed"],
		]);
		store.close();
	});

	it("migrates a pre-plan operation table without rebuilding existing storage", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-capability-migration-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		const legacy = new DatabaseSync(path);
		legacy.exec(`
			CREATE TABLE operations (
				operation_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				type TEXT NOT NULL,
				status TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				abort_requested INTEGER NOT NULL DEFAULT 0,
				trace_id TEXT,
				error TEXT,
				retry_after INTEGER,
				usage_json TEXT,
				tools_json TEXT,
				failure_kind TEXT,
				retry_history_json TEXT,
				approval_id TEXT,
				approval_tool_call_id TEXT
			)
		`);
		legacy.close();

		const store = new SqliteOrchestratorStore(path);
		try {
			const runtime = new CapabilityRuntime();
			runtime.store = store;
			const orchestrator = new SessionOrchestrator(store, runtime, {
				clock: () => 100,
				idFactory: ids("migration"),
			});
			const created = await orchestrator.createSession(createInput());
			await orchestrator.acceptTurn({
				principalId: "user-1",
				idempotencyKey: "migration-turn",
				sessionId: created.snapshot.session.id,
				mode: "prompt",
				content: [{ type: "text", text: "inspect the repository" }],
			});
			await orchestrator.drainSession(created.snapshot.session.id, "migration-worker");
			const plan = store.listOperations(created.snapshot.session.id)[0]?.capabilityPlan;
			const contextPlan = store.listOperations(created.snapshot.session.id)[0]?.contextPlan;
			expect(plan && verifyCapabilityPlan(plan)).toBe(true);
			expect(contextPlan && verifyContextPlan(contextPlan)).toBe(true);
		} finally {
			store.close();
		}
	});

	it("runs a durable child session and publishes its result and usage to the parent", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FakeRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("subagent"),
		});
		const parent = await orchestrator.createSession({
			...createInput(),
			costBudgetUsd: 1,
			tokenBudget: 100,
		});
		const created = await orchestrator.createSubagent({
			principalId: "user-1",
			idempotencyKey: "subagent-create-1",
			sourceToolCallId: "source-call",
			sessionId: parent.snapshot.session.id,
			task: "Inspect the authentication flow",
			costBudgetUsd: 0.25,
			tokenBudget: 50,
		});

		expect(created.subagent).toMatchObject({
			sourceToolCallId: "source-call",
			parentSessionId: parent.snapshot.session.id,
			depth: 1,
			status: "queued",
			task: "Inspect the authentication flow",
			costBudgetUsd: 0.25,
			tokenBudget: 50,
		});
		expect(store.listSnapshots("workspace-1").map((snapshot) => snapshot.session.id)).toEqual([
			parent.snapshot.session.id,
		]);
		expect(orchestrator.listSubagents(parent.snapshot.session.id)).toHaveLength(1);
		expect(await orchestrator.drainSession(created.subagent.sessionId, "subagent-worker")).toBe(1);
		const completed = await orchestrator.publishSubagentResult(parent.snapshot.session.id, created.subagent.sessionId);
		expect(completed).toMatchObject({
			status: "completed",
			result: "done",
			usage: { totalTokens: 12, costUsd: 0.01 },
		});

		const parentAfter = store.loadSnapshot(parent.snapshot.session.id)!;
		expect(parentAfter.transcript.at(-1)).toMatchObject({
			type: "tool",
			toolCallId: created.subagent.sessionId,
			toolName: "subagent",
			status: "complete",
			isError: false,
		});
		expect(parentAfter.usage).toMatchObject({ totalTokens: 12, costUsd: 0.01 });
		expect(parentAfter.usageByTool).toEqual([
			expect.objectContaining({ toolName: "subagent", callCount: 1, succeededCount: 1 }),
		]);
		await orchestrator.publishSubagentResult(parent.snapshot.session.id, created.subagent.sessionId);
		expect(store.loadSnapshot(parent.snapshot.session.id)?.usage.totalTokens).toBe(12);
		store.close();
	});

	it("bounds nested delegation and cascades cancellation through descendants", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("nested"),
		});
		const root = await orchestrator.createSession(createInput());
		const first = await orchestrator.createSubagent({
			principalId: "user-1",
			idempotencyKey: "nested-1",
			sessionId: root.snapshot.session.id,
			task: "Coordinate the investigation",
		});
		const second = await orchestrator.createSubagent({
			principalId: "agent:first",
			idempotencyKey: "nested-2",
			sessionId: first.subagent.sessionId,
			task: "Inspect the protocol",
		});
		const third = await orchestrator.createSubagent({
			principalId: "agent:second",
			idempotencyKey: "nested-3",
			sessionId: second.subagent.sessionId,
			task: "Check schema callers",
		});

		expect([first.subagent.depth, second.subagent.depth, third.subagent.depth]).toEqual([1, 2, 3]);
		expect(orchestrator.subagentDepth(root.snapshot.session.id)).toBe(0);
		await expect(
			orchestrator.createSubagent({
				principalId: "agent:third",
				idempotencyKey: "nested-4",
				sessionId: third.subagent.sessionId,
				task: "Exceed the bound",
			})
		).rejects.toMatchObject({ code: "conflict", message: "Subagents are limited to 3 levels" });

		await orchestrator.cancelSubagent({
			principalId: "user-1",
			idempotencyKey: "cancel-nested-tree",
			sessionId: root.snapshot.session.id,
			subagentId: first.subagent.sessionId,
		});
		expect(orchestrator.subagentSummary(root.snapshot.session.id, first.subagent.sessionId)).toMatchObject({
			depth: 1,
			status: "cancelled",
		});
		expect(orchestrator.subagentSummary(first.subagent.sessionId, second.subagent.sessionId)).toMatchObject({
			depth: 2,
			status: "cancelled",
		});
		expect(orchestrator.subagentSummary(second.subagent.sessionId, third.subagent.sessionId)).toMatchObject({
			depth: 3,
			status: "cancelled",
		});
		store.close();
	});

	it("cascades cancellation to every descendant beyond the UI list limit", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("wide-tree"),
		});
		const root = await orchestrator.createSession(createInput());
		const branch = await orchestrator.createSubagent({
			principalId: "user-1",
			idempotencyKey: "wide-branch",
			sessionId: root.snapshot.session.id,
			task: "Coordinate a wide investigation",
		});
		const descendants = [];
		for (let index = 0; index < 105; index += 1) {
			descendants.push(
				await orchestrator.createSubagent({
					principalId: "agent:branch",
					idempotencyKey: `wide-child-${index}`,
					sessionId: branch.subagent.sessionId,
					task: `Inspect partition ${index}`,
				})
			);
		}

		expect(orchestrator.listSubagents(branch.subagent.sessionId)).toHaveLength(100);
		expect(store.listAllDirectChildSnapshots(branch.subagent.sessionId)).toHaveLength(105);
		await orchestrator.cancelSubagent({
			principalId: "user-1",
			idempotencyKey: "cancel-wide-tree",
			sessionId: root.snapshot.session.id,
			subagentId: branch.subagent.sessionId,
		});
		for (const descendant of [descendants[0]!, descendants[100]!, descendants[104]!]) {
			expect(orchestrator.subagentSummary(branch.subagent.sessionId, descendant.subagent.sessionId).status).toBe(
				"cancelled"
			);
		}
		store.close();
	});

	it("cancels a running subagent and publishes an aborted result", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new BlockingRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("cancel-subagent"),
		});
		const parent = await orchestrator.createSession(createInput());
		const created = await orchestrator.createSubagent({
			principalId: "user-1",
			idempotencyKey: "subagent-create-cancel",
			sessionId: parent.snapshot.session.id,
			task: "Wait for cancellation",
		});
		const draining = orchestrator.drainSession(created.subagent.sessionId, "subagent-cancel-worker");
		await runtime.started;

		const cancelled = await orchestrator.cancelSubagent({
			principalId: "user-1",
			idempotencyKey: "subagent-cancel-1",
			sessionId: parent.snapshot.session.id,
			subagentId: created.subagent.id,
		});
		expect(cancelled.subagent.status).toBe("cancelling");
		await draining;
		const summary = await orchestrator.publishSubagentResult(parent.snapshot.session.id, created.subagent.id);
		expect(summary.status).toBe("cancelled");
		expect(store.loadSnapshot(parent.snapshot.session.id)?.transcript.at(-1)).toMatchObject({
			type: "tool",
			status: "aborted",
			isError: true,
		});
		store.close();
	});

	it("charges an inline subagent to the parent after the turn instead of duplicating its result", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new InlineSubagentRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("inline"),
		});
		runtime.orchestrator = orchestrator;
		const parent = await orchestrator.createSession({
			...createInput(),
			costBudgetUsd: 5,
			tokenBudget: 500,
		});
		const parentId = parent.snapshot.session.id;

		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "turn-1",
			sessionId: parentId,
			mode: "prompt",
			content: [{ type: "text", text: "Delegate the search" }],
		});
		expect(await orchestrator.drainSession(parentId, "parent-worker")).toBe(1);
		const childId = runtime.childSessionId!;

		// The child's spend must not land on the parent while the parent's own turn is
		// still accumulating usage: whichever was written second would replace the other.
		expect(runtime.parentUsageDuringTurn).toBe(0);
		const parentAfter = store.loadSnapshot(parentId)!;
		expect(parentAfter.usage).toMatchObject({ totalTokens: 24, costUsd: 0.02 });
		expect(parentAfter.usageByTurn?.map((turn) => turn.turnId)).toContain(childId);
		// The model already received the report as its tool result, so there is no
		// second copy in the transcript.
		expect(parentAfter.transcript.some((item) => item.id === `subagent:${childId}`)).toBe(false);
		expect(orchestrator.listSubagents(parentId)).toHaveLength(1);
		expect(orchestrator.subagentSummary(parentId, childId)).toMatchObject({
			status: "completed",
			result: "done",
		});

		// Restart reconciliation must not publish it a second time either.
		expect(await orchestrator.reconcileSubagentResults()).toBe(0);
		await orchestrator.publishSubagentResult(parentId, childId);
		const reconciled = store.loadSnapshot(parentId)!;
		expect(reconciled.usage.totalTokens).toBe(24);
		expect(reconciled.transcript.some((item) => item.id === `subagent:${childId}`)).toBe(false);
		expect(() => orchestrator.subagentSummary(childId, childId)).toThrow(OrchestratorError);
		store.close();
	});

	it("persists, starts, and projects a completed background goal", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FakeRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("goal"),
		});
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
		expect(created.goal).toMatchObject({
			status: "pending",
			title: "Release review",
			objective: input.objective,
		});
		expect(orchestrator.listGoals(parent.snapshot.session.id)).toHaveLength(1);

		const startInput = {
			principalId: "user-1",
			idempotencyKey: "goal-start-1",
			sessionId: parent.snapshot.session.id,
			goalId: created.goal.id,
		};
		const started = await orchestrator.startGoal(startInput);
		expect(started.goal).toMatchObject({
			status: "queued",
			runSessionId: expect.any(String),
			operationId: expect.any(String),
		});
		expect(await orchestrator.startGoal(startInput)).toEqual(started);
		expect(orchestrator.listSubagents(parent.snapshot.session.id)).toHaveLength(1);
		await expect(orchestrator.startGoal({ ...startInput, idempotencyKey: "goal-start-again" })).rejects.toMatchObject({
			code: "conflict",
		});
		expect(orchestrator.listSubagents(parent.snapshot.session.id)).toHaveLength(1);
		expect(await orchestrator.drainSession(started.goal.runSessionId!, "goal-worker")).toBe(1);
		await orchestrator.publishSubagentResult(parent.snapshot.session.id, started.goal.runSessionId!);
		expect(orchestrator.listGoals(parent.snapshot.session.id)).toEqual([
			expect.objectContaining({
				id: created.goal.id,
				status: "completed",
				result: "done",
				usage: expect.objectContaining({ totalTokens: 12 }),
			}),
		]);

		const restarted = new SessionOrchestrator(store, runtime, { clock: () => 200 });
		expect(restarted.listGoals(parent.snapshot.session.id)[0]).toMatchObject({
			id: created.goal.id,
			status: "completed",
			result: "done",
		});
		store.close();
	});

	it("runs a session goal as a normal turn without creating a subagent", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FakeRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("session-goal"),
		});
		const parent = await orchestrator.createSession(createInput());
		const parentId = parent.snapshot.session.id;
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "session-goal-create",
			sessionId: parentId,
			title: "Current conversation goal",
			objective: "Finish the long task in this conversation",
			executionMode: "session",
		});

		const started = await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "session-goal-start",
			sessionId: parentId,
			goalId: created.goal.id,
		});
		expect(started.goal).toMatchObject({
			executionMode: "session",
			status: "queued",
			operationId: expect.any(String),
		});
		expect(started.goal.runSessionId).toBeUndefined();
		expect(orchestrator.listSubagents(parentId)).toHaveLength(0);
		expect(store.loadSnapshot(parentId)?.transcript.at(-1)).toMatchObject({
			type: "user",
			content: [{ type: "text", text: "Finish the long task in this conversation" }],
		});

		const operation = store.getOperation(started.goal.operationId!);
		expect(operation?.payload).toMatchObject({
			type: "turn",
			goalId: created.goal.id,
			content: [{ type: "text", text: "Finish the long task in this conversation" }],
		});
		expect(operation?.payload.type === "turn" ? operation.payload.runtimeContent?.[0] : undefined).toMatchObject({
			type: "text",
			text: expect.stringContaining("Use a Loop Engineering cycle"),
		});

		expect(await orchestrator.driveGoal(parentId, created.goal.id)).toMatchObject({
			status: "completed",
			result: "done",
			usage: expect.objectContaining({ totalTokens: 12 }),
		});
		const snapshot = store.loadSnapshot(parentId)!;
		expect(snapshot.transcript.map((item) => item.type)).toEqual(["user", "assistant"]);
		expect(snapshot.transcript.at(-1)).toMatchObject({ type: "assistant", status: "complete" });
		expect(orchestrator.listSubagents(parentId)).toHaveLength(0);
		store.close();
	});

	it("rolls back the child session when a goal run cannot be attached", async () => {
		const store = new RejectingGoalAttachStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("atomic-goal"),
		});
		const parent = await orchestrator.createSession(createInput());
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "atomic-goal-create",
			sessionId: parent.snapshot.session.id,
			objective: "Start atomically",
		});

		await expect(
			orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "atomic-goal-start",
				sessionId: parent.snapshot.session.id,
				goalId: created.goal.id,
			})
		).rejects.toMatchObject({ code: "conflict" });
		expect(store.listChildSnapshots(parent.snapshot.session.id)).toEqual([]);
		const goal = orchestrator.listGoals(parent.snapshot.session.id)[0];
		expect(goal).toMatchObject({ status: "pending" });
		expect(goal?.runSessionId).toBeUndefined();
		store.close();
	});

	it("reviews goal results and uses bounded feedback rounds", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new GoalReviewRuntime(["fail", "pass"]);
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("review-goal"),
		});
		const parent = await orchestrator.createSession(createInput());
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "review-goal-create",
			sessionId: parent.snapshot.session.id,
			objective: "Produce a verified release report",
			successCriteria: "The report includes concrete verification evidence.",
			maxRounds: 2,
		});
		expect(created.goal).toMatchObject({
			status: "pending",
			reviewPhase: "pending",
			round: 0,
			maxRounds: 2,
		});

		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "review-goal-start",
			sessionId: parent.snapshot.session.id,
			goalId: created.goal.id,
		});
		const completed = await orchestrator.driveGoal(parent.snapshot.session.id, created.goal.id);

		expect(runtime).toMatchObject({ calls: 4, workerCalls: 2, reviewerCalls: 2 });
		expect(completed).toMatchObject({
			status: "completed",
			reviewPhase: "passed",
			round: 2,
			maxRounds: 2,
			result: "candidate-2",
			usage: { totalTokens: 8, costUsd: 0.04 },
			reviewHistory: [
				{
					round: 1,
					verdict: "fail",
					feedback: "Add concrete verification evidence.",
					checks: [
						{
							criterion: "The report includes concrete verification evidence.",
							status: "fail",
							evidence: "No command result was included.",
						},
					],
					toolsUsed: ["read_file"],
				},
				{
					round: 2,
					verdict: "pass",
					feedback: "All criteria are satisfied.",
					checks: [
						{
							criterion: "The report includes concrete verification evidence.",
							status: "pass",
							evidence: "The report includes a verified command result.",
						},
					],
					toolsUsed: ["read_file"],
				},
			],
		});
		expect(orchestrator.listSubagents(parent.snapshot.session.id)).toHaveLength(4);
		store.close();
	});

	it("persists review configuration across a SQLite reopen", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-goal-review-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		const firstStore = new SqliteOrchestratorStore(path);
		const first = new SessionOrchestrator(firstStore, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("persisted-review-goal"),
		});
		const parent = await first.createSession(createInput());
		const created = await first.createGoal({
			principalId: "user-1",
			idempotencyKey: "persisted-review-goal-create",
			sessionId: parent.snapshot.session.id,
			objective: "Persist review state",
			successCriteria: "The state survives reopening SQLite.",
			maxRounds: 4,
		});
		firstStore.close();

		const reopenedStore = new SqliteOrchestratorStore(path);
		const reopened = new SessionOrchestrator(reopenedStore, new FakeRuntime());
		expect(reopened.listGoals(parent.snapshot.session.id)[0]).toMatchObject({
			id: created.goal.id,
			status: "pending",
			successCriteria: "The state survives reopening SQLite.",
			maxRounds: 4,
			round: 0,
			reviewPhase: "pending",
		});
		await expect(
			reopened.createGoal({
				principalId: "user-1",
				idempotencyKey: "invalid-review-goal-create",
				sessionId: parent.snapshot.session.id,
				objective: "Invalid review state",
				maxRounds: 2,
			})
		).rejects.toMatchObject({ code: "conflict" });
		reopenedStore.close();
	});

	it("fails a reviewed goal after the configured round limit", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new GoalReviewRuntime(["fail"]);
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("failed-review-goal"),
		});
		const parent = await orchestrator.createSession(createInput());
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "failed-review-goal-create",
			sessionId: parent.snapshot.session.id,
			objective: "Produce a verified release report",
			successCriteria: "The report includes verification evidence.",
			maxRounds: 1,
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "failed-review-goal-start",
			sessionId: parent.snapshot.session.id,
			goalId: created.goal.id,
		});
		const failed = await orchestrator.driveGoal(parent.snapshot.session.id, created.goal.id);
		expect(failed).toMatchObject({
			status: "failed",
			reviewPhase: "failed",
			round: 1,
			result: "candidate-1",
			error: "Add concrete verification evidence.",
		});
		expect(runtime).toMatchObject({ calls: 2, workerCalls: 1, reviewerCalls: 1 });
		store.close();
	});

	it("rejects a review whose overall verdict contradicts its checks", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new GoalReviewRuntime(["pass"], true);
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("inconsistent-review"),
		});
		const parent = await orchestrator.createSession(createInput());
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "inconsistent-review-create",
			sessionId: parent.snapshot.session.id,
			objective: "Produce a verified report",
			successCriteria: "Every recorded check passes.",
			maxRounds: 2,
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "inconsistent-review-start",
			sessionId: parent.snapshot.session.id,
			goalId: created.goal.id,
		});
		const failed = await orchestrator.driveGoal(parent.snapshot.session.id, created.goal.id);

		expect(failed).toMatchObject({
			status: "failed",
			reviewPhase: "failed",
			error: "Reviewer returned an invalid structured verdict.",
			reviewHistory: [
				{
					verdict: "fail",
					checks: [{ criterion: "Structured review output", status: "fail" }],
				},
			],
		});
		expect(runtime).toMatchObject({ calls: 2, workerCalls: 1, reviewerCalls: 1 });
		store.close();
	});

	it("resumes review progression after the orchestrator is recreated", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new GoalReviewRuntime(["pass"]);
		const first = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("resumed-review-goal"),
		});
		const parent = await first.createSession(createInput());
		const created = await first.createGoal({
			principalId: "user-1",
			idempotencyKey: "resumed-review-goal-create",
			sessionId: parent.snapshot.session.id,
			objective: "Produce a verified report",
			successCriteria: "The report is complete.",
		});
		const started = await first.startGoal({
			principalId: "user-1",
			idempotencyKey: "resumed-review-goal-start",
			sessionId: parent.snapshot.session.id,
			goalId: created.goal.id,
		});
		expect(await first.drainSession(started.goal.runSessionId!)).toBe(1);
		expect(first.listGoals(parent.snapshot.session.id)[0]).toMatchObject({
			status: "running",
			reviewPhase: "executing",
		});

		const restarted = new SessionOrchestrator(store, runtime, {
			clock: () => 200,
			idFactory: ids("restarted-review-goal"),
		});
		expect(await restarted.resumeGoalReviews()).toBe(1);
		expect(restarted.listGoals(parent.snapshot.session.id)[0]).toMatchObject({
			status: "completed",
			reviewPhase: "passed",
			result: "candidate-1",
		});
		expect(runtime).toMatchObject({ calls: 2, workerCalls: 1, reviewerCalls: 1 });
		store.close();
	});

	it("cancels an active reviewed goal while its driver is running", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new BlockingRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("cancel-review-goal"),
		});
		const parent = await orchestrator.createSession(createInput());
		const created = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "cancel-review-goal-create",
			sessionId: parent.snapshot.session.id,
			objective: "Wait for cancellation",
			successCriteria: "The run finishes successfully.",
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "cancel-review-goal-start",
			sessionId: parent.snapshot.session.id,
			goalId: created.goal.id,
		});
		const driving = orchestrator.driveGoal(parent.snapshot.session.id, created.goal.id);
		await runtime.started;
		const cancelInput = {
			principalId: "user-1",
			idempotencyKey: "cancel-review-goal-cancel",
			sessionId: parent.snapshot.session.id,
			goalId: created.goal.id,
		};
		const cancelled = await orchestrator.cancelGoal(cancelInput);
		expect(["cancelling", "cancelled"]).toContain(cancelled.goal.status);
		await driving;
		expect(orchestrator.listGoals(parent.snapshot.session.id)[0]).toMatchObject({
			status: "cancelled",
			reviewPhase: "cancelled",
		});
		expect(await orchestrator.cancelGoal(cancelInput)).toEqual(cancelled);
		store.close();
	});

	it("cancels pending and running goals", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new BlockingRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("cancel-goal"),
		});
		const parent = await orchestrator.createSession(createInput());
		const pending = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "goal-pending",
			sessionId: parent.snapshot.session.id,
			objective: "Do not start",
		});
		const pendingCancelled = await orchestrator.cancelGoal({
			principalId: "user-1",
			idempotencyKey: "goal-pending-cancel",
			sessionId: parent.snapshot.session.id,
			goalId: pending.goal.id,
		});
		expect(pendingCancelled.goal.status).toBe("cancelled");
		await expect(
			orchestrator.startGoal({
				principalId: "user-1",
				idempotencyKey: "goal-pending-start",
				sessionId: parent.snapshot.session.id,
				goalId: pending.goal.id,
			})
		).rejects.toMatchObject({ code: "conflict" });
		const queued = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "goal-queued",
			sessionId: parent.snapshot.session.id,
			objective: "Cancel before worker claim",
		});
		await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "goal-queued-start",
			sessionId: parent.snapshot.session.id,
			goalId: queued.goal.id,
		});
		await orchestrator.cancelGoal({
			principalId: "user-1",
			idempotencyKey: "goal-queued-cancel",
			sessionId: parent.snapshot.session.id,
			goalId: queued.goal.id,
		});
		expect(orchestrator.listGoals(parent.snapshot.session.id).find((goal) => goal.id === queued.goal.id)?.status).toBe(
			"cancelled"
		);

		const running = await orchestrator.createGoal({
			principalId: "user-1",
			idempotencyKey: "goal-running",
			sessionId: parent.snapshot.session.id,
			objective: "Wait until cancelled",
		});
		const started = await orchestrator.startGoal({
			principalId: "user-1",
			idempotencyKey: "goal-running-start",
			sessionId: parent.snapshot.session.id,
			goalId: running.goal.id,
		});
		const draining = orchestrator.drainSession(started.goal.runSessionId!, "goal-cancel-worker");
		await runtime.started;
		const cancelled = await orchestrator.cancelGoal({
			principalId: "user-1",
			idempotencyKey: "goal-running-cancel",
			sessionId: parent.snapshot.session.id,
			goalId: running.goal.id,
		});
		expect(cancelled.goal.status).toBe("cancelling");
		await draining;
		expect(orchestrator.listGoals(parent.snapshot.session.id).find((goal) => goal.id === running.goal.id)?.status).toBe(
			"cancelled"
		);
		store.close();
	});

	it("creates, pauses, manually triggers, and completes one-time automations", async () => {
		let now = 1_000;
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new GoalReviewRuntime(["pass", "pass"]);
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => now,
			idFactory: ids("automation"),
		});
		const parent = await orchestrator.createSession(createInput());
		const input = {
			principalId: "user-1",
			idempotencyKey: "automation-create",
			sessionId: parent.snapshot.session.id,
			title: "Nightly release check",
			objective: "Verify the release and report blockers",
			schedule: { kind: "once" as const, runAt: 2_000 },
			successCriteria: "The result names the release status.",
			maxRounds: 2,
		};
		const created = await orchestrator.createAutomation(input);
		expect(await orchestrator.createAutomation(input)).toEqual(created);
		expect(created.automation).toMatchObject({ status: "active", nextRunAt: 2_000, maxRounds: 2 });

		const paused = await orchestrator.setAutomationEnabled({
			principalId: "user-1",
			idempotencyKey: "automation-pause",
			sessionId: input.sessionId,
			automationId: created.automation.id,
			enabled: false,
		});
		expect(paused.automation.status).toBe("paused");
		const resumed = await orchestrator.setAutomationEnabled({
			principalId: "user-1",
			idempotencyKey: "automation-resume",
			sessionId: input.sessionId,
			automationId: created.automation.id,
			enabled: true,
		});
		expect(resumed.automation.status).toBe("active");

		const triggerInput = {
			principalId: "user-1",
			idempotencyKey: "automation-trigger",
			sessionId: input.sessionId,
			automationId: created.automation.id,
		};
		const triggered = await orchestrator.triggerAutomation(triggerInput);
		expect(triggered.run.status).toBe("dispatching");
		expect(await orchestrator.triggerAutomation(triggerInput)).toEqual(triggered);
		await orchestrator.dispatchAutomationRun(triggered.run.id);
		expect(orchestrator.listAutomationRuns(input.sessionId, created.automation.id)).toEqual([
			expect.objectContaining({
				id: triggered.run.id,
				trigger: "manual",
				status: "completed",
				result: "candidate-1",
				usage: expect.objectContaining({ totalTokens: 4 }),
			}),
		]);
		expect(runtime.calls).toBe(2);

		now = 2_000;
		expect(await orchestrator.runDueAutomations()).toBe(1);
		expect(orchestrator.listAutomations(input.sessionId)[0]).toMatchObject({
			status: "completed",
			lastRunAt: 2_000,
		});
		expect(orchestrator.listAutomations(input.sessionId)[0]?.nextRunAt).toBeUndefined();
		expect(orchestrator.listAutomationRuns(input.sessionId, created.automation.id)).toHaveLength(2);
		await expect(
			orchestrator.setAutomationEnabled({
				principalId: "user-1",
				idempotencyKey: "automation-reenable",
				sessionId: input.sessionId,
				automationId: created.automation.id,
				enabled: true,
			})
		).rejects.toMatchObject({ code: "conflict" });
		store.close();
	});

	it("coalesces missed intervals, atomically claims one run, and resumes dispatch after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-automation-"));
		cleanup.push(directory);
		const path = join(directory, "orchestrator.sqlite");
		let now = 100;
		const firstStore = new SqliteOrchestratorStore(path);
		const first = new SessionOrchestrator(firstStore, new FakeRuntime(), {
			clock: () => now,
			idFactory: ids("scheduled"),
		});
		const parent = await first.createSession(createInput());
		const created = await first.createAutomation({
			principalId: "user-1",
			idempotencyKey: "interval-create",
			sessionId: parent.snapshot.session.id,
			objective: "Run a durable interval check",
			schedule: { kind: "interval", startsAt: 1_000, everyMinutes: 10 },
		});
		now = 500;
		await first.archiveSession({
			principalId: "user-1",
			idempotencyKey: "archive-automation-parent",
			sessionId: parent.snapshot.session.id,
			archived: true,
		});
		now = 2_000_000;
		expect(firstStore.listDueAutomations(now)).toEqual([]);
		expect(
			firstStore.claimScheduledAutomationRun({
				automationId: created.automation.id,
				runId: "archived-run",
				scheduledFor: 1_000,
				now,
			})
		).toBeUndefined();
		await first.archiveSession({
			principalId: "user-1",
			idempotencyKey: "restore-automation-parent",
			sessionId: parent.snapshot.session.id,
			archived: false,
		});
		const expected = firstStore.listDueAutomations(now)[0]!;
		const secondStore = new SqliteOrchestratorStore(path);
		const claimed = firstStore.claimScheduledAutomationRun({
			automationId: created.automation.id,
			runId: "claimed-run",
			scheduledFor: expected.nextRunAt!,
			now,
		});
		const duplicate = secondStore.claimScheduledAutomationRun({
			automationId: created.automation.id,
			runId: "duplicate-run",
			scheduledFor: expected.nextRunAt!,
			now,
		});
		expect(claimed).toMatchObject({ id: "claimed-run", scheduledFor: 1_000, trigger: "schedule" });
		expect(duplicate).toBeUndefined();
		expect(secondStore.loadAutomation(created.automation.id)?.nextRunAt).toBeGreaterThan(now);
		firstStore.close();

		const runtime = new FakeRuntime();
		const restarted = new SessionOrchestrator(secondStore, runtime, {
			clock: () => now,
			idFactory: ids("recovered"),
		});
		expect(await restarted.resumeAutomationRuns()).toBe(1);
		expect(restarted.listAutomationRuns(parent.snapshot.session.id, created.automation.id)[0]).toMatchObject({
			id: "claimed-run",
			status: "completed",
			result: "done",
		});
		expect(await restarted.runDueAutomations(now)).toBe(0);
		expect(runtime.calls).toBe(1);
		secondStore.close();
	});

	it("deduplicates concurrent retries before they create a second turn", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FakeRuntime();
		const progress: string[] = [];
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids(),
		});
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
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids(),
		});
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
			})
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		store.close();
	});

	it("automatically names an unnamed session with its first prompt", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("auto-title"),
		});
		const { name: _name, ...unnamedInput } = createInput();
		const created = await orchestrator.createSession(unnamedInput);
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "auto-title-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "Investigate the flaky login tests" }],
		});

		const snapshot = store.loadSnapshot(created.snapshot.session.id)!;
		expect(snapshot.session.name).toBe("Investigate the flaky login tests");
		expect(store.loadEvents(created.snapshot.session.id).map((event) => event.type)).toEqual([
			"session.created",
			"session.item.upserted",
			"session.phase.changed",
			"session.renamed",
		]);
		store.close();
	});

	it("backfills existing unnamed and legacy fork sessions without changing their order timestamp", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 200,
			idFactory: ids("backfill-title"),
		});
		for (const legacyName of [undefined, "Session (fork)"] as const) {
			const { name: _name, ...baseInput } = createInput();
			const created = await orchestrator.createSession({
				...baseInput,
				idempotencyKey: `create-${legacyName ?? "unnamed"}`,
				...(legacyName === undefined ? {} : { name: legacyName }),
			});
			const item: SessionEvent = {
				type: "session.item.upserted",
				eventId: `legacy-item-${legacyName ?? "unnamed"}`,
				sessionId: created.snapshot.session.id,
				revision: 2,
				timestamp: 100,
				item: {
					id: `user-${legacyName ?? "unnamed"}`,
					type: "user",
					createdAt: 100,
					content: [{ type: "text", text: "Repair project imports" }],
				},
			};
			store.commitMutation({
				sessionId: created.snapshot.session.id,
				expectedRevision: 1,
				events: [item],
				snapshot: reduceSessionEvent(created.snapshot, item),
			});
		}

		expect(await orchestrator.backfillSessionNames("workspace-1")).toBe(2);
		const sessions = store.listSnapshots("workspace-1", { limit: 10 });
		expect(sessions.map((snapshot) => snapshot.session.name).sort()).toEqual(
			["Repair project imports", "Repair project imports (fork)"].sort()
		);
		expect(sessions.every((snapshot) => snapshot.session.updatedAt === 100)).toBe(true);
		expect(await orchestrator.backfillSessionNames("workspace-1")).toBe(0);
		store.close();
	});

	it("renames, searches, archives, and restores an idle session", async () => {
		let now = 100;
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => now,
			idFactory: ids(),
		});
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
		expect(store.listSnapshots("workspace-1", { query: "release" }).map((snapshot) => snapshot.session.id)).toEqual([
			sessionId,
		]);
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
		await expect(
			orchestrator.acceptTurn({
				principalId: "user-1",
				idempotencyKey: "archived-turn",
				sessionId,
				mode: "prompt",
				content: [{ type: "text", text: "should fail" }],
			})
		).rejects.toMatchObject({ code: "conflict" });

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
		const first = new SessionOrchestrator(firstStore, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("first"),
		});
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
		const second = new SessionOrchestrator(secondStore, runtime, {
			clock: () => 200,
			idFactory: ids("second"),
		});
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
		const first = new SessionOrchestrator(firstStore, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("first"),
		});
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
		const second = new SessionOrchestrator(secondStore, runtime, {
			clock: () => 200,
			idFactory: ids("second"),
		});
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
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 200,
			idFactory: ids("approval-recovery"),
		});
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "approval-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "write" }],
		});
		const running = store.claimNextOperation(created.snapshot.session.id, 100)!;
		const approval = persistApprovalBoundary(store, created.snapshot.session.id, running.id, "waiting");

		expect(orchestrator.recoverInterruptedOperations()).toBe(1);
		expect(store.getOperation(running.id)?.status).toBe("running");
		expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([approval]);
		await orchestrator.abortTurn({
			principalId: "user-1",
			idempotencyKey: "abort-recovered-approval",
			sessionId: created.snapshot.session.id,
		});
		expect(store.getOperation(running.id)).toMatchObject({
			status: "interrupted",
			abortRequested: true,
			failureKind: "user_abort",
		});
		expect(store.getApprovalExecution(approval.id)?.state).toBe("interrupted");
		expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
		expect(
			store
				.trajectoryReport(running.id)
				.replay.events.filter((event) => event.data.type === "approval.state")
				.map((event) => event.data)
		).toMatchObject([
			{ approvalId: approval.id, state: "waiting" },
			{ approvalId: approval.id, state: "interrupted" },
		]);
		store.close();
	});

	it("never replays a tool whose execution state was uncertain at restart", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 200,
			idFactory: ids("unsafe-recovery"),
		});
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "unsafe-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "write" }],
		});
		const running = store.claimNextOperation(created.snapshot.session.id, 100)!;
		const approval = persistApprovalBoundary(store, created.snapshot.session.id, running.id, "executing");

		expect(orchestrator.recoverInterruptedOperations()).toBe(1);
		expect(store.getOperation(running.id)).toMatchObject({
			status: "interrupted",
			error: expect.stringContaining("not replayed"),
		});
		expect(store.getApprovalExecution(approval.id)?.state).toBe("interrupted");
		expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
		store.close();
	});

	it("fences an expired writer lease", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids(),
		});
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
		const orchestrator = new SessionOrchestrator(store, new FailingRuntime(), {
			clock: () => 100,
			idFactory: ids(),
		});
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
		expect(failed?.transcript.at(-1)).toMatchObject({
			type: "assistant",
			status: "error",
			error: "provider failed",
		});
		await expect(
			orchestrator.acceptTurn({
				principalId: "user-1",
				idempotencyKey: "turn-after-failure",
				sessionId: created.snapshot.session.id,
				mode: "prompt",
				content: [{ type: "text", text: "try again" }],
			})
		).resolves.toMatchObject({ type: "turn.accepted", queue: "active" });
		store.close();
	});

	it.each([0, 1])("preserves tool and skill evidence across provider failure (retries=%s)", async (maxRetries) => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-skill-evidence-"));
		cleanup.push(directory);
		const database = join(directory, "sessions.db");
		const store = new SqliteOrchestratorStore(database);
		const runtime = new FakeRuntime();
		const execute = runtime.executeTurn.bind(runtime);
		const skills = Array.from({ length: 12 }, (_, index) => `skill-${index}`);
		runtime.executeTurn = async (input) => {
			// Dynamic observations must not become explicit input on the retry.
			expect(input.operation.payload.skills).toBeUndefined();
			const base = await execute(input);
			if (runtime.calls > 1)
				return {
					...base,
					skills: ["last-skill"],
					usage: {
						...base.usage!,
						totalTokens: 24,
						inputTokens: 20,
						outputTokens: 4,
						costUsd: 0.02,
					},
				};
			return {
				...base,
				items: [
					{
						id: "observed-tool",
						type: "tool",
						createdAt: 100,
						toolCallId: "load-debug",
						toolName: "skill_load",
						status: "complete",
						isError: false,
						input: { skillId: skills[0]! },
						content: [{ type: "text", text: "Observed skill instructions; sha256:fixture" }],
					},
				],
				skills,
				failure: {
					code: "runtime_error",
					message: "429 after skill loading",
					retryable: true,
					kind: "provider",
				},
			};
		};
		let sessionId: string;
		try {
			const orchestrator = new SessionOrchestrator(store, runtime, {
				clock: () => 100,
				idFactory: ids("evidence"),
				maxRetries,
				retryBaseDelayMs: 0,
			});
			const created = await orchestrator.createSession(createInput());
			sessionId = created.snapshot.session.id;
			await orchestrator.acceptTurn({
				principalId: "user-1",
				idempotencyKey: "evidence-turn",
				sessionId,
				mode: "prompt",
				content: [{ type: "text", text: "work" }],
			});
			await orchestrator.drainSession(sessionId);
		} finally {
			store.close();
		}
		const reopened = new SqliteOrchestratorStore(database);
		try {
			const snapshot = reopened.loadSnapshot(sessionId)!;
			expect(snapshot.transcript.filter((item) => item.id === "observed-tool")).toHaveLength(1);
			expect(snapshot.transcript.find((item) => item.id === "observed-tool")).toMatchObject({
				type: "tool",
				status: "complete",
				input: { skillId: "skill-0" },
			});
			expect(snapshot.usageByTurn?.[0]?.skills).toEqual(maxRetries ? [...skills, "last-skill"] : skills);
			expect(snapshot.transcript.at(-1)).toMatchObject({
				type: "assistant",
				status: maxRetries ? "complete" : "error",
			});
			expect(reopened.listOperations(sessionId)[0]?.status).toBe(maxRetries ? "completed" : "failed");
			expect(snapshot).toEqual(replaySessionEvents(reopened.loadEvents(sessionId)));
		} finally {
			reopened.close();
		}
	});

	it("replans after a provider failure changes context and commits usage before replanning", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new CapabilityRuntime();
		runtime.store = store;
		let observedTokens = 0;
		const digests: string[] = [];
		runtime.resolveContext = async (input) => {
			expect(input.snapshot.usage.totalTokens).toBe(observedTokens);
			return new ContextEngine().assemble({
				workspaceId: input.snapshot.session.workspaceId,
				sessionId: input.snapshot.session.id,
				operationId: input.operation.id,
				model: input.snapshot.model,
				baseSystemPrompt: "Test system prompt",
				query: "Read code",
				fragments: [],
				budget: {
					contextWindowTokens: 258000,
					observedContextTokens: observedTokens,
					userInputTokens: 10,
					reservedOutputTokens: 100,
					maxSystemTokens: 250,
				},
			}).plan;
		};
		const execute = runtime.executeTurn.bind(runtime);
		runtime.executeTurn = async (input) => {
			expect(input.contextPlan?.budget.observedContextTokens).toBe(observedTokens);
			expect(store.getOperation(input.operation.id)?.contextPlan?.digest).toBe(input.contextPlan?.digest);
			digests.push(input.contextPlan!.digest);
			const result = await execute(input);
			if (runtime.calls === 1) {
				observedTokens = result.usage!.totalTokens;
				return { ...result, failure: { code: "runtime_error", message: "Connection error.", retryable: true } };
			}
			return result;
		};
		try {
			const orchestrator = new SessionOrchestrator(store, runtime, {
				idFactory: ids("replan"),
				retryBaseDelayMs: 0,
				maxRetries: 1,
			});
			const created = await orchestrator.createSession(createInput());
			await orchestrator.acceptTurn({
				principalId: "user-1",
				idempotencyKey: "replan-turn",
				sessionId: created.snapshot.session.id,
				mode: "prompt",
				content: [{ type: "text", text: "Read code" }],
			});
			await orchestrator.drainSession(created.snapshot.session.id);
			expect(store.listOperations(created.snapshot.session.id)[0]?.error).toBeUndefined();
			expect(store.listOperations(created.snapshot.session.id)[0]).toMatchObject({ status: "completed", attempt: 2 });
			expect(digests).toHaveLength(2);
			expect(digests[0]).not.toBe(digests[1]);
			expect(runtime.resolveCalls).toBe(2);
		} finally {
			store.close();
		}
	});

	it("retries an explicitly retryable provider failure and persists the attempt", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FlakyRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("retry"),
			maxRetries: 1,
			retryBaseDelayMs: 0,
		});
		const progress: ProgressEvent[] = [];
		orchestrator.subscribeProgress((event) => progress.push(event));
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "retry-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "retry" }],
		});
		await expect(
			orchestrator.drainSession(created.snapshot.session.id, undefined, "trace-provider-retry")
		).resolves.toBe(1);
		expect(runtime.calls).toBe(2);
		expect(store.listOperations(created.snapshot.session.id)[0]).toMatchObject({
			status: "completed",
			attempt: 2,
			traceId: "trace-provider-retry",
			usage: { totalTokens: 2, costUsd: 0.02 },
			retryHistory: [
				{
					attempt: 1,
					maxAttempts: 1,
					delayMs: 0,
					error: "temporary provider failure",
					timestamp: 100,
				},
			],
		});
		expect(store.loadSnapshot(created.snapshot.session.id)).toMatchObject({
			session: { phase: "idle" },
			usage: { costUsd: 0.02 },
		});
		expect(progress).toContainEqual({
			type: "run.retrying",
			sessionId: created.snapshot.session.id,
			operationId: expect.any(String),
			attempt: 1,
			nextAttempt: 2,
			maxAttempts: 2,
			delayMs: 0,
			failureKind: "provider",
			error: "temporary provider failure",
		});
		const trajectory = store.trajectoryReport(store.listOperations(created.snapshot.session.id)[0]!.id);
		expect(trajectory.replay.integrity).toBe(true);
		expect(
			trajectory.replay.events.filter((event) => event.data.type === "operation.started").map((event) => event.data)
		).toMatchObject([{ attempt: 1 }, { attempt: 2 }]);
		expect(trajectory.replay.events.find((event) => event.data.type === "retry.scheduled")?.data).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 0,
			failureKind: "provider",
			errorDigest: expect.stringMatching(/^sha256:/),
		});
		expect(JSON.stringify(trajectory)).not.toContain("temporary provider failure");
		store.close();
	});

	it("updates and removes idle session budgets without resetting unrelated limits", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("budget-config"),
		});
		const created = await orchestrator.createSession({
			...createInput(),
			costBudgetUsd: 2,
			tokenBudget: 10_000,
			budgetWarningThreshold: 0.8,
		});
		const threshold = await orchestrator.setSessionBudget({
			principalId: "user-1",
			idempotencyKey: "budget-threshold",
			sessionId: created.snapshot.session.id,
			budgetWarningThreshold: 0.9,
		});
		expect(threshold.snapshot).toMatchObject({
			costBudgetUsd: 2,
			tokenBudget: 10_000,
			budgetWarningThreshold: 0.9,
		});
		const removed = await orchestrator.setSessionBudget({
			principalId: "user-1",
			idempotencyKey: "budget-remove",
			sessionId: created.snapshot.session.id,
			costBudgetUsd: null,
		});
		expect(removed.snapshot.costBudgetUsd).toBeUndefined();
		expect(removed.snapshot.tokenBudget).toBe(10_000);
		store.close();
	});

	it("stops a turn after it exceeds the durable cost budget and keeps its usage", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("budget"),
			defaultCostBudgetUsd: 0.005,
		});
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "budget-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "budget" }],
		});
		await expect(orchestrator.drainSession(created.snapshot.session.id)).resolves.toBe(1);
		expect(store.loadSnapshot(created.snapshot.session.id)).toMatchObject({
			usage: { costUsd: 0.01 },
			session: { phase: "idle" },
		});
		expect(store.listOperations(created.snapshot.session.id)[0]).toMatchObject({
			status: "failed",
			error: expect.stringContaining("budget"),
		});
		await expect(
			orchestrator.acceptTurn({
				principalId: "user-1",
				idempotencyKey: "budget-turn-2",
				sessionId: created.snapshot.session.id,
				mode: "prompt",
				content: [{ type: "text", text: "blocked" }],
			})
		).rejects.toMatchObject({ code: "budget_exceeded" });
		store.close();
	});

	it("records model/turn usage and emits a durable token warning once", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const events: SessionEvent[] = [];
		store.subscribeEvents(({ event }) => events.push(event));
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("usage-warning"),
		});
		const created = await orchestrator.createSession({
			...createInput(),
			costBudgetUsd: 2,
			tokenBudget: 10,
			budgetWarningThreshold: 0.8,
		});
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "usage-warning-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "usage" }],
			skills: ["review-code", "review-code"],
		});
		await expect(orchestrator.drainSession(created.snapshot.session.id)).resolves.toBe(1);
		const snapshot = store.loadSnapshot(created.snapshot.session.id)!;
		expect(snapshot.usageByTurn).toMatchObject([
			{
				mode: "prompt",
				attempts: 1,
				usage: { totalTokens: 12, costUsd: 0.01 },
				requests: [],
				skills: ["review-code"],
			},
		]);
		expect(snapshot.usageByModel).toMatchObject([
			{ model: { provider: "anthropic", id: "claude" }, usage: { totalTokens: 12 } },
		]);
		expect(snapshot.budgetWarnings).toHaveLength(1);
		expect(snapshot.budgetWarnings?.[0]).toMatchObject({
			kind: "tokens",
			budget: 10,
			threshold: 0.8,
		});
		await waitUntil(() => events.length > 0);
		expect(events.filter((event) => event.type === "session.budget.warning")).toHaveLength(1);
		store.close();
	});

	it("persists more than eight dynamically loaded skills without expanding explicit selections", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new FakeRuntime();
		const execute = runtime.executeTurn.bind(runtime);
		const skills = Array.from({ length: 12 }, (_, index) => `loaded-${index}`);
		runtime.executeTurn = async (input) => ({
			...(await execute(input)),
			skills: [...skills, skills[0]!],
		});
		const orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 100,
			idFactory: ids("loaded-skills"),
		});
		try {
			const created = await orchestrator.createSession(createInput());
			const sessionId = created.snapshot.session.id;
			await orchestrator.acceptTurn({
				principalId: "user-1",
				idempotencyKey: "loaded-turn",
				sessionId,
				mode: "prompt",
				content: [{ type: "text", text: "work" }],
			});
			await orchestrator.drainSession(sessionId);
			expect(store.listOperations(sessionId)[0]?.status).toBe("completed");
			expect(store.loadSnapshot(sessionId)?.usageByTurn?.[0]?.skills).toEqual(skills);
			expect(store.listOperations(sessionId)[0]?.payload.skills).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("attributes retry usage by delta instead of charging the cumulative result twice", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FlakyRuntime(), {
			clock: () => 100,
			idFactory: ids("usage-retry"),
			maxRetries: 1,
			retryBaseDelayMs: 0,
		});
		const created = await orchestrator.createSession(createInput());
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: "usage-retry-turn",
			sessionId: created.snapshot.session.id,
			mode: "prompt",
			content: [{ type: "text", text: "retry" }],
		});
		await expect(orchestrator.drainSession(created.snapshot.session.id)).resolves.toBe(1);
		const snapshot = store.loadSnapshot(created.snapshot.session.id)!;
		expect(snapshot.usage).toMatchObject({ totalTokens: 2, costUsd: 0.02 });
		expect(snapshot.usageByTurn).toMatchObject([{ attempts: 2, usage: { totalTokens: 2, costUsd: 0.02 } }]);
		store.close();
	});

	it("durably aborts a turn before a worker claims it", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids(),
		});
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
		const controller = new SessionOrchestrator(store, blocking, {
			clock: Date.now,
			idFactory: nextId,
		});
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
		runtime.store = store;
		const nextId = ids("inject");
		const worker = new SessionOrchestrator(store, runtime, { clock: Date.now, idFactory: nextId });
		const controller = new SessionOrchestrator(store, runtime, {
			clock: Date.now,
			idFactory: nextId,
		});
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
		expect(runtime.resolveCalls).toBe(3);
		expect(runtime.contextResolveCalls).toBe(3);
		expect(runtime.injectedPlans).toHaveLength(2);
		expect(
			runtime.injectedPlans.every(
				(entry) =>
					entry.persistedBeforeInject &&
					entry.contextPersistedBeforeInject &&
					entry.digest?.startsWith("sha256:") &&
					entry.contextDigest?.startsWith("sha256:")
			)
		).toBe(true);
		expect(store.loadSnapshot(sessionId)).toMatchObject({
			queuedSteerCount: 0,
			queuedFollowUpCount: 0,
		});
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

	it("atomically clamps thinking when changing model and replays the result idempotently", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime());
		try {
			const created = await orchestrator.createSession({ ...createInput(), thinkingLevel: "max" });
			const input = {
				principalId: "user-1",
				idempotencyKey: "model-capabilities",
				sessionId: created.snapshot.session.id,
				model: { provider: "custom", id: "limited" },
				thinkingLevels: ["off", "high"] as const,
			};
			const result = await orchestrator.setSessionModel(input);
			expect(result.snapshot.thinkingLevel).toBe("high");
			expect(result.snapshot.revision).toBe(created.snapshot.revision + 2);
			expect(store.loadSnapshot(input.sessionId)?.thinkingLevel).toBe("high");
			await expect(orchestrator.setSessionModel(input)).resolves.toEqual(result);
			const disabled = await orchestrator.setSessionModel({
				...input,
				idempotencyKey: "model-disabled",
				model: { provider: "custom", id: "plain" },
				thinkingLevels: ["off"],
			});
			expect(disabled.snapshot.thinkingLevel).toBe("off");
		} finally {
			store.close();
		}
	});

	it("forks a transcript prefix and supports idempotent session configuration", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const orchestrator = new SessionOrchestrator(store, new FakeRuntime(), {
			clock: () => 100,
			idFactory: ids("fork"),
		});
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
		await expect(
			orchestrator.forkSession({
				principalId: "user-1",
				idempotencyKey: "fork-1",
				sessionId,
				fromItemId: firstItemId,
			})
		).resolves.toEqual(forked);

		const changed = await orchestrator.setSessionModel({
			principalId: "user-1",
			idempotencyKey: "model-1",
			sessionId,
			model: { provider: "openai", id: "gpt-test" },
		});
		expect(changed.snapshot.model).toEqual({ provider: "openai", id: "gpt-test" });
		const policyChanged = await orchestrator.setSessionPolicy({
			principalId: "user-1",
			idempotencyKey: "policy-1",
			sessionId,
			sandboxMode: "unrestricted",
			approvalPolicy: "never",
		});
		expect(policyChanged.snapshot).toMatchObject({
			sandboxMode: "unrestricted",
			approvalPolicy: "never",
		});
		await expect(
			orchestrator.setSessionPolicy({
				principalId: "user-1",
				idempotencyKey: "policy-1",
				sessionId,
				sandboxMode: "unrestricted",
				approvalPolicy: "never",
			})
		).resolves.toEqual(policyChanged);
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
		expect(store.listMemories(sessionId)).toMatchObject([
			{
				kind: "compaction",
				reason: "manual",
				summary: "Keep the implementation focused.",
				source: {
					revision: expect.any(Number),
					fromItemId: expect.any(String),
					throughItemId: expect.any(String),
				},
			},
		]);
		store.close();
	});
});

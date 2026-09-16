import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	CapabilityRegistry,
	HookPipeline,
	type CapabilityManifest,
	type HookInvocation,
} from "@wuming/capability-kernel";
import { ContextEngine } from "@wuming/context-engine";
import { reduceSessionEvent, type SessionEvent } from "@wuming/domain";
import { describe, expect, it } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore } from "../src/index.js";
import type { AgentRuntime, RuntimeTurnResult } from "../src/types.js";

const policy: CapabilityManifest = {
	id: "hook:retry-policy",
	version: "1",
	kind: "hook",
	provider: "test",
	scope: "system",
	hook: { points: ["operation.before_execute"], mode: "enforce", timeoutMs: 100 },
};

class RetryRuntime implements AgentRuntime {
	calls = 0;
	observedTokens = 0;
	capabilityResolutions = 0;
	contextResolutions = 0;
	policyEnabled = false;
	failFirst = true;
	failPlanning = false;

	async resolveCapabilities(input: Parameters<NonNullable<AgentRuntime["resolveCapabilities"]>>[0]) {
		this.capabilityResolutions++;
		const registry = new CapabilityRegistry();
		if (this.policyEnabled) registry.register(policy);
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
		this.contextResolutions++;
		if (this.failPlanning) throw new Error("Context planning unavailable");
		return new ContextEngine().assemble({
			workspaceId: input.snapshot.session.workspaceId,
			sessionId: input.snapshot.session.id,
			operationId: input.operation.id,
			model: input.snapshot.model,
			query: "inspect",
			baseSystemPrompt: "Test system prompt",
			fragments: [],
			budget: {
				contextWindowTokens: 258000,
				observedContextTokens: this.observedTokens,
				userInputTokens: 10,
				reservedOutputTokens: 100,
				maxSystemTokens: 1000,
			},
		}).plan;
	}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		this.calls++;
		expect(input.operation.retryAfter).toBeUndefined();
		if (input.contextPlan?.budget.observedContextTokens !== this.observedTokens)
			throw new Error("Context plan drifted before operation execution");
		if (this.calls === 1 && this.failFirst) {
			this.observedTokens = 10000;
			this.policyEnabled = true;
			return { items: [], failure: { code: "runtime_error", message: "Connection error.", retryable: true } };
		}
		return { items: [] };
	}
}

async function queueTurn(orchestrator: SessionOrchestrator) {
	const created = await orchestrator.createSession({
		principalId: "review",
		idempotencyKey: "create",
		workspaceId: "review",
		model: { provider: "test", id: "test" },
		thinkingLevel: "off",
		sandboxMode: "read_only",
		approvalPolicy: "never",
	});
	const sessionId = created.snapshot.session.id;
	await orchestrator.acceptTurn({
		principalId: "review",
		idempotencyKey: "turn",
		sessionId,
		mode: "prompt",
		content: [{ type: "text", text: "inspect" }],
	});
	return sessionId;
}

describe("retry preflight", () => {
	it("preserves the pinned execution plans when resuming an approved tool", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			const runtime = new RetryRuntime();
			runtime.failFirst = false;
			const orchestrator = new SessionOrchestrator(store, runtime);
			const sessionId = await queueTurn(orchestrator);
			const operation = store.claimNextOperation(sessionId, Date.now())!;
			const snapshot = store.loadSnapshot(sessionId)!;
			const input = { snapshot, operation, signal: new AbortController().signal };
			const capabilityPlan = await runtime.resolveCapabilities(input);
			const contextPlan = await runtime.resolveContext(input);
			store.storeCapabilityPlan(operation.id, capabilityPlan, Date.now());
			store.storeContextPlan(operation.id, contextPlan, Date.now());
			const event: SessionEvent = {
				type: "session.phase.changed",
				eventId: randomUUID(),
				sessionId,
				revision: snapshot.revision + 1,
				timestamp: Date.now(),
				phase: "turn",
			};
			store.commitMutation({
				sessionId,
				expectedRevision: snapshot.revision,
				events: [event],
				snapshot: reduceSessionEvent(snapshot, event),
				approvalExecution: {
					approvalId: "approved",
					sessionId,
					operationId: operation.id,
					toolCallId: "approved-tool",
					mode: "preflight",
					state: "approved",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			});
			expect(store.requeueOperationForApproval(operation.id, "approved", Date.now())).toBe(true);
			runtime.policyEnabled = true;
			await orchestrator.drainSession(sessionId);
			expect(runtime.calls).toBe(1);
			expect(runtime.capabilityResolutions).toBe(1);
			expect(runtime.contextResolutions).toBe(1);
			expect(store.getOperation(operation.id)).toMatchObject({
				status: "completed",
				attempt: 2,
				approvalId: "approved",
				capabilityPlan: { digest: capabilityPlan.digest },
				contextPlan: { digest: contextPlan.digest },
			});
		} finally {
			store.close();
		}
	});

	it("does not treat an already-started recovered retry as another waiting retry", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			const runtime = new RetryRuntime();
			const orchestrator = new SessionOrchestrator(store, runtime);
			const sessionId = await queueTurn(orchestrator);
			const operation = store.claimNextOperation(sessionId, Date.now())!;
			const snapshot = store.loadSnapshot(sessionId)!;
			const now = Date.now();
			const event: SessionEvent = {
				type: "session.phase.changed",
				eventId: randomUUID(),
				sessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				phase: "retry",
			};
			store.commitMutation({
				sessionId,
				expectedRevision: snapshot.revision,
				events: [event],
				snapshot: reduceSessionEvent(snapshot, event),
				retryOperation: { id: operation.id, error: "Connection error.", retryAfter: now + 1000, retryHistory: [] },
			});
			orchestrator.recoverInterruptedOperations();
			expect(store.claimNextOperation(sessionId, now)).toBeUndefined();
			const claimed = store.claimNextOperation(sessionId, now + 1001)!;
			expect(claimed.attempt).toBe(2);
			expect(claimed.retryAfter).toBeUndefined();
			expect(store.getOperation(operation.id)?.retryAfter).toBeUndefined();
			// Simulate a second restart after execution was claimed, not while waiting.
			orchestrator.recoverInterruptedOperations();
			expect(store.getOperation(operation.id)).toMatchObject({ status: "interrupted", failureKind: "runtime_restart" });
			expect(store.claimNextOperation(sessionId, now + 2000)).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it.each([
		{ deny: false, initiallyEnabled: false },
		{ deny: true, initiallyEnabled: false },
		{ deny: true, initiallyEnabled: true },
	])("checks the current policy on each attempt ($deny, $initiallyEnabled)", async ({ deny, initiallyEnabled }) => {
		const store = new SqliteOrchestratorStore(":memory:");
		const runtime = new RetryRuntime();
		runtime.policyEnabled = initiallyEnabled;
		const pipeline = new HookPipeline();
		const seen: HookInvocation[] = [];
		pipeline.register(policy, (invocation) => {
			seen.push(invocation);
			return deny && runtime.calls > 0
				? { decision: "deny", code: "blocked", reason: "Retry denied by policy" }
				: undefined;
		});
		try {
			const orchestrator = new SessionOrchestrator(store, runtime, {
				maxRetries: 1,
				retryBaseDelayMs: 0,
				hookPipeline: pipeline,
			});
			const sessionId = await queueTurn(orchestrator);
			await orchestrator.drainSession(sessionId);
			const operation = store.listOperations(sessionId)[0]!;
			expect(runtime.calls).toBe(deny ? 1 : 2);
			expect(runtime.capabilityResolutions).toBe(2);
			expect(runtime.contextResolutions).toBe(2);
			expect(operation).toMatchObject({ status: deny ? "failed" : "completed", attempt: 2 });
			expect(seen).toHaveLength(initiallyEnabled ? 2 : 1);
			expect(seen.at(-1)!.data).toMatchObject({
				attempt: 2,
				capabilityPlanDigest: operation.capabilityPlan!.digest,
				contextPlanDigest: operation.contextPlan!.digest,
			});
			expect(store.listHookAuditRecords(operation.id).at(-1)).toMatchObject({
				point: "operation.before_execute",
				outcome: deny ? "denied" : "completed",
			});
			expect(store.trajectoryReport(operation.id).replay.integrity).toBe(true);
		} finally {
			store.close();
		}
	});

	it.each(["allow", "deny", "planning_failure"] as const)(
		"refreshes saved retry plans after a database reopen (%s)",
		async (outcome) => {
			const directory = mkdtempSync(join(tmpdir(), "wuming-retry-preflight-"));
			const path = join(directory, "state.db");
			let store = new SqliteOrchestratorStore(path);
			try {
				const originalRuntime = new RetryRuntime();
				const original = new SessionOrchestrator(store, originalRuntime);
				const sessionId = await queueTurn(original);
				const operation = store.claimNextOperation(sessionId, Date.now())!;
				const snapshot = store.loadSnapshot(sessionId)!;
				const input = { snapshot, operation, signal: new AbortController().signal };
				const oldCapabilityPlan = await originalRuntime.resolveCapabilities(input);
				const oldContextPlan = await originalRuntime.resolveContext(input);
				store.storeCapabilityPlan(operation.id, oldCapabilityPlan, Date.now());
				store.storeContextPlan(operation.id, oldContextPlan, Date.now());
				const event: SessionEvent = {
					type: "session.phase.changed",
					eventId: randomUUID(),
					sessionId,
					revision: snapshot.revision + 1,
					timestamp: Date.now(),
					phase: "retry",
				};
				store.commitMutation({
					sessionId,
					expectedRevision: snapshot.revision,
					events: [event],
					snapshot: reduceSessionEvent(snapshot, event),
					retryOperation: {
						id: operation.id,
						error: "Connection error.",
						retryAfter: Date.now() - 1,
						retryHistory: [
							{ attempt: 1, maxAttempts: 1, delayMs: 0, error: "Connection error.", timestamp: Date.now() },
						],
					},
				});
				store.close();
				store = new SqliteOrchestratorStore(path);
				const runtime = new RetryRuntime();
				runtime.observedTokens = 10000;
				runtime.policyEnabled = true;
				runtime.failFirst = false;
				runtime.failPlanning = outcome === "planning_failure";
				const pipeline = new HookPipeline();
				const seen: HookInvocation[] = [];
				pipeline.register(policy, (invocation) => {
					seen.push(invocation);
					return outcome === "deny"
						? { decision: "deny", code: "blocked", reason: "Retry denied by policy" }
						: undefined;
				});
				const restarted = new SessionOrchestrator(store, runtime, {
					maxRetries: 1,
					retryBaseDelayMs: 0,
					hookPipeline: pipeline,
				});
				restarted.recoverInterruptedOperations();
				await restarted.drainSession(sessionId);
				const result = store.getOperation(operation.id)!;
				expect(result.retryAfter).toBeUndefined();
				expect(result).toMatchObject({ status: outcome === "allow" ? "completed" : "failed", attempt: 2 });
				expect(runtime.calls).toBe(outcome === "allow" ? 1 : 0);
				expect(runtime.capabilityResolutions).toBe(1);
				expect(runtime.contextResolutions).toBe(1);
				expect(result.capabilityPlan!.digest).not.toBe(oldCapabilityPlan.digest);
				if (outcome === "planning_failure") {
					expect(result.contextPlan).toBeUndefined();
					expect(result.error).toContain("Context planning unavailable");
					expect(seen).toHaveLength(0);
				} else {
					expect(result.contextPlan!.digest).not.toBe(oldContextPlan.digest);
					expect(result.contextPlan!.budget.observedContextTokens).toBe(10000);
					expect(seen).toHaveLength(1);
					expect(seen[0]!.data).toMatchObject({ attempt: 2, contextPlanDigest: result.contextPlan!.digest });
				}
				expect(store.trajectoryReport(operation.id).replay.integrity).toBe(true);
			} finally {
				store.close();
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);
});

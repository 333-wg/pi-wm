import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_USAGE, replaySessionEvents } from "@wuming/domain";
import { sessionUsageRequests, type UsageRequestSummary } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore, type AgentRuntime } from "../src/index.js";

const model = { provider: "test", id: "model" };
const request: UsageRequestSummary = {
	requestId: "request-1",
	model,
	usage: { ...EMPTY_USAGE, inputTokens: 100, cacheReadTokens: 900, outputTokens: 10, totalTokens: 1010 },
	startedAt: 100,
	firstContentAt: 150,
	finishedAt: 200,
	status: "complete",
};

async function queueTurn(orchestrator: SessionOrchestrator) {
	const { snapshot } = await orchestrator.createSession({
		principalId: "test",
		idempotencyKey: "create",
		workspaceId: "test",
		model,
		thinkingLevel: "off",
		sandboxMode: "read_only",
		approvalPolicy: "never",
	});
	await orchestrator.acceptTurn({
		principalId: "test",
		idempotencyKey: "turn",
		sessionId: snapshot.session.id,
		mode: "prompt",
		content: [{ type: "text", text: "inspect" }],
	});
	return snapshot.session.id;
}

describe("live request usage", () => {
	it.each(["complete", "failure", "retry"] as const)(
		"settles timed requests after desktop tools without losing progress (%s)",
		async (outcome) => {
			const store = new SqliteOrchestratorStore(":memory:");
			let calls = 0;
			let launches = 0;
			const runtime: AgentRuntime = {
				async executeTurn(input) {
					calls++;
					if (calls > 1) {
						expect(input.snapshot.transcript.filter((item) => item.type === "tool")).toHaveLength(1);
						expect(input.snapshot.usage).toEqual(request.usage);
						return { items: [] };
					}
					launches++;
					const item = {
						id: "launched",
						type: "tool" as const,
						toolCallId: "launch",
						toolName: "computer_open",
						createdAt: 100,
						status: "complete" as const,
						input: { app_ref: "opaque-ref" },
						content: [{ type: "text" as const, text: '{"performed":true,"outcome":"launch_requested"}' }],
						isError: false,
					};
					input.onTranscriptItem?.(item);
					input.onRequestUsage?.(request);
					return {
						items: [item],
						usage: request.usage,
						requests: [request],
						tools: [{ toolName: "computer_open", callCount: 1, succeededCount: 1, usage: EMPTY_USAGE }],
						...(outcome === "complete"
							? {}
							: {
									failure: {
										code: "runtime_error" as const,
										message: "Connection error.",
										kind: "provider_network" as const,
										retryable: outcome === "retry",
									},
								}),
					};
				},
			};
			try {
				const orchestrator = new SessionOrchestrator(store, runtime, { maxRetries: 1, retryBaseDelayMs: 0 });
				const sessionId = await queueTurn(orchestrator);
				await orchestrator.drainSession(sessionId);
				const operation = store.listOperations(sessionId)[0]!;
				expect(operation.status).toBe(outcome === "failure" ? "failed" : "completed");
				expect(operation.error).toBe(outcome === "failure" ? "Connection error." : undefined);
				expect(operation.attempt).toBe(outcome === "retry" ? 2 : 1);
				expect(launches).toBe(1);
				const saved = store.loadSnapshot(sessionId)!;
				expect(saved.usageByTurn?.[0]?.requests).toEqual([request]);
				expect(saved.transcript.filter((item) => item.type === "tool")).toHaveLength(1);
				expect(replaySessionEvents(store.loadEvents(sessionId))).toEqual(saved);
			} finally {
				store.close();
			}
		}
	);

	it("persists during execution, replaces corrections and reconciles without charging twice", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-request-usage-"));
		const path = join(directory, "state.db");
		let store = new SqliteOrchestratorStore(path);
		const corrected = { ...request, usage: { ...request.usage, inputTokens: 50, cacheReadTokens: 950 } };
		const second = { ...request, requestId: "request-2" };
		const total = { ...EMPTY_USAGE, inputTokens: 150, cacheReadTokens: 1850, outputTokens: 20, totalTokens: 2020 };
		const runtime: AgentRuntime = {
			async executeTurn(input) {
				input.onRequestUsage!(request);
				input.onRequestUsage!(request);
				input.onRequestUsage!(corrected);
				input.onContextUsage!({ model, tokens: 1010, basis: "request" });
				const reader = new SqliteOrchestratorStore(path);
				try {
					const live = reader.loadSnapshot(input.snapshot.session.id)!;
					expect(live.session.phase).toBe("turn");
					expect(sessionUsageRequests(live)).toEqual([corrected]);
					expect(live.usage).toEqual(EMPTY_USAGE);
					expect(live.usageByTurn).toEqual([]);
					expect(replaySessionEvents(reader.loadEvents(live.session.id))).toEqual(live);
				} finally {
					reader.close();
				}
				// The second request simulates an observation missed by the live callback.
				return { items: [], usage: total, requests: [corrected, second, second] };
			},
		};
		try {
			const orchestrator = new SessionOrchestrator(store, runtime);
			const sessionId = await queueTurn(orchestrator);
			await orchestrator.drainSession(sessionId);
			store.close();
			store = new SqliteOrchestratorStore(path);
			const saved = store.loadSnapshot(sessionId)!;
			expect(sessionUsageRequests(saved)).toEqual([corrected, second]);
			expect(saved.usage).toEqual(total);
			expect(saved.usageByTurn?.[0]?.usage).toEqual(total);
			expect(saved.usageByTurn?.[0]?.requests).toEqual([corrected, second]);
			expect(saved.usageByModel?.[0]?.turnCount).toBe(1);
			expect(store.loadEvents(sessionId).filter((e) => e.type === "session.request.usage.updated")).toHaveLength(3);
			expect(replaySessionEvents(store.loadEvents(sessionId))).toEqual(saved);
			const reopened = new SessionOrchestrator(store, runtime);
			const fork = await reopened.forkSession({ principalId: "test", idempotencyKey: "fork", sessionId });
			expect(sessionUsageRequests(fork.snapshot)).toEqual([]);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(["failure", "abort", "retry"] as const)("retains completed request usage after %s", async (outcome) => {
		const store = new SqliteOrchestratorStore(":memory:");
		let orchestrator: SessionOrchestrator;
		let calls = 0;
		const runtime: AgentRuntime = {
			async executeTurn(input) {
				calls++;
				const observed = { ...request, requestId: `request-${calls}` };
				input.onRequestUsage!(observed);
				if (calls > 1) return { items: [], requests: [observed] };
				if (outcome === "abort") {
					await orchestrator.abortTurn({
						principalId: "test",
						idempotencyKey: "stop",
						sessionId: input.snapshot.session.id,
					});
					input.onRequestUsage!({ ...request, requestId: "late-after-abort" });
					throw new Error("aborted");
				}
				if (outcome === "failure") throw new Error("disconnected");
				return {
					items: [],
					requests: [observed],
					failure: { code: "runtime_error", message: "retry", retryable: true },
				};
			},
		};
		try {
			orchestrator = new SessionOrchestrator(store, runtime, { maxRetries: 1, retryBaseDelayMs: 0 });
			const sessionId = await queueTurn(orchestrator);
			await orchestrator.drainSession(sessionId);
			const saved = store.loadSnapshot(sessionId)!;
			expect(saved.session.phase).toBe("idle");
			expect(sessionUsageRequests(saved).map((r) => r.requestId)).toEqual(
				outcome === "retry" ? ["request-1", "request-2"] : ["request-1"]
			);
			expect(saved.usage).toEqual(EMPTY_USAGE);
			expect(replaySessionEvents(store.loadEvents(sessionId))).toEqual(saved);
		} finally {
			store.close();
		}
	});
});

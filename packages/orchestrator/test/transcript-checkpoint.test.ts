import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaySessionEvents } from "@wuming/domain";
import type { TranscriptItem } from "@wuming/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore } from "../src/index.js";
import { TranscriptCheckpoint } from "../src/transcript-checkpoint.js";
import type { AgentRuntime } from "../src/types.js";

function assistant(id: string, text: string, status: "streaming" | "complete" = "streaming"): TranscriptItem {
	return {
		id,
		type: "assistant",
		createdAt: 1,
		status,
		content: [{ type: "text", text }],
		model: { provider: "test", id: "test" },
	};
}

const tool: TranscriptItem = {
	id: "tool:read-1",
	type: "tool",
	createdAt: 2,
	toolCallId: "read-1",
	toolName: "read_file",
	status: "running",
	input: { path: "readme.md" },
	content: [{ type: "text", text: "partial output" }],
	isError: false,
};

async function queueTurn(orchestrator: SessionOrchestrator) {
	const { snapshot } = await orchestrator.createSession({
		principalId: "test",
		idempotencyKey: "create",
		workspaceId: "test",
		model: { provider: "test", id: "test" },
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

afterEach(() => vi.useRealTimers());

describe("transcript checkpoints", () => {
	it("coalesces partials, snapshots mutable input and flushes completed boundaries immediately", () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const checkpoint = new TranscriptCheckpoint(persist, (error) => {
			throw error;
		});
		checkpoint.put(assistant("a", ""));
		const partial = { ...assistant("a", "first"), content: [{ type: "text" as const, text: "first" }] };
		checkpoint.put(partial);
		partial.content = [{ type: "text", text: "mutated after callback" }];
		expect(persist).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(250);
		expect(persist.mock.calls[1]![0][0].content).toEqual([{ type: "text", text: "first" }]);
		checkpoint.put(assistant("a", "second"));
		checkpoint.put(assistant("a", "finished", "complete"));
		expect(persist).toHaveBeenCalledTimes(3);
		checkpoint.close();
		checkpoint.put(assistant("late", "ignored"));
		vi.runAllTimers();
		expect(persist).toHaveBeenCalledTimes(3);
	});

	it.each([false, true])("reports persistence failures and stops further writes (background: %s)", (background) => {
		vi.useFakeTimers();
		const persist = vi.fn<() => void>(() => {
			throw new Error("disk full");
		});
		if (background) persist.mockImplementationOnce(() => {});
		const onError = vi.fn();
		const checkpoint = new TranscriptCheckpoint(persist, onError);
		checkpoint.put(assistant("a", ""));
		checkpoint.put(assistant("a", "partial"));
		vi.advanceTimersByTime(250);
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "disk full" }));
		checkpoint.put(assistant("a", "late", "complete"));
		expect(persist).toHaveBeenCalledTimes(background ? 2 : 1);
	});

	it("makes in-flight history readable from SQLite and preserves order without duplicates on completion", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-checkpoint-"));
		const path = join(directory, "state.db");
		let store = new SqliteOrchestratorStore(path);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const runtime: AgentRuntime = {
			async executeTurn(input) {
				input.onTranscriptItem!(assistant("a", "earlier reply", "complete"));
				input.onTranscriptItem!(tool);
				input.onTranscriptItem!(assistant("b", "thinking in progress"));
				input.onTranscriptItem!(assistant("b", "latest partial"));
				entered();
				await gate;
				return {
					items: [
						assistant("a", "earlier reply", "complete"),
						{ ...tool, status: "complete" },
						assistant("b", "final reply", "complete"),
					],
				};
			},
		};
		const orchestrator = new SessionOrchestrator(store, runtime);
		const sessionId = await queueTurn(orchestrator);
		const draining = orchestrator.drainSession(sessionId);
		try {
			await started;
			await vi.waitFor(() =>
				expect(store.loadSnapshot(sessionId)!.transcript.at(-1)!.content).toEqual([
					{ type: "text", text: "latest partial" },
				])
			);
			const reader = new SqliteOrchestratorStore(path);
			try {
				const persisted = reader.loadSnapshot(sessionId)!;
				expect(persisted.session.phase).toBe("turn");
				expect(persisted.transcript.slice(1).map((item) => item.id)).toEqual(["a", "tool:read-1", "b"]);
				expect(replaySessionEvents(reader.loadEvents(sessionId))).toEqual(persisted);
			} finally {
				reader.close();
			}
			release();
			await draining;
			store.close();
			store = new SqliteOrchestratorStore(path);
			const persisted = store.loadSnapshot(sessionId)!;
			expect(persisted.session.phase).toBe("idle");
			expect(persisted.transcript.slice(1).map((item) => item.id)).toEqual(["a", "tool:read-1", "b"]);
			expect(persisted.transcript.at(-1)).toMatchObject({
				status: "complete",
				content: [{ type: "text", text: "final reply" }],
			});
			expect(replaySessionEvents(store.loadEvents(sessionId))).toEqual(persisted);
		} finally {
			release();
			await draining;
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(["failure", "abort", "retry"] as const)(
		"preserves partial output and settles running items after %s",
		async (outcome) => {
			const store = new SqliteOrchestratorStore(":memory:");
			let orchestrator: SessionOrchestrator;
			let calls = 0;
			const runtime: AgentRuntime = {
				async executeTurn(input) {
					calls++;
					if (calls > 1) return { items: [assistant("recovered", "retry completed", "complete")] };
					input.onTranscriptItem!(assistant("a", "partial"));
					input.onTranscriptItem!(tool);
					input.onTranscriptItem!(assistant("a", "last buffered text"));
					if (outcome === "abort") {
						await orchestrator.abortTurn({
							principalId: "test",
							idempotencyKey: "stop",
							sessionId: input.operation.sessionId,
						});
						throw new Error("aborted");
					}
					if (outcome === "failure") throw new Error("provider disconnected");
					return { items: [], failure: { code: "runtime_error", message: "retry", retryable: true } };
				},
			};
			try {
				orchestrator = new SessionOrchestrator(store, runtime, { maxRetries: 1, retryBaseDelayMs: 0 });
				const sessionId = await queueTurn(orchestrator);
				await orchestrator.drainSession(sessionId);
				const snapshot = store.loadSnapshot(sessionId)!;
				expect(snapshot.transcript.find((item) => item.id === "a")).toMatchObject({
					status: outcome === "abort" ? "aborted" : "error",
					content: [{ type: "text", text: "last buffered text" }],
				});
				expect(snapshot.transcript.find((item) => item.id === tool.id)).toMatchObject({
					status: outcome === "abort" ? "aborted" : "error",
				});
				expect(snapshot.session.phase).toBe("idle");
				expect(calls).toBe(outcome === "retry" ? 2 : 1);
				expect(replaySessionEvents(store.loadEvents(sessionId))).toEqual(snapshot);
			} finally {
				store.close();
			}
		}
	);
});

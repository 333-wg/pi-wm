import { describe, it, expect } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore } from "../src/index.js";
import type { AgentRuntime } from "../src/types.js";

async function setup() {
	const store = new SqliteOrchestratorStore(":memory:");
	const seen: string[] = [];
	const runtime: AgentRuntime = { async executeTurn({ operation, snapshot }) {
		const text = operation.payload.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		seen.push(text);
		expect(snapshot.transcript.some((item) => item.id === operation.payload.userItemId)).toBe(true);
		return { items: [{ id: `answer-${operation.id}`, type: "assistant", status: "complete", model: snapshot.model, createdAt: Date.now(), content: [{ type: "text", text: `answer:${text}` }] }] };
	} };
	const orchestrator = new SessionOrchestrator(store, runtime);
	const { snapshot } = await orchestrator.createSession({ principalId: "test", idempotencyKey: "session", workspaceId: "workspace", model: { provider: "demo", id: "demo" }, thinkingLevel: "off", sandboxMode: "read_only", approvalPolicy: "never" });
	const sessionId = snapshot.session.id;
	const send = (text: string, mode: "prompt" | "follow_up") => orchestrator.acceptTurn({ principalId: "test", idempotencyKey: text, sessionId, mode, content: [{ type: "text", text }] });
	return { store, orchestrator, sessionId, send, seen };
}

describe("persistent follow-up queue", () => {
	it("keeps follow-ups out of the transcript, edits in place, deletes, and dispatches FIFO", async () => {
		const { store, orchestrator, sessionId, send, seen } = await setup();
		try {
			await send("first", "prompt");
			await send("second", "follow_up");
			await send("delete me", "follow_up");
			await send("third", "follow_up");
			expect(store.loadSnapshot(sessionId)?.transcript).toHaveLength(1);
			const [second, removed] = store.listQueuedFollowUps(sessionId);
			const edit = { principalId: "test", idempotencyKey: "edit", sessionId, operationId: second!.id, expectedUpdatedAt: second!.updatedAt, text: "edited second" };
			await orchestrator.mutateQueuedFollowUp(edit);
			await orchestrator.mutateQueuedFollowUp(edit); // replay is safe
			await expect(orchestrator.mutateQueuedFollowUp({ ...edit, idempotencyKey: "stale", text: "stale" })).rejects.toThrow(/已被修改/);
			const deletion = { principalId: "test", idempotencyKey: "delete", sessionId, operationId: removed!.id, expectedUpdatedAt: removed!.updatedAt };
			await orchestrator.mutateQueuedFollowUp(deletion);
			await orchestrator.mutateQueuedFollowUp(deletion);
			expect(store.loadSnapshot(sessionId)?.queuedFollowUpCount).toBe(2);
			expect(store.listQueuedFollowUps(sessionId)).toHaveLength(2);
			expect(store.getOperation(removed!.id)).toMatchObject({ status: "interrupted", attempt: 0 });
			expect(store.listRecoveryOperations(sessionId)).toEqual([]);
			await orchestrator.drainSession(sessionId);
			expect(seen).toEqual(["first", "edited second", "third"]);
			expect(store.listRecoveryOperations(sessionId).map((op) => op.payload.content)).toEqual(
				["first", "edited second", "third"].map((text) => [{ type: "text", text }])
			);
			expect(store.listQueuedFollowUps(sessionId)).toEqual([]);
			expect(store.loadSnapshot(sessionId)?.transcript.map((item) => item.type)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
			expect(store.loadSnapshot(sessionId)?.queuedFollowUpCount).toBe(0);
			await expect(orchestrator.mutateQueuedFollowUp({ ...edit, idempotencyKey: "too late" })).rejects.toThrow(/已开始/);
		} finally { store.close(); }
	});
	it("rejects empty edits and wrong-session changes without consuming the queue", async () => {
		const { store, orchestrator, sessionId, send } = await setup();
		try {
			await send("first", "prompt");
			await send("second", "follow_up");
			const entry = store.listQueuedFollowUps(sessionId)[0]!;
			const input = { principalId: "test", idempotencyKey: "empty", sessionId, operationId: entry.id, expectedUpdatedAt: entry.updatedAt, text: "  " };
			await expect(orchestrator.mutateQueuedFollowUp(input)).rejects.toThrow(/请输入/);
			await expect(orchestrator.mutateQueuedFollowUp({ ...input, sessionId: "wrong" })).rejects.toThrow();
			expect(store.listQueuedFollowUps(sessionId)).toHaveLength(1);
		} finally { store.close(); }
	});
});

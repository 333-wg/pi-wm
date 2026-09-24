import { afterEach, expect, it, vi } from "vitest";
import { replaySessionEvents } from "@wuming/domain";
import { SessionOrchestrator, SqliteOrchestratorStore, type AgentRuntime } from "../src/index.js";

const stores: SqliteOrchestratorStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function setup() {
	const store = new SqliteOrchestratorStore(":memory:");
	stores.push(store);
	let calls = 0;
	const branchSession = vi.fn<NonNullable<AgentRuntime["branchSession"]>>(async () => {});
	const runtime: AgentRuntime = {
		branchSession,
		executeTurn: async (input) => ({
			items: [
				{
					id: `reply-${++calls}`,
					type: "assistant",
					status: "complete",
					createdAt: Date.now(),
					content: [{ type: "text", text: `answer-${calls}` }],
					model: input.snapshot.model,
				},
			],
		}),
	};
	const orchestrator = new SessionOrchestrator(store, runtime);
	const { snapshot } = await orchestrator.createSession({
		principalId: "test",
		idempotencyKey: "create",
		workspaceId: "workspace",
		model: { provider: "test", id: "test" },
		thinkingLevel: "off",
		sandboxMode: "read_only",
		approvalPolicy: "never",
	});
	const sessionId = snapshot.session.id;
	const send = async (text: string) => {
		await orchestrator.acceptTurn({
			principalId: "test",
			idempotencyKey: text,
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text }],
		});
		await orchestrator.drainSession(sessionId);
	};
	await send("first");
	await send("second");
	const source = store.loadSnapshot(sessionId)!;
	const input = {
		principalId: "test",
		idempotencyKey: "edit",
		sessionId,
		mode: "prompt" as const,
		content: [{ type: "text" as const, text: "revised" }],
		edit: { itemId: source.transcript[2]!.id, expectedRevision: source.revision },
	};
	return { store, orchestrator, sessionId, source, input, branchSession };
}

it("edits and enqueues atomically in the same session, preserving the prefix and audit operations", async () => {
	const { store, orchestrator, sessionId, source, input, branchSession } = await setup();
	const accepted = await orchestrator.acceptTurn(input);
	const edited = store.loadSnapshot(sessionId)!;
	expect(accepted.sessionId).toBe(sessionId);
	expect(edited.transcript.slice(0, 2)).toEqual(source.transcript.slice(0, 2));
	expect(edited.transcript).toHaveLength(3);
	expect(edited.transcript[2]!.content).toEqual(input.content);
	expect(edited.runtimeHistoryId).toBeTruthy();
	expect(replaySessionEvents(store.loadEvents(sessionId))).toEqual(edited);
	expect(edited.contextUsage?.tokens).toBeNull();
	expect(store.listOperations(sessionId)).toHaveLength(3);
	expect(branchSession).toHaveBeenCalledWith(
		expect.objectContaining({ targetSessionId: sessionId, beforeItemId: input.edit.itemId })
	);
	await expect(orchestrator.acceptTurn(input)).resolves.toEqual(accepted);
	expect(branchSession).toHaveBeenCalledTimes(1);
	await orchestrator.drainSession(sessionId);
	expect(store.loadSnapshot(sessionId)!.transcript).toHaveLength(4);
});

it("editing the first message keeps the session identity and removes all old context", async () => {
	const { store, orchestrator, sessionId, source, input } = await setup();
	await orchestrator.acceptTurn({ ...input, edit: { ...input.edit, itemId: source.transcript[0]!.id } });
	const edited = store.loadSnapshot(sessionId)!;
	expect(edited.session.id).toBe(sessionId);
	expect(edited.session.name).toBe(source.session.name);
	expect(edited.transcript).toHaveLength(1);
	expect(edited.transcript[0]!.content).toEqual(input.content);
});

it("does not change the conversation or accept a turn when history staging fails", async () => {
	const { store, orchestrator, sessionId, source, input, branchSession } = await setup();
	branchSession.mockRejectedValueOnce(new Error("disk unavailable"));
	await expect(orchestrator.acceptTurn(input)).rejects.toThrow("disk unavailable");
	expect(store.loadSnapshot(sessionId)).toEqual(source);
	expect(store.listOperations(sessionId)).toHaveLength(2);
});

it("rejects stale, non-user, queued and active edits without staging history", async () => {
	const { store, orchestrator, sessionId, input, branchSession } = await setup();
	await expect(orchestrator.acceptTurn({ ...input, edit: { ...input.edit, expectedRevision: 1 } })).rejects.toThrow(
		"conversation changed"
	);
	await expect(orchestrator.acceptTurn({ ...input, edit: { ...input.edit, itemId: "reply-1" } })).rejects.toThrow(
		"user message"
	);
	const { edit: _edit, ...plain } = input;
	await orchestrator.acceptTurn({ ...plain, idempotencyKey: "queue", mode: "follow_up" });
	await expect(
		orchestrator.acceptTurn({
			...input,
			edit: { ...input.edit, expectedRevision: store.loadSnapshot(sessionId)!.revision },
		})
	).rejects.toThrow();
	expect(branchSession).not.toHaveBeenCalled();
});

it("stages an explicit fork before publishing it and retains a stable history pointer", async () => {
	const { store, orchestrator, sessionId, source, branchSession } = await setup();
	const input = { principalId: "test", idempotencyKey: "fork", sessionId, fromItemId: source.transcript[1]!.id };
	const fork = await orchestrator.forkSession(input);
	expect(fork.snapshot.session.id).not.toBe(sessionId);
	expect(fork.snapshot.runtimeHistoryId).toBeTruthy();
	expect(fork.snapshot.transcript).toEqual(source.transcript.slice(0, 2));
	expect(store.loadSnapshot(sessionId)).toEqual(source);
	await expect(orchestrator.forkSession(input)).resolves.toEqual(fork);
	expect(branchSession).toHaveBeenCalledTimes(1);
});

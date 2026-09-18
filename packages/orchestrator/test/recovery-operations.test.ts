import { expect, it } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore } from "../src/index.js";

it("returns all terminal raw requests in acceptance order, excluding active work and other sessions", async () => {
	const store = new SqliteOrchestratorStore(":memory:");
	const orchestrator = new SessionOrchestrator(
		store,
		{ executeTurn: async () => ({ items: [] }) },
		{ clock: () => 100 }
	);
	const create = (id: string) =>
		orchestrator.createSession({
			principalId: "test",
			idempotencyKey: id,
			workspaceId: "test",
			model: { provider: "test", id: "test" },
			thinkingLevel: "off",
			sandboxMode: "read_only",
			approvalPolicy: "never",
		});
	try {
		const sessionId = (await create("one")).snapshot.session.id;
		const otherSessionId = (await create("two")).snapshot.session.id;
		const queue = (id: string, text: string, session = sessionId) =>
			orchestrator.acceptTurn({
				principalId: "test",
				idempotencyKey: id,
				sessionId: session,
				mode: "prompt",
				content: [{ type: "text", text }],
			});
		for (let index = 0; index < 105; index++) {
			await queue(`turn-${index}`, `Raw request ${index}`);
			await orchestrator.drainSession(sessionId);
		}
		await queue("other", "Other session", otherSessionId);
		await orchestrator.drainSession(otherSessionId);
		await queue("pending", "Not executed yet");
		const restored = store.listRecoveryOperations(sessionId);
		expect(restored).toHaveLength(105);
		expect(restored.every((item) => item.sessionId === sessionId && item.status === "completed")).toBe(true);
		expect(restored.map((item) => item.payload.content)).toEqual(
			Array.from({ length: 105 }, (_, index) => [{ type: "text", text: `Raw request ${index}` }])
		);
	} finally {
		store.close();
	}
});

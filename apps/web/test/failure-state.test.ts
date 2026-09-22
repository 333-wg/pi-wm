import type { RunSummary, SessionSnapshot, TranscriptItem } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import {
	activeRecovery,
	activeTurnFailure,
	connectionFailure,
	desktopContinuation,
	retrySummary,
	supersededFailure,
} from "../src/lib/failure-state.js";

const user: TranscriptItem = { id: "user", type: "user", createdAt: 1, content: [] };
const tool: TranscriptItem = {
	id: "tool",
	type: "tool",
	createdAt: 2,
	toolCallId: "call",
	toolName: "computer_open",
	status: "complete",
	input: {},
	content: [],
	isError: false,
};
const error: TranscriptItem = {
	id: "provider",
	type: "assistant",
	createdAt: 3,
	status: "error",
	content: [],
	model: { provider: "test", id: "test" },
	error: "Connection error.",
};
const terminal: TranscriptItem = { ...error, id: "operation:error", createdAt: 4 };
const run: RunSummary = {
	id: "operation",
	sessionId: "session",
	mode: "prompt",
	status: "failed",
	attempt: 1,
	createdAt: 1,
	updatedAt: 4,
	abortRequested: false,
	retryHistory: [{ attempt: 1, maxAttempts: 2, delayMs: 1000, error: "Connection error.", timestamp: 3 }],
};

describe("failure display and recovery", () => {
	it("does not count a scheduled retry as a started attempt", () => {
		expect(retrySummary(run)).toBe("已安排自动重试 1 次；任务实际启动 1 次");
		expect(retrySummary({ ...run, attempt: 2 })).toBe("已安排自动重试 1 次；任务实际启动 2 次");
		expect(retrySummary(undefined)).toBeUndefined();
	});
	it("identifies connection errors even without a classified run", () => {
		expect(connectionFailure(error.error!)).toBe(true);
		expect(connectionFailure("Connection error: ECONNRESET")).toBe(true);
		expect(connectionFailure("Upstream HTTP/2 stream failed")).toBe(true);
		expect(connectionFailure("permission denied")).toBe(false);
	});
	it("only suppresses intermediate errors when the same turn has a final error", () => {
		expect(supersededFailure([user, tool, error, terminal], error.id)).toBe(true);
		expect(supersededFailure([user, tool, error, terminal], terminal.id)).toBe(false);
		const { error: _error, ...aborted } = terminal;
		expect(supersededFailure([user, error, { ...aborted, status: "aborted" }], error.id)).toBe(true);
		expect(supersededFailure([user, tool, error], error.id)).toBe(false);
		expect(supersededFailure([user, error, { ...error, id: "retry-2" }], error.id)).toBe(true);
		expect(supersededFailure([error, user, terminal], error.id)).toBe(false);
		const recovered: TranscriptItem = {
			id: "recovered",
			type: "assistant",
			createdAt: 5,
			model: error.model,
			status: "complete",
			content: [{ type: "text", text: "done" }],
		};
		expect(supersededFailure([user, error, recovered], error.id)).toBe(true);
	});
	it("suppresses in-flight failures only in the active turn", () => {
		expect(activeTurnFailure([user, error], error.id, true)).toBe(true);
		expect(activeTurnFailure([user, error], error.id, false)).toBe(false);
		expect(activeTurnFailure([error, user], error.id, true)).toBe(false);
	});
	it("restores the single recovery card from durable history after reload", () => {
		const snapshot = { session: { id: "session", phase: "retry" }, transcript: [user, error] } as SessionSnapshot;
		const running = { ...run, status: "running" as const, failureKind: "provider_network" as const };
		expect(activeRecovery(snapshot, [running], undefined)).toMatchObject({
			operationId: "operation",
			nextAttempt: 2,
			maxAttempts: 3,
			waiting: true,
		});
		expect(
			activeRecovery({ ...snapshot, session: { ...snapshot.session, phase: "turn" } }, [running], undefined)
		).toMatchObject({ waiting: false });
		expect(
			activeRecovery({ ...snapshot, session: { ...snapshot.session, phase: "idle" } }, [running], undefined)
		).toBeUndefined();
		expect(activeRecovery({ ...snapshot, transcript: [user, error, terminal] }, [running], undefined)).toBeUndefined();
		expect(activeRecovery(snapshot, [{ ...running, sessionId: "other" }], undefined)).toBeUndefined();
	});
	it("continues desktop work after successful or uncertain actions without including older turns", () => {
		expect(desktopContinuation([user, tool, error], error.id)).toBe(true);
		expect(desktopContinuation([user, { ...tool, status: "error", isError: true }, error], error.id)).toBe(true);
		expect(desktopContinuation([tool, user, error], error.id)).toBe(false);
		expect(desktopContinuation([user, { ...tool, status: "pending" }, error], error.id)).toBe(false);
	});
});

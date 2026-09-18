import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { CommandSchema, ServerMessageSchema, UsageRequestSummarySchema } from "../src/index.js";

describe("task observability contracts", () => {
	it("bounds search requests and rejects extra fields", () => {
		const check = Compile(CommandSchema);
		const command = { type: "session.search", workspaceId: "workspace", query: "中文" };
		expect(check.Check(command)).toBe(true);
		for (const value of [
			{ ...command, query: "" },
			{ ...command, query: "x".repeat(201) },
			{ ...command, limit: 51 },
			{ ...command, path: "C:/private" },
		])
			expect(check.Check(value)).toBe(false);
	});
	it("accepts legacy usage and optional timing but rejects a raw error body", () => {
		const check = Compile(UsageRequestSummarySchema);
		const request = {
			requestId: "request",
			model: { provider: "test", id: "model" },
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
		};
		expect(check.Check(request)).toBe(true);
		expect(check.Check({ ...request, startedAt: 1, finishedAt: 3, firstContentAt: 2, status: "error" })).toBe(true);
		expect(check.Check({ ...request, error: "private" })).toBe(false);
	});
	it("keeps notification payload body-free", () => {
		const check = Compile(ServerMessageSchema);
		const message = {
			type: "task.notification",
			id: "event",
			sessionId: "session",
			workspaceId: "workspace",
			kind: "approval",
		};
		expect(check.Check(message)).toBe(true);
		expect(check.Check({ ...message, title: "private" })).toBe(false);
	});
});

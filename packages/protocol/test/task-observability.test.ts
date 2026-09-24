import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
	CommandSchema,
	PromptCacheDiagnosticSchema,
	ServerMessageSchema,
	UsageRequestSummarySchema,
} from "../src/index.js";

describe("task observability contracts", () => {
	it("accepts bounded cache fingerprints but rejects prompt bodies and invalid hashes", () => {
		const check = Compile(PromptCacheDiagnosticSchema);
		const hash = `sha256:${"a".repeat(64)}`;
		const diagnostic = {
			basis: "provider_payload",
			change: "append_only",
			systemDigest: hash,
			toolsDigest: hash,
			historyDigest: hash,
			parametersDigest: hash,
			messageCount: 3,
			sharedPrefixMessages: 1,
			previousMessageCount: 1,
			intervalMs: 10,
		};
		expect(check.Check(diagnostic)).toBe(true);
		expect(check.Check({ ...diagnostic, prompt: "private" })).toBe(false);
		expect(check.Check({ ...diagnostic, systemDigest: "private" })).toBe(false);
		expect(check.Check({ ...diagnostic, intervalMs: -1 })).toBe(false);
	});
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

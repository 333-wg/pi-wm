import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderLocalized as renderToStaticMarkup } from "./render-localized.js";
import type { RunSummary, SessionSnapshot } from "@wuming/protocol";
import { diagnoseRun, diagnosticReport } from "../src/lib/run-diagnostics";
import { RunDiagnostics } from "../src/components/RunDiagnostics";

const snapshot: SessionSnapshot = {
	session: { id: "session", workspaceId: "workspace", phase: "turn", createdAt: 1, updatedAt: 1 },
	revision: 1,
	model: { provider: "test", id: "model" },
	thinkingLevel: "off",
	sandboxMode: "read_only",
	approvalPolicy: "never",
	transcript: [],
	pendingApprovals: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
};
const run: RunSummary = {
	id: "run",
	sessionId: "session",
	mode: "prompt",
	status: "running",
	attempt: 1,
	createdAt: 1,
	updatedAt: 2,
	abortRequested: false,
};

describe("run diagnostics", () => {
	it("shows the actual command and durable output timing after recovery without displaying a model wait", () => {
		const active: SessionSnapshot = {
			...snapshot,
			transcript: [
				{
					type: "tool",
					id: "tool",
					toolCallId: "call",
					toolName: "exec",
					status: "running",
					createdAt: 1000,
					lastProgressAt: 2000,
					input: { command: "npm test --api-key=secret-value" },
					content: [],
					isError: false,
				},
			],
		};
		expect(diagnoseRun(active, [run])).toMatchObject({
			phase: "tool",
			toolStartedAt: 1000,
			lastProgressAt: 2000,
			command: "npm test --api-key=secret-value",
		});
		const html = renderToStaticMarkup(
			createElement(RunDiagnostics, {
				snapshot: active,
				runs: [
					{
						...run,
						retryHistory: [{ attempt: 1, maxAttempts: 6, delayMs: 1000, timestamp: 1, error: "Connection error." }],
					},
				],
			})
		);
		expect(html).toContain("npm test");
		expect(html).not.toContain("secret-value");
		expect(html).toContain("距最近输出");
		expect(html).toContain("此前连接异常已恢复");
		expect(html).not.toContain("等待模型响应");
	});
	it("renders recorded request timing and keeps legacy timing explicitly unknown", () => {
		const html = renderToStaticMarkup(
			createElement(RunDiagnostics, {
				runs: [],
				snapshot: {
					...snapshot,
					session: { ...snapshot.session, phase: "idle" },
					usageRequests: [
						{
							requestId: "recorded",
							model: snapshot.model,
							usage: snapshot.usage,
							status: "complete",
							startedAt: 1000,
							firstContentAt: 2500,
							finishedAt: 3000,
						},
						{ requestId: "legacy", model: snapshot.model, usage: snapshot.usage },
					],
				},
			})
		);
		expect(html).toContain("1.5s");
		expect(html).toContain("2.0s");
		expect(html).toContain("未记录");
		expect(html).toContain("--");
	});

	it("distinguishes waiting, retry, approval, interruption and stop without calling a wait a failure", () => {
		expect(diagnoseRun(snapshot, [run])).toMatchObject({ phase: "waiting", attention: false });
		expect(diagnoseRun(snapshot, [{ ...run, abortRequested: true }]).phase).toBe("stopping");
		for (const [phase, expected] of [
			["retry", "retry"],
			["awaiting_approval", "approval"],
			["compaction", "compaction"],
		] as const)
			expect(diagnoseRun({ ...snapshot, session: { ...snapshot.session, phase } }, [run]).phase).toBe(expected);
		expect(
			diagnoseRun({ ...snapshot, session: { ...snapshot.session, phase: "idle" } }, [{ ...run, status: "interrupted" }])
				.phase
		).toBe("interrupted");
	});
	it("does not mistake historical tool execution for the current turn", () => {
		const next: SessionSnapshot = {
			...snapshot,
			transcript: [
				{
					type: "tool",
					id: "tool",
					toolCallId: "call",
					toolName: "exec",
					status: "running",
					createdAt: 1,
					input: {},
					content: [],
					isError: false,
				},
				{ type: "user", id: "user", createdAt: 2, content: [{ type: "text", text: "next" }] },
			],
		};
		expect(diagnoseRun(next, [run]).phase).toBe("waiting");
		expect(diagnoseRun({ ...next, transcript: next.transcript.slice(0, 1) }, [run]).phase).toBe("tool");
	});
	it("exports metadata without body, provider names, tool names or error text", () => {
		const secret = "private-password";
		const report = diagnosticReport(
			{
				...snapshot,
				session: { ...snapshot.session, name: secret },
				transcript: [{ type: "user", id: secret, createdAt: 2, content: [{ type: "text", text: secret }] }],
				usageRequests: [
					{
						requestId: secret,
						model: { provider: secret, id: secret },
						usage: snapshot.usage,
						status: "complete",
						startedAt: 1,
						finishedAt: 3,
					},
				],
			},
			[{ ...run, error: secret, traceId: secret }]
		);
		expect(JSON.stringify(report)).not.toContain(secret);
		expect(report.requests[0]).toMatchObject({ startedAt: 1, finishedAt: 3, status: "complete" });
	});
});

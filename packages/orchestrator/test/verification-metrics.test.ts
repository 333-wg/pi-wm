import type { TranscriptItem, UsageToolSummary } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { verificationMetrics } from "../src/verification-metrics.js";

function call(toolName: string, input: unknown = {}): TranscriptItem {
	return {
		id: toolName,
		type: "tool",
		toolCallId: toolName,
		toolName,
		createdAt: 1,
		status: "error",
		isError: true,
		input: input as Extract<TranscriptItem, { type: "tool" }>["input"],
		content: [{ type: "text", text: "private result" }],
	};
}

function timing(toolName: string, durationMs?: number): UsageToolSummary {
	return {
		toolName,
		callCount: 1,
		...(durationMs === undefined ? {} : { durationMs }),
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
	};
}

describe("verification metrics", () => {
	it("counts attempted batches, observations and work after the last edit without exposing content", () => {
		const metrics = verificationMetrics([
			call("browser_snapshot"),
			call("edit", { path: "/private/file" }),
			call("exec", { command: "private command" }),
			call("write_file"),
			call("preview_start"),
			call("browser_action", { action: "batch", steps: [{ value: "private value" }] }),
			call("browser_action", { action: "click" }),
			call("browser_screenshot"),
			call("browser_diagnostics"),
		]);
		expect(metrics).toEqual({
			browserCallCount: 5,
			browserBatchCallCount: 1,
			browserObservationCallCount: 3,
			previewStartCallCount: 1,
			postEditToolCallCount: 5,
		});
		expect(JSON.stringify(metrics)).not.toContain("private");
	});

	it("reports summed tool time only when browser timing is available, including a measured zero", () => {
		const items = [call("browser_open"), call("browser_action")];
		expect(
			verificationMetrics(items, [timing("browser_open", 0), timing("browser_action", 30), timing("exec", 500)])
		).toMatchObject({ browserToolDurationMs: 30 });
		expect(verificationMetrics(items, [timing("browser_open", 0)])).not.toHaveProperty("browserToolDurationMs");
		expect(verificationMetrics(items, [timing("browser_open", 0), timing("browser_action")])).not.toHaveProperty(
			"browserToolDurationMs"
		);
		expect(verificationMetrics([call("browser_open")], [timing("browser_open", 0)])).toHaveProperty(
			"browserToolDurationMs",
			0
		);
	});

	it("does not invent an edit boundary or interpret shell commands and arbitrary inputs", () => {
		const metrics = verificationMetrics([
			call("exec", { command: "ego-browser nodejs; edit a file" }),
			call("browser_action", null),
			call("browser_action", [{ action: "batch" }]),
		]);
		expect(metrics.browserBatchCallCount).toBe(0);
		expect(metrics).not.toHaveProperty("postEditToolCallCount");
		expect(metrics).not.toHaveProperty("browserToolDurationMs");
	});
});

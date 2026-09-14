import { describe, expect, it } from "vitest";
import { createTrajectoryEvent, evaluateTrajectory, replayTrajectory, trajectoryDigest } from "../src/index.js";

function chain(operationId: string, data: Parameters<typeof createTrajectoryEvent>[0]["data"][]) {
	let previousDigest: string | null = null;
	return data.map((entry, index) => {
		const event = createTrajectoryEvent({
			operationId,
			sequence: index + 1,
			timestamp: 100 + index,
			previousDigest,
			data: entry,
		});
		previousDigest = event.digest;
		return event;
	});
}

describe("trajectory", () => {
	it("creates and replays a deterministic hash chain", () => {
		const events = chain("operation-1", [
			{ type: "operation.accepted", mode: "prompt" },
			{ type: "operation.started", attempt: 1, traceId: "trace-1" },
			{ type: "operation.finished", status: "completed", durationMs: 20 },
		]);
		const replay = replayTrajectory("operation-1", events);
		expect(replay).toMatchObject({ integrity: true, eventCount: 3, headDigest: events[2]!.digest });
		expect(events[0]!.digest).toBe(
			trajectoryDigest({
				schemaVersion: 1,
				operationId: "operation-1",
				sequence: 1,
				timestamp: 100,
				previousDigest: null,
				data: events[0]!.data,
			})
		);
	});

	it("pinpoints tampering instead of accepting a plausible event", () => {
		const events = chain("operation-1", [
			{ type: "operation.accepted", mode: "prompt" },
			{ type: "operation.finished", status: "completed" },
		]);
		const tampered = [...events];
		tampered[1] = { ...tampered[1]!, timestamp: 999 };
		expect(replayTrajectory("operation-1", tampered)).toMatchObject({
			integrity: false,
			invalidSequence: 2,
		});
	});

	it("evaluates structural evidence without claiming semantic correctness", () => {
		const usage = {
			inputTokens: 10,
			outputTokens: 2,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 12,
			costUsd: 0.01,
		};
		const replay = replayTrajectory(
			"operation-1",
			chain("operation-1", [
				{ type: "operation.accepted", mode: "prompt" },
				{ type: "operation.started", attempt: 1 },
				{ type: "capability.resolved", digest: `sha256:${"a".repeat(64)}`, capabilityCount: 2 },
				{
					type: "context.resolved",
					digest: `sha256:${"b".repeat(64)}`,
					fragmentCount: 2,
					estimatedSystemTokens: 100,
					availableSystemTokens: 500,
				},
				{
					type: "model.request",
					requestId: "request-1",
					model: { provider: "test", id: "model" },
					usage,
				},
				{
					type: "tool.summary",
					toolName: "read_file",
					callCount: 1,
					succeededCount: 1,
					failedCount: 0,
					abortedCount: 0,
				},
				{ type: "operation.finished", status: "completed", usage, durationMs: 50 },
			])
		);
		const evaluation = evaluateTrajectory(replay);
		expect(evaluation).toMatchObject({
			verdict: "pass",
			score: 100,
			semanticCorrectness: "not_evaluated",
			metrics: { modelRequestCount: 1, toolCallCount: 1 },
		});
		expect(evaluation.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("marks missing terminal evidence incomplete", () => {
		const evaluation = evaluateTrajectory(
			replayTrajectory("operation-1", chain("operation-1", [{ type: "operation.accepted", mode: "prompt" }]))
		);
		expect(evaluation.verdict).toBe("incomplete");
		expect(evaluation.semanticCorrectness).toBe("not_evaluated");
	});

	it("evaluates the latest approval state instead of historical intermediate states", () => {
		const operationId = "operation-approval";
		const events = chain(operationId, [
			{ type: "operation.accepted", mode: "prompt" },
			{
				type: "approval.state",
				approvalId: "approval-1",
				toolCallId: "tool-call-1",
				mode: "preflight",
				state: "waiting",
			},
			{
				type: "approval.state",
				approvalId: "approval-1",
				toolCallId: "tool-call-1",
				mode: "preflight",
				state: "executing",
			},
			{
				type: "approval.state",
				approvalId: "approval-1",
				toolCallId: "tool-call-1",
				mode: "preflight",
				state: "completed",
			},
			{ type: "operation.finished", status: "completed" },
		]);
		const evaluation = evaluateTrajectory(replayTrajectory(operationId, events));
		expect(evaluation.criteria.find((criterion) => criterion.id === "policy")).toMatchObject({
			status: "pass",
			score: 100,
		});
		expect(evaluation.metrics.approvalCount).toBe(1);
	});
});

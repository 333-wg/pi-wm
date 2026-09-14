import { createHash } from "node:crypto";
import type {
	TrajectoryCriterion,
	TrajectoryEvaluation,
	TrajectoryEvent,
	TrajectoryEventData,
	TrajectoryReplay,
	TrajectoryReport,
} from "./types.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
		.join(",")}}`;
}

export function trajectoryDigest(value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(typeof value === "string" ? value : canonicalize(value))
		.digest("hex")}`;
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}

function nonNegativeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
	return value;
}

function assertIdentifier(value: string, label: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/.test(value)) throw new Error(`${label} is invalid: ${value}`);
}

function validateUsage(usage: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
}): void {
	for (const [label, value] of Object.entries(usage)) {
		if (!Number.isFinite(value) || value < 0) throw new Error(`usage.${label} must be a non-negative finite number`);
	}
}

function validateData(data: TrajectoryEventData): void {
	switch (data.type) {
		case "operation.accepted":
			return;
		case "operation.started":
			positiveInteger(data.attempt, "attempt");
			if (data.traceId) assertIdentifier(data.traceId, "traceId");
			return;
		case "capability.resolved":
		case "context.resolved":
			if (!DIGEST_PATTERN.test(data.digest)) throw new Error(`${data.type} digest is invalid`);
			nonNegativeInteger(
				data.type === "capability.resolved" ? data.capabilityCount : data.fragmentCount,
				"resolved count"
			);
			if (data.type === "context.resolved") {
				nonNegativeInteger(data.estimatedSystemTokens, "estimatedSystemTokens");
				nonNegativeInteger(data.availableSystemTokens, "availableSystemTokens");
			}
			return;
		case "hook.executed":
			assertIdentifier(data.hookId, "hookId");
			nonNegativeInteger(data.durationMs, "durationMs");
			return;
		case "model.request":
			assertIdentifier(data.requestId, "requestId");
			assertIdentifier(data.model.provider, "model provider");
			assertIdentifier(data.model.id, "model id");
			validateUsage(data.usage);
			return;
		case "tool.summary":
			assertIdentifier(data.toolName, "toolName");
			positiveInteger(data.callCount, "callCount");
			if (data.durationMs !== undefined) nonNegativeInteger(data.durationMs, "durationMs");
			for (const count of [data.succeededCount, data.failedCount, data.abortedCount])
				nonNegativeInteger(count, "tool outcome count");
			return;
		case "approval.state":
			assertIdentifier(data.approvalId, "approvalId");
			assertIdentifier(data.toolCallId, "toolCallId");
			return;
		case "retry.scheduled":
			positiveInteger(data.attempt, "attempt");
			positiveInteger(data.maxAttempts, "maxAttempts");
			nonNegativeInteger(data.delayMs, "delayMs");
			if (!DIGEST_PATTERN.test(data.errorDigest)) throw new Error("retry errorDigest is invalid");
			return;
		case "compaction.completed":
			assertIdentifier(data.memoryId, "memoryId");
			if (!DIGEST_PATTERN.test(data.memoryDigest)) throw new Error("compaction memoryDigest is invalid");
			if (data.tokensBefore !== undefined) nonNegativeInteger(data.tokensBefore, "tokensBefore");
			if (data.estimatedTokensAfter !== undefined)
				nonNegativeInteger(data.estimatedTokensAfter, "estimatedTokensAfter");
			if (data.usage !== undefined) validateUsage(data.usage);
			return;
		case "operation.finished":
			if (data.durationMs !== undefined) nonNegativeInteger(data.durationMs, "durationMs");
			if (data.usage !== undefined) validateUsage(data.usage);
	}
}

export function createTrajectoryEvent(input: {
	operationId: string;
	sequence: number;
	timestamp: number;
	previousDigest: string | null;
	data: TrajectoryEventData;
}): TrajectoryEvent {
	assertIdentifier(input.operationId, "operationId");
	positiveInteger(input.sequence, "sequence");
	nonNegativeInteger(input.timestamp, "timestamp");
	if (input.previousDigest !== null && !DIGEST_PATTERN.test(input.previousDigest))
		throw new Error("previousDigest is invalid");
	validateData(input.data);
	const unsigned = {
		schemaVersion: 1 as const,
		operationId: input.operationId,
		sequence: input.sequence,
		timestamp: input.timestamp,
		previousDigest: input.previousDigest,
		data: input.data,
	};
	return Object.freeze({ ...unsigned, digest: trajectoryDigest(unsigned) });
}

export function verifyTrajectoryEvent(event: TrajectoryEvent): boolean {
	try {
		if (event.schemaVersion !== 1 || !DIGEST_PATTERN.test(event.digest)) return false;
		const rebuilt = createTrajectoryEvent(event);
		return rebuilt.digest === event.digest;
	} catch {
		return false;
	}
}

export function replayTrajectory(operationId: string, events: readonly TrajectoryEvent[]): TrajectoryReplay {
	let previousDigest: string | null = null;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index]!;
		if (
			event.operationId !== operationId ||
			event.sequence !== index + 1 ||
			event.previousDigest !== previousDigest ||
			!verifyTrajectoryEvent(event)
		) {
			return {
				operationId,
				integrity: false,
				eventCount: events.length,
				headDigest: previousDigest,
				invalidSequence: index + 1,
				events: [...events],
			};
		}
		previousDigest = event.digest;
	}
	return {
		operationId,
		integrity: true,
		eventCount: events.length,
		headDigest: previousDigest,
		events: [...events],
	};
}

function criterion(
	id: TrajectoryCriterion["id"],
	status: TrajectoryCriterion["status"],
	score: number,
	weight: number,
	evidence: string
): TrajectoryCriterion {
	return { id, status, score: Math.max(0, Math.min(100, Math.round(score))), weight, evidence };
}

export function evaluateTrajectory(replay: TrajectoryReplay): TrajectoryEvaluation {
	const events = replay.events;
	const terminal = [...events].reverse().find((event) => event.data.type === "operation.finished");
	const retries = events.filter((event) => event.data.type === "retry.scheduled");
	const requests = events.filter((event) => event.data.type === "model.request");
	const tools = events.flatMap((event) => (event.data.type === "tool.summary" ? [event.data] : []));
	const approvals = events.flatMap((event) => (event.data.type === "approval.state" ? [event.data] : []));
	const hooks = events.flatMap((event) => (event.data.type === "hook.executed" ? [event.data] : []));
	const latestApprovals = new Map<string, (typeof approvals)[number]>();
	for (const approval of approvals) latestApprovals.set(approval.approvalId, approval);
	const hasCapability = events.some((event) => event.data.type === "capability.resolved");
	const hasContext = events.some((event) => event.data.type === "context.resolved");
	const terminalData = terminal?.data.type === "operation.finished" ? terminal.data : undefined;
	const failedTools = tools.reduce((sum, tool) => sum + tool.failedCount + tool.abortedCount, 0);
	const hookFailures = hooks.filter((hook) => hook.outcome === "failed" || hook.outcome === "timed_out").length;
	const hookDenials = hooks.filter((hook) => hook.outcome === "denied").length;
	const unresolvedApprovals = [...latestApprovals.values()].filter(
		(approval) => approval.state === "waiting" || approval.state === "executing"
	).length;
	const observabilitySignals = [
		hasCapability,
		hasContext,
		requests.length > 0 || terminalData?.status === "interrupted",
		terminalData !== undefined,
	].filter(Boolean).length;
	const criteria = [
		criterion(
			"integrity",
			replay.integrity ? "pass" : "fail",
			replay.integrity ? 100 : 0,
			20,
			replay.integrity
				? `Verified ${events.length} chained events.`
				: `Hash chain failed at sequence ${replay.invalidSequence ?? "unknown"}.`
		),
		criterion(
			"completion",
			terminalData?.status === "completed" ? "pass" : terminalData ? "fail" : "warn",
			terminalData?.status === "completed" ? 100 : 0,
			30,
			terminalData ? `Operation settled as ${terminalData.status}.` : "No terminal event was captured."
		),
		criterion(
			"reliability",
			failedTools === 0 && retries.length === 0 ? "pass" : terminalData?.status === "completed" ? "warn" : "fail",
			100 - retries.length * 15 - failedTools * 20,
			20,
			`${retries.length} retries and ${failedTools} failed or aborted tool calls.`
		),
		criterion(
			"policy",
			hookDenials === 0 && hookFailures === 0 && unresolvedApprovals === 0
				? "pass"
				: hookDenials > 0 || unresolvedApprovals > 0
					? "fail"
					: "warn",
			100 - hookDenials * 50 - hookFailures * 20 - unresolvedApprovals * 50,
			15,
			`${hookDenials} enforcing denials, ${hookFailures} hook failures/timeouts, ${unresolvedApprovals} unresolved approvals.`
		),
		criterion(
			"observability",
			observabilitySignals === 4 ? "pass" : "warn",
			observabilitySignals * 25,
			15,
			`${observabilitySignals}/4 structural signals captured; semantic correctness requires a separate evaluator.`
		),
	];
	const score = Math.round(
		criteria.reduce((sum, item) => sum + item.score * item.weight, 0) /
			criteria.reduce((sum, item) => sum + item.weight, 0)
	);
	const unsigned = {
		schemaVersion: 1 as const,
		algorithm: "structural-v1" as const,
		verdict: !replay.integrity
			? ("fail" as const)
			: terminalData === undefined
				? ("incomplete" as const)
				: terminalData.status === "completed"
					? ("pass" as const)
					: ("fail" as const),
		score,
		semanticCorrectness: "not_evaluated" as const,
		criteria,
		metrics: {
			...(terminalData?.durationMs === undefined ? {} : { durationMs: terminalData.durationMs }),
			...(terminalData?.usage === undefined ? {} : { usage: terminalData.usage }),
			modelRequestCount: requests.length,
			toolCallCount: tools.reduce((sum, tool) => sum + tool.callCount, 0),
			retryCount: retries.length,
			approvalCount: latestApprovals.size,
		},
	};
	return { ...unsigned, digest: trajectoryDigest(unsigned) };
}

export function trajectoryReport(operationId: string, events: readonly TrajectoryEvent[]): TrajectoryReport {
	const replay = replayTrajectory(operationId, events);
	return { replay, evaluation: evaluateTrajectory(replay) };
}

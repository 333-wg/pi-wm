import type { ModelRef, RunFailureKind, Usage } from "@wuming/protocol";

export type TrajectoryTerminalStatus = "completed" | "failed" | "interrupted";

export type TrajectoryEventData =
	| { type: "operation.accepted"; mode: "prompt" | "steer" | "follow_up" }
	| { type: "operation.started"; attempt: number; traceId?: string }
	| { type: "capability.resolved"; digest: string; capabilityCount: number }
	| {
			type: "context.resolved";
			digest: string;
			fragmentCount: number;
			estimatedSystemTokens: number;
			availableSystemTokens: number;
	  }
	| {
			type: "hook.executed";
			hookId: string;
			point: "operation.before_execute" | "operation.after_execute" | "operation.on_error";
			mode: "enforce" | "observe";
			outcome: "completed" | "denied" | "denial_ignored" | "failed" | "timed_out";
			durationMs: number;
			code?: string;
	  }
	| { type: "model.request"; requestId: string; model: ModelRef; usage: Usage }
	| {
			type: "tool.summary";
			toolName: string;
			callCount: number;
			durationMs?: number;
			succeededCount: number;
			failedCount: number;
			abortedCount: number;
	  }
	| {
			type: "approval.state";
			approvalId: string;
			toolCallId: string;
			mode: "preflight" | "failure_retry";
			state: "waiting" | "approved" | "executing" | "completed" | "interrupted" | "cancelled";
	  }
	| {
			type: "retry.scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			failureKind: RunFailureKind;
			errorDigest: string;
	  }
	| {
			type: "compaction.completed";
			memoryId: string;
			reason: "manual" | "threshold" | "overflow";
			memoryDigest: string;
			tokensBefore?: number;
			estimatedTokensAfter?: number;
			usage?: Usage;
	  }
	| {
			type: "operation.finished";
			status: TrajectoryTerminalStatus;
			failureKind?: RunFailureKind;
			usage?: Usage;
			durationMs?: number;
	  };

export interface TrajectoryEvent<TData extends TrajectoryEventData = TrajectoryEventData> {
	schemaVersion: 1;
	operationId: string;
	sequence: number;
	timestamp: number;
	previousDigest: string | null;
	digest: string;
	data: TData;
}

export interface TrajectoryReplay {
	operationId: string;
	integrity: boolean;
	eventCount: number;
	headDigest: string | null;
	invalidSequence?: number;
	events: TrajectoryEvent[];
}

export interface TrajectoryCriterion {
	id: "integrity" | "completion" | "reliability" | "policy" | "observability";
	status: "pass" | "warn" | "fail";
	score: number;
	weight: number;
	evidence: string;
}

export interface TrajectoryEvaluation {
	schemaVersion: 1;
	algorithm: "structural-v1";
	verdict: "pass" | "fail" | "incomplete";
	score: number;
	semanticCorrectness: "not_evaluated";
	criteria: TrajectoryCriterion[];
	metrics: {
		durationMs?: number;
		usage?: Usage;
		modelRequestCount: number;
		toolCallCount: number;
		retryCount: number;
		approvalCount: number;
	};
	digest: string;
}

export interface TrajectoryReport {
	replay: TrajectoryReplay;
	evaluation: TrajectoryEvaluation;
}

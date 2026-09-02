import type { ProgressEvent, RunFailureKind, SessionSnapshot, TranscriptItem, Usage, UsageRequestSummary, UsageToolSummary, UserContentPart } from "@wuming/protocol";

export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogger {
	log(level: StructuredLogLevel, event: string, fields?: Record<string, unknown>): void;
}

export type TurnMode = "prompt" | "steer" | "follow_up";

export interface TurnOperationPayload {
	type: "turn";
	mode: TurnMode;
	userItemId: string;
	content: UserContentPart[];
	skills?: string[];
}

export type OperationPayload = TurnOperationPayload;
export type OperationStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

export interface DurableOperation {
	id: string;
	sessionId: string;
	type: OperationPayload["type"];
	status: OperationStatus;
	payload: OperationPayload;
	attempt: number;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	finishedAt?: number;
	abortRequested: boolean;
	traceId?: string;
	retryAfter?: number;
	error?: string;
	usage?: Usage;
	tools?: UsageToolSummary[];
	failureKind?: RunFailureKind;
	retryHistory?: RuntimeRetryEvent[];
	approvalId?: string;
	approvalToolCallId?: string;
}

export interface DurableGoal {
	id: string;
	parentSessionId: string;
	title: string;
	objective: string;
	createdAt: number;
	updatedAt: number;
	runSessionId?: string;
	cancelledAt?: number;
}

export type ApprovalExecutionMode = "preflight" | "failure_retry";
export type ApprovalExecutionState = "waiting" | "approved" | "executing" | "completed" | "interrupted" | "cancelled";

export interface DurableApprovalExecution {
	approvalId: string;
	sessionId: string;
	operationId?: string;
	toolCallId: string;
	mode: ApprovalExecutionMode;
	state: ApprovalExecutionState;
	createdAt: number;
	updatedAt: number;
}

export interface RuntimeTurnResult {
	items: TranscriptItem[];
	usage?: Usage;
	tools?: UsageToolSummary[];
	requests?: UsageRequestSummary[];
	skills?: string[];
	failure?: {
		code: "runtime_error" | "cost_budget_exceeded";
		message: string;
		retryable?: boolean;
		kind?: RunFailureKind;
	};
}

export interface RuntimeRetryEvent {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	error: string;
	timestamp?: number;
}

export interface RuntimeCompactionResult {
	summary: string;
	usage?: Usage;
}

export interface AgentRuntime {
	executeTurn(input: {
		operation: DurableOperation & { payload: TurnOperationPayload };
		snapshot: SessionSnapshot;
		signal: AbortSignal;
		onProgress: (event: ProgressEvent) => void;
		onRetry?: (event: RuntimeRetryEvent) => void;
		costBudgetUsd?: number;
		tokenBudget?: number;
	}): Promise<RuntimeTurnResult>;
	compact?(input: {
		snapshot: SessionSnapshot;
		signal: AbortSignal;
		instructions?: string;
	}): Promise<RuntimeCompactionResult>;
	injectTurn?(input: {
		operation: DurableOperation & { payload: TurnOperationPayload };
		snapshot: SessionSnapshot;
		signal: AbortSignal;
	}): Promise<void>;
	forceTerminate?(sessionId: string): Promise<void>;
}

export interface WriterLease {
	sessionId: string;
	ownerId: string;
	fence: number;
	expiresAt: number;
}

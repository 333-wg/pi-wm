import type { CapabilityPlan } from "@wuming/capability-kernel";
import type { ContextPlan } from "@wuming/context-engine";
import type {
	AutomationSchedule,
	ContextUsageState,
	GoalExecutionMode,
	GoalPlanFailurePolicy,
	GoalPlanPhase,
	GoalPlanSpec,
	GoalReviewPhase,
	GoalReviewRecord,
	MemorySummary,
	ProgressEvent,
	RunFailureKind,
	SessionSnapshot,
	TranscriptItem,
	Usage,
	UsageRequestSummary,
	UsageToolSummary,
	UserContentPart,
} from "@wuming/protocol";

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
	/**
	 * Optional provider-facing prompt for internal orchestration. The visible
	 * transcript always uses `content`; this field is never rendered as a user
	 * message.
	 */
	runtimeContent?: UserContentPart[];
	skills?: string[];
	goalId?: string;
	/**
	 * Set on a subagent turn whose result is handed back to the parent model as a
	 * tool result rather than appended to the parent transcript by the durable
	 * publish path. The parent still absorbs the child's usage, but only once the
	 * parent turn is no longer running: folding it in mid-turn would race the
	 * parent's own cumulative usage and lose one of the two.
	 */
	deliverInline?: boolean;
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
	capabilityPlan?: CapabilityPlan;
	contextPlan?: ContextPlan;
}

export interface DurableGoalReview {
	successCriteria: string;
	maxRounds: number;
	round: number;
	phase: GoalReviewPhase;
	runs: Array<{ round: number; workerSessionId: string; reviewerSessionId?: string }>;
	history: GoalReviewRecord[];
	failure?: string;
}

export interface DurableGoalPlanStep {
	id: string;
	title: string;
	objective: string;
	dependsOn: string[];
	goalId?: string;
	skippedAt?: number;
	skipReason?: string;
	successCriteria?: string;
	maxRounds?: number;
	costBudgetUsd?: number;
	tokenBudget?: number;
}

export interface DurableGoalPlan {
	phase: GoalPlanPhase;
	maxParallel: number;
	failurePolicy: GoalPlanFailurePolicy;
	steps: DurableGoalPlanStep[];
}

export interface DurableGoal {
	id: string;
	parentSessionId: string;
	title: string;
	objective: string;
	skillId?: string;
	executionMode?: GoalExecutionMode;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	runSessionId?: string;
	operationId?: string;
	cancelledAt?: number;
	pausedAt?: number;
	accumulatedRunMs?: number;
	review?: DurableGoalReview;
	plan?: DurableGoalPlan;
	ownerGoalId?: string;
	planStepId?: string;
}

export interface DurableGoalAutomation {
	id: string;
	parentSessionId: string;
	title: string;
	objective: string;
	schedule: AutomationSchedule;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
	nextRunAt?: number;
	lastRunAt?: number;
	successCriteria?: string;
	maxRounds?: number;
	plan?: GoalPlanSpec;
}

export interface DurableAutomationRun {
	id: string;
	automationId: string;
	parentSessionId: string;
	trigger: "schedule" | "manual";
	triggerKey: string;
	scheduledFor: number;
	triggeredAt: number;
	updatedAt: number;
	spec: {
		title: string;
		objective: string;
		successCriteria?: string;
		maxRounds?: number;
		plan?: GoalPlanSpec;
	};
	goalId?: string;
	dispatchError?: string;
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
	compactions?: RuntimeCompactionRecord[];
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
	tokensBefore?: number;
	estimatedTokensAfter?: number;
}

export interface RuntimeCompactionRecord extends RuntimeCompactionResult {
	reason: "threshold" | "overflow";
}

export type DurableMemory = MemorySummary;

export interface AgentRuntime {
	resolveCapabilities?(input: {
		operation: DurableOperation & { payload: TurnOperationPayload };
		snapshot: SessionSnapshot;
		signal: AbortSignal;
	}): Promise<CapabilityPlan>;
	resolveContext?(input: {
		operation: DurableOperation & { payload: TurnOperationPayload };
		snapshot: SessionSnapshot;
		signal: AbortSignal;
		onProgress?: ((event: ProgressEvent) => void) | undefined;
		capabilityPlan?: CapabilityPlan;
	}): Promise<ContextPlan>;
	executeTurn(input: {
		operation: DurableOperation & { payload: TurnOperationPayload };
		snapshot: SessionSnapshot;
		signal: AbortSignal;
		onProgress: (event: ProgressEvent) => void;
		onContextUsage?: (usage: ContextUsageState) => void;
		onRetry?: (event: RuntimeRetryEvent) => void;
		costBudgetUsd?: number;
		tokenBudget?: number;
		capabilityPlan?: CapabilityPlan;
		contextPlan?: ContextPlan;
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
		capabilityPlan?: CapabilityPlan;
		contextPlan?: ContextPlan;
	}): Promise<void>;
	forceTerminate?(sessionId: string): Promise<void>;
}

export interface WriterLease {
	sessionId: string;
	ownerId: string;
	fence: number;
	expiresAt: number;
}

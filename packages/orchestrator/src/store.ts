import { type SessionEvent, SessionEventSchema } from "@wuming/domain";
import { verifyCapabilityPlan, type CapabilityPlan, type HookAuditRecord } from "@wuming/capability-kernel";
import { verifyContextPlan, type ContextPlan } from "@wuming/context-engine";
import {
	type CommandResult,
	CommandResultSchema,
	AutomationScheduleSchema,
	ScheduledTaskConfigSchema,
	nextCalendarRun,
	validateCalendarSchedule,
	GoalPlanSpecSchema,
	type GoalPlanSpec,
	type MemoryAction,
	type MemoryRecord,
	type MemorySearchMatch,
	type MemorySummary,
	MemorySummarySchema,
	type SessionSnapshot,
	SessionSnapshotSchema,
	type Usage,
	type UsageOverview,
	type UsageRequestSummary,
} from "@wuming/protocol";
import {
	createTrajectoryEvent,
	trajectoryDigest,
	trajectoryReport,
	type TrajectoryEvent,
	type TrajectoryEventData,
	type TrajectoryReport,
} from "@wuming/trajectory";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { OrchestratorError } from "./errors.js";
import { searchMemoryRecords, verifyDurableMemory } from "./memory.js";
import { SessionSearchIndex, type SessionSearchOptions } from "./session-search.js";
import type {
	ApprovalExecutionMode,
	ApprovalExecutionState,
	DurableApprovalExecution,
	DurableAutomationRun,
	DurableGoal,
	DurableGoalAutomation,
	DurableOperation,
	OperationPayload,
	OperationStatus,
	WriterLease,
} from "./types.js";

const checkEvent = Compile(SessionEventSchema);
const checkSnapshot = Compile(SessionSnapshotSchema);
const checkCommandResult = Compile(CommandResultSchema);
const GoalReviewStateSchema = Type.Object(
	{
		successCriteria: Type.String({ minLength: 1, maxLength: 4000 }),
		maxRounds: Type.Integer({ minimum: 1, maximum: 5 }),
		round: Type.Integer({ minimum: 0, maximum: 5 }),
		phase: Type.Union([
			Type.Literal("pending"),
			Type.Literal("executing"),
			Type.Literal("reviewing"),
			Type.Literal("passed"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
		]),
		runs: Type.Array(
			Type.Object(
				{
					round: Type.Integer({ minimum: 1, maximum: 5 }),
					workerSessionId: Type.String({ minLength: 1, maxLength: 200 }),
					reviewerSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
				},
				{ additionalProperties: false }
			),
			{ maxItems: 5 }
		),
		history: Type.Array(
			Type.Object(
				{
					round: Type.Integer({ minimum: 1, maximum: 5 }),
					verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
					feedback: Type.String({ maxLength: 4000 }),
					checks: Type.Optional(
						Type.Array(
							Type.Object(
								{
									criterion: Type.String({ minLength: 1, maxLength: 500 }),
									status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
									evidence: Type.String({ minLength: 1, maxLength: 2000 }),
								},
								{ additionalProperties: false }
							),
							{ minItems: 1, maxItems: 20 }
						)
					),
					toolsUsed: Type.Optional(
						Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
							maxItems: 50,
							uniqueItems: true,
						})
					),
					reviewedAt: Type.Integer({ minimum: 0 }),
				},
				{ additionalProperties: false }
			),
			{ maxItems: 5 }
		),
		failure: Type.Optional(Type.String({ maxLength: 4000 })),
	},
	{ additionalProperties: false }
);
const checkGoalReview = Compile(GoalReviewStateSchema);
const GoalPlanStateSchema = Type.Object(
	{
		phase: Type.Union([
			Type.Literal("pending"),
			Type.Literal("running"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
		]),
		maxParallel: Type.Integer({ minimum: 1, maximum: 4 }),
		failurePolicy: Type.Union([Type.Literal("fail_fast"), Type.Literal("continue_independent")]),
		steps: Type.Array(
			Type.Object(
				{
					id: Type.String({ minLength: 1, maxLength: 200 }),
					title: Type.String({ minLength: 1, maxLength: 500 }),
					objective: Type.String({ minLength: 1, maxLength: 20_000 }),
					dependsOn: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
						maxItems: 20,
						uniqueItems: true,
					}),
					goalId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
					skippedAt: Type.Optional(Type.Integer({ minimum: 0 })),
					skipReason: Type.Optional(Type.String({ maxLength: 1000 })),
					successCriteria: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
					maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
					costBudgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
					tokenBudget: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })),
				},
				{ additionalProperties: false }
			),
			{ minItems: 1, maxItems: 20 }
		),
	},
	{ additionalProperties: false }
);
const checkGoalPlan = Compile(GoalPlanStateSchema);
const checkAutomationSchedule = Compile(AutomationScheduleSchema);
const checkScheduledTaskConfig = Compile(ScheduledTaskConfigSchema);
const checkGoalPlanSpec = Compile(GoalPlanSpecSchema);
const checkAutomationSpec = Compile(
	Type.Object(
		{
			execution: Type.Optional(ScheduledTaskConfigSchema),
			title: Type.String({ minLength: 1, maxLength: 500 }),
			objective: Type.String({ minLength: 1, maxLength: 20_000 }),
			successCriteria: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
			maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
			plan: Type.Optional(GoalPlanSpecSchema),
		},
		{ additionalProperties: false }
	)
);
const checkMemory = Compile(MemorySummarySchema);

interface MutationIdempotency {
	principalId: string;
	key: string;
	commandHash: string;
	result: CommandResult;
	expiresAt: number;
}

export interface CommitMutationOptions {
	sessionId: string;
	expectedRevision: number;
	events: SessionEvent[];
	snapshot: SessionSnapshot;
	idempotency?: MutationIdempotency;
	operation?: DurableOperation;
	interruptRunningOperation?: string;
	attachGoalRun?: {
		goalId: string;
		parentSessionId: string;
		runSessionId: string;
		expectedRunSessionId?: string;
		expectedUpdatedAt: number;
		updatedAt: number;
		review?: DurableGoal["review"];
	};
	attachGoalOperation?: {
		goalId: string;
		parentSessionId: string;
		operationId: string;
		expectedUpdatedAt: number;
		updatedAt: number;
		startedAt: number;
		review?: DurableGoal["review"];
	};
	settleOperation?: {
		id: string;
		status: "completed" | "failed" | "interrupted";
		error?: string;
		usage?: DurableOperation["usage"];
		tools?: DurableOperation["tools"];
		trajectoryTools?: DurableOperation["tools"];
		requests?: UsageRequestSummary[];
		failureKind?: DurableOperation["failureKind"];
		retryHistory?: DurableOperation["retryHistory"];
	};
	retryOperation?: {
		id: string;
		error: string;
		retryAfter: number;
		retryHistory: NonNullable<DurableOperation["retryHistory"]>;
		usage?: DurableOperation["usage"];
		tools?: DurableOperation["tools"];
		trajectoryTools?: DurableOperation["tools"];
		requests?: UsageRequestSummary[];
		failureKind?: DurableOperation["failureKind"];
	};
	memories?: MemorySummary[];
	approvalExecution?: DurableApprovalExecution;
	settleApprovalExecution?: { approvalId: string; state: "approved" | "cancelled" };
	lease?: WriterLease;
}

interface SessionRow {
	snapshot_json: string;
	revision: number;
}

interface IdempotencyRow {
	command_hash: string;
	result_json: string;
	expires_at: number;
}

interface OperationRow {
	operation_id: string;
	session_id: string;
	type: OperationPayload["type"];
	status: OperationStatus;
	payload_json: string;
	attempt: number;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	finished_at: number | null;
	abort_requested: number;
	trace_id: string | null;
	error: string | null;
	retry_after: number | null;
	usage_json: string | null;
	tools_json: string | null;
	failure_kind: NonNullable<DurableOperation["failureKind"]> | null;
	retry_history_json: string | null;
	approval_id: string | null;
	approval_tool_call_id: string | null;
	capability_plan_json: string | null;
	context_plan_json: string | null;
}

interface ApprovalExecutionRow {
	approval_id: string;
	session_id: string;
	operation_id: string | null;
	tool_call_id: string;
	mode: ApprovalExecutionMode;
	state: ApprovalExecutionState;
	created_at: number;
	updated_at: number;
}

interface TrajectoryRow {
	sequence: number;
	event_json: string;
	event_digest: string;
	previous_digest: string | null;
}

interface MemoryRow {
	memory_json: string;
	memory_digest: string;
}

interface MemoryRecordRow extends MemoryRow {
	status: MemoryRecord["status"];
	retained: number;
	updated_at: number;
	superseded_by: string | null;
}

export interface ManageMemoryOptions {
	principalId: string;
	idempotencyKey: string;
	commandHash: string;
	sessionId: string;
	memoryId: string;
	action: MemoryAction;
	now: number;
	expiresAt: number;
}

export interface MemoryLifecycleEvent {
	sequence: number;
	memoryId: string;
	sessionId: string;
	action: "created" | "auto_superseded" | MemoryAction;
	actorId: string;
	relatedMemoryId?: string;
	createdAt: number;
}

interface GoalRow {
	goal_id: string;
	parent_session_id: string;
	title: string;
	objective: string;
	skill_id: string | null;
	execution_mode: "session" | "subagent" | null;
	run_session_id: string | null;
	operation_id: string | null;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	cancelled_at: number | null;
	paused_at: number | null;
	accumulated_run_ms: number | null;
	review_json: string | null;
	plan_json: string | null;
	owner_goal_id: string | null;
	plan_step_id: string | null;
}

interface AutomationRow {
	execution_json: string | null;
	automation_id: string;
	parent_session_id: string;
	title: string;
	objective: string;
	schedule_json: string;
	enabled: number;
	created_at: number;
	updated_at: number;
	next_run_at: number | null;
	last_run_at: number | null;
	success_criteria: string | null;
	max_rounds: number | null;
	plan_json: string | null;
}

interface AutomationRunRow {
	run_id: string;
	automation_id: string;
	parent_session_id: string;
	trigger: DurableAutomationRun["trigger"];
	trigger_key: string;
	scheduled_for: number;
	triggered_at: number;
	updated_at: number;
	spec_json: string;
	goal_id: string | null;
	dispatch_error: string | null;
}

export interface CommitGoalMutationOptions {
	goal: DurableGoal;
	expectedUpdatedAt?: number;
	idempotency: MutationIdempotency;
}

export interface DeleteGoalOptions {
	goalId: string;
	parentSessionId: string;
	expectedUpdatedAt: number;
	now: number;
	idempotency: MutationIdempotency;
}

export interface AttachPlanStepGoalOptions {
	parentGoal: DurableGoal;
	expectedUpdatedAt: number;
	childGoal: DurableGoal;
	verifyBudgetReservation: () => void;
}

export interface DeleteAutomationOptions {
	automationId: string;
	parentSessionId: string;
	expectedUpdatedAt: number;
	now: number;
	isRunFinished: (run: DurableAutomationRun) => boolean;
	idempotency: MutationIdempotency;
}

export interface CommitAutomationMutationOptions {
	automation: DurableGoalAutomation;
	expectedUpdatedAt?: number;
	requireUnarchived?: boolean;
	idempotency: MutationIdempotency;
}

export interface ClaimAutomationRunOptions {
	isRunFinished?: (run: DurableAutomationRun) => boolean;
	automationId: string;
	runId: string;
	trigger: "schedule" | "manual";
	triggerKey: string;
	scheduledFor: number;
	now: number;
	idempotency?: MutationIdempotency;
}

export interface RequestOperationAbortOptions {
	principalId: string;
	idempotencyKey: string;
	commandHash: string;
	sessionId: string;
	result: CommandResult;
	now: number;
	expiresAt: number;
}

interface LeaseRow {
	session_id: string;
	owner_id: string;
	fence: number;
	expires_at: number;
}

export interface StoredSessionEvent {
	cursor: string;
	event: SessionEvent;
}

export interface ListSnapshotsOptions {
	query?: string;
	archived?: boolean;
	limit?: number;
	excludeSessionIds?: readonly string[];
}

const EMPTY_USAGE: Usage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
};

function addUsage(left: Usage, right: Usage): Usage {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
		cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
		totalTokens: left.totalTokens + right.totalTokens,
		costUsd: left.costUsd + right.costUsd,
	};
}

function localDateKey(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseChecked<T>(json: string, check: { Check(value: unknown): boolean }, label: string): T {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new OrchestratorError("corrupt_storage", `${label} contains invalid JSON`);
	}

	if (!check.Check(value)) throw new OrchestratorError("corrupt_storage", `${label} does not match its schema`);
	return value as T;
}

function mapOperation(row: OperationRow): DurableOperation {
	const capabilityPlan =
		row.capability_plan_json === null ? undefined : (JSON.parse(row.capability_plan_json) as CapabilityPlan);
	if (capabilityPlan && !verifyCapabilityPlan(capabilityPlan))
		throw new Error(`Operation ${row.operation_id} has an invalid capability plan`);
	const contextPlan = row.context_plan_json === null ? undefined : (JSON.parse(row.context_plan_json) as ContextPlan);
	if (contextPlan && !verifyContextPlan(contextPlan))
		throw new Error(`Operation ${row.operation_id} has an invalid context plan`);
	return {
		id: row.operation_id,
		sessionId: row.session_id,
		type: row.type,
		status: row.status,
		payload: JSON.parse(row.payload_json) as OperationPayload,
		attempt: row.attempt,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.started_at === null ? {} : { startedAt: row.started_at }),
		...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
		abortRequested: row.abort_requested !== 0,
		...(row.trace_id === null ? {} : { traceId: row.trace_id }),
		...(row.retry_after === null ? {} : { retryAfter: row.retry_after }),
		...(row.error === null ? {} : { error: row.error }),
		...(row.usage_json === null ? {} : { usage: JSON.parse(row.usage_json) as NonNullable<DurableOperation["usage"]> }),
		...(row.tools_json === null ? {} : { tools: JSON.parse(row.tools_json) as NonNullable<DurableOperation["tools"]> }),
		...(row.failure_kind === null ? {} : { failureKind: row.failure_kind }),
		...(row.retry_history_json === null
			? {}
			: {
					retryHistory: JSON.parse(row.retry_history_json) as NonNullable<DurableOperation["retryHistory"]>,
				}),
		...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
		...(row.approval_tool_call_id === null ? {} : { approvalToolCallId: row.approval_tool_call_id }),
		...(capabilityPlan ? { capabilityPlan } : {}),
		...(contextPlan ? { contextPlan } : {}),
	};
}

function mapApprovalExecution(row: ApprovalExecutionRow): DurableApprovalExecution {
	return {
		approvalId: row.approval_id,
		sessionId: row.session_id,
		...(row.operation_id === null ? {} : { operationId: row.operation_id }),
		toolCallId: row.tool_call_id,
		mode: row.mode,
		state: row.state,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapGoal(row: GoalRow): DurableGoal {
	const goal: DurableGoal = {
		id: row.goal_id,
		parentSessionId: row.parent_session_id,
		title: row.title,
		objective: row.objective,
		...(row.skill_id === null ? {} : { skillId: row.skill_id }),
		...(row.execution_mode === null ? {} : { executionMode: row.execution_mode }),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.started_at === null ? {} : { startedAt: row.started_at }),
		...(row.run_session_id === null ? {} : { runSessionId: row.run_session_id }),
		...(row.operation_id === null ? {} : { operationId: row.operation_id }),
		...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
		...(row.paused_at === null ? {} : { pausedAt: row.paused_at }),
		...(row.accumulated_run_ms === null ? {} : { accumulatedRunMs: row.accumulated_run_ms }),
		...(row.review_json === null
			? {}
			: {
					review: parseChecked<NonNullable<DurableGoal["review"]>>(
						row.review_json,
						checkGoalReview,
						`Goal review ${row.goal_id}`
					),
				}),
		...(row.plan_json === null
			? {}
			: {
					plan: parseChecked<NonNullable<DurableGoal["plan"]>>(
						row.plan_json,
						checkGoalPlan,
						`Goal plan ${row.goal_id}`
					),
				}),
		...(row.owner_goal_id === null ? {} : { ownerGoalId: row.owner_goal_id }),
		...(row.plan_step_id === null ? {} : { planStepId: row.plan_step_id }),
	};
	if (goal.plan) assertPlanGraph(goal.plan, "corrupt_storage");
	assertGoal(goal);
	return goal;
}

function mapAutomation(row: AutomationRow): DurableGoalAutomation {
	const automation: DurableGoalAutomation = {
		id: row.automation_id,
		parentSessionId: row.parent_session_id,
		title: row.title,
		objective: row.objective,
		schedule: parseChecked<DurableGoalAutomation["schedule"]>(
			row.schedule_json,
			checkAutomationSchedule,
			`Automation schedule ${row.automation_id}`
		),
		enabled: row.enabled !== 0,
		...(row.execution_json == null
			? {}
			: {
					execution: parseChecked<NonNullable<DurableGoalAutomation["execution"]>>(
						row.execution_json,
						checkScheduledTaskConfig,
						"Scheduled task execution"
					),
				}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
		...(row.last_run_at === null ? {} : { lastRunAt: row.last_run_at }),
		...(row.success_criteria === null ? {} : { successCriteria: row.success_criteria }),
		...(row.max_rounds === null ? {} : { maxRounds: row.max_rounds }),
		...(row.plan_json === null
			? {}
			: {
					plan: parseChecked<NonNullable<DurableGoalAutomation["plan"]>>(
						row.plan_json,
						checkGoalPlanSpec,
						`Automation plan ${row.automation_id}`
					),
				}),
	};
	if (automation.plan) assertPlanGraph(automation.plan, "corrupt_storage");
	try {
		assertAutomation(automation);
	} catch (error) {
		throw new OrchestratorError("corrupt_storage", error instanceof Error ? error.message : String(error));
	}
	return automation;
}

function mapAutomationRun(row: AutomationRunRow): DurableAutomationRun {
	const run: DurableAutomationRun = {
		id: row.run_id,
		automationId: row.automation_id,
		parentSessionId: row.parent_session_id,
		trigger: row.trigger,
		triggerKey: row.trigger_key,
		scheduledFor: row.scheduled_for,
		triggeredAt: row.triggered_at,
		updatedAt: row.updated_at,
		spec: parseChecked<DurableAutomationRun["spec"]>(
			row.spec_json,
			checkAutomationSpec,
			`Automation run spec ${row.run_id}`
		),
		...(row.goal_id === null ? {} : { goalId: row.goal_id }),
		...(row.dispatch_error === null ? {} : { dispatchError: row.dispatch_error }),
	};
	if (run.spec.plan) assertPlanGraph(run.spec.plan, "corrupt_storage");
	return run;
}

const AUTOMATION_COLUMNS =
	"automation_id, parent_session_id, title, objective, schedule_json, enabled, created_at, updated_at, next_run_at, last_run_at, success_criteria, max_rounds, plan_json, execution_json";
const AUTOMATION_RUN_COLUMNS =
	"run_id, automation_id, parent_session_id, trigger, trigger_key, scheduled_for, triggered_at, updated_at, spec_json, goal_id, dispatch_error";
const GOAL_COLUMNS =
	"goal_id, parent_session_id, title, objective, skill_id, execution_mode, run_session_id, operation_id, created_at, updated_at, started_at, cancelled_at, paused_at, accumulated_run_ms, review_json, plan_json, owner_goal_id, plan_step_id";

function assertPlanGraph(plan: Pick<GoalPlanSpec, "steps">, code: "conflict" | "corrupt_storage" = "conflict"): void {
	const steps = new Map(plan.steps.map((step) => [step.id, step]));
	const fail = (reason: string): never => {
		throw new OrchestratorError(code, "Invalid Goal plan: " + reason);
	};
	if (steps.size !== plan.steps.length) fail("duplicate step IDs");
	for (const step of plan.steps) {
		if (!step.id.trim() || !step.title.trim() || !step.objective.trim()) fail("empty step fields");
		if (new Set(step.dependsOn).size !== step.dependsOn.length) fail("duplicate dependencies");
		if (step.dependsOn.some((id) => !steps.has(id))) fail("unknown dependency");
		if (step.maxRounds !== undefined && !step.successCriteria?.trim()) fail("review rounds without criteria");
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) fail("dependency cycle");
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of steps.get(id)!.dependsOn) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of steps.keys()) visit(id);
}

function assertGoal(goal: DurableGoal): void {
	if (!goal.id || !goal.parentSessionId || !goal.title.trim() || !goal.objective.trim())
		throw new OrchestratorError("conflict", "Goal contains empty required fields");
	if (goal.review && !checkGoalReview.Check(goal.review))
		throw new OrchestratorError("conflict", `Goal ${goal.id} contains invalid review state`);
	if (goal.plan && !checkGoalPlan.Check(goal.plan))
		throw new OrchestratorError("conflict", `Goal ${goal.id} contains invalid plan state`);
	if (goal.plan) assertPlanGraph(goal.plan);
	if (goal.review && goal.plan)
		throw new OrchestratorError("conflict", `Goal ${goal.id} cannot have both a review loop and a plan`);
	if ((goal.ownerGoalId === undefined) !== (goal.planStepId === undefined))
		throw new OrchestratorError("conflict", `Goal ${goal.id} has an incomplete plan-step owner`);
	if (goal.plan && goal.ownerGoalId !== undefined)
		throw new OrchestratorError("conflict", `Nested plan goal ${goal.id} is not supported`);
}

function assertAutomation(automation: DurableGoalAutomation): void {
	if (automation.execution && !checkScheduledTaskConfig.Check(automation.execution))
		throw new OrchestratorError("conflict", "Invalid scheduled task execution configuration");
	if (!automation.id || !automation.parentSessionId || !automation.title.trim() || !automation.objective.trim()) {
		throw new OrchestratorError("conflict", "Automation contains empty required fields");
	}
	if (!checkAutomationSchedule.Check(automation.schedule))
		throw new OrchestratorError("conflict", `Automation ${automation.id} has an invalid schedule`);
	if (automation.schedule.kind === "calendar") {
		try {
			validateCalendarSchedule(automation.schedule);
		} catch (error) {
			throw new OrchestratorError("conflict", error instanceof Error ? error.message : String(error));
		}
	}
	if ((automation.successCriteria === undefined) !== (automation.maxRounds === undefined)) {
		throw new OrchestratorError("conflict", `Automation ${automation.id} review configuration is incomplete`);
	}
	if (automation.plan && !checkGoalPlanSpec.Check(automation.plan))
		throw new OrchestratorError("conflict", `Automation ${automation.id} has an invalid Goal plan`);
	if (automation.plan) assertPlanGraph(automation.plan);
	if (automation.plan && automation.successCriteria !== undefined)
		throw new OrchestratorError(
			"conflict",
			`Automation ${automation.id} cannot combine a plan with a top-level review loop`
		);
	if (
		automation.successCriteria !== undefined &&
		(!automation.successCriteria.trim() || automation.successCriteria.length > 4000)
	) {
		throw new OrchestratorError("conflict", `Automation ${automation.id} has invalid success criteria`);
	}
	if (
		automation.maxRounds !== undefined &&
		(!Number.isInteger(automation.maxRounds) || automation.maxRounds < 1 || automation.maxRounds > 5)
	) {
		throw new OrchestratorError("conflict", `Automation ${automation.id} has invalid review rounds`);
	}
}

function automationSpec(automation: DurableGoalAutomation): DurableAutomationRun["spec"] {
	return {
		...(automation.execution ? { execution: automation.execution } : {}),
		title: automation.title,
		objective: automation.objective,
		...(automation.successCriteria === undefined ? {} : { successCriteria: automation.successCriteria }),
		...(automation.maxRounds === undefined ? {} : { maxRounds: automation.maxRounds }),
		...(automation.plan === undefined ? {} : { plan: automation.plan }),
	};
}

function nextIntervalRun(
	schedule: Extract<DurableGoalAutomation["schedule"], { kind: "interval" }>,
	scheduledFor: number,
	now: number
): number {
	const intervalMs = schedule.everyMinutes * 60_000;
	const steps = Math.max(1, Math.floor((now - scheduledFor) / intervalMs) + 1);
	return scheduledFor + steps * intervalMs;
}

export class SqliteOrchestratorStore implements Disposable {
	readonly #db: DatabaseSync;
	readonly #search: SessionSearchIndex;
	readonly #eventListeners = new Set<(event: StoredSessionEvent) => void>();

	constructor(path: string) {
		this.#db = new DatabaseSync(path);
		this.#db.exec("PRAGMA foreign_keys = ON");
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS session_snapshots (
				session_id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL,
				name TEXT,
				archived_at INTEGER,
				parent_session_id TEXT,
				revision INTEGER NOT NULL,
				snapshot_json TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_events (
				global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				event_id TEXT NOT NULL UNIQUE,
				event_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE (session_id, revision),
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS goals (
				goal_id TEXT PRIMARY KEY,
				parent_session_id TEXT NOT NULL,
				title TEXT NOT NULL,
				objective TEXT NOT NULL,
				skill_id TEXT,
				execution_mode TEXT CHECK (execution_mode IS NULL OR execution_mode IN ('session', 'subagent')),
				run_session_id TEXT UNIQUE,
				operation_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				started_at INTEGER,
				cancelled_at INTEGER,
				review_json TEXT,
				plan_json TEXT,
				owner_goal_id TEXT,
				plan_step_id TEXT,
				FOREIGN KEY (parent_session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE,
				FOREIGN KEY (run_session_id) REFERENCES session_snapshots(session_id) ON DELETE SET NULL,
				FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE SET NULL,
				FOREIGN KEY (owner_goal_id) REFERENCES goals(goal_id) ON DELETE CASCADE,
				UNIQUE (owner_goal_id, plan_step_id)
			);
			CREATE INDEX IF NOT EXISTS goals_parent ON goals(parent_session_id, updated_at DESC);
			CREATE TABLE IF NOT EXISTS goal_automations (
				automation_id TEXT PRIMARY KEY,
				parent_session_id TEXT NOT NULL,
				title TEXT NOT NULL,
				objective TEXT NOT NULL,
				schedule_json TEXT NOT NULL,
				enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				next_run_at INTEGER,
				last_run_at INTEGER,
				success_criteria TEXT,
				max_rounds INTEGER,
				plan_json TEXT,
				FOREIGN KEY (parent_session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS goal_automations_parent ON goal_automations(parent_session_id, updated_at DESC, automation_id DESC);
			CREATE INDEX IF NOT EXISTS goal_automations_due ON goal_automations(enabled, next_run_at, automation_id);
			CREATE TABLE IF NOT EXISTS automation_runs (
				run_id TEXT PRIMARY KEY,
				automation_id TEXT NOT NULL,
				parent_session_id TEXT NOT NULL,
				trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
				trigger_key TEXT NOT NULL,
				scheduled_for INTEGER NOT NULL,
				triggered_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				spec_json TEXT NOT NULL,
				goal_id TEXT UNIQUE,
				dispatch_error TEXT,
				UNIQUE (automation_id, trigger_key),
				FOREIGN KEY (automation_id) REFERENCES goal_automations(automation_id) ON DELETE CASCADE,
				FOREIGN KEY (parent_session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE,
				FOREIGN KEY (goal_id) REFERENCES goals(goal_id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS automation_runs_automation ON automation_runs(automation_id, triggered_at DESC, run_id DESC);
			CREATE INDEX IF NOT EXISTS automation_runs_recovery ON automation_runs(dispatch_error, updated_at, run_id);
			CREATE TABLE IF NOT EXISTS idempotency_results (
				principal_id TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				command_hash TEXT NOT NULL,
				result_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				PRIMARY KEY (principal_id, idempotency_key)
			);
			CREATE TABLE IF NOT EXISTS operations (
				operation_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				type TEXT NOT NULL,
				status TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				abort_requested INTEGER NOT NULL DEFAULT 0,
				trace_id TEXT,
				error TEXT,
				retry_after INTEGER,
				usage_json TEXT,
				tools_json TEXT,
				failure_kind TEXT,
				retry_history_json TEXT,
				approval_id TEXT,
				approval_tool_call_id TEXT,
				capability_plan_json TEXT,
				context_plan_json TEXT,
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS operations_queue ON operations(session_id, status, created_at);
			CREATE TABLE IF NOT EXISTS operation_hook_events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				operation_id TEXT NOT NULL,
				event_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS operation_hook_events_operation ON operation_hook_events(operation_id, sequence);
			CREATE TABLE IF NOT EXISTS operation_trajectory_events (
				operation_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				event_json TEXT NOT NULL,
				event_digest TEXT NOT NULL,
				previous_digest TEXT,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (operation_id, sequence),
				UNIQUE (event_digest),
				FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS operation_trajectory_events_operation ON operation_trajectory_events(operation_id, sequence);
			CREATE TABLE IF NOT EXISTS session_memories (
				memory_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				operation_id TEXT,
				memory_json TEXT NOT NULL,
				memory_digest TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE,
				FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS session_memories_session ON session_memories(session_id, created_at DESC, memory_id DESC);
			CREATE INDEX IF NOT EXISTS session_memories_operation ON session_memories(operation_id, created_at, memory_id);
			CREATE TABLE IF NOT EXISTS session_memory_state (
				memory_id TEXT PRIMARY KEY,
				status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'forgotten')),
				retained INTEGER NOT NULL DEFAULT 0 CHECK (retained IN (0, 1)),
				superseded_by TEXT,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (memory_id) REFERENCES session_memories(memory_id) ON DELETE CASCADE,
				FOREIGN KEY (superseded_by) REFERENCES session_memories(memory_id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS session_memory_state_active ON session_memory_state(status, retained, updated_at DESC);
			CREATE TABLE IF NOT EXISTS session_memory_lifecycle_events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				memory_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				action TEXT NOT NULL CHECK (action IN ('created', 'auto_superseded', 'promote', 'release', 'forget')),
				actor_id TEXT NOT NULL,
				related_memory_id TEXT,
				related_memory_key TEXT,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (memory_id) REFERENCES session_memories(memory_id) ON DELETE CASCADE,
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE,
				FOREIGN KEY (related_memory_id) REFERENCES session_memories(memory_id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS session_memory_lifecycle_memory ON session_memory_lifecycle_events(memory_id, sequence);
			CREATE TABLE IF NOT EXISTS session_memory_tombstones (
				memory_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				operation_id TEXT,
				memory_digest TEXT NOT NULL,
				reason TEXT NOT NULL,
				source_revision INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				forgotten_at INTEGER NOT NULL,
				actor_id TEXT NOT NULL,
				lifecycle_json TEXT NOT NULL,
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE,
				FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS session_memory_tombstones_operation ON session_memory_tombstones(operation_id, created_at);
			CREATE TABLE IF NOT EXISTS approval_executions (
				approval_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				operation_id TEXT,
				tool_call_id TEXT NOT NULL,
				mode TEXT NOT NULL,
				state TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE,
				FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS approval_executions_tool ON approval_executions(session_id, tool_call_id, state, created_at DESC);
			CREATE TABLE IF NOT EXISTS writer_leases (
				session_id TEXT PRIMARY KEY,
				owner_id TEXT NOT NULL,
				fence INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE
			);
		`);
		this.#db.exec(`
			INSERT OR IGNORE INTO session_memory_state(memory_id, status, retained, superseded_by, updated_at)
			SELECT memory_id, 'active', 0, NULL, created_at FROM session_memories;
		`);
		const memoryLifecycleColumns = this.#db
			.prepare("PRAGMA table_info(session_memory_lifecycle_events)")
			.all() as unknown as Array<{ name: string }>;
		if (!memoryLifecycleColumns.some((column) => column.name === "related_memory_key")) {
			this.#db.exec("ALTER TABLE session_memory_lifecycle_events ADD COLUMN related_memory_key TEXT");
		}
		this.#db.exec(
			"UPDATE session_memory_lifecycle_events SET related_memory_key = related_memory_id WHERE related_memory_key IS NULL AND related_memory_id IS NOT NULL"
		);
		const sessionColumns = this.#db.prepare("PRAGMA table_info(session_snapshots)").all() as unknown as Array<{
			name: string;
		}>;
		let backfillSessionIndex = false;
		if (!sessionColumns.some((column) => column.name === "name")) {
			this.#db.exec("ALTER TABLE session_snapshots ADD COLUMN name TEXT");
			backfillSessionIndex = true;
		}
		if (!sessionColumns.some((column) => column.name === "archived_at")) {
			this.#db.exec("ALTER TABLE session_snapshots ADD COLUMN archived_at INTEGER");
			backfillSessionIndex = true;
		}
		if (!sessionColumns.some((column) => column.name === "parent_session_id")) {
			this.#db.exec("ALTER TABLE session_snapshots ADD COLUMN parent_session_id TEXT");
			backfillSessionIndex = true;
		}
		if (backfillSessionIndex) {
			const rows = this.#db
				.prepare("SELECT session_id, snapshot_json FROM session_snapshots")
				.all() as unknown as Array<{ session_id: string; snapshot_json: string }>;
			const update = this.#db.prepare(
				"UPDATE session_snapshots SET name = ?, archived_at = ?, parent_session_id = ? WHERE session_id = ?"
			);
			for (const row of rows) {
				const snapshot = parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${row.session_id}`);
				update.run(
					snapshot.session.name ?? null,
					snapshot.session.archivedAt ?? null,
					snapshot.session.parentSessionId ?? null,
					row.session_id
				);
			}
		}
		this.#db.exec(
			"CREATE INDEX IF NOT EXISTS session_snapshots_list ON session_snapshots(workspace_id, archived_at, updated_at DESC)"
		);
		this.#db.exec(
			"CREATE INDEX IF NOT EXISTS session_snapshots_parent ON session_snapshots(parent_session_id, updated_at DESC)"
		);
		this.#search = new SessionSearchIndex(this.#db);
		// A mismatch also repairs writes made by an older app after a downgrade.
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const rows = this.#db
				.prepare(
					`SELECT s.session_id FROM session_snapshots s
				LEFT JOIN session_search_revisions r ON r.session_id = s.session_id
				WHERE r.revision IS NULL OR r.revision != s.revision`
				)
				.all();
			for (const row of rows) {
				const snapshot = this.loadSnapshot(String(row.session_id));
				if (snapshot) this.#search.replace(snapshot);
			}
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
		const goalColumns = this.#db.prepare("PRAGMA table_info(goals)").all() as unknown as Array<{
			name: string;
		}>;
		if (!goalColumns.some((column) => column.name === "review_json"))
			this.#db.exec("ALTER TABLE goals ADD COLUMN review_json TEXT");
		if (!goalColumns.some((column) => column.name === "plan_json"))
			this.#db.exec("ALTER TABLE goals ADD COLUMN plan_json TEXT");
		if (!goalColumns.some((column) => column.name === "owner_goal_id"))
			this.#db.exec("ALTER TABLE goals ADD COLUMN owner_goal_id TEXT");
		if (!goalColumns.some((column) => column.name === "plan_step_id"))
			this.#db.exec("ALTER TABLE goals ADD COLUMN plan_step_id TEXT");
		if (!goalColumns.some((column) => column.name === "paused_at"))
			this.#db.exec("ALTER TABLE goals ADD COLUMN paused_at INTEGER");
		if (!goalColumns.some((column) => column.name === "accumulated_run_ms"))
			this.#db.exec("ALTER TABLE goals ADD COLUMN accumulated_run_ms INTEGER");
		if (!goalColumns.some((column) => column.name === "skill_id"))
			this.#db.exec("ALTER TABLE goals ADD COLUMN skill_id TEXT");
		if (!goalColumns.some((column) => column.name === "execution_mode"))
			this.#db.exec("ALTER TABLE goals ADD COLUMN execution_mode TEXT");
		if (!goalColumns.some((column) => column.name === "started_at"))
			this.#db.exec("ALTER TABLE goals ADD COLUMN started_at INTEGER");
		if (!goalColumns.some((column) => column.name === "operation_id"))
			this.#db.exec("ALTER TABLE goals ADD COLUMN operation_id TEXT");
		this.#db.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS goals_owner_step ON goals(owner_goal_id, plan_step_id) WHERE owner_goal_id IS NOT NULL"
		);
		const automationColumns = this.#db.prepare("PRAGMA table_info(goal_automations)").all() as unknown as Array<{
			name: string;
		}>;
		if (!automationColumns.some((column) => column.name === "plan_json"))
			this.#db.exec("ALTER TABLE goal_automations ADD COLUMN plan_json TEXT");
		if (
			!(this.#db.prepare("PRAGMA table_info(goal_automations)").all() as { name: string }[]).some(
				(column) => column.name === "execution_json"
			)
		)
			this.#db.exec("ALTER TABLE goal_automations ADD COLUMN execution_json TEXT");
		this.#db.exec("CREATE TABLE IF NOT EXISTS scheduled_task_sessions (session_id TEXT PRIMARY KEY)");
		this.#db.exec(
			"INSERT OR IGNORE INTO scheduled_task_sessions SELECT parent_session_id FROM goal_automations WHERE execution_json IS NOT NULL"
		);
		const operationColumns = this.#db.prepare("PRAGMA table_info(operations)").all() as unknown as Array<{
			name: string;
		}>;
		if (!operationColumns.some((column) => column.name === "abort_requested")) {
			this.#db.exec("ALTER TABLE operations ADD COLUMN abort_requested INTEGER NOT NULL DEFAULT 0");
		}
		if (!operationColumns.some((column) => column.name === "started_at")) {
			this.#db.exec("ALTER TABLE operations ADD COLUMN started_at INTEGER");
		}
		if (!operationColumns.some((column) => column.name === "finished_at")) {
			this.#db.exec("ALTER TABLE operations ADD COLUMN finished_at INTEGER");
		}
		if (!operationColumns.some((column) => column.name === "retry_after"))
			this.#db.exec("ALTER TABLE operations ADD COLUMN retry_after INTEGER");
		if (!operationColumns.some((column) => column.name === "usage_json"))
			this.#db.exec("ALTER TABLE operations ADD COLUMN usage_json TEXT");
		if (!operationColumns.some((column) => column.name === "tools_json"))
			this.#db.exec("ALTER TABLE operations ADD COLUMN tools_json TEXT");
		if (!operationColumns.some((column) => column.name === "failure_kind"))
			this.#db.exec("ALTER TABLE operations ADD COLUMN failure_kind TEXT");
		if (!operationColumns.some((column) => column.name === "retry_history_json"))
			this.#db.exec("ALTER TABLE operations ADD COLUMN retry_history_json TEXT");
		if (!operationColumns.some((column) => column.name === "approval_id"))
			this.#db.exec("ALTER TABLE operations ADD COLUMN approval_id TEXT");
		if (!operationColumns.some((column) => column.name === "approval_tool_call_id"))
			this.#db.exec("ALTER TABLE operations ADD COLUMN approval_tool_call_id TEXT");
		if (!operationColumns.some((column) => column.name === "trace_id"))
			this.#db.exec("ALTER TABLE operations ADD COLUMN trace_id TEXT");
		if (!operationColumns.some((column) => column.name === "capability_plan_json"))
			this.#db.exec("ALTER TABLE operations ADD COLUMN capability_plan_json TEXT");
		if (!operationColumns.some((column) => column.name === "context_plan_json"))
			this.#db.exec("ALTER TABLE operations ADD COLUMN context_plan_json TEXT");
	}

	[Symbol.dispose](): void {
		this.#db.close();
	}

	close(): void {
		this.#db.close();
	}

	#appendTrajectoryEvent(operationId: string, timestamp: number, data: TrajectoryEventData): TrajectoryEvent {
		const previous = this.#db
			.prepare(
				"SELECT sequence, event_digest FROM operation_trajectory_events WHERE operation_id = ? ORDER BY sequence DESC LIMIT 1"
			)
			.get(operationId) as unknown as { sequence: number; event_digest: string } | undefined;
		const sequence = (previous?.sequence ?? 0) + 1;
		if (sequence > 2000)
			throw new OrchestratorError("conflict", `Operation ${operationId} exceeded the trajectory event limit`);
		const event = createTrajectoryEvent({
			operationId,
			sequence,
			timestamp,
			previousDigest: previous?.event_digest ?? null,
			data,
		});
		this.#db
			.prepare(
				"INSERT INTO operation_trajectory_events(operation_id, sequence, event_json, event_digest, previous_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)"
			)
			.run(operationId, sequence, JSON.stringify(event), event.digest, event.previousDigest, timestamp);
		return event;
	}

	appendTrajectoryEvent(operationId: string, timestamp: number, data: TrajectoryEventData): TrajectoryEvent {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const operation = this.#db.prepare("SELECT 1 FROM operations WHERE operation_id = ?").get(operationId);
			if (!operation) throw new OrchestratorError("not_found", `Operation ${operationId} does not exist`);
			const event = this.#appendTrajectoryEvent(operationId, timestamp, data);
			this.#db.exec("COMMIT");
			return event;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	#appendAttemptEvidence(
		operationId: string,
		timestamp: number,
		requests: UsageRequestSummary[] | undefined,
		tools: DurableOperation["tools"]
	): void {
		for (const request of requests ?? []) {
			this.#appendTrajectoryEvent(operationId, timestamp, {
				type: "model.request",
				requestId: request.requestId,
				model: request.model,
				usage: request.usage,
			});
		}
		for (const tool of tools ?? []) {
			this.#appendTrajectoryEvent(operationId, timestamp, {
				type: "tool.summary",
				toolName: tool.toolName,
				callCount: tool.callCount,
				...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
				succeededCount: tool.succeededCount ?? 0,
				failedCount: tool.failedCount ?? 0,
				abortedCount: tool.abortedCount ?? 0,
			});
		}
	}

	trajectoryReport(operationId: string): TrajectoryReport {
		const rows = this.#db
			.prepare(
				"SELECT sequence, event_json, event_digest, previous_digest FROM operation_trajectory_events WHERE operation_id = ? ORDER BY sequence"
			)
			.all(operationId) as unknown as TrajectoryRow[];
		const events = rows.map((row) => {
			let event: TrajectoryEvent;
			try {
				event = JSON.parse(row.event_json) as TrajectoryEvent;
			} catch {
				throw new OrchestratorError(
					"corrupt_storage",
					`Trajectory ${operationId}/${row.sequence} contains invalid JSON`
				);
			}
			if (event.digest !== row.event_digest || event.previousDigest !== row.previous_digest) {
				return {
					...event,
					digest: trajectoryDigest({ rowDigest: row.event_digest, eventDigest: event.digest }),
				};
			}
			return event;
		});
		return trajectoryReport(operationId, events);
	}

	#memoryFromRow(row: MemoryRow, context: string): MemorySummary {
		const memory = parseChecked<MemorySummary>(row.memory_json, checkMemory, context);
		if (memory.digest !== row.memory_digest || !verifyDurableMemory(memory))
			throw new OrchestratorError("corrupt_storage", `Memory ${memory.id} failed digest verification`);
		return memory;
	}

	#memoryRecordFromRow(row: MemoryRecordRow, context: string): MemoryRecord {
		const memory = this.#memoryFromRow(row, context);
		return {
			memory,
			status: row.status,
			retention: row.retained === 1 ? "retained" : "automatic",
			updatedAt: row.updated_at,
			...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
		};
	}

	listMemories(sessionId: string, limit = 20): MemorySummary[] {
		const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
		const rows = this.#db
			.prepare(
				"SELECT memory_json, memory_digest FROM session_memories WHERE session_id = ? ORDER BY created_at DESC, memory_id DESC LIMIT ?"
			)
			.all(sessionId, boundedLimit) as unknown as MemoryRow[];
		return rows.map((row) => this.#memoryFromRow(row, `Memory in session ${sessionId}`));
	}

	listMemoryRecords(sessionId: string, options: { limit?: number; includeInactive?: boolean } = {}): MemoryRecord[] {
		const boundedLimit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 20)));
		const rows = this.#db
			.prepare(
				`
			SELECT m.memory_json, m.memory_digest, s.status, s.retained, s.updated_at, s.superseded_by
			FROM session_memories m
			JOIN session_memory_state s ON s.memory_id = m.memory_id
			WHERE m.session_id = ? ${options.includeInactive ? "" : "AND s.status = 'active'"}
			ORDER BY s.retained DESC, m.created_at DESC, m.memory_id DESC LIMIT ?
		`
			)
			.all(sessionId, boundedLimit) as unknown as MemoryRecordRow[];
		return rows.map((row) => this.#memoryRecordFromRow(row, `Memory record in session ${sessionId}`));
	}

	searchMemories(sessionId: string, query: string, limit = 5): MemorySearchMatch[] {
		const records = this.#db
			.prepare(
				`
			SELECT m.memory_json, m.memory_digest, s.status, s.retained, s.updated_at, s.superseded_by
			FROM session_memories m
			JOIN session_memory_state s ON s.memory_id = m.memory_id
			WHERE m.session_id = ? AND s.status = 'active'
			ORDER BY s.retained DESC, m.created_at DESC, m.memory_id DESC LIMIT 200
		`
			)
			.all(sessionId) as unknown as MemoryRecordRow[];
		return searchMemoryRecords(
			records.map((row) => this.#memoryRecordFromRow(row, `Searchable memory in session ${sessionId}`)),
			query,
			limit
		);
	}

	listOperationMemories(operationId: string, limit = 32): MemorySummary[] {
		const boundedLimit = Math.max(1, Math.min(32, Math.trunc(limit)));
		const rows = this.#db
			.prepare(
				"SELECT memory_json, memory_digest FROM session_memories WHERE operation_id = ? ORDER BY created_at, memory_id LIMIT ?"
			)
			.all(operationId, boundedLimit) as unknown as MemoryRow[];
		return rows.map((row) => this.#memoryFromRow(row, `Memory for operation ${operationId}`));
	}

	countOperationMemories(operationId: string): number {
		const row = this.#db
			.prepare(
				`
			SELECT
				(SELECT COUNT(*) FROM session_memories WHERE operation_id = ?) +
				(SELECT COUNT(*) FROM session_memory_tombstones WHERE operation_id = ?) AS count
		`
			)
			.get(operationId, operationId) as unknown as { count: number };
		return Number(row.count);
	}

	manageMemory(options: ManageMemoryOptions): Extract<CommandResult, { type: "session.memory.managed" }> {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#db
				.prepare(
					"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?"
				)
				.get(options.principalId, options.idempotencyKey) as unknown as IdempotencyRow | undefined;
			if (existing && existing.expires_at > options.now) {
				if (existing.command_hash !== options.commandHash)
					throw new OrchestratorError(
						"idempotency_conflict",
						`Idempotency key ${options.idempotencyKey} was used for another command`
					);
				const result = parseChecked<CommandResult>(
					existing.result_json,
					checkCommandResult,
					`Idempotency result ${options.idempotencyKey}`
				);
				this.#db.exec("COMMIT");
				return result as Extract<CommandResult, { type: "session.memory.managed" }>;
			}
			if (existing)
				this.#db
					.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?")
					.run(options.principalId, options.idempotencyKey);

			const row = this.#db
				.prepare(
					`
				SELECT m.memory_json, m.memory_digest, s.status, s.retained, s.updated_at, s.superseded_by
				FROM session_memories m JOIN session_memory_state s ON s.memory_id = m.memory_id
				WHERE m.session_id = ? AND m.memory_id = ?
			`
				)
				.get(options.sessionId, options.memoryId) as unknown as MemoryRecordRow | undefined;
			if (!row)
				throw new OrchestratorError(
					"not_found",
					`Memory ${options.memoryId} does not exist in session ${options.sessionId}`
				);
			const current = this.#memoryRecordFromRow(row, `Managed memory ${options.memoryId}`);
			if (current.status === "forgotten" && options.action !== "forget") {
				throw new OrchestratorError("conflict", `Memory ${options.memoryId} has been forgotten and cannot be restored`);
			}

			let status = current.status;
			let retained = current.retention === "retained";
			let supersededBy = current.supersededBy;
			if (options.action === "promote") {
				if (!retained) {
					const count = this.#db
						.prepare(
							`
						SELECT COUNT(*) AS count FROM session_memory_state s
						JOIN session_memories m ON m.memory_id = s.memory_id
						WHERE m.session_id = ? AND s.retained = 1 AND s.status != 'forgotten'
					`
						)
						.get(options.sessionId) as unknown as { count: number };
					if (Number(count.count) >= 20)
						throw new OrchestratorError("conflict", "A session can retain at most 20 memories");
				}
				status = "active";
				retained = true;
				supersededBy = undefined;
			} else if (options.action === "release") {
				retained = false;
				const candidates = this.#db
					.prepare(
						`
					SELECT m.memory_json, m.memory_digest, s.status, s.retained, s.updated_at, s.superseded_by
					FROM session_memories m JOIN session_memory_state s ON s.memory_id = m.memory_id
					WHERE m.session_id = ? AND m.memory_id != ? AND s.status = 'active'
					ORDER BY m.created_at DESC, m.memory_id DESC LIMIT 200
				`
					)
					.all(options.sessionId, options.memoryId) as unknown as MemoryRecordRow[];
				const replacement = candidates
					.map((candidate) => this.#memoryRecordFromRow(candidate, `Replacement memory for ${options.memoryId}`))
					.find((candidate) => candidate.memory.source.revision >= current.memory.source.revision);
				status = replacement ? "superseded" : "active";
				supersededBy = replacement?.memory.id;
			} else {
				status = "forgotten";
				retained = false;
				supersededBy = undefined;
			}

			const changed =
				options.action === "forget" ||
				status !== current.status ||
				retained !== (current.retention === "retained") ||
				supersededBy !== current.supersededBy;
			if (options.action === "forget") {
				this.#db
					.prepare(
						"INSERT INTO session_memory_lifecycle_events(memory_id, session_id, action, actor_id, related_memory_id, related_memory_key, created_at) VALUES (?, ?, 'forget', ?, NULL, NULL, ?)"
					)
					.run(options.memoryId, options.sessionId, options.principalId, options.now);
				const lifecycle = this.#liveMemoryLifecycleEvents(options.memoryId, 100);
				this.#db
					.prepare(
						`
					INSERT INTO session_memory_tombstones(memory_id, session_id, operation_id, memory_digest, reason, source_revision, created_at, forgotten_at, actor_id, lifecycle_json)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`
					)
					.run(
						current.memory.id,
						current.memory.sessionId,
						current.memory.operationId ?? null,
						current.memory.digest,
						current.memory.reason,
						current.memory.source.revision,
						current.memory.createdAt,
						options.now,
						options.principalId,
						JSON.stringify(lifecycle)
					);
				this.#db
					.prepare("DELETE FROM session_memories WHERE memory_id = ? AND session_id = ?")
					.run(options.memoryId, options.sessionId);
			} else if (changed) {
				this.#db
					.prepare(
						"UPDATE session_memory_state SET status = ?, retained = ?, superseded_by = ?, updated_at = ? WHERE memory_id = ?"
					)
					.run(status, retained ? 1 : 0, supersededBy ?? null, options.now, options.memoryId);
				this.#db
					.prepare(
						"INSERT INTO session_memory_lifecycle_events(memory_id, session_id, action, actor_id, related_memory_id, related_memory_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
					)
					.run(
						options.memoryId,
						options.sessionId,
						options.action,
						options.principalId,
						supersededBy ?? null,
						supersededBy ?? null,
						options.now
					);
			}
			const result: Extract<CommandResult, { type: "session.memory.managed" }> = {
				type: "session.memory.managed",
				sessionId: options.sessionId,
				memoryId: options.memoryId,
				action: options.action,
				status,
				retention: retained ? "retained" : "automatic",
			};
			if (!checkCommandResult.Check(result))
				throw new OrchestratorError("conflict", "Invalid memory management result");
			this.#db
				.prepare(
					"INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
				)
				.run(
					options.principalId,
					options.idempotencyKey,
					options.commandHash,
					JSON.stringify(result),
					options.now,
					options.expiresAt
				);
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	#liveMemoryLifecycleEvents(memoryId: string, limit: number): MemoryLifecycleEvent[] {
		const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
		const rows = this.#db
			.prepare(
				`
			SELECT sequence, memory_id, session_id, action, actor_id, COALESCE(related_memory_key, related_memory_id) AS related_memory_id, created_at
			FROM session_memory_lifecycle_events WHERE memory_id = ? ORDER BY sequence LIMIT ?
		`
			)
			.all(memoryId, boundedLimit) as unknown as Array<{
			sequence: number;
			memory_id: string;
			session_id: string;
			action: MemoryLifecycleEvent["action"];
			actor_id: string;
			related_memory_id: string | null;
			created_at: number;
		}>;
		return rows.map((row) => ({
			sequence: row.sequence,
			memoryId: row.memory_id,
			sessionId: row.session_id,
			action: row.action,
			actorId: row.actor_id,
			...(row.related_memory_id === null ? {} : { relatedMemoryId: row.related_memory_id }),
			createdAt: row.created_at,
		}));
	}

	listMemoryLifecycleEvents(memoryId: string, limit = 100): MemoryLifecycleEvent[] {
		const live = this.#liveMemoryLifecycleEvents(memoryId, limit);
		if (live.length > 0) return live;
		const tombstone = this.#db
			.prepare("SELECT lifecycle_json FROM session_memory_tombstones WHERE memory_id = ?")
			.get(memoryId) as unknown as { lifecycle_json: string } | undefined;
		if (!tombstone) return [];
		try {
			const events = JSON.parse(tombstone.lifecycle_json) as MemoryLifecycleEvent[];
			return events.slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
		} catch {
			throw new OrchestratorError("corrupt_storage", `Memory tombstone ${memoryId} contains invalid lifecycle JSON`);
		}
	}

	subscribeEvents(listener: (event: StoredSessionEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	loadSnapshot(sessionId: string): SessionSnapshot | undefined {
		const row = this.#db
			.prepare("SELECT snapshot_json, revision FROM session_snapshots WHERE session_id = ?")
			.get(sessionId) as unknown as SessionRow | undefined;
		return row ? parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${sessionId}`) : undefined;
	}

	loadEvents(sessionId: string, afterRevision = 0): SessionEvent[] {
		const rows = this.#db
			.prepare("SELECT event_json FROM session_events WHERE session_id = ? AND revision > ? ORDER BY revision")
			.all(sessionId, afterRevision) as unknown as Array<{ event_json: string }>;
		return rows.map((row, index) =>
			parseChecked<SessionEvent>(row.event_json, checkEvent, `Event ${sessionId}/${afterRevision + index + 1}`)
		);
	}

	loadEventFeed(afterCursor = "0", limit = 1000): StoredSessionEvent[] {
		const cursor = Number(afterCursor);
		if (!Number.isSafeInteger(cursor) || cursor < 0) {
			throw new OrchestratorError("conflict", `Invalid event cursor ${afterCursor}`);
		}
		const rows = this.#db
			.prepare("SELECT global_seq, event_json FROM session_events WHERE global_seq > ? ORDER BY global_seq LIMIT ?")
			.all(cursor, limit) as unknown as Array<{ global_seq: number; event_json: string }>;
		return rows.map((row) => ({
			cursor: String(row.global_seq),
			event: parseChecked<SessionEvent>(row.event_json, checkEvent, `Event cursor ${row.global_seq}`),
		}));
	}

	listSnapshots(workspaceId: string, options: ListSnapshotsOptions = {}): SessionSnapshot[] {
		const conditions = [
			"workspace_id = ?",
			"parent_session_id IS NULL",
			options.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL",
		];
		const parameters: Array<string | number> = [workspaceId];
		if (options.excludeSessionIds?.length) {
			conditions.push("session_id NOT IN (SELECT value FROM json_each(?))");
			parameters.push(JSON.stringify(options.excludeSessionIds));
		}
		const query = options.query?.trim().toLocaleLowerCase();
		if (query) {
			const escaped = query.replace(/[!%_]/g, "!$&");
			conditions.push("(LOWER(COALESCE(name, '')) LIKE ? ESCAPE '!' OR LOWER(session_id) LIKE ? ESCAPE '!')");
			parameters.push(`%${escaped}%`, `%${escaped}%`);
		}
		parameters.push(Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100))));
		const rows = this.#db
			.prepare(
				`SELECT session_id, snapshot_json FROM session_snapshots WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`
			)
			.all(...parameters) as unknown as Array<{ session_id: string; snapshot_json: string }>;
		return rows.map((row) =>
			parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${row.session_id}`)
		);
	}

	searchSessions(workspaceId: string, options: SessionSearchOptions) {
		return this.#search.search(workspaceId, options);
	}

	usageOverview(workspaceIds: string | readonly string[] | undefined, now: number, requestedDays = 7): UsageOverview {
		const workspaceId = typeof workspaceIds === "string" ? workspaceIds : undefined;
		const allowedIds = typeof workspaceIds === "string" ? [workspaceIds] : workspaceIds;
		const days = Math.max(7, Math.min(31, Math.trunc(requestedDays)));
		const current = new Date(now);
		const todayStart = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
		const tomorrowStart = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime();
		const monthStart = new Date(current.getFullYear(), current.getMonth(), 1).getTime();
		const daily = Array.from({ length: days }, (_, index) => {
			const timestamp = new Date(
				current.getFullYear(),
				current.getMonth(),
				current.getDate() - days + index + 1
			).getTime();
			return {
				date: localDateKey(timestamp),
				usage: { ...EMPTY_USAGE },
				turnCount: 0,
				requestCount: 0,
			};
		});
		const byDate = new Map(daily.map((entry) => [entry.date, entry]));
		let total = { ...EMPTY_USAGE };
		let totalTurnCount = 0;
		let totalRequestCount = 0;
		let today = { ...EMPTY_USAGE };
		let month = { ...EMPTY_USAGE };
		const rows = this.#db
			.prepare(
				`
			SELECT e.event_json
			FROM session_events e
			JOIN session_snapshots s ON s.session_id = e.session_id
			WHERE ${allowedIds === undefined ? "1 = 1" : "s.workspace_id IN (SELECT value FROM json_each(?))"}
				AND s.parent_session_id IS NULL
				AND json_extract(e.event_json, '$.type') = 'session.usage.recorded'
				AND e.created_at < ?
			ORDER BY e.created_at
		`
			)
			.all(...(allowedIds === undefined ? [] : [JSON.stringify(allowedIds)]), tomorrowStart) as unknown as Array<{
			event_json: string;
		}>;
		for (const row of rows) {
			const event = parseChecked<SessionEvent>(row.event_json, checkEvent, "Usage event");
			if (event.type !== "session.usage.recorded") continue;
			const usage = event.usage as Usage;
			total = addUsage(total, usage);
			totalTurnCount += 1;
			totalRequestCount += event.requests.length;
			if (event.timestamp >= monthStart) month = addUsage(month, usage);
			if (event.timestamp >= todayStart) today = addUsage(today, usage);
			const bucket = byDate.get(localDateKey(event.timestamp));
			if (!bucket) continue;
			bucket.usage = addUsage(bucket.usage, usage);
			bucket.turnCount += 1;
			bucket.requestCount += event.requests.length;
		}
		return {
			...(workspaceId === undefined ? {} : { workspaceId }),
			generatedAt: now,
			total,
			totalTurnCount,
			totalRequestCount,
			today,
			month,
			daily,
		};
	}

	listChildSnapshots(parentSessionId: string, limit = 100): SessionSnapshot[] {
		const rows = this.#db
			.prepare(
				"SELECT session_id, snapshot_json FROM session_snapshots WHERE parent_session_id = ? ORDER BY updated_at DESC LIMIT ?"
			)
			.all(parentSessionId, Math.max(1, Math.min(100, Math.trunc(limit)))) as unknown as Array<{
			session_id: string;
			snapshot_json: string;
		}>;
		return rows.map((row) =>
			parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${row.session_id}`)
		);
	}

	listAllDirectChildSnapshots(parentSessionId: string): SessionSnapshot[] {
		const rows = this.#db
			.prepare(
				"SELECT session_id, snapshot_json FROM session_snapshots WHERE parent_session_id = ? ORDER BY updated_at DESC"
			)
			.all(parentSessionId) as unknown as Array<{ session_id: string; snapshot_json: string }>;
		return rows.map((row) =>
			parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${row.session_id}`)
		);
	}

	listAllChildSnapshots(limit = 1000, offset = 0): SessionSnapshot[] {
		const rows = this.#db
			.prepare(
				"SELECT session_id, snapshot_json FROM session_snapshots WHERE parent_session_id IS NOT NULL ORDER BY updated_at ASC LIMIT ? OFFSET ?"
			)
			.all(Math.max(1, Math.min(10_000, Math.trunc(limit))), Math.max(0, Math.trunc(offset))) as unknown as Array<{
			session_id: string;
			snapshot_json: string;
		}>;
		return rows.map((row) =>
			parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${row.session_id}`)
		);
	}

	loadGoal(goalId: string): DurableGoal | undefined {
		const row = this.#db.prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE goal_id = ?`).get(goalId) as unknown as
			GoalRow | undefined;
		return row ? mapGoal(row) : undefined;
	}

	findGoalByRunSessionId(sessionId: string): DurableGoal | undefined {
		const row = this.#db
			.prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE run_session_id = ?`)
			.get(sessionId) as unknown as GoalRow | undefined;
		return row ? mapGoal(row) : undefined;
	}

	listGoals(parentSessionId: string, limit = 100): DurableGoal[] {
		const rows = this.#db
			.prepare(
				`SELECT ${GOAL_COLUMNS} FROM goals WHERE parent_session_id = ? AND owner_goal_id IS NULL ORDER BY updated_at DESC, goal_id DESC LIMIT ?`
			)
			.all(parentSessionId, Math.max(1, Math.min(100, Math.trunc(limit)))) as unknown as GoalRow[];
		return rows.map(mapGoal);
	}

	listReviewGoals(): DurableGoal[] {
		const rows = this.#db
			.prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE review_json IS NOT NULL ORDER BY updated_at, goal_id`)
			.all() as unknown as GoalRow[];
		return rows.map(mapGoal);
	}

	listPlanGoals(parentSessionId?: string): DurableGoal[] {
		const statement = this.#db.prepare(
			`SELECT ${GOAL_COLUMNS} FROM goals WHERE plan_json IS NOT NULL${parentSessionId === undefined ? "" : " AND parent_session_id = ?"} ORDER BY updated_at, goal_id`
		);
		const rows = (parentSessionId === undefined
			? statement.all()
			: statement.all(parentSessionId)) as unknown as GoalRow[];
		return rows.map(mapGoal);
	}

	listPlanStepGoals(ownerGoalId: string): DurableGoal[] {
		const rows = this.#db
			.prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE owner_goal_id = ? ORDER BY plan_step_id, goal_id`)
			.all(ownerGoalId) as unknown as GoalRow[];
		return rows.map(mapGoal);
	}

	withGoalPlanSnapshot<T>(goalId: string, project: (goal: DurableGoal, children: DurableGoal[]) => T): T {
		this.#db.exec("SAVEPOINT goal_plan_projection");
		try {
			const goal = this.loadGoal(goalId);
			if (!goal?.plan) throw new OrchestratorError("not_found", "Goal plan does not exist");
			const result = project(goal, this.listPlanStepGoals(goalId));
			this.#db.exec("RELEASE goal_plan_projection");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK TO goal_plan_projection");
			this.#db.exec("RELEASE goal_plan_projection");
			throw error;
		}
	}

	commitGoalMutation(options: CommitGoalMutationOptions): {
		deduplicated: boolean;
		result: CommandResult;
	} {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#db
				.prepare(
					"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?"
				)
				.get(options.idempotency.principalId, options.idempotency.key) as unknown as IdempotencyRow | undefined;
			if (existing && existing.expires_at <= options.goal.updatedAt) {
				this.#db
					.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?")
					.run(options.idempotency.principalId, options.idempotency.key);
			} else if (existing) {
				if (existing.command_hash !== options.idempotency.commandHash) {
					throw new OrchestratorError(
						"idempotency_conflict",
						`Idempotency key ${options.idempotency.key} was used for another command`
					);
				}
				const result = parseChecked<CommandResult>(
					existing.result_json,
					checkCommandResult,
					`Idempotency result ${options.idempotency.key}`
				);
				this.#db.exec("COMMIT");
				return { deduplicated: true, result };
			}

			if (!checkCommandResult.Check(options.idempotency.result)) {
				throw new OrchestratorError("conflict", "Goal mutation contains an invalid command result");
			}
			assertGoal(options.goal);
			if (options.expectedUpdatedAt === undefined) {
				this.#db
					.prepare(
						"INSERT INTO goals(goal_id, parent_session_id, title, objective, skill_id, execution_mode, run_session_id, operation_id, created_at, updated_at, started_at, cancelled_at, paused_at, accumulated_run_ms, review_json, plan_json, owner_goal_id, plan_step_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
					)
					.run(
						options.goal.id,
						options.goal.parentSessionId,
						options.goal.title,
						options.goal.objective,
						options.goal.skillId ?? null,
						options.goal.executionMode ?? null,
						options.goal.runSessionId ?? null,
						options.goal.operationId ?? null,
						options.goal.createdAt,
						options.goal.updatedAt,
						options.goal.startedAt ?? null,
						options.goal.cancelledAt ?? null,
						options.goal.pausedAt ?? null,
						options.goal.accumulatedRunMs ?? null,
						options.goal.review ? JSON.stringify(options.goal.review) : null,
						options.goal.plan ? JSON.stringify(options.goal.plan) : null,
						options.goal.ownerGoalId ?? null,
						options.goal.planStepId ?? null
					);
			} else {
				const updated = this.#db
					.prepare(
						"UPDATE goals SET title = ?, objective = ?, skill_id = ?, execution_mode = ?, run_session_id = ?, operation_id = ?, updated_at = ?, started_at = ?, cancelled_at = ?, paused_at = ?, accumulated_run_ms = ?, review_json = ?, plan_json = ? WHERE goal_id = ? AND parent_session_id = ? AND updated_at = ?"
					)
					.run(
						options.goal.title,
						options.goal.objective,
						options.goal.skillId ?? null,
						options.goal.executionMode ?? null,
						options.goal.runSessionId ?? null,
						options.goal.operationId ?? null,
						options.goal.updatedAt,
						options.goal.startedAt ?? null,
						options.goal.cancelledAt ?? null,
						options.goal.pausedAt ?? null,
						options.goal.accumulatedRunMs ?? null,
						options.goal.review ? JSON.stringify(options.goal.review) : null,
						options.goal.plan ? JSON.stringify(options.goal.plan) : null,
						options.goal.id,
						options.goal.parentSessionId,
						options.expectedUpdatedAt
					);
				if (Number(updated.changes) !== 1)
					throw new OrchestratorError("conflict", `Goal ${options.goal.id} changed concurrently`);
			}
			this.#db
				.prepare(
					"INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
				)
				.run(
					options.idempotency.principalId,
					options.idempotency.key,
					options.idempotency.commandHash,
					JSON.stringify(options.idempotency.result),
					options.goal.updatedAt,
					options.idempotency.expiresAt
				);
			this.#db.exec("COMMIT");
			return { deduplicated: false, result: options.idempotency.result };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	updateGoal(goal: DurableGoal, expectedUpdatedAt: number): void {
		assertGoal(goal);
		const updated = this.#db
			.prepare(
				"UPDATE goals SET title = ?, objective = ?, skill_id = ?, execution_mode = ?, run_session_id = ?, operation_id = ?, updated_at = ?, started_at = ?, cancelled_at = ?, paused_at = ?, accumulated_run_ms = ?, review_json = ?, plan_json = ? WHERE goal_id = ? AND parent_session_id = ? AND updated_at = ?"
			)
			.run(
				goal.title,
				goal.objective,
				goal.skillId ?? null,
				goal.executionMode ?? null,
				goal.runSessionId ?? null,
				goal.operationId ?? null,
				goal.updatedAt,
				goal.startedAt ?? null,
				goal.cancelledAt ?? null,
				goal.pausedAt ?? null,
				goal.accumulatedRunMs ?? null,
				goal.review ? JSON.stringify(goal.review) : null,
				goal.plan ? JSON.stringify(goal.plan) : null,
				goal.id,
				goal.parentSessionId,
				expectedUpdatedAt
			);
		if (Number(updated.changes) !== 1) throw new OrchestratorError("conflict", `Goal ${goal.id} changed concurrently`);
	}

	deleteGoal(options: DeleteGoalOptions): { deduplicated: boolean; result: CommandResult } {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#db
				.prepare(
					"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?"
				)
				.get(options.idempotency.principalId, options.idempotency.key) as unknown as IdempotencyRow | undefined;
			if (existing && existing.expires_at <= options.now) {
				this.#db
					.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?")
					.run(options.idempotency.principalId, options.idempotency.key);
			} else if (existing) {
				if (existing.command_hash !== options.idempotency.commandHash)
					throw new OrchestratorError(
						"idempotency_conflict",
						"Idempotency key " + options.idempotency.key + " was used for another command"
					);
				const result = parseChecked<CommandResult>(
					existing.result_json,
					checkCommandResult,
					"Idempotency result " + options.idempotency.key
				);
				this.#db.exec("COMMIT");
				return { deduplicated: true, result };
			}
			if (!checkCommandResult.Check(options.idempotency.result))
				throw new OrchestratorError("conflict", "Goal deletion contains an invalid command result");
			const deleted = this.#db
				.prepare("DELETE FROM goals WHERE goal_id = ? AND parent_session_id = ? AND updated_at = ?")
				.run(options.goalId, options.parentSessionId, options.expectedUpdatedAt);
			if (Number(deleted.changes) !== 1)
				throw new OrchestratorError("conflict", "Goal " + options.goalId + " changed concurrently");
			this.#db
				.prepare(
					"INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
				)
				.run(
					options.idempotency.principalId,
					options.idempotency.key,
					options.idempotency.commandHash,
					JSON.stringify(options.idempotency.result),
					options.now,
					options.idempotency.expiresAt
				);
			this.#db.exec("COMMIT");
			return { deduplicated: false, result: options.idempotency.result };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	attachPlanStepGoal(options: AttachPlanStepGoalOptions): void {
		assertGoal(options.parentGoal);
		assertGoal(options.childGoal);
		if (!options.parentGoal.plan) throw new OrchestratorError("conflict", `Goal ${options.parentGoal.id} has no plan`);
		if (
			options.childGoal.ownerGoalId !== options.parentGoal.id ||
			!options.childGoal.planStepId ||
			options.childGoal.parentSessionId !== options.parentGoal.parentSessionId
		) {
			throw new OrchestratorError(
				"conflict",
				`Goal ${options.childGoal.id} is not a child of plan ${options.parentGoal.id}`
			);
		}
		const step = options.parentGoal.plan.steps.find((candidate) => candidate.id === options.childGoal.planStepId);
		if (!step || step.goalId !== options.childGoal.id)
			throw new OrchestratorError(
				"conflict",
				`Plan step ${options.childGoal.planStepId} does not reference Goal ${options.childGoal.id}`
			);
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			options.verifyBudgetReservation();
			this.#db
				.prepare(
					"INSERT INTO goals(goal_id, parent_session_id, title, objective, skill_id, run_session_id, created_at, updated_at, started_at, cancelled_at, review_json, plan_json, owner_goal_id, plan_step_id) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, NULL, ?, ?)"
				)
				.run(
					options.childGoal.id,
					options.childGoal.parentSessionId,
					options.childGoal.title,
					options.childGoal.objective,
					options.childGoal.createdAt,
					options.childGoal.updatedAt,
					options.childGoal.review ? JSON.stringify(options.childGoal.review) : null,
					options.childGoal.ownerGoalId,
					options.childGoal.planStepId
				);
			const updated = this.#db
				.prepare(
					"UPDATE goals SET updated_at = ?, plan_json = ? WHERE goal_id = ? AND parent_session_id = ? AND updated_at = ? AND cancelled_at IS NULL"
				)
				.run(
					options.parentGoal.updatedAt,
					JSON.stringify(options.parentGoal.plan),
					options.parentGoal.id,
					options.parentGoal.parentSessionId,
					options.expectedUpdatedAt
				);
			if (Number(updated.changes) !== 1)
				throw new OrchestratorError("conflict", `Goal ${options.parentGoal.id} changed concurrently`);
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	loadAutomation(automationId: string): DurableGoalAutomation | undefined {
		const row = this.#db
			.prepare(`SELECT ${AUTOMATION_COLUMNS} FROM goal_automations WHERE automation_id = ?`)
			.get(automationId) as unknown as AutomationRow | undefined;
		return row ? mapAutomation(row) : undefined;
	}

	listAutomations(parentSessionId: string, limit = 100): DurableGoalAutomation[] {
		const rows = this.#db
			.prepare(
				`SELECT ${AUTOMATION_COLUMNS} FROM goal_automations WHERE parent_session_id = ? ORDER BY updated_at DESC, automation_id DESC LIMIT ?`
			)
			.all(parentSessionId, Math.max(1, Math.min(100, Math.trunc(limit)))) as unknown as AutomationRow[];
		return rows.map(mapAutomation);
	}

	listDueAutomations(now: number, limit = 20): DurableGoalAutomation[] {
		this.skipMissedScheduledTasks(now);
		const rows = this.#db
			.prepare(
				`SELECT ${AUTOMATION_COLUMNS} FROM goal_automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? AND parent_session_id IN (SELECT session_id FROM session_snapshots WHERE archived_at IS NULL) ORDER BY next_run_at, automation_id LIMIT ?`
			)
			.all(now, Math.max(1, Math.min(100, Math.trunc(limit)))) as unknown as AutomationRow[];
		return rows.map(mapAutomation);
	}

	scheduledTaskSessionIds(): string[] {
		return (this.#db.prepare("SELECT session_id FROM scheduled_task_sessions").all() as { session_id: string }[]).map(
			(row) => row.session_id
		);
	}

	listScheduledTasks(
		workspaceIds: string[],
		offset = 0,
		limit = 100
	): { tasks: DurableGoalAutomation[]; total: number } {
		if (!workspaceIds.length) return { tasks: [], total: 0 };
		const filter =
			"execution_json IS NOT NULL AND json_extract(execution_json, '$.workspaceId') IN (" +
			workspaceIds.map(() => "?").join(",") +
			")";
		const rows = this.#db
			.prepare(
				"SELECT " +
					AUTOMATION_COLUMNS +
					" FROM goal_automations WHERE " +
					filter +
					" ORDER BY created_at DESC, automation_id DESC LIMIT ? OFFSET ?"
			)
			.all(...workspaceIds, limit, offset) as unknown as AutomationRow[];
		const count = this.#db
			.prepare("SELECT COUNT(*) AS total FROM goal_automations WHERE " + filter)
			.get(...workspaceIds) as { total: number };
		return { tasks: rows.map(mapAutomation), total: count.total };
	}

	loadAutomationRunForGoal(goalId: string): DurableAutomationRun | undefined {
		const row = this.#db
			.prepare("SELECT " + AUTOMATION_RUN_COLUMNS + " FROM automation_runs WHERE goal_id = ?")
			.get(goalId) as AutomationRunRow | undefined;
		return row ? mapAutomationRun(row) : undefined;
	}

	// Only the current minute is eligible; legacy automations retain catch-up.
	skipMissedScheduledTasks(now: number): void {
		const minuteStart = Math.floor(now / 60_000) * 60_000;
		const rows = this.#db
			.prepare(
				"SELECT " +
					AUTOMATION_COLUMNS +
					" FROM goal_automations WHERE execution_json IS NOT NULL AND enabled = 1 AND next_run_at < ?"
			)
			.all(minuteStart) as unknown as AutomationRow[];
		for (const row of rows) {
			const task = mapAutomation(row);
			const schedule = task.schedule;
			const next =
				schedule.kind === "once"
					? undefined
					: schedule.kind === "calendar"
						? nextCalendarRun(schedule, minuteStart - 1)
						: schedule.startsAt +
							Math.max(0, Math.ceil((minuteStart - schedule.startsAt) / (schedule.everyMinutes * 60_000))) *
								schedule.everyMinutes *
								60_000;
			this.#db
				.prepare(
					"UPDATE goal_automations SET next_run_at = ?, enabled = ?, updated_at = ? WHERE automation_id = ? AND updated_at = ?"
				)
				.run(next ?? null, next === undefined ? 0 : 1, Math.max(now, task.updatedAt + 1), task.id, task.updatedAt);
		}
	}

	commitAutomationMutation(options: CommitAutomationMutationOptions): {
		deduplicated: boolean;
		result: CommandResult;
	} {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#db
				.prepare(
					"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?"
				)
				.get(options.idempotency.principalId, options.idempotency.key) as unknown as IdempotencyRow | undefined;
			if (existing && existing.expires_at <= options.automation.updatedAt) {
				this.#db
					.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?")
					.run(options.idempotency.principalId, options.idempotency.key);
			} else if (existing) {
				if (existing.command_hash !== options.idempotency.commandHash)
					throw new OrchestratorError(
						"idempotency_conflict",
						`Idempotency key ${options.idempotency.key} was used for another command`
					);
				const result = parseChecked<CommandResult>(
					existing.result_json,
					checkCommandResult,
					`Idempotency result ${options.idempotency.key}`
				);
				this.#db.exec("COMMIT");
				return { deduplicated: true, result };
			}
			assertAutomation(options.automation);
			if (options.automation.execution)
				this.#db
					.prepare("INSERT OR IGNORE INTO scheduled_task_sessions(session_id) VALUES (?)")
					.run(options.automation.parentSessionId);
			if (options.requireUnarchived) {
				const parent = this.loadSnapshot(options.automation.parentSessionId);
				if (!parent) throw new OrchestratorError("not_found", "Automation parent session does not exist");
				if (parent.session.archivedAt !== undefined)
					throw new OrchestratorError("conflict", "Archived sessions cannot update automations");
			}
			if (!checkCommandResult.Check(options.idempotency.result))
				throw new OrchestratorError("conflict", "Automation mutation contains an invalid command result");
			if (options.expectedUpdatedAt === undefined) {
				this.#db
					.prepare(
						"INSERT INTO goal_automations(automation_id, parent_session_id, title, objective, schedule_json, enabled, created_at, updated_at, next_run_at, last_run_at, success_criteria, max_rounds, plan_json, execution_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
					)
					.run(
						options.automation.id,
						options.automation.parentSessionId,
						options.automation.title,
						options.automation.objective,
						JSON.stringify(options.automation.schedule),
						options.automation.enabled ? 1 : 0,
						options.automation.createdAt,
						options.automation.updatedAt,
						options.automation.nextRunAt ?? null,
						options.automation.lastRunAt ?? null,
						options.automation.successCriteria ?? null,
						options.automation.maxRounds ?? null,
						options.automation.plan ? JSON.stringify(options.automation.plan) : null,
						options.automation.execution ? JSON.stringify(options.automation.execution) : null
					);
			} else {
				const updated = this.#db
					.prepare(
						"UPDATE goal_automations SET title = ?, objective = ?, schedule_json = ?, enabled = ?, updated_at = ?, next_run_at = ?, last_run_at = ?, success_criteria = ?, max_rounds = ?, plan_json = ?, execution_json = ? WHERE automation_id = ? AND parent_session_id = ? AND updated_at = ?"
					)
					.run(
						options.automation.title,
						options.automation.objective,
						JSON.stringify(options.automation.schedule),
						options.automation.enabled ? 1 : 0,
						options.automation.updatedAt,
						options.automation.nextRunAt ?? null,
						options.automation.lastRunAt ?? null,
						options.automation.successCriteria ?? null,
						options.automation.maxRounds ?? null,
						options.automation.plan ? JSON.stringify(options.automation.plan) : null,
						options.automation.execution ? JSON.stringify(options.automation.execution) : null,
						options.automation.id,
						options.automation.parentSessionId,
						options.expectedUpdatedAt
					);
				if (Number(updated.changes) !== 1)
					throw new OrchestratorError("conflict", `Automation ${options.automation.id} changed concurrently`);
			}
			this.#db
				.prepare(
					"INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
				)
				.run(
					options.idempotency.principalId,
					options.idempotency.key,
					options.idempotency.commandHash,
					JSON.stringify(options.idempotency.result),
					options.automation.updatedAt,
					options.idempotency.expiresAt
				);
			this.#db.exec("COMMIT");
			return { deduplicated: false, result: options.idempotency.result };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	deleteAutomation(options: DeleteAutomationOptions): { deduplicated: boolean; result: CommandResult } {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.getIdempotencyResult(
				options.idempotency.principalId,
				options.idempotency.key,
				options.idempotency.commandHash,
				options.now
			);
			if (existing) {
				this.#db.exec("COMMIT");
				return { deduplicated: true, result: existing };
			}
			const automation = this.loadAutomation(options.automationId);
			if (!automation || automation.parentSessionId !== options.parentSessionId)
				throw new OrchestratorError("not_found", `Automation ${options.automationId} does not exist`);
			const parent = this.loadSnapshot(options.parentSessionId);
			if (!parent) throw new OrchestratorError("not_found", "Automation parent session does not exist");
			if (parent.session.archivedAt !== undefined)
				throw new OrchestratorError("conflict", "Archived sessions cannot delete automations");
			if (automation.updatedAt !== options.expectedUpdatedAt)
				throw new OrchestratorError("conflict", `Automation ${automation.id} changed concurrently`);
			// Do not use the paginated run-list API: even an older unfinished run blocks deletion.
			const rows = this.#db
				.prepare(`SELECT ${AUTOMATION_RUN_COLUMNS} FROM automation_runs WHERE automation_id = ?`)
				.all(automation.id) as unknown as AutomationRunRow[];
			if (rows.some((row) => !options.isRunFinished(mapAutomationRun(row))))
				throw new OrchestratorError("conflict", "Automations with unfinished runs cannot be deleted");
			if (
				!checkCommandResult.Check(options.idempotency.result) ||
				options.idempotency.result.type !== "automation.deleted" ||
				options.idempotency.result.automationId !== automation.id
			)
				throw new OrchestratorError("conflict", "Automation deletion contains an invalid command result");
			// Keep Goals and their sessions; only remove the definition and its scheduling records.
			this.#db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(automation.id);
			const deleted = this.#db
				.prepare("DELETE FROM goal_automations WHERE automation_id = ? AND parent_session_id = ? AND updated_at = ?")
				.run(automation.id, options.parentSessionId, options.expectedUpdatedAt);
			if (Number(deleted.changes) !== 1)
				throw new OrchestratorError("conflict", `Automation ${automation.id} changed concurrently`);
			this.#db
				.prepare(
					"INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
				)
				.run(
					options.idempotency.principalId,
					options.idempotency.key,
					options.idempotency.commandHash,
					JSON.stringify(options.idempotency.result),
					options.now,
					options.idempotency.expiresAt
				);
			this.#db.exec("COMMIT");
			return { deduplicated: false, result: options.idempotency.result };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	claimScheduledAutomationRun(
		options: Omit<ClaimAutomationRunOptions, "trigger" | "triggerKey" | "idempotency">
	): DurableAutomationRun | undefined {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.#db
				.prepare(`SELECT ${AUTOMATION_COLUMNS} FROM goal_automations WHERE automation_id = ?`)
				.get(options.automationId) as unknown as AutomationRow | undefined;
			if (!row) throw new OrchestratorError("not_found", `Automation ${options.automationId} does not exist`);
			const automation = mapAutomation(row);
			if (!automation.enabled || automation.nextRunAt !== options.scheduledFor || options.scheduledFor > options.now) {
				this.#db.exec("COMMIT");
				return undefined;
			}
			const parent = this.#db
				.prepare("SELECT archived_at FROM session_snapshots WHERE session_id = ?")
				.get(automation.parentSessionId) as unknown as { archived_at: number | null } | undefined;
			if (!parent || parent.archived_at !== null) {
				this.#db.exec("COMMIT");
				return undefined;
			}
			const updatedAt = Math.max(options.now, automation.updatedAt + 1);
			let nextRunAt: number | undefined;
			try {
				nextRunAt =
					automation.schedule.kind === "once"
						? undefined
						: automation.schedule.kind === "calendar"
							? nextCalendarRun(automation.schedule, options.now)
							: nextIntervalRun(automation.schedule, options.scheduledFor, options.now);
			} catch (error) {
				throw new OrchestratorError("conflict", error instanceof Error ? error.message : String(error));
			}
			const updated = this.#db
				.prepare(
					"UPDATE goal_automations SET enabled = ?, updated_at = ?, next_run_at = ?, last_run_at = ? WHERE automation_id = ? AND enabled = 1 AND next_run_at = ? AND updated_at = ?"
				)
				.run(
					nextRunAt === undefined ? 0 : 1,
					updatedAt,
					nextRunAt ?? null,
					options.now,
					automation.id,
					options.scheduledFor,
					automation.updatedAt
				);
			if (Number(updated.changes) !== 1) {
				this.#db.exec("COMMIT");
				return undefined;
			}
			if (
				automation.execution &&
				options.isRunFinished &&
				this.listAllAutomationRuns(automation.id).some((run) => !options.isRunFinished!(run))
			) {
				this.#db.exec("COMMIT");
				return undefined;
			}
			const run: DurableAutomationRun = {
				id: options.runId,
				automationId: automation.id,
				parentSessionId: automation.parentSessionId,
				trigger: "schedule",
				triggerKey: `schedule:${options.scheduledFor}`,
				scheduledFor: options.scheduledFor,
				triggeredAt: options.now,
				updatedAt,
				spec: automationSpec(automation),
			};
			this.#db
				.prepare(
					"INSERT INTO automation_runs(run_id, automation_id, parent_session_id, trigger, trigger_key, scheduled_for, triggered_at, updated_at, spec_json, goal_id, dispatch_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)"
				)
				.run(
					run.id,
					run.automationId,
					run.parentSessionId,
					run.trigger,
					run.triggerKey,
					run.scheduledFor,
					run.triggeredAt,
					run.updatedAt,
					JSON.stringify(run.spec)
				);
			this.#db.exec("COMMIT");
			return run;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	listAllAutomationRuns(automationId: string): DurableAutomationRun[] {
		return (
			this.#db
				.prepare("SELECT " + AUTOMATION_RUN_COLUMNS + " FROM automation_runs WHERE automation_id = ?")
				.all(automationId) as unknown as AutomationRunRow[]
		).map(mapAutomationRun);
	}

	claimManualAutomationRun(
		options: ClaimAutomationRunOptions & { trigger: "manual"; idempotency: MutationIdempotency }
	): { deduplicated: boolean; run: DurableAutomationRun; result: CommandResult } {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#db
				.prepare(
					"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?"
				)
				.get(options.idempotency.principalId, options.idempotency.key) as unknown as IdempotencyRow | undefined;
			if (existing && existing.expires_at <= options.now) {
				this.#db
					.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?")
					.run(options.idempotency.principalId, options.idempotency.key);
			} else if (existing) {
				if (existing.command_hash !== options.idempotency.commandHash)
					throw new OrchestratorError(
						"idempotency_conflict",
						`Idempotency key ${options.idempotency.key} was used for another command`
					);
				const result = parseChecked<CommandResult>(
					existing.result_json,
					checkCommandResult,
					`Idempotency result ${options.idempotency.key}`
				);
				if (result.type !== "automation.triggered")
					throw new OrchestratorError("corrupt_storage", "Automation trigger idempotency result has the wrong type");
				const stored = this.#db
					.prepare(`SELECT ${AUTOMATION_RUN_COLUMNS} FROM automation_runs WHERE run_id = ?`)
					.get(result.run.id) as unknown as AutomationRunRow | undefined;
				if (!stored) throw new OrchestratorError("corrupt_storage", `Automation run ${result.run.id} is missing`);
				this.#db.exec("COMMIT");
				return { deduplicated: true, run: mapAutomationRun(stored), result };
			}
			const row = this.#db
				.prepare(`SELECT ${AUTOMATION_COLUMNS} FROM goal_automations WHERE automation_id = ?`)
				.get(options.automationId) as unknown as AutomationRow | undefined;
			if (!row) throw new OrchestratorError("not_found", `Automation ${options.automationId} does not exist`);
			const automation = mapAutomation(row);
			const updatedAt = Math.max(options.now, automation.updatedAt + 1);
			if (
				automation.execution &&
				options.isRunFinished &&
				this.listAllAutomationRuns(automation.id).some((run) => !options.isRunFinished!(run))
			)
				throw new OrchestratorError("conflict", "任务正在执行，请等待本次运行结束");
			const run: DurableAutomationRun = {
				id: options.runId,
				automationId: automation.id,
				parentSessionId: automation.parentSessionId,
				trigger: "manual",
				triggerKey: options.triggerKey,
				scheduledFor: options.scheduledFor,
				triggeredAt: options.now,
				updatedAt,
				spec: automationSpec(automation),
			};
			if (
				!checkCommandResult.Check(options.idempotency.result) ||
				options.idempotency.result.type !== "automation.triggered" ||
				options.idempotency.result.run.id !== run.id
			) {
				throw new OrchestratorError("conflict", "Automation trigger contains an invalid command result");
			}
			this.#db
				.prepare(
					"UPDATE goal_automations SET updated_at = ?, last_run_at = ? WHERE automation_id = ? AND updated_at = ?"
				)
				.run(updatedAt, options.now, automation.id, automation.updatedAt);
			this.#db
				.prepare(
					"INSERT INTO automation_runs(run_id, automation_id, parent_session_id, trigger, trigger_key, scheduled_for, triggered_at, updated_at, spec_json, goal_id, dispatch_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)"
				)
				.run(
					run.id,
					run.automationId,
					run.parentSessionId,
					run.trigger,
					run.triggerKey,
					run.scheduledFor,
					run.triggeredAt,
					run.updatedAt,
					JSON.stringify(run.spec)
				);
			this.#db
				.prepare(
					"INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
				)
				.run(
					options.idempotency.principalId,
					options.idempotency.key,
					options.idempotency.commandHash,
					JSON.stringify(options.idempotency.result),
					updatedAt,
					options.idempotency.expiresAt
				);
			this.#db.exec("COMMIT");
			return { deduplicated: false, run, result: options.idempotency.result };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	loadAutomationRun(runId: string): DurableAutomationRun | undefined {
		const row = this.#db
			.prepare(`SELECT ${AUTOMATION_RUN_COLUMNS} FROM automation_runs WHERE run_id = ?`)
			.get(runId) as unknown as AutomationRunRow | undefined;
		return row ? mapAutomationRun(row) : undefined;
	}

	listAutomationRuns(automationId: string, limit = 50): DurableAutomationRun[] {
		const rows = this.#db
			.prepare(
				`SELECT ${AUTOMATION_RUN_COLUMNS} FROM automation_runs WHERE automation_id = ? ORDER BY triggered_at DESC, run_id DESC LIMIT ?`
			)
			.all(automationId, Math.max(1, Math.min(50, Math.trunc(limit)))) as unknown as AutomationRunRow[];
		return rows.map(mapAutomationRun);
	}

	listRecoverableAutomationRuns(limit = 1000): DurableAutomationRun[] {
		const rows = this.#db
			.prepare(
				`SELECT ${AUTOMATION_RUN_COLUMNS} FROM automation_runs WHERE dispatch_error IS NULL ORDER BY updated_at, run_id LIMIT ?`
			)
			.all(Math.max(1, Math.min(10_000, Math.trunc(limit)))) as unknown as AutomationRunRow[];
		return rows.map(mapAutomationRun);
	}

	attachAutomationRunGoal(runId: string, goal: DurableGoal, now: number): DurableAutomationRun {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.#db
				.prepare(`SELECT ${AUTOMATION_RUN_COLUMNS} FROM automation_runs WHERE run_id = ?`)
				.get(runId) as unknown as AutomationRunRow | undefined;
			if (!row) throw new OrchestratorError("not_found", `Automation run ${runId} does not exist`);
			const run = mapAutomationRun(row);
			if (run.goalId) {
				this.#db.exec("COMMIT");
				return run;
			}
			if (
				run.parentSessionId !== goal.parentSessionId ||
				goal.runSessionId !== undefined ||
				goal.cancelledAt !== undefined
			)
				throw new OrchestratorError("conflict", `Automation run ${runId} cannot attach goal ${goal.id}`);
			assertGoal(goal);
			this.#db
				.prepare(
					"INSERT INTO goals(goal_id, parent_session_id, title, objective, skill_id, run_session_id, created_at, updated_at, started_at, cancelled_at, review_json, plan_json, owner_goal_id, plan_step_id) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL)"
				)
				.run(
					goal.id,
					goal.parentSessionId,
					goal.title,
					goal.objective,
					goal.createdAt,
					goal.updatedAt,
					goal.review ? JSON.stringify(goal.review) : null,
					goal.plan ? JSON.stringify(goal.plan) : null
				);
			const updatedAt = Math.max(now, run.updatedAt + 1);
			const updated = this.#db
				.prepare(
					"UPDATE automation_runs SET goal_id = ?, updated_at = ? WHERE run_id = ? AND goal_id IS NULL AND dispatch_error IS NULL"
				)
				.run(goal.id, updatedAt, run.id);
			if (Number(updated.changes) !== 1)
				throw new OrchestratorError("conflict", `Automation run ${runId} changed concurrently`);
			this.#db.exec("COMMIT");
			return { ...run, goalId: goal.id, updatedAt };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	setAutomationRunDispatchError(runId: string, error: string, now: number): DurableAutomationRun {
		const bounded = error.replaceAll("\0", "").slice(0, 4000) || "Automation dispatch failed";
		const updated = this.#db
			.prepare(
				"UPDATE automation_runs SET dispatch_error = ?, updated_at = MAX(updated_at + 1, ?) WHERE run_id = ? AND dispatch_error IS NULL"
			)
			.run(bounded, now, runId);
		const run = this.loadAutomationRun(runId);
		if (!run) throw new OrchestratorError("not_found", `Automation run ${runId} does not exist`);
		if (Number(updated.changes) !== 1 && run.dispatchError === undefined)
			throw new OrchestratorError("conflict", `Automation run ${runId} changed concurrently`);
		return run;
	}

	getIdempotencyResult(principalId: string, key: string, commandHash: string, now: number): CommandResult | undefined {
		const existing = this.#db
			.prepare(
				"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?"
			)
			.get(principalId, key) as unknown as IdempotencyRow | undefined;
		if (!existing) return undefined;
		if (existing.expires_at <= now) {
			this.#db
				.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ? AND expires_at <= ?")
				.run(principalId, key, now);
			return undefined;
		}
		if (existing.command_hash !== commandHash) {
			throw new OrchestratorError("idempotency_conflict", `Idempotency key ${key} was used for another command`);
		}
		return parseChecked<CommandResult>(existing.result_json, checkCommandResult, `Idempotency result ${key}`);
	}

	commitMutation(options: CommitMutationOptions): {
		deduplicated: boolean;
		result?: CommandResult;
	} {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			if (options.idempotency) {
				const existing = this.#db
					.prepare(
						"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?"
					)
					.get(options.idempotency.principalId, options.idempotency.key) as unknown as IdempotencyRow | undefined;
				if (existing && existing.expires_at <= options.snapshot.session.updatedAt) {
					this.#db
						.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?")
						.run(options.idempotency.principalId, options.idempotency.key);
				} else if (existing) {
					if (existing.command_hash !== options.idempotency.commandHash) {
						throw new OrchestratorError(
							"idempotency_conflict",
							`Idempotency key ${options.idempotency.key} was used for another command`
						);
					}
					const result = parseChecked<CommandResult>(
						existing.result_json,
						checkCommandResult,
						`Idempotency result ${options.idempotency.key}`
					);
					this.#db.exec("COMMIT");
					return { deduplicated: true, result };
				}
			}

			const current = this.#db
				.prepare("SELECT snapshot_json, revision FROM session_snapshots WHERE session_id = ?")
				.get(options.sessionId) as unknown as SessionRow | undefined;
			const currentRevision = current?.revision ?? 0;
			if (currentRevision !== options.expectedRevision) {
				throw new OrchestratorError(
					"conflict",
					`Session ${options.sessionId} is at revision ${currentRevision}, expected ${options.expectedRevision}`
				);
			}
			if (options.events.length === 0 || options.snapshot.revision !== currentRevision + options.events.length) {
				throw new OrchestratorError("conflict", "Mutation events and final snapshot revision do not align");
			}
			if (options.lease) {
				const lease = this.#db
					.prepare("SELECT session_id, owner_id, fence, expires_at FROM writer_leases WHERE session_id = ?")
					.get(options.sessionId) as unknown as LeaseRow | undefined;
				if (
					!lease ||
					lease.owner_id !== options.lease.ownerId ||
					lease.fence !== options.lease.fence ||
					lease.expires_at <= options.snapshot.session.updatedAt
				) {
					throw new OrchestratorError("lease_lost", `Writer lease for ${options.sessionId} was lost`);
				}
			}
			for (const [index, event] of options.events.entries()) {
				if (!checkEvent.Check(event)) throw new OrchestratorError("conflict", "Mutation contains an invalid event");
				if (event.sessionId !== options.sessionId || event.revision !== currentRevision + index + 1) {
					throw new OrchestratorError("conflict", "Mutation event sequence is not contiguous");
				}
			}
			if (!checkSnapshot.Check(options.snapshot) || options.snapshot.session.id !== options.sessionId) {
				throw new OrchestratorError("conflict", "Mutation contains an invalid snapshot");
			}

			if (current) {
				this.#db
					.prepare(
						"UPDATE session_snapshots SET revision = ?, snapshot_json = ?, name = ?, archived_at = ?, parent_session_id = ?, updated_at = ? WHERE session_id = ?"
					)
					.run(
						options.snapshot.revision,
						JSON.stringify(options.snapshot),
						options.snapshot.session.name ?? null,
						options.snapshot.session.archivedAt ?? null,
						options.snapshot.session.parentSessionId ?? null,
						options.snapshot.session.updatedAt,
						options.sessionId
					);
			} else {
				this.#db
					.prepare(
						"INSERT INTO session_snapshots(session_id, workspace_id, name, archived_at, parent_session_id, revision, snapshot_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
					)
					.run(
						options.sessionId,
						options.snapshot.session.workspaceId,
						options.snapshot.session.name ?? null,
						options.snapshot.session.archivedAt ?? null,
						options.snapshot.session.parentSessionId ?? null,
						options.snapshot.revision,
						JSON.stringify(options.snapshot),
						options.snapshot.session.updatedAt
					);
			}

			if (!current) {
				this.#search.replace(options.snapshot);
			} else {
				for (const event of options.events) {
					if (event.type === "session.item.upserted") this.#search.upsert(options.sessionId, event.item);
				}
				this.#search.markRevision(options.sessionId, options.snapshot.revision);
			}

			const insertEvent = this.#db.prepare(
				"INSERT INTO session_events(session_id, revision, event_id, event_json, created_at) VALUES (?, ?, ?, ?, ?)"
			);
			const storedEvents: StoredSessionEvent[] = [];
			for (const event of options.events) {
				const inserted = insertEvent.run(
					event.sessionId,
					event.revision,
					event.eventId,
					JSON.stringify(event),
					event.timestamp
				);
				storedEvents.push({ cursor: String(inserted.lastInsertRowid), event });
			}

			if (options.operation) {
				const operation = options.operation;
				this.#db
					.prepare(
						"INSERT INTO operations(operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id, capability_plan_json, context_plan_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
					)
					.run(
						operation.id,
						operation.sessionId,
						operation.type,
						operation.status,
						JSON.stringify(operation.payload),
						operation.attempt,
						operation.createdAt,
						operation.updatedAt,
						operation.startedAt ?? null,
						operation.finishedAt ?? null,
						operation.abortRequested ? 1 : 0,
						operation.traceId ?? null,
						operation.error ?? null,
						operation.retryAfter ?? null,
						operation.usage ? JSON.stringify(operation.usage) : null,
						operation.tools ? JSON.stringify(operation.tools) : null,
						operation.failureKind ?? null,
						operation.retryHistory ? JSON.stringify(operation.retryHistory) : null,
						operation.approvalId ?? null,
						operation.approvalToolCallId ?? null,
						operation.capabilityPlan ? JSON.stringify(operation.capabilityPlan) : null,
						operation.contextPlan ? JSON.stringify(operation.contextPlan) : null
					);
				this.#appendTrajectoryEvent(operation.id, operation.createdAt, {
					type: "operation.accepted",
					mode: operation.payload.mode,
				});
			}
			if (options.interruptRunningOperation) {
				// Persist cancellation with the new input, so other workers and restarts see both or neither.
				this.#db
					.prepare(
						"UPDATE operations SET abort_requested = 1, updated_at = ?, error = ? WHERE session_id = ? AND (status = 'running' OR (status = 'queued' AND json_extract(payload_json, '$.mode') = 'prompt')) AND abort_requested = 0"
					)
					.run(options.snapshot.session.updatedAt, options.interruptRunningOperation, options.sessionId);
			}
			if (options.attachGoalRun) {
				if (options.attachGoalRun.review && !checkGoalReview.Check(options.attachGoalRun.review)) {
					throw new OrchestratorError("conflict", `Goal ${options.attachGoalRun.goalId} contains invalid review state`);
				}
				const attached = this.#db
					.prepare(
						"UPDATE goals SET run_session_id = ?, updated_at = ?, review_json = ? WHERE goal_id = ? AND parent_session_id = ? AND run_session_id IS ? AND cancelled_at IS NULL AND updated_at = ?"
					)
					.run(
						options.attachGoalRun.runSessionId,
						options.attachGoalRun.updatedAt,
						options.attachGoalRun.review ? JSON.stringify(options.attachGoalRun.review) : null,
						options.attachGoalRun.goalId,
						options.attachGoalRun.parentSessionId,
						options.attachGoalRun.expectedRunSessionId ?? null,
						options.attachGoalRun.expectedUpdatedAt
					);
				if (Number(attached.changes) !== 1) {
					throw new OrchestratorError(
						"conflict",
						`Goal ${options.attachGoalRun.goalId} cannot attach run ${options.attachGoalRun.runSessionId}`
					);
				}
			}
			if (options.attachGoalOperation) {
				if (options.attachGoalOperation.review && !checkGoalReview.Check(options.attachGoalOperation.review)) {
					throw new OrchestratorError(
						"conflict",
						`Goal ${options.attachGoalOperation.goalId} contains invalid review state`
					);
				}
				const attached = this.#db
					.prepare(
						"UPDATE goals SET operation_id = ?, updated_at = ?, started_at = ?, review_json = ? WHERE goal_id = ? AND parent_session_id = ? AND operation_id IS NULL AND run_session_id IS NULL AND cancelled_at IS NULL AND updated_at = ?"
					)
					.run(
						options.attachGoalOperation.operationId,
						options.attachGoalOperation.updatedAt,
						options.attachGoalOperation.startedAt,
						options.attachGoalOperation.review ? JSON.stringify(options.attachGoalOperation.review) : null,
						options.attachGoalOperation.goalId,
						options.attachGoalOperation.parentSessionId,
						options.attachGoalOperation.expectedUpdatedAt
					);
				if (Number(attached.changes) !== 1) {
					throw new OrchestratorError(
						"conflict",
						`Goal ${options.attachGoalOperation.goalId} cannot attach operation ${options.attachGoalOperation.operationId}`
					);
				}
			}

			if (options.approvalExecution) {
				const approval = options.approvalExecution;
				this.#db
					.prepare(
						"INSERT INTO approval_executions(approval_id, session_id, operation_id, tool_call_id, mode, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
					)
					.run(
						approval.approvalId,
						approval.sessionId,
						approval.operationId ?? null,
						approval.toolCallId,
						approval.mode,
						approval.state,
						approval.createdAt,
						approval.updatedAt
					);
				if (approval.operationId)
					this.#appendTrajectoryEvent(approval.operationId, approval.updatedAt, {
						type: "approval.state",
						approvalId: approval.approvalId,
						toolCallId: approval.toolCallId,
						mode: approval.mode,
						state: approval.state,
					});
			}
			if (options.settleApprovalExecution) {
				const approval = this.#db
					.prepare(
						"SELECT operation_id, tool_call_id, mode FROM approval_executions WHERE approval_id = ? AND state = 'waiting'"
					)
					.get(options.settleApprovalExecution.approvalId) as unknown as
					Pick<ApprovalExecutionRow, "operation_id" | "tool_call_id" | "mode"> | undefined;
				const settled = this.#db
					.prepare(
						"UPDATE approval_executions SET state = ?, updated_at = ? WHERE approval_id = ? AND state = 'waiting'"
					)
					.run(
						options.settleApprovalExecution.state,
						options.snapshot.session.updatedAt,
						options.settleApprovalExecution.approvalId
					);
				if (Number(settled.changes) !== 1)
					throw new OrchestratorError(
						"conflict",
						`Approval execution ${options.settleApprovalExecution.approvalId} is not waiting`
					);
				if (approval?.operation_id)
					this.#appendTrajectoryEvent(approval.operation_id, options.snapshot.session.updatedAt, {
						type: "approval.state",
						approvalId: options.settleApprovalExecution.approvalId,
						toolCallId: approval.tool_call_id,
						mode: approval.mode,
						state: options.settleApprovalExecution.state,
					});
			}

			if (options.memories) {
				if (options.memories.length > 32)
					throw new OrchestratorError("conflict", "Mutation contains too many memories");
				const insertMemory = this.#db.prepare(
					"INSERT INTO session_memories(memory_id, session_id, operation_id, memory_json, memory_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)"
				);
				const insertState = this.#db.prepare(
					"INSERT INTO session_memory_state(memory_id, status, retained, superseded_by, updated_at) VALUES (?, 'active', 0, NULL, ?)"
				);
				const insertLifecycle = this.#db.prepare(
					"INSERT INTO session_memory_lifecycle_events(memory_id, session_id, action, actor_id, related_memory_id, related_memory_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
				);
				for (const memory of options.memories) {
					if (memory.sessionId !== options.sessionId || !checkMemory.Check(memory) || !verifyDurableMemory(memory)) {
						throw new OrchestratorError("conflict", `Mutation contains invalid memory ${memory.id}`);
					}
					if (memory.operationId) {
						const operation = this.#db
							.prepare("SELECT session_id FROM operations WHERE operation_id = ?")
							.get(memory.operationId) as unknown as { session_id: string } | undefined;
						if (operation?.session_id !== options.sessionId)
							throw new OrchestratorError(
								"conflict",
								`Memory ${memory.id} references an operation outside its session`
							);
					}
					insertMemory.run(
						memory.id,
						memory.sessionId,
						memory.operationId ?? null,
						JSON.stringify(memory),
						memory.digest,
						memory.createdAt
					);
					insertState.run(memory.id, memory.createdAt);
					insertLifecycle.run(
						memory.id,
						memory.sessionId,
						"created",
						"system:compaction",
						null,
						null,
						memory.createdAt
					);
					const candidates = this.#db
						.prepare(
							`
						SELECT m.memory_json, m.memory_digest, s.status, s.retained, s.updated_at, s.superseded_by
						FROM session_memories m JOIN session_memory_state s ON s.memory_id = m.memory_id
						WHERE m.session_id = ? AND m.memory_id != ? AND s.status = 'active' AND s.retained = 0
					`
						)
						.all(memory.sessionId, memory.id) as unknown as MemoryRecordRow[];
					for (const candidate of candidates) {
						const previous = this.#memoryRecordFromRow(candidate, `Supersession candidate for ${memory.id}`);
						if (
							previous.memory.createdAt > memory.createdAt ||
							previous.memory.source.revision > memory.source.revision
						)
							continue;
						this.#db
							.prepare(
								"UPDATE session_memory_state SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE memory_id = ? AND status = 'active' AND retained = 0"
							)
							.run(memory.id, memory.createdAt, previous.memory.id);
						insertLifecycle.run(
							previous.memory.id,
							memory.sessionId,
							"auto_superseded",
							"system:retention",
							memory.id,
							memory.id,
							memory.createdAt
						);
					}
					if (memory.operationId)
						this.#appendTrajectoryEvent(memory.operationId, memory.createdAt, {
							type: "compaction.completed",
							memoryId: memory.id,
							reason: memory.reason,
							memoryDigest: memory.digest,
							...(memory.tokensBefore === undefined ? {} : { tokensBefore: memory.tokensBefore }),
							...(memory.estimatedTokensAfter === undefined
								? {}
								: { estimatedTokensAfter: memory.estimatedTokensAfter }),
							...(memory.usage === undefined ? {} : { usage: memory.usage }),
						});
				}
			}

			if (options.settleOperation) {
				const timing = this.#db
					.prepare("SELECT started_at FROM operations WHERE operation_id = ? AND status = 'running'")
					.get(options.settleOperation.id) as unknown as { started_at: number | null } | undefined;
				const settled = this.#db
					.prepare(
						"UPDATE operations SET status = ?, updated_at = ?, finished_at = ?, error = ?, retry_after = NULL, usage_json = COALESCE(?, usage_json), tools_json = COALESCE(?, tools_json), failure_kind = ?, retry_history_json = COALESCE(?, retry_history_json) WHERE operation_id = ? AND status = 'running'"
					)
					.run(
						options.settleOperation.status,
						options.snapshot.session.updatedAt,
						options.snapshot.session.updatedAt,
						options.settleOperation.error ?? null,
						options.settleOperation.usage ? JSON.stringify(options.settleOperation.usage) : null,
						options.settleOperation.tools ? JSON.stringify(options.settleOperation.tools) : null,
						options.settleOperation.failureKind ?? null,
						options.settleOperation.retryHistory ? JSON.stringify(options.settleOperation.retryHistory) : null,
						options.settleOperation.id
					);
				if (Number(settled.changes) !== 1) {
					throw new OrchestratorError("conflict", `Operation ${options.settleOperation.id} is not running`);
				}
				this.#appendAttemptEvidence(
					options.settleOperation.id,
					options.snapshot.session.updatedAt,
					options.settleOperation.requests,
					options.settleOperation.trajectoryTools
				);
				this.#appendTrajectoryEvent(options.settleOperation.id, options.snapshot.session.updatedAt, {
					type: "operation.finished",
					status: options.settleOperation.status,
					...(options.settleOperation.failureKind === undefined
						? {}
						: { failureKind: options.settleOperation.failureKind }),
					...(options.settleOperation.usage === undefined ? {} : { usage: options.settleOperation.usage }),
					...(timing?.started_at === null || timing?.started_at === undefined
						? {}
						: {
								durationMs: Math.max(0, options.snapshot.session.updatedAt - timing.started_at),
							}),
				});
			}
			if (options.retryOperation) {
				const updated = this.#db
					.prepare(
						"UPDATE operations SET updated_at = ?, error = ?, retry_after = ?, retry_history_json = ?, usage_json = COALESCE(?, usage_json), tools_json = COALESCE(?, tools_json), failure_kind = ? WHERE operation_id = ? AND status = 'running'"
					)
					.run(
						options.snapshot.session.updatedAt,
						options.retryOperation.error,
						options.retryOperation.retryAfter,
						JSON.stringify(options.retryOperation.retryHistory),
						options.retryOperation.usage ? JSON.stringify(options.retryOperation.usage) : null,
						options.retryOperation.tools ? JSON.stringify(options.retryOperation.tools) : null,
						options.retryOperation.failureKind ?? "provider",
						options.retryOperation.id
					);
				if (Number(updated.changes) !== 1) {
					throw new OrchestratorError(
						"conflict",
						`Operation ${options.retryOperation.id} cannot record retry metadata`
					);
				}
				this.#appendAttemptEvidence(
					options.retryOperation.id,
					options.snapshot.session.updatedAt,
					options.retryOperation.requests,
					options.retryOperation.trajectoryTools
				);
				const retry = options.retryOperation.retryHistory.at(-1);
				if (retry)
					this.#appendTrajectoryEvent(options.retryOperation.id, options.snapshot.session.updatedAt, {
						type: "retry.scheduled",
						attempt: retry.attempt,
						maxAttempts: retry.maxAttempts,
						delayMs: retry.delayMs,
						failureKind: options.retryOperation.failureKind ?? "provider",
						errorDigest: trajectoryDigest(options.retryOperation.error),
					});
			}

			if (options.idempotency) {
				if (!checkCommandResult.Check(options.idempotency.result)) {
					throw new OrchestratorError("conflict", "Mutation contains an invalid command result");
				}
				this.#db
					.prepare(
						"INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
					)
					.run(
						options.idempotency.principalId,
						options.idempotency.key,
						options.idempotency.commandHash,
						JSON.stringify(options.idempotency.result),
						options.snapshot.session.updatedAt,
						options.idempotency.expiresAt
					);
			}

			this.#db.exec("COMMIT");
			if (this.#eventListeners.size > 0) {
				setImmediate(() => {
					for (const stored of storedEvents) {
						for (const listener of this.#eventListeners) listener(stored);
					}
				});
			}
			return {
				deduplicated: false,
				...(options.idempotency ? { result: options.idempotency.result } : {}),
			};
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	startOperationRetry(operationId: string, attempt: number, now: number): boolean {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const operation = this.#db
				.prepare("SELECT trace_id FROM operations WHERE operation_id = ? AND status = 'running' AND attempt = ?")
				.get(operationId, attempt) as unknown as { trace_id: string | null } | undefined;
			const result = this.#db
				.prepare(
					"UPDATE operations SET attempt = ?, updated_at = ?, retry_after = NULL WHERE operation_id = ? AND status = 'running' AND attempt = ?"
				)
				.run(attempt + 1, now, operationId, attempt);
			if (Number(result.changes) === 1)
				this.#appendTrajectoryEvent(operationId, now, {
					type: "operation.started",
					attempt: attempt + 1,
					...(operation?.trace_id ? { traceId: operation.trace_id } : {}),
				});
			this.#db.exec("COMMIT");
			return Number(result.changes) === 1;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	recordOperationRetry(operationId: string, attempt: number, now: number, error: string): void {
		const updated = this.#db
			.prepare(
				"UPDATE operations SET attempt = ?, updated_at = ?, error = ? WHERE operation_id = ? AND status = 'running' AND attempt < ?"
			)
			.run(attempt, now, error, operationId, attempt);
		if (Number(updated.changes) !== 1) {
			throw new OrchestratorError("conflict", `Operation ${operationId} cannot record retry attempt ${attempt}`);
		}
	}

	claimNextOperation(sessionId: string, now: number, traceId?: string): DurableOperation | undefined {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.#db
				.prepare(
					"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id, capability_plan_json, context_plan_json FROM operations WHERE session_id = ? AND status = 'queued' ORDER BY CASE json_extract(payload_json, '$.mode') WHEN 'prompt' THEN 0 WHEN 'steer' THEN 1 ELSE 2 END, created_at, rowid LIMIT 1"
				)
				.get(sessionId) as unknown as OperationRow | undefined;
			if (!row) {
				this.#db.exec("COMMIT");
				return undefined;
			}
			if (!row.abort_requested && row.retry_after !== null && row.retry_after > now) {
				this.#db.exec("COMMIT");
				return undefined;
			}
			this.#db
				.prepare(
					"UPDATE operations SET status = 'running', attempt = attempt + 1, updated_at = ?, started_at = ?, finished_at = NULL, retry_after = NULL, trace_id = COALESCE(trace_id, ?) WHERE operation_id = ?"
				)
				.run(now, now, traceId ?? null, row.operation_id);
			this.#appendTrajectoryEvent(row.operation_id, now, {
				type: "operation.started",
				attempt: row.attempt + 1,
				...((row.trace_id ?? traceId) ? { traceId: (row.trace_id ?? traceId)! } : {}),
			});
			this.#db.exec("COMMIT");
			return mapOperation({
				...row,
				status: "running",
				attempt: row.attempt + 1,
				updated_at: now,
				started_at: now,
				finished_at: null,
				retry_after: null,
				trace_id: row.trace_id ?? traceId ?? null,
			});
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	getOperation(operationId: string): DurableOperation | undefined {
		const row = this.#db
			.prepare(
				"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id, capability_plan_json, context_plan_json FROM operations WHERE operation_id = ?"
			)
			.get(operationId) as unknown as OperationRow | undefined;
		return row ? mapOperation(row) : undefined;
	}

	storeCapabilityPlan(operationId: string, plan: CapabilityPlan, now: number): boolean {
		if (!verifyCapabilityPlan(plan))
			throw new OrchestratorError("conflict", `Operation ${operationId} received an invalid capability plan`);
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const result = this.#db
				.prepare(
					"UPDATE operations SET capability_plan_json = ?, updated_at = ? WHERE operation_id = ? AND status = 'running' AND capability_plan_json IS NULL"
				)
				.run(JSON.stringify(plan), now, operationId);
			if (Number(result.changes) === 1)
				this.#appendTrajectoryEvent(operationId, now, {
					type: "capability.resolved",
					digest: plan.digest,
					capabilityCount: plan.capabilities.length,
				});
			this.#db.exec("COMMIT");
			return Number(result.changes) === 1;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	storeContextPlan(operationId: string, plan: ContextPlan, now: number): boolean {
		if (!verifyContextPlan(plan))
			throw new OrchestratorError("conflict", `Operation ${operationId} received an invalid context plan`);
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const result = this.#db
				.prepare(
					"UPDATE operations SET context_plan_json = ?, updated_at = ? WHERE operation_id = ? AND status = 'running' AND context_plan_json IS NULL"
				)
				.run(JSON.stringify(plan), now, operationId);
			if (Number(result.changes) === 1)
				this.#appendTrajectoryEvent(operationId, now, {
					type: "context.resolved",
					digest: plan.digest,
					fragmentCount: plan.fragments.length,
					estimatedSystemTokens: plan.estimatedSystemTokens,
					availableSystemTokens: plan.budget.availableSystemTokens,
				});
			this.#db.exec("COMMIT");
			return Number(result.changes) === 1;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	clearExecutionPlans(operationId: string, now: number): void {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const result = this.#db
				.prepare(
					"UPDATE operations SET capability_plan_json = NULL, context_plan_json = NULL, updated_at = ? WHERE operation_id = ? AND status = 'running'"
				)
				.run(now, operationId);
			if (Number(result.changes) === 0)
				throw new OrchestratorError("conflict", `Operation ${operationId} is no longer running`);
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}
	appendHookAuditRecords(operationId: string, records: HookAuditRecord[]): void {
		if (records.length === 0) return;
		if (records.length > 1000)
			throw new OrchestratorError("conflict", `Operation ${operationId} produced too many hook audit records`);
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const operation = this.#db.prepare("SELECT 1 FROM operations WHERE operation_id = ?").get(operationId);
			if (!operation) throw new OrchestratorError("not_found", `Operation ${operationId} does not exist`);
			const insert = this.#db.prepare(
				"INSERT INTO operation_hook_events(operation_id, event_json, created_at) VALUES (?, ?, ?)"
			);
			for (const record of records) {
				insert.run(operationId, JSON.stringify(record), record.finishedAt);
				this.#appendTrajectoryEvent(operationId, record.finishedAt, {
					type: "hook.executed",
					hookId: record.hookId,
					point: record.point,
					mode: record.mode,
					outcome: record.outcome,
					durationMs: record.durationMs,
					...(record.code === undefined ? {} : { code: record.code }),
				});
			}
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	listHookAuditRecords(operationId: string, limit = 100): HookAuditRecord[] {
		const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
		const rows = this.#db
			.prepare("SELECT event_json FROM operation_hook_events WHERE operation_id = ? ORDER BY sequence DESC LIMIT ?")
			.all(operationId, boundedLimit) as unknown as Array<{ event_json: string }>;
		return rows.reverse().map((row) => JSON.parse(row.event_json) as HookAuditRecord);
	}

	listOperationsByStatus(status: OperationStatus): DurableOperation[] {
		const rows = this.#db
			.prepare(
				"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id, capability_plan_json, context_plan_json FROM operations WHERE status = ? ORDER BY created_at, operation_id"
			)
			.all(status) as unknown as OperationRow[];
		return rows.map(mapOperation);
	}

	/** Raw accepted requests for reconciling a missing or incomplete runtime log. */
	listRecoveryOperations(sessionId: string): DurableOperation[] {
		const rows = this.#db
			.prepare(
				"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id, capability_plan_json, context_plan_json FROM operations WHERE session_id = ? AND status IN ('completed', 'failed', 'interrupted') ORDER BY rowid"
			)
			.all(sessionId) as unknown as OperationRow[];
		return rows.map(mapOperation);
	}

	listOperations(sessionId: string, limit = 20): DurableOperation[] {
		const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
		const rows = this.#db
			.prepare(
				"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id, capability_plan_json, context_plan_json FROM operations WHERE session_id = ? ORDER BY created_at DESC, operation_id DESC LIMIT ?"
			)
			.all(sessionId, boundedLimit) as unknown as OperationRow[];
		return rows.map(mapOperation);
	}

	/** Durable delivery receipts survive transcript compaction and RPC cache expiry. */
	findTurnDelivery(sessionId: string, marker: string): DurableOperation | undefined {
		const row = this.#db
			.prepare(
				`SELECT operation_id FROM operations WHERE session_id = ?
			AND substr(json_extract(payload_json, '$.content[0].text'), 1, ?) = ? LIMIT 1`
			)
			.get(sessionId, marker.length, marker);
		return row ? this.getOperation(String(row.operation_id)) : undefined;
	}

	getRunningOperation(sessionId: string): DurableOperation | undefined {
		const row = this.#db
			.prepare(
				"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id, capability_plan_json, context_plan_json FROM operations WHERE session_id = ? AND status = 'running' ORDER BY created_at, operation_id LIMIT 1"
			)
			.get(sessionId) as unknown as OperationRow | undefined;
		return row ? mapOperation(row) : undefined;
	}

	getApprovalExecution(approvalId: string): DurableApprovalExecution | undefined {
		const row = this.#db
			.prepare(
				"SELECT approval_id, session_id, operation_id, tool_call_id, mode, state, created_at, updated_at FROM approval_executions WHERE approval_id = ?"
			)
			.get(approvalId) as unknown as ApprovalExecutionRow | undefined;
		return row ? mapApprovalExecution(row) : undefined;
	}

	listApprovalExecutionsForOperation(operationId: string): DurableApprovalExecution[] {
		const rows = this.#db
			.prepare(
				"SELECT approval_id, session_id, operation_id, tool_call_id, mode, state, created_at, updated_at FROM approval_executions WHERE operation_id = ? ORDER BY created_at, approval_id"
			)
			.all(operationId) as unknown as ApprovalExecutionRow[];
		return rows.map(mapApprovalExecution);
	}

	claimApprovedApprovalExecution(
		sessionId: string,
		toolCallId: string,
		now: number
	): DurableApprovalExecution | undefined {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.#db
				.prepare(
					"SELECT approval_id, session_id, operation_id, tool_call_id, mode, state, created_at, updated_at FROM approval_executions WHERE session_id = ? AND tool_call_id = ? AND state = 'approved' ORDER BY created_at DESC, approval_id DESC LIMIT 1"
				)
				.get(sessionId, toolCallId) as unknown as ApprovalExecutionRow | undefined;
			if (!row) {
				this.#db.exec("COMMIT");
				return undefined;
			}
			const claimed = this.#db
				.prepare(
					"UPDATE approval_executions SET state = 'executing', updated_at = ? WHERE approval_id = ? AND state = 'approved'"
				)
				.run(now, row.approval_id);
			if (Number(claimed.changes) !== 1)
				throw new OrchestratorError("conflict", `Approval execution ${row.approval_id} could not be claimed`);
			if (row.operation_id)
				this.#appendTrajectoryEvent(row.operation_id, now, {
					type: "approval.state",
					approvalId: row.approval_id,
					toolCallId: row.tool_call_id,
					mode: row.mode,
					state: "executing",
				});
			this.#db.exec("COMMIT");
			return mapApprovalExecution({ ...row, state: "executing", updated_at: now });
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	completeApprovalExecution(approvalId: string, now: number): boolean {
		return this.#settleApprovalExecutionState(approvalId, now, "completed", "state = 'executing'");
	}

	interruptApprovalExecution(approvalId: string, now: number): boolean {
		return this.#settleApprovalExecutionState(
			approvalId,
			now,
			"interrupted",
			"state IN ('waiting', 'approved', 'executing')"
		);
	}

	#settleApprovalExecutionState(
		approvalId: string,
		now: number,
		state: "completed" | "interrupted",
		condition: string
	): boolean {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.#db
				.prepare(
					`SELECT operation_id, tool_call_id, mode FROM approval_executions WHERE approval_id = ? AND ${condition}`
				)
				.get(approvalId) as unknown as Pick<ApprovalExecutionRow, "operation_id" | "tool_call_id" | "mode"> | undefined;
			const result = this.#db
				.prepare(`UPDATE approval_executions SET state = ?, updated_at = ? WHERE approval_id = ? AND ${condition}`)
				.run(state, now, approvalId);
			if (Number(result.changes) === 1 && row?.operation_id)
				this.#appendTrajectoryEvent(row.operation_id, now, {
					type: "approval.state",
					approvalId,
					toolCallId: row.tool_call_id,
					mode: row.mode,
					state,
				});
			this.#db.exec("COMMIT");
			return Number(result.changes) === 1;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	requeueOperationForApproval(operationId: string, approvalId: string, now: number): boolean {
		const approval = this.getApprovalExecution(approvalId);
		if (!approval || approval.operationId !== operationId) return false;
		const result = this.#db
			.prepare(
				"UPDATE operations SET status = 'queued', updated_at = ?, finished_at = NULL, error = NULL, retry_after = NULL, approval_id = ?, approval_tool_call_id = ? WHERE operation_id = ? AND status = 'running'"
			)
			.run(now, approvalId, approval.toolCallId, operationId);
		return Number(result.changes) === 1;
	}

	requeueOperation(operationId: string, now: number, error?: string): boolean {
		const result = this.#db
			.prepare(
				"UPDATE operations SET status = 'queued', updated_at = ?, finished_at = NULL, retry_after = NULL, error = ? WHERE operation_id = ? AND status = 'running'"
			)
			.run(now, error ?? null, operationId);
		return Number(result.changes) === 1;
	}

	recoverRetryOperation(operationId: string, now: number): boolean {
		const result = this.#db
			.prepare(
				"UPDATE operations SET status = 'queued', updated_at = ?, finished_at = NULL WHERE operation_id = ? AND status = 'running' AND retry_after IS NOT NULL"
			)
			.run(now, operationId);
		return Number(result.changes) === 1;
	}

	requestOperationAbort(options: RequestOperationAbortOptions): CommandResult {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#db
				.prepare(
					"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?"
				)
				.get(options.principalId, options.idempotencyKey) as unknown as IdempotencyRow | undefined;
			if (existing && existing.expires_at > options.now) {
				if (existing.command_hash !== options.commandHash) {
					throw new OrchestratorError(
						"idempotency_conflict",
						`Idempotency key ${options.idempotencyKey} was used for another command`
					);
				}
				const result = parseChecked<CommandResult>(
					existing.result_json,
					checkCommandResult,
					`Idempotency result ${options.idempotencyKey}`
				);
				this.#db.exec("COMMIT");
				return result;
			}
			if (existing) {
				this.#db
					.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?")
					.run(options.principalId, options.idempotencyKey);
			}
			const operation = this.#db
				.prepare(
					"SELECT operation_id FROM operations WHERE session_id = ? AND status IN ('running', 'queued') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at, operation_id LIMIT 1"
				)
				.get(options.sessionId) as unknown as { operation_id: string } | undefined;
			if (!operation) throw new OrchestratorError("conflict", `Session ${options.sessionId} has no active turn`);
			this.#db
				.prepare("UPDATE operations SET abort_requested = 1, updated_at = ? WHERE operation_id = ?")
				.run(options.now, operation.operation_id);
			if (!checkCommandResult.Check(options.result)) throw new OrchestratorError("conflict", "Invalid abort result");
			this.#db
				.prepare(
					"INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
				)
				.run(
					options.principalId,
					options.idempotencyKey,
					options.commandHash,
					JSON.stringify(options.result),
					options.now,
					options.expiresAt
				);
			this.#db.exec("COMMIT");
			return options.result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	countQueuedOperations(sessionId: string): number {
		const row = this.#db
			.prepare("SELECT COUNT(*) AS count FROM operations WHERE session_id = ? AND status = 'queued'")
			.get(sessionId) as unknown as { count: number };
		return Number(row.count);
	}

	markRunningOperationsInterrupted(now: number): number {
		const result = this.#db
			.prepare(
				"UPDATE operations SET status = 'interrupted', updated_at = ?, finished_at = ?, error = 'worker interrupted' WHERE status = 'running'"
			)
			.run(now, now);
		return Number(result.changes);
	}

	clearWriterLeases(): number {
		return Number(this.#db.prepare("DELETE FROM writer_leases").run().changes);
	}

	acquireWriterLease(sessionId: string, ownerId: string, now: number, ttlMs: number): WriterLease {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const session = this.#db.prepare("SELECT 1 FROM session_snapshots WHERE session_id = ?").get(sessionId);
			if (!session) throw new OrchestratorError("not_found", `Session ${sessionId} does not exist`);
			const current = this.#db
				.prepare("SELECT session_id, owner_id, fence, expires_at FROM writer_leases WHERE session_id = ?")
				.get(sessionId) as unknown as LeaseRow | undefined;
			if (current && current.owner_id !== ownerId && current.expires_at > now) {
				throw new OrchestratorError("lease_conflict", `Session ${sessionId} already has an active writer`);
			}
			const fence = (current?.fence ?? 0) + 1;
			const expiresAt = now + ttlMs;
			this.#db
				.prepare(
					"INSERT INTO writer_leases(session_id, owner_id, fence, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET owner_id = excluded.owner_id, fence = excluded.fence, expires_at = excluded.expires_at"
				)
				.run(sessionId, ownerId, fence, expiresAt);
			this.#db.exec("COMMIT");
			return { sessionId, ownerId, fence, expiresAt };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	renewWriterLease(lease: WriterLease, now: number, ttlMs: number): WriterLease {
		const expiresAt = now + ttlMs;
		const result = this.#db
			.prepare(
				"UPDATE writer_leases SET expires_at = ? WHERE session_id = ? AND owner_id = ? AND fence = ? AND expires_at > ?"
			)
			.run(expiresAt, lease.sessionId, lease.ownerId, lease.fence, now);
		if (Number(result.changes) !== 1)
			throw new OrchestratorError("lease_lost", `Writer lease for ${lease.sessionId} was lost`);
		return { ...lease, expiresAt };
	}

	releaseWriterLease(lease: WriterLease): void {
		this.#db
			.prepare("DELETE FROM writer_leases WHERE session_id = ? AND owner_id = ? AND fence = ?")
			.run(lease.sessionId, lease.ownerId, lease.fence);
	}
}

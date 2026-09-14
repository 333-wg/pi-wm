import { createHash, randomUUID } from "node:crypto";
import { HookPipeline, type CapabilityJson, type HookPoint } from "@wuming/capability-kernel";
import { EMPTY_USAGE, reduceSessionEvent, type SessionEvent } from "@wuming/domain";
import { clampModelThinkingLevel } from "@wuming/protocol";
import type {
	ApprovalPolicy,
	AutomationRunSummary,
	AutomationSchedule,
	CommandResult,
	ContextUsageState,
	GoalExecutionMode,
	GoalAutomationSummary,
	GoalPlanSpec,
	GoalPlanStepSummary,
	GoalPlanSummary,
	GoalReviewCheck,
	GoalSummary,
	MemoryAction,
	ModelRef,
	ProgressEvent,
	SandboxMode,
	SessionSnapshot,
	SubagentSummary,
	ThinkingLevel,
	TranscriptItem,
	Usage,
	UsageRequestSummary,
	UsageToolSummary,
	UserContentPart,
} from "@wuming/protocol";
import { OrchestratorError } from "./errors.js";
import { createDurableMemory } from "./memory.js";
import { verificationEvidence } from "./verification.js";
import {
	appendForkTitle,
	isAutomaticSessionTitle,
	suggestSessionTitle,
	suggestSessionTitleFromTranscript,
	wasLegacyForkTitle,
} from "./session-title.js";
import { SqliteOrchestratorStore } from "./store.js";
import type {
	AgentRuntime,
	DurableAutomationRun,
	DurableGoal,
	DurableGoalAutomation,
	DurableGoalPlan,
	DurableGoalPlanStep,
	DurableMemory,
	DurableOperation,
	RuntimeCompactionRecord,
	RuntimeCompactionResult,
	RuntimeTurnResult,
	StructuredLogger,
	TurnMode,
	TurnOperationPayload,
	WriterLease,
} from "./types.js";

export interface CreateSessionInput {
	principalId: string;
	idempotencyKey: string;
	workspaceId: string;
	name?: string;
	model: ModelRef;
	thinkingLevel: ThinkingLevel;
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
	costBudgetUsd?: number;
	tokenBudget?: number;
	budgetWarningThreshold?: number;
}

export interface AcceptTurnInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	mode: TurnMode;
	content: UserContentPart[];
	runtimeContent?: UserContentPart[];
	skills?: string[];
	goalId?: string;
}

export interface AbortTurnInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
}

export interface RenameSessionInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	name: string;
}

export interface ArchiveSessionInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	archived: boolean;
}

export interface ForkSessionInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	fromItemId?: string;
}

export interface SetSessionModelInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	model: ModelRef;
	thinkingLevels?: readonly ThinkingLevel[];
}

export interface SetSessionThinkingInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	thinkingLevel: ThinkingLevel;
}

export interface SetSessionPolicyInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
}

export interface SetSessionBudgetInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	costBudgetUsd?: number | null;
	tokenBudget?: number | null;
	budgetWarningThreshold?: number;
}

export interface CompactSessionInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	instructions?: string;
}

export interface ManageMemoryInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	memoryId: string;
	action: MemoryAction;
}

export interface CreateSubagentInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	task: string;
	name?: string;
	costBudgetUsd?: number;
	tokenBudget?: number;
	/**
	 * The caller waits for this subagent and returns its result itself — used by the
	 * model-facing `subagent` tool, where the child's answer becomes the tool result
	 * in the parent's own context instead of a separate parent transcript item.
	 */
	deliverInline?: boolean;
}

export interface CancelSubagentInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	subagentId: string;
}

export interface CreateGoalInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	objective: string;
	skillId?: string;
	executionMode?: GoalExecutionMode;
	title?: string;
	successCriteria?: string;
	maxRounds?: number;
	plan?: GoalPlanSpec;
}

export interface GoalCommandInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	goalId: string;
}

export interface CreateAutomationInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	objective: string;
	title?: string;
	schedule: AutomationSchedule;
	successCriteria?: string;
	maxRounds?: number;
	plan?: GoalPlanSpec;
}

export interface AutomationCommandInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	automationId: string;
}

export interface SetAutomationEnabledInput extends AutomationCommandInput {
	enabled: boolean;
}

export interface SessionOrchestratorOptions {
	clock?: () => number;
	idFactory?: () => string;
	idempotencyTtlMs?: number;
	leaseTtlMs?: number;
	turnTimeoutMs?: number;
	abortGraceMs?: number;
	forceTerminateTimeoutMs?: number;
	defaultCostBudgetUsd?: number;
	maxRetries?: number;
	retryBaseDelayMs?: number;
	logger?: StructuredLogger;
	hookPipeline?: HookPipeline;
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
		.join(",")}}`;
}

function commandHash(value: unknown): string {
	return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function normalizeSkills(skills: string[] | undefined): string[] {
	return [...new Set((skills ?? []).slice(0, 8))];
}

function normalizeGoalPlanSpec(
	input: GoalPlanSpec
): Required<Pick<GoalPlanSpec, "maxParallel" | "failurePolicy">> & Pick<GoalPlanSpec, "steps"> {
	if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 20)
		throw new OrchestratorError("conflict", "Goal plans require between 1 and 20 steps");
	const maxParallel = input.maxParallel ?? 2;
	if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 4)
		throw new OrchestratorError("conflict", "Goal plan parallelism must be between 1 and 4");
	const failurePolicy = input.failurePolicy ?? "fail_fast";
	if (failurePolicy !== "fail_fast" && failurePolicy !== "continue_independent")
		throw new OrchestratorError("conflict", "Goal plan failure policy is invalid");
	const steps = input.steps.map((candidate) => {
		const id = candidate.id.trim();
		const title = candidate.title.trim();
		const objective = candidate.objective.trim();
		const dependsOn = [...new Set(candidate.dependsOn.map((dependency) => dependency.trim()))];
		const successCriteria = candidate.successCriteria?.trim();
		if (!id || id.length > 200 || !title || title.length > 500 || !objective || objective.length > 20_000)
			throw new OrchestratorError("conflict", "Goal plan steps contain invalid required fields");
		if (dependsOn.some((dependency) => !dependency || dependency.length > 200))
			throw new OrchestratorError("conflict", `Goal plan step ${id} contains an invalid dependency`);
		if (candidate.dependsOn.length !== dependsOn.length)
			throw new OrchestratorError("conflict", `Goal plan step ${id} contains duplicate dependencies`);
		if (candidate.successCriteria !== undefined && (!successCriteria || successCriteria.length > 4000))
			throw new OrchestratorError("conflict", `Goal plan step ${id} has invalid success criteria`);
		if (candidate.maxRounds !== undefined && !successCriteria)
			throw new OrchestratorError("conflict", `Goal plan step ${id} max rounds require success criteria`);
		const maxRounds = successCriteria ? (candidate.maxRounds ?? 3) : undefined;
		if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5))
			throw new OrchestratorError("conflict", `Goal plan step ${id} max rounds must be between 1 and 5`);
		return {
			id,
			title,
			objective,
			dependsOn,
			...(successCriteria === undefined || maxRounds === undefined ? {} : { successCriteria, maxRounds }),
		};
	});
	const ids = new Set<string>();
	for (const step of steps) {
		if (ids.has(step.id)) throw new OrchestratorError("conflict", `Goal plan step ID ${step.id} is duplicated`);
		ids.add(step.id);
	}
	for (const step of steps) {
		for (const dependency of step.dependsOn) {
			if (dependency === step.id)
				throw new OrchestratorError("conflict", `Goal plan step ${step.id} cannot depend on itself`);
			if (!ids.has(dependency))
				throw new OrchestratorError("conflict", `Goal plan step ${step.id} depends on unknown step ${dependency}`);
		}
	}
	const remaining = new Map(steps.map((step) => [step.id, step.dependsOn.length]));
	const dependents = new Map<string, string[]>();
	for (const step of steps)
		for (const dependency of step.dependsOn)
			dependents.set(dependency, [...(dependents.get(dependency) ?? []), step.id]);
	const ready = steps.filter((step) => step.dependsOn.length === 0).map((step) => step.id);
	let visited = 0;
	for (let index = 0; index < ready.length; index += 1) {
		visited += 1;
		for (const dependent of dependents.get(ready[index]!) ?? []) {
			const count = (remaining.get(dependent) ?? 0) - 1;
			remaining.set(dependent, count);
			if (count === 0) ready.push(dependent);
		}
	}
	if (visited !== steps.length) throw new OrchestratorError("conflict", "Goal plan dependencies contain a cycle");
	return { steps, maxParallel, failurePolicy };
}

function durableGoalPlan(input: GoalPlanSpec): DurableGoalPlan {
	const normalized = normalizeGoalPlanSpec(input);
	return { ...normalized, phase: "pending" };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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

function deltaUsage(after: Usage, before: Usage): Usage {
	return {
		inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
		outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
		cacheReadTokens: Math.max(0, after.cacheReadTokens - before.cacheReadTokens),
		cacheWriteTokens: Math.max(0, after.cacheWriteTokens - before.cacheWriteTokens),
		totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
		costUsd: Math.max(0, after.costUsd - before.costUsd),
	};
}

function hasUsage(usage: Usage): boolean {
	return (
		usage.totalTokens > 0 ||
		usage.costUsd > 0 ||
		usage.inputTokens > 0 ||
		usage.outputTokens > 0 ||
		usage.cacheReadTokens > 0 ||
		usage.cacheWriteTokens > 0
	);
}

function mergeTools(
	left: UsageToolSummary[] | undefined,
	right: UsageToolSummary[] | undefined
): UsageToolSummary[] | undefined {
	if (!left && !right) return undefined;
	const merged = new Map<string, UsageToolSummary>();
	for (const item of [...(left ?? []), ...(right ?? [])]) {
		const current = merged.get(item.toolName);
		merged.set(
			item.toolName,
			current
				? {
						...current,
						callCount: current.callCount + item.callCount,
						usage: addUsage(current.usage, item.usage),
						...(current.durationMs !== undefined || item.durationMs !== undefined
							? { durationMs: (current.durationMs ?? 0) + (item.durationMs ?? 0) }
							: {}),
						...(current.succeededCount !== undefined || item.succeededCount !== undefined
							? { succeededCount: (current.succeededCount ?? 0) + (item.succeededCount ?? 0) }
							: {}),
						...(current.failedCount !== undefined || item.failedCount !== undefined
							? { failedCount: (current.failedCount ?? 0) + (item.failedCount ?? 0) }
							: {}),
						...(current.abortedCount !== undefined || item.abortedCount !== undefined
							? { abortedCount: (current.abortedCount ?? 0) + (item.abortedCount ?? 0) }
							: {}),
						...(current.mcpServerId || item.mcpServerId
							? { mcpServerId: current.mcpServerId ?? item.mcpServerId! }
							: {}),
						...(current.mcpToolName || item.mcpToolName
							? { mcpToolName: current.mcpToolName ?? item.mcpToolName! }
							: {}),
					}
				: item
		);
	}
	return [...merged.values()];
}

function waitForWork(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const finish = () => {
			signal.removeEventListener("abort", finish);
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}

function subagentTask(snapshot: SessionSnapshot): string {
	const user = snapshot.transcript.find((item) => item.type === "user");
	if (!user || user.type !== "user") return snapshot.session.name ?? "Subagent task";
	return (
		user.content
			.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.slice(0, 20_000) ||
		snapshot.session.name ||
		"Subagent task"
	);
}

function subagentResult(snapshot: SessionSnapshot): string | undefined {
	const assistant = [...snapshot.transcript].reverse().find((item) => item.type === "assistant");
	if (!assistant || assistant.type !== "assistant") return undefined;
	const text = assistant.content
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return (text || assistant.error)?.slice(0, 200_000);
}

function operationResult(snapshot: SessionSnapshot, operation: DurableOperation): string | undefined {
	if (operation.payload.type !== "turn") return undefined;
	const start = snapshot.transcript.findIndex((item) => item.id === operation.payload.userItemId);
	if (start < 0) return undefined;
	const following = snapshot.transcript.slice(start + 1);
	const nextUser = following.findIndex((item) => item.type === "user");
	const turnItems = nextUser < 0 ? following : following.slice(0, nextUser);
	const assistant = [...turnItems].reverse().find((item) => item.type === "assistant");
	if (!assistant || assistant.type !== "assistant") return undefined;
	const text = assistant.content
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return (text || assistant.error)?.slice(0, 200_000);
}

export const MAX_SUBAGENT_DEPTH = 3;

function summarizeSubagent(snapshot: SessionSnapshot, operation: DurableOperation, depth: number): SubagentSummary {
	const status =
		snapshot.session.phase === "awaiting_approval" && (operation.status === "queued" || operation.status === "running")
			? ("awaiting_approval" as const)
			: operation.abortRequested && (operation.status === "queued" || operation.status === "running")
				? ("cancelling" as const)
				: operation.status === "interrupted"
					? ("cancelled" as const)
					: operation.status;
	const result = operation.status === "completed" ? subagentResult(snapshot) : undefined;
	return {
		id: snapshot.session.id,
		parentSessionId: snapshot.session.parentSessionId!,
		sessionId: snapshot.session.id,
		operationId: operation.id,
		name: snapshot.session.name ?? "Subagent",
		task: subagentTask(snapshot),
		depth,
		status,
		createdAt: operation.createdAt,
		updatedAt: Math.max(snapshot.session.updatedAt, operation.updatedAt),
		...(operation.startedAt === undefined ? {} : { startedAt: operation.startedAt }),
		...(operation.finishedAt === undefined ? {} : { finishedAt: operation.finishedAt }),
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		sandboxMode: snapshot.sandboxMode,
		approvalPolicy: snapshot.approvalPolicy,
		usage: snapshot.usage,
		...(snapshot.costBudgetUsd === undefined ? {} : { costBudgetUsd: snapshot.costBudgetUsd }),
		...(snapshot.tokenBudget === undefined ? {} : { tokenBudget: snapshot.tokenBudget }),
		pendingApprovals: snapshot.pendingApprovals,
		...(result === undefined ? {} : { result }),
		...(operation.error === undefined ? {} : { error: operation.error.slice(0, 4000) }),
	};
}

interface GoalProjection {
	usage?: Usage;
	result?: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	updatedAt?: number;
	pendingApprovals?: GoalSummary["pendingApprovals"];
	plan?: GoalPlanSummary;
}

interface GoalRunSummary {
	status: GoalSummary["status"];
	operationId?: string;
	updatedAt: number;
	startedAt?: number;
	finishedAt?: number;
	usage: Usage;
	pendingApprovals: GoalSummary["pendingApprovals"];
	result?: string;
	error?: string;
}

function summarizeGoalPlan(plan: DurableGoalPlan, children: ReadonlyMap<string, GoalSummary>): GoalPlanSummary {
	const statuses = new Map<string, GoalPlanStepSummary["status"]>();
	for (const step of plan.steps) {
		const child = step.goalId ? children.get(step.goalId) : undefined;
		if (step.skippedAt !== undefined) statuses.set(step.id, "skipped");
		else if (child) statuses.set(step.id, child.status);
	}
	const steps = plan.steps.map((step): GoalPlanStepSummary => {
		const child = step.goalId ? children.get(step.goalId) : undefined;
		const status: GoalPlanStepSummary["status"] =
			step.skippedAt !== undefined
				? "skipped"
				: (child?.status ??
					(step.dependsOn.every((dependency) => statuses.get(dependency) === "completed") ? "pending" : "blocked"));
		return {
			id: step.id,
			title: step.title,
			objective: step.objective,
			dependsOn: step.dependsOn,
			status,
			...(step.goalId === undefined ? {} : { goalId: step.goalId }),
			...(child?.runSessionId === undefined ? {} : { runSessionId: child.runSessionId }),
			...(child?.operationId === undefined ? {} : { operationId: child.operationId }),
			...(child?.startedAt === undefined ? {} : { startedAt: child.startedAt }),
			...(child?.finishedAt === undefined && step.skippedAt === undefined
				? {}
				: { finishedAt: child?.finishedAt ?? step.skippedAt }),
			usage: child?.usage ?? EMPTY_USAGE,
			...(step.costBudgetUsd === undefined ? {} : { costBudgetUsd: step.costBudgetUsd }),
			...(step.tokenBudget === undefined ? {} : { tokenBudget: step.tokenBudget }),
			pendingApprovals: child?.pendingApprovals ?? [],
			...(child?.result === undefined ? {} : { result: child.result }),
			...(child?.error === undefined ? {} : { error: child.error }),
			...(step.skipReason === undefined ? {} : { skipReason: step.skipReason }),
			...(child?.successCriteria === undefined
				? step.successCriteria === undefined
					? {}
					: { successCriteria: step.successCriteria }
				: { successCriteria: child.successCriteria }),
			...(child?.round === undefined ? {} : { round: child.round }),
			...(child?.maxRounds === undefined
				? step.maxRounds === undefined
					? {}
					: { maxRounds: step.maxRounds }
				: { maxRounds: child.maxRounds }),
			...(child?.reviewPhase === undefined ? {} : { reviewPhase: child.reviewPhase }),
			...(child?.reviewHistory === undefined ? {} : { reviewHistory: child.reviewHistory }),
		};
	});
	return {
		phase: plan.phase,
		maxParallel: plan.maxParallel,
		failurePolicy: plan.failurePolicy,
		steps,
	};
}

function summarizeGoal(
	goal: DurableGoal,
	subagent?: GoalRunSummary | SubagentSummary,
	projection: GoalProjection = {}
): GoalSummary {
	const review = goal.review;
	const plan = projection.plan ?? (goal.plan ? summarizeGoalPlan(goal.plan, new Map()) : undefined);
	const planStatuses = plan?.steps.map((step) => step.status) ?? [];
	const status =
		goal.cancelledAt !== undefined || plan?.phase === "cancelled" || review?.phase === "cancelled"
			? ("cancelled" as const)
			: goal.pausedAt !== undefined
				? ("paused" as const)
				: plan?.phase === "completed"
					? ("completed" as const)
					: plan?.phase === "failed"
						? ("failed" as const)
						: plan?.phase === "pending"
							? ("pending" as const)
							: plan?.phase === "running"
								? planStatuses.includes("cancelling")
									? ("cancelling" as const)
									: planStatuses.includes("awaiting_approval")
										? ("awaiting_approval" as const)
										: planStatuses.includes("running")
											? ("running" as const)
											: ("queued" as const)
								: review?.phase === "passed"
									? ("completed" as const)
									: review?.phase === "failed"
										? ("failed" as const)
										: review?.phase === "pending"
											? ("pending" as const)
											: (review?.phase === "executing" || review?.phase === "reviewing") &&
												  (subagent?.status === "completed" ||
														subagent?.status === "failed" ||
														subagent?.status === "cancelled")
												? ("running" as const)
												: (subagent?.status ??
													(goal.runSessionId === undefined ? ("pending" as const) : ("queued" as const)));
	const startedAt = goal.startedAt ?? projection.startedAt ?? subagent?.startedAt;
	const finishedAt =
		goal.cancelledAt ??
		projection.finishedAt ??
		(status === "completed" || status === "failed" || status === "cancelled" ? subagent?.finishedAt : undefined);
	const result = projection.result ?? (review ? undefined : subagent?.result);
	const error = projection.error ?? (review ? undefined : subagent?.error);
	return {
		id: goal.id,
		parentSessionId: goal.parentSessionId,
		title: goal.title,
		objective: goal.objective,
		...(goal.skillId === undefined ? {} : { skillId: goal.skillId }),
		...(goal.executionMode === undefined ? {} : { executionMode: goal.executionMode }),
		status,
		createdAt: goal.createdAt,
		updatedAt: Math.max(goal.updatedAt, subagent?.updatedAt ?? goal.updatedAt, projection.updatedAt ?? goal.updatedAt),
		...(goal.runSessionId === undefined ? {} : { runSessionId: goal.runSessionId }),
		...(goal.operationId === undefined ? {} : { operationId: goal.operationId }),
		...(subagent?.operationId === undefined ? {} : { operationId: subagent.operationId }),
		...(goal.pausedAt === undefined ? {} : { pausedAt: goal.pausedAt }),
		...(goal.accumulatedRunMs === undefined ? {} : { accumulatedRunMs: goal.accumulatedRunMs }),
		...(startedAt === undefined ? {} : { startedAt }),
		...(finishedAt === undefined ? {} : { finishedAt }),
		usage: projection.usage ?? subagent?.usage ?? EMPTY_USAGE,
		pendingApprovals: projection.pendingApprovals ?? subagent?.pendingApprovals ?? [],
		...(result === undefined ? {} : { result }),
		...(error === undefined ? {} : { error: error.slice(0, 4000) }),
		...(review === undefined
			? {}
			: {
					successCriteria: review.successCriteria,
					round: review.round,
					maxRounds: review.maxRounds,
					reviewPhase: review.phase,
					reviewHistory: review.history,
				}),
		...(plan === undefined ? {} : { plan }),
	};
}

function summarizeAutomation(automation: DurableGoalAutomation): GoalAutomationSummary {
	const status = automation.enabled
		? ("active" as const)
		: automation.schedule.kind === "once" && automation.nextRunAt === undefined
			? ("completed" as const)
			: ("paused" as const);
	return {
		id: automation.id,
		parentSessionId: automation.parentSessionId,
		title: automation.title,
		objective: automation.objective,
		schedule: automation.schedule,
		status,
		createdAt: automation.createdAt,
		updatedAt: automation.updatedAt,
		...(automation.nextRunAt === undefined ? {} : { nextRunAt: automation.nextRunAt }),
		...(automation.lastRunAt === undefined ? {} : { lastRunAt: automation.lastRunAt }),
		...(automation.successCriteria === undefined ? {} : { successCriteria: automation.successCriteria }),
		...(automation.maxRounds === undefined ? {} : { maxRounds: automation.maxRounds }),
		...(automation.plan === undefined ? {} : { plan: automation.plan }),
	};
}

function summarizeAutomationRun(run: DurableAutomationRun, goal?: GoalSummary): AutomationRunSummary {
	const status = run.dispatchError !== undefined ? ("failed" as const) : (goal?.status ?? ("dispatching" as const));
	return {
		id: run.id,
		automationId: run.automationId,
		trigger: run.trigger,
		scheduledFor: run.scheduledFor,
		triggeredAt: run.triggeredAt,
		status,
		...(run.goalId === undefined ? {} : { goalId: run.goalId }),
		...(goal?.runSessionId === undefined ? {} : { runSessionId: goal.runSessionId }),
		...(goal?.finishedAt === undefined ? {} : { finishedAt: goal.finishedAt }),
		usage: goal?.usage ?? EMPTY_USAGE,
		pendingApprovals: goal?.pendingApprovals ?? [],
		...(goal?.result === undefined ? {} : { result: goal.result }),
		...(run.dispatchError === undefined && goal?.error === undefined
			? {}
			: { error: (run.dispatchError ?? goal?.error)!.slice(0, 4000) }),
		...(goal?.plan === undefined ? {} : { plan: goal.plan }),
	};
}

function parseGoalReview(
	text: string | undefined
): { verdict: "pass" | "fail"; feedback: string; checks: GoalReviewCheck[] } | undefined {
	if (!text) return undefined;
	const normalized = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	try {
		const value = JSON.parse(normalized) as unknown;
		if (!value || typeof value !== "object") return undefined;
		const record = value as Record<string, unknown>;
		if (record.verdict !== "pass" && record.verdict !== "fail") return undefined;
		if (typeof record.feedback !== "string") return undefined;
		if (!Array.isArray(record.checks) || record.checks.length < 1 || record.checks.length > 20) return undefined;
		const checks: GoalReviewCheck[] = [];
		for (const value of record.checks) {
			if (!value || typeof value !== "object") return undefined;
			const check = value as Record<string, unknown>;
			if (typeof check.criterion !== "string" || !check.criterion.trim()) return undefined;
			if (check.status !== "pass" && check.status !== "fail") return undefined;
			if (typeof check.evidence !== "string" || !check.evidence.trim()) return undefined;
			checks.push({
				criterion: check.criterion.trim().slice(0, 500),
				status: check.status,
				evidence: check.evidence.trim().slice(0, 2000),
			});
		}
		if ((record.verdict === "pass") !== checks.every((check) => check.status === "pass")) return undefined;
		return { verdict: record.verdict, feedback: record.feedback.trim().slice(0, 4000), checks };
	} catch {
		return undefined;
	}
}

function goalReviewPrompt(goal: DurableGoal, candidate: string, dependencies = ""): string {
	return [
		"Review the candidate result against the goal and success criteria.",
		"Independently inspect the workspace and use available tools for every relevant check. Run tests or static checks when process tools are available. Never claim a command or inspection you did not perform.",
		"Return exactly one JSON object with no commentary or markdown. Include one check for every independently verifiable criterion. The overall verdict is pass only when every check passes:",
		'{"verdict":"pass","feedback":"concise summary and required corrections","checks":[{"criterion":"criterion being checked","status":"pass","evidence":"specific observed file, command, output, or candidate fact"}]}',
		`Goal:\n${goal.objective.slice(0, dependencies ? 1000 : 7000)}`,
		...(dependencies ? [dependencies] : []),
		`Success criteria:\n${goal.review!.successCriteria}`,
		`Candidate result:\n${candidate.slice(0, 7000)}`,
	]
		.join("\n\n")
		.slice(0, 20_000);
}

function goalRetryPrompt(goal: DurableGoal, candidate: string, feedback: string, dependencies = ""): string {
	return [
		`Continue working on this goal. This is round ${goal.review!.round + 1} of ${goal.review!.maxRounds}.`,
		`Goal:\n${goal.objective.slice(0, dependencies ? 3000 : 9000)}`,
		...(dependencies ? [dependencies] : []),
		`Success criteria:\n${goal.review!.successCriteria}`,
		`Previous result:\n${candidate.slice(0, dependencies ? 3000 : 3500)}`,
		`Reviewer feedback:\n${feedback.slice(0, dependencies ? 3000 : 3500)}`,
		"Produce a corrected final result that satisfies every criterion.",
	]
		.join("\n\n")
		.slice(0, 20_000);
}

function sessionGoalPrompt(goal: DurableGoal): string {
	return [
		goal.objective,
		"Run this as a long-form goal in the current conversation.",
		"Use a Loop Engineering cycle: inspect the current state, choose the next concrete step, execute it, verify the result, then continue automatically.",
		"Keep working through tool calls and corrections until the goal is complete or a real blocker requires user input.",
		"Do not stop at a plan or status update when you can perform the next step yourself.",
	]
		.join("\n\n")
		.slice(0, 20_000);
}

function compactionMemories(
	idFactory: () => string,
	snapshot: SessionSnapshot,
	operationId: string | undefined,
	records: ReadonlyArray<RuntimeCompactionRecord | (RuntimeCompactionResult & { reason: "manual" })>,
	createdAt: number
): DurableMemory[] {
	if (records.length > 32) throw new OrchestratorError("conflict", "Runtime produced too many compaction records");
	const fromItemId = snapshot.transcript[0]?.id;
	const throughItemId = snapshot.transcript.at(-1)?.id;
	return records.map((record) =>
		createDurableMemory({
			id: idFactory(),
			sessionId: snapshot.session.id,
			...(operationId === undefined ? {} : { operationId }),
			kind: "compaction",
			reason: record.reason,
			summary: record.summary.slice(0, 20_000),
			source: {
				revision: snapshot.revision,
				...(fromItemId === undefined ? {} : { fromItemId }),
				...(throughItemId === undefined ? {} : { throughItemId }),
			},
			...(record.tokensBefore === undefined ? {} : { tokensBefore: record.tokensBefore }),
			...(record.estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter: record.estimatedTokensAfter }),
			...(record.usage === undefined ? {} : { usage: record.usage }),
			createdAt,
		})
	);
}

export class SessionOrchestrator {
	readonly #clock: () => number;
	readonly #idFactory: () => string;
	readonly #idempotencyTtlMs: number;
	readonly #leaseTtlMs: number;
	readonly #turnTimeoutMs: number;
	readonly #abortGraceMs: number;
	readonly #forceTerminateTimeoutMs: number;
	readonly #defaultCostBudgetUsd: number | undefined;
	readonly #maxRetries: number;
	readonly #retryBaseDelayMs: number;
	readonly #logger: StructuredLogger;
	readonly #hookPipeline: HookPipeline;
	readonly #progressListeners = new Set<(event: ProgressEvent) => void>();
	readonly #commandTails = new Map<string, Promise<void>>();
	readonly #activeTurns = new Map<string, { operationId: string; controller: AbortController }>();

	constructor(
		readonly store: SqliteOrchestratorStore,
		readonly runtime: AgentRuntime,
		options: SessionOrchestratorOptions = {}
	) {
		this.#clock = options.clock ?? Date.now;
		this.#idFactory = options.idFactory ?? randomUUID;
		this.#idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
		this.#leaseTtlMs = options.leaseTtlMs ?? 30_000;
		this.#turnTimeoutMs = options.turnTimeoutMs ?? 20 * 60 * 1000;
		this.#abortGraceMs = options.abortGraceMs ?? 5_000;
		this.#forceTerminateTimeoutMs = options.forceTerminateTimeoutMs ?? 2_000;
		this.#defaultCostBudgetUsd = options.defaultCostBudgetUsd;
		this.#maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 0));
		this.#retryBaseDelayMs = Math.max(0, Math.floor(options.retryBaseDelayMs ?? 1000));
		this.#logger = options.logger ?? { log: () => {} };
		this.#hookPipeline = options.hookPipeline ?? new HookPipeline({ clock: this.#clock });
		if (
			this.#defaultCostBudgetUsd !== undefined &&
			(!Number.isFinite(this.#defaultCostBudgetUsd) || this.#defaultCostBudgetUsd <= 0)
		) {
			throw new Error("defaultCostBudgetUsd must be a positive finite number");
		}
	}

	subscribeProgress(listener: (event: ProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	recoverInterruptedOperations(): number {
		let recovered = 0;
		for (const operation of this.store.listOperationsByStatus("running")) {
			const approvalExecutions = this.store.listApprovalExecutionsForOperation(operation.id);
			const activeApprovalExecutions = approvalExecutions.filter(
				(approval) => approval.state === "waiting" || approval.state === "approved" || approval.state === "executing"
			);
			const recoverableApproval =
				activeApprovalExecutions.length === 1 && activeApprovalExecutions[0]?.mode === "preflight"
					? activeApprovalExecutions[0]
					: undefined;
			if (recoverableApproval?.state === "waiting") {
				const snapshot = this.store.loadSnapshot(operation.sessionId);
				if (
					snapshot?.pendingApprovals.length === 1 &&
					snapshot.pendingApprovals[0]?.id === recoverableApproval.approvalId
				) {
					this.#logger.log("info", "orchestrator.recovery.approval_waiting", {
						sessionId: operation.sessionId,
						operationId: operation.id,
						approvalId: recoverableApproval.approvalId,
					});
					recovered += 1;
					continue;
				}
			}
			if (
				recoverableApproval?.state === "approved" &&
				this.store.requeueOperationForApproval(operation.id, recoverableApproval.approvalId, this.#clock())
			) {
				this.#logger.log("info", "orchestrator.recovery.approval_requeued", {
					sessionId: operation.sessionId,
					operationId: operation.id,
					approvalId: recoverableApproval.approvalId,
				});
				recovered += 1;
				continue;
			}
			if (operation.retryAfter !== undefined && approvalExecutions.length === 0) {
				this.store.recoverRetryOperation(operation.id, this.#clock());
				this.#logger.log("info", "orchestrator.recovery.retry_requeued", {
					sessionId: operation.sessionId,
					operationId: operation.id,
					attempt: operation.attempt,
					retryAfter: operation.retryAfter,
				});
				continue;
			}
			for (const approval of approvalExecutions)
				this.store.interruptApprovalExecution(approval.approvalId, this.#clock());
			const lease = this.store.acquireWriterLease(
				operation.sessionId,
				`recovery:${this.#idFactory()}`,
				this.#clock(),
				this.#leaseTtlMs
			);
			try {
				const unsafeToolState = approvalExecutions.some(
					(approval) =>
						approval.state === "executing" || approval.state === "completed" || approval.mode === "failure_retry"
				);
				this.#commitRuntimeFailure(
					operation,
					lease,
					unsafeToolState
						? "Turn interrupted by gateway restart after tool execution may have started; the tool was not replayed"
						: "Turn interrupted by gateway restart",
					true,
					true,
					undefined,
					undefined,
					undefined,
					"runtime_restart"
				);
				this.#logger.log("warn", "orchestrator.recovery.operation_interrupted", {
					sessionId: operation.sessionId,
					operationId: operation.id,
					unsafeToolState,
				});
				recovered += 1;
			} finally {
				this.store.releaseWriterLease(lease);
			}
		}
		if (recovered > 0) this.#logger.log("warn", "orchestrator.operations.recovered", { recovered });
		return recovered;
	}

	handleRecoveredApproval(approval: import("@wuming/protocol").ApprovalRequest): boolean {
		const execution = this.store.getApprovalExecution(approval.id);
		if (!execution?.operationId) return false;
		const operation = this.store.getOperation(execution.operationId);
		if (!operation || operation.status !== "running") return false;
		const now = this.#clock();
		if (approval.status === "approved" && execution.mode === "preflight" && execution.state === "approved") {
			return this.store.requeueOperationForApproval(operation.id, approval.id, now);
		}
		this.store.interruptApprovalExecution(approval.id, now);
		const lease = this.store.acquireWriterLease(
			operation.sessionId,
			`approval-recovery:${this.#idFactory()}`,
			now,
			this.#leaseTtlMs
		);
		try {
			this.#commitRuntimeFailure(
				operation,
				lease,
				`Recovered approval was ${approval.status}; the interrupted tool was not executed`,
				approval.status === "cancelled",
				false,
				undefined,
				undefined,
				undefined,
				approval.status === "cancelled" ? "user_abort" : "tool"
			);
		} finally {
			this.store.releaseWriterLease(lease);
		}
		return true;
	}

	async resumeQueuedSessions(): Promise<number> {
		const queued = this.store.listOperationsByStatus("queued");
		const sessions = new Map<string, number>();
		for (const operation of queued) {
			if (!sessions.has(operation.sessionId)) sessions.set(operation.sessionId, operation.retryAfter ?? 0);
		}
		const counts = await Promise.all(
			[...sessions].map(async ([sessionId, dueAt]) => {
				const delayMs = Math.max(0, dueAt - this.#clock());
				if (delayMs > 0) await waitForWork(delayMs, new AbortController().signal);
				return this.drainSession(sessionId);
			})
		);
		return counts.reduce((total, count) => total + count, 0);
	}

	async reconcileSubagentResults(batchSize = 1000): Promise<number> {
		let published = 0;
		const size = Math.max(1, Math.min(10_000, Math.trunc(batchSize)));
		for (let offset = 0; ; offset += size) {
			const children = this.store.listAllChildSnapshots(size, offset);
			for (const child of children) {
				const parentSessionId = child.session.parentSessionId;
				if (!parentSessionId) continue;
				const operation = this.store.listOperations(child.session.id, 1)[0];
				if (!operation || operation.status === "queued" || operation.status === "running") continue;
				const parent = this.store.loadSnapshot(parentSessionId);
				if (!parent || !this.#subagentPublishPending(parent, child, operation)) continue;
				await this.publishSubagentResult(parentSessionId, child.session.id);
				published += 1;
			}
			if (children.length < size) break;
		}
		return published;
	}

	async #serializeCommand<T>(sessionId: string, action: () => T | Promise<T>): Promise<T> {
		const previous = this.#commandTails.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		this.#commandTails.set(sessionId, tail);
		await previous;
		try {
			return await action();
		} finally {
			release();
			if (this.#commandTails.get(sessionId) === tail) this.#commandTails.delete(sessionId);
		}
	}

	async createSession(input: CreateSessionInput): Promise<Extract<CommandResult, { type: "session.created" }>> {
		return this.#serializeCommand(`create:${input.principalId}:${input.idempotencyKey}`, () => {
			if (input.costBudgetUsd !== undefined && (!Number.isFinite(input.costBudgetUsd) || input.costBudgetUsd <= 0)) {
				throw new OrchestratorError("conflict", "costBudgetUsd must be a positive finite number");
			}
			if (input.tokenBudget !== undefined && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0))
				throw new OrchestratorError("conflict", "tokenBudget must be a positive integer");
			if (
				input.budgetWarningThreshold !== undefined &&
				(!Number.isFinite(input.budgetWarningThreshold) ||
					input.budgetWarningThreshold <= 0 ||
					input.budgetWarningThreshold > 1)
			)
				throw new OrchestratorError("conflict", "budgetWarningThreshold must be between 0 and 1");
			const now = this.#clock();
			const hash = commandHash({
				type: "session.create",
				workspaceId: input.workspaceId,
				name: input.name,
				model: input.model,
				thinkingLevel: input.thinkingLevel,
				sandboxMode: input.sandboxMode,
				approvalPolicy: input.approvalPolicy,
				costBudgetUsd: input.costBudgetUsd,
				tokenBudget: input.tokenBudget,
				budgetWarningThreshold: input.budgetWarningThreshold,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.created" }>;
			const sessionId = this.#idFactory();
			const costBudgetUsd = input.costBudgetUsd ?? this.#defaultCostBudgetUsd;
			const event: SessionEvent = {
				type: "session.created",
				eventId: this.#idFactory(),
				sessionId,
				revision: 1,
				timestamp: now,
				session: {
					id: sessionId,
					workspaceId: input.workspaceId,
					...(input.name === undefined ? {} : { name: input.name }),
					phase: "idle",
					createdAt: now,
					updatedAt: now,
				},
				model: input.model,
				thinkingLevel: input.thinkingLevel,
				sandboxMode: input.sandboxMode,
				approvalPolicy: input.approvalPolicy,
				usage: EMPTY_USAGE,
				...(costBudgetUsd === undefined ? {} : { costBudgetUsd }),
				...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
				...(input.budgetWarningThreshold === undefined ? {} : { budgetWarningThreshold: input.budgetWarningThreshold }),
			};
			const snapshot = reduceSessionEvent(undefined, event);
			const result = { type: "session.created", snapshot } as const;
			const committed = this.store.commitMutation({
				sessionId,
				expectedRevision: 0,
				events: [event],
				snapshot,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			return committed.result as Extract<CommandResult, { type: "session.created" }>;
		});
	}

	async backfillSessionNames(workspaceId: string): Promise<number> {
		const candidates = [
			...this.store.listSnapshots(workspaceId, { archived: false, limit: 200 }),
			...this.store.listSnapshots(workspaceId, { archived: true, limit: 200 }),
		];
		let renamed = 0;
		for (const candidate of candidates) {
			if (!isAutomaticSessionTitle(candidate.session.name)) continue;
			const changed = await this.#serializeCommand(candidate.session.id, () => {
				const current = this.store.loadSnapshot(candidate.session.id);
				if (!current || !isAutomaticSessionTitle(current.session.name)) return false;
				const suggested = suggestSessionTitleFromTranscript(current.transcript);
				if (!suggested) return false;
				const name = wasLegacyForkTitle(current.session.name) ? appendForkTitle(suggested) : suggested;
				const event: SessionEvent = {
					type: "session.renamed",
					eventId: this.#idFactory(),
					sessionId: current.session.id,
					revision: current.revision + 1,
					timestamp: current.session.updatedAt,
					name,
				};
				this.store.commitMutation({
					sessionId: current.session.id,
					expectedRevision: current.revision,
					events: [event],
					snapshot: reduceSessionEvent(current, event),
				});
				return true;
			});
			if (changed) renamed += 1;
		}
		return renamed;
	}

	async createSubagent(input: CreateSubagentInput): Promise<Extract<CommandResult, { type: "subagent.created" }>> {
		return this.#serializeCommand(`subagent:create:${input.sessionId}:${input.idempotencyKey}`, () => {
			const now = this.#clock();
			const task = input.task.trim();
			if (!task) throw new OrchestratorError("conflict", "Subagent task cannot be empty");
			const hash = commandHash({
				type: "subagent.create",
				sessionId: input.sessionId,
				task,
				name: input.name,
				costBudgetUsd: input.costBudgetUsd,
				tokenBudget: input.tokenBudget,
				deliverInline: input.deliverInline,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "subagent.created" }>;
			const parent = this.store.loadSnapshot(input.sessionId);
			if (!parent) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			const parentDepth = this.subagentDepth(parent.session.id);
			if (parentDepth >= MAX_SUBAGENT_DEPTH)
				throw new OrchestratorError("conflict", `Subagents are limited to ${MAX_SUBAGENT_DEPTH} levels`);
			if (parent.session.archivedAt !== undefined)
				throw new OrchestratorError("conflict", "Archived sessions cannot create subagents");
			const prepared = this.#prepareSubagent(
				parent,
				{
					task,
					...(input.name === undefined ? {} : { name: input.name }),
					...(input.costBudgetUsd === undefined ? {} : { costBudgetUsd: input.costBudgetUsd }),
					...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
					...(input.deliverInline === undefined ? {} : { deliverInline: input.deliverInline }),
				},
				now
			);
			const result = { type: "subagent.created", subagent: prepared.summary } as const;
			const committed = this.store.commitMutation({
				sessionId: prepared.snapshot.session.id,
				expectedRevision: 0,
				events: prepared.events,
				snapshot: prepared.snapshot,
				operation: prepared.operation,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			return committed.result as Extract<CommandResult, { type: "subagent.created" }>;
		});
	}

	#prepareSubagent(
		parent: SessionSnapshot,
		input: {
			task: string;
			name?: string;
			costBudgetUsd?: number;
			tokenBudget?: number;
			deliverInline?: boolean;
			skills?: string[];
		},
		now: number
	): {
		events: SessionEvent[];
		snapshot: SessionSnapshot;
		operation: DurableOperation;
		summary: SubagentSummary;
	} {
		const remainingCost =
			parent.costBudgetUsd === undefined ? undefined : Math.max(0, parent.costBudgetUsd - parent.usage.costUsd);
		const remainingTokens =
			parent.tokenBudget === undefined ? undefined : Math.max(0, parent.tokenBudget - parent.usage.totalTokens);
		if (remainingCost !== undefined && remainingCost <= 0)
			throw new OrchestratorError("budget_exceeded", "Parent session cost budget is exhausted");
		if (remainingTokens !== undefined && remainingTokens <= 0)
			throw new OrchestratorError("budget_exceeded", "Parent session token budget is exhausted");
		if (input.costBudgetUsd !== undefined && remainingCost !== undefined && input.costBudgetUsd > remainingCost)
			throw new OrchestratorError(
				"budget_exceeded",
				"Subagent cost budget exceeds the parent session remaining budget"
			);
		if (input.tokenBudget !== undefined && remainingTokens !== undefined && input.tokenBudget > remainingTokens)
			throw new OrchestratorError(
				"budget_exceeded",
				"Subagent token budget exceeds the parent session remaining budget"
			);
		const costBudgetUsd = input.costBudgetUsd ?? remainingCost;
		const tokenBudget = input.tokenBudget ?? remainingTokens;
		const sessionId = this.#idFactory();
		const operationId = this.#idFactory();
		const name = (input.name?.trim() || `Subagent: ${input.task.replace(/\s+/g, " ").slice(0, 80)}`).slice(0, 500);
		const created: SessionEvent = {
			type: "session.created",
			eventId: this.#idFactory(),
			sessionId,
			revision: 1,
			timestamp: now,
			session: {
				id: sessionId,
				workspaceId: parent.session.workspaceId,
				name,
				phase: "idle",
				createdAt: now,
				updatedAt: now,
				parentSessionId: parent.session.id,
			},
			model: parent.model,
			thinkingLevel: parent.thinkingLevel,
			sandboxMode: parent.sandboxMode,
			approvalPolicy: parent.approvalPolicy,
			usage: EMPTY_USAGE,
			...(costBudgetUsd === undefined ? {} : { costBudgetUsd }),
			...(tokenBudget === undefined ? {} : { tokenBudget }),
			...(parent.budgetWarningThreshold === undefined ? {} : { budgetWarningThreshold: parent.budgetWarningThreshold }),
		};
		let snapshot = reduceSessionEvent(undefined, created);
		const userItemId = this.#idFactory();
		const item: SessionEvent = {
			type: "session.item.upserted",
			eventId: this.#idFactory(),
			sessionId,
			revision: 2,
			timestamp: now,
			item: {
				id: userItemId,
				type: "user",
				createdAt: now,
				content: [{ type: "text", text: input.task }],
			},
		};
		snapshot = reduceSessionEvent(snapshot, item);
		const phase: SessionEvent = {
			type: "session.phase.changed",
			eventId: this.#idFactory(),
			sessionId,
			revision: 3,
			timestamp: now,
			phase: "turn",
		};
		snapshot = reduceSessionEvent(snapshot, phase);
		const operation: DurableOperation = {
			id: operationId,
			sessionId,
			type: "turn",
			status: "queued",
			payload: {
				type: "turn",
				mode: "prompt",
				userItemId,
				content: [{ type: "text", text: input.task }],
				...(input.deliverInline === undefined ? {} : { deliverInline: input.deliverInline }),
				...(input.skills === undefined ? {} : { skills: input.skills }),
			},
			attempt: 0,
			createdAt: now,
			updatedAt: now,
			abortRequested: false,
		};
		return {
			events: [created, item, phase],
			snapshot,
			operation,
			summary: summarizeSubagent(snapshot, operation, this.subagentDepth(parent.session.id) + 1),
		};
	}

	/** Return the number of parent links above a session, with primary sessions at depth zero. */
	subagentDepth(sessionId: string): number {
		let snapshot = this.store.loadSnapshot(sessionId);
		if (!snapshot) throw new OrchestratorError("not_found", `Session ${sessionId} does not exist`);
		let depth = 0;
		const visited = new Set<string>([sessionId]);
		while (snapshot.session.parentSessionId !== undefined) {
			const parentId = snapshot.session.parentSessionId;
			if (visited.has(parentId))
				throw new OrchestratorError("conflict", `Session ${sessionId} has a cyclic parent chain`);
			visited.add(parentId);
			depth += 1;
			const parent = this.store.loadSnapshot(parentId);
			if (!parent) throw new OrchestratorError("not_found", `Parent session ${parentId} does not exist`);
			snapshot = parent;
		}
		return depth;
	}

	listSubagents(parentSessionId: string, limit = 100): SubagentSummary[] {
		if (!this.store.loadSnapshot(parentSessionId))
			throw new OrchestratorError("not_found", `Session ${parentSessionId} does not exist`);
		return this.store.listChildSnapshots(parentSessionId, limit).flatMap((snapshot) => {
			const operation = this.store.listOperations(snapshot.session.id, 1)[0];
			return operation ? [summarizeSubagent(snapshot, operation, this.subagentDepth(snapshot.session.id))] : [];
		});
	}

	async createGoal(input: CreateGoalInput): Promise<Extract<CommandResult, { type: "goal.created" }>> {
		return this.#serializeCommand(`goal:create:${input.sessionId}`, () => {
			const now = this.#clock();
			const objective = input.objective.trim();
			if (!objective) throw new OrchestratorError("conflict", "Goal objective cannot be empty");
			const successCriteria = input.successCriteria?.trim();
			if (input.successCriteria !== undefined && !successCriteria)
				throw new OrchestratorError("conflict", "Goal success criteria cannot be empty");
			if (input.maxRounds !== undefined && !successCriteria)
				throw new OrchestratorError("conflict", "Goal max rounds require success criteria");
			const maxRounds = successCriteria ? (input.maxRounds ?? 3) : undefined;
			if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5))
				throw new OrchestratorError("conflict", "Goal max rounds must be between 1 and 5");
			if (input.plan && successCriteria)
				throw new OrchestratorError(
					"conflict",
					"Goal plans cannot combine with a top-level review loop; configure review per step"
				);
			if (input.executionMode === "session" && (input.plan || successCriteria))
				throw new OrchestratorError(
					"conflict",
					"Session goals currently use the live conversation loop and cannot use detached review or plan runs"
				);
			const plan = input.plan ? durableGoalPlan(input.plan) : undefined;
			const hash = commandHash({
				type: "goal.create",
				sessionId: input.sessionId,
				objective,
				skillId: input.skillId,
				executionMode: input.executionMode,
				title: input.title,
				successCriteria,
				maxRounds,
				...(plan === undefined
					? {}
					: {
							plan: {
								steps: plan.steps,
								maxParallel: plan.maxParallel,
								failurePolicy: plan.failurePolicy,
							},
						}),
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "goal.created" }>;
			const parent = this.store.loadSnapshot(input.sessionId);
			if (!parent) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (parent.session.parentSessionId !== undefined)
				throw new OrchestratorError("conflict", "Goals can only be created from a primary session");
			if (parent.session.archivedAt !== undefined)
				throw new OrchestratorError("conflict", "Archived sessions cannot create goals");
			const goal: DurableGoal = {
				id: this.#idFactory(),
				parentSessionId: input.sessionId,
				title: (input.title?.trim() || objective.replace(/\s+/g, " ").slice(0, 80)).slice(0, 500),
				objective,
				...(input.skillId === undefined ? {} : { skillId: input.skillId }),
				...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
				createdAt: now,
				updatedAt: now,
				...(successCriteria === undefined || maxRounds === undefined
					? {}
					: {
							review: {
								successCriteria,
								maxRounds,
								round: 0,
								phase: "pending" as const,
								runs: [],
								history: [],
							},
						}),
				...(plan === undefined ? {} : { plan }),
			};
			const result = { type: "goal.created", goal: summarizeGoal(goal) } as const;
			return this.store.commitGoalMutation({
				goal,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			}).result as Extract<CommandResult, { type: "goal.created" }>;
		});
	}

	listGoals(parentSessionId: string, limit = 100): GoalSummary[] {
		if (!this.store.loadSnapshot(parentSessionId))
			throw new OrchestratorError("not_found", `Session ${parentSessionId} does not exist`);
		return this.store.listGoals(parentSessionId, limit).map((goal) => this.#summarizeStoredGoal(goal));
	}

	async createAutomation(
		input: CreateAutomationInput
	): Promise<Extract<CommandResult, { type: "automation.created" }>> {
		return this.#serializeCommand(`automation:create:${input.sessionId}`, () => {
			const now = this.#clock();
			const objective = input.objective.trim();
			if (!objective) throw new OrchestratorError("conflict", "Automation objective cannot be empty");
			const successCriteria = input.successCriteria?.trim();
			if (input.successCriteria !== undefined && !successCriteria)
				throw new OrchestratorError("conflict", "Automation success criteria cannot be empty");
			if (input.maxRounds !== undefined && !successCriteria)
				throw new OrchestratorError("conflict", "Automation max rounds require success criteria");
			const maxRounds = successCriteria ? (input.maxRounds ?? 3) : undefined;
			if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5))
				throw new OrchestratorError("conflict", "Automation max rounds must be between 1 and 5");
			if (input.plan && successCriteria)
				throw new OrchestratorError("conflict", "Automation Goal plans cannot combine with a top-level review loop");
			const plan = input.plan ? normalizeGoalPlanSpec(input.plan) : undefined;
			if (input.schedule.kind === "once") {
				if (!Number.isSafeInteger(input.schedule.runAt) || input.schedule.runAt < 0)
					throw new OrchestratorError("conflict", "Automation run time is invalid");
			} else if (
				!Number.isSafeInteger(input.schedule.startsAt) ||
				input.schedule.startsAt < 0 ||
				!Number.isInteger(input.schedule.everyMinutes) ||
				input.schedule.everyMinutes < 1 ||
				input.schedule.everyMinutes > 525_600
			) {
				throw new OrchestratorError("conflict", "Automation interval schedule is invalid");
			}
			const hash = commandHash({
				type: "automation.create",
				sessionId: input.sessionId,
				objective,
				title: input.title,
				schedule: input.schedule,
				successCriteria,
				maxRounds,
				plan,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "automation.created" }>;
			const parent = this.store.loadSnapshot(input.sessionId);
			if (!parent) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (parent.session.parentSessionId !== undefined)
				throw new OrchestratorError("conflict", "Automations can only be created from a primary session");
			if (parent.session.archivedAt !== undefined)
				throw new OrchestratorError("conflict", "Archived sessions cannot create automations");
			const automation: DurableGoalAutomation = {
				id: this.#idFactory(),
				parentSessionId: input.sessionId,
				title: (input.title?.trim() || objective.replace(/\s+/g, " ").slice(0, 80)).slice(0, 500),
				objective,
				schedule: input.schedule,
				enabled: true,
				createdAt: now,
				updatedAt: now,
				nextRunAt: input.schedule.kind === "once" ? input.schedule.runAt : input.schedule.startsAt,
				...(successCriteria === undefined || maxRounds === undefined ? {} : { successCriteria, maxRounds }),
				...(plan === undefined ? {} : { plan }),
			};
			const result = {
				type: "automation.created",
				automation: summarizeAutomation(automation),
			} as const;
			return this.store.commitAutomationMutation({
				automation,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			}).result as Extract<CommandResult, { type: "automation.created" }>;
		});
	}

	listAutomations(parentSessionId: string, limit = 100): GoalAutomationSummary[] {
		if (!this.store.loadSnapshot(parentSessionId))
			throw new OrchestratorError("not_found", `Session ${parentSessionId} does not exist`);
		return this.store.listAutomations(parentSessionId, limit).map(summarizeAutomation);
	}

	async setAutomationEnabled(
		input: SetAutomationEnabledInput
	): Promise<Extract<CommandResult, { type: "automation.configured" }>> {
		return this.#serializeCommand(`automation:configure:${input.sessionId}:${input.automationId}`, () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "automation.set_enabled",
				sessionId: input.sessionId,
				automationId: input.automationId,
				enabled: input.enabled,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "automation.configured" }>;
			const automation = this.store.loadAutomation(input.automationId);
			if (!automation || automation.parentSessionId !== input.sessionId)
				throw new OrchestratorError("not_found", `Automation ${input.automationId} does not exist`);
			if (input.enabled && automation.schedule.kind === "once" && automation.nextRunAt === undefined)
				throw new OrchestratorError("conflict", "A completed one-time automation cannot be re-enabled");
			const parent = this.store.loadSnapshot(input.sessionId);
			if (!parent) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (parent.session.archivedAt !== undefined && input.enabled)
				throw new OrchestratorError("conflict", "Archived sessions cannot enable automations");
			const updated: DurableGoalAutomation = {
				...automation,
				enabled: input.enabled,
				updatedAt: Math.max(now, automation.updatedAt + 1),
			};
			const result = {
				type: "automation.configured",
				automation: summarizeAutomation(updated),
			} as const;
			return this.store.commitAutomationMutation({
				automation: updated,
				expectedUpdatedAt: automation.updatedAt,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			}).result as Extract<CommandResult, { type: "automation.configured" }>;
		});
	}

	async triggerAutomation(
		input: AutomationCommandInput
	): Promise<Extract<CommandResult, { type: "automation.triggered" }>> {
		return this.#serializeCommand(`automation:trigger:${input.sessionId}:${input.automationId}`, () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "automation.trigger",
				sessionId: input.sessionId,
				automationId: input.automationId,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "automation.triggered" }>;
			const automation = this.store.loadAutomation(input.automationId);
			if (!automation || automation.parentSessionId !== input.sessionId)
				throw new OrchestratorError("not_found", `Automation ${input.automationId} does not exist`);
			const parent = this.store.loadSnapshot(input.sessionId);
			if (!parent) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (parent.session.archivedAt !== undefined)
				throw new OrchestratorError("conflict", "Archived sessions cannot trigger automations");
			const runId = this.#idFactory();
			const initialRun: AutomationRunSummary = {
				id: runId,
				automationId: automation.id,
				trigger: "manual",
				scheduledFor: now,
				triggeredAt: now,
				status: "dispatching",
				usage: EMPTY_USAGE,
			};
			const result = { type: "automation.triggered", run: initialRun } as const;
			return this.store.claimManualAutomationRun({
				automationId: automation.id,
				runId,
				trigger: "manual",
				triggerKey: `manual:${input.principalId}:${input.idempotencyKey}`,
				scheduledFor: now,
				now,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			}).result as Extract<CommandResult, { type: "automation.triggered" }>;
		});
	}

	listAutomationRuns(parentSessionId: string, automationId: string, limit = 50): AutomationRunSummary[] {
		const automation = this.store.loadAutomation(automationId);
		if (!automation || automation.parentSessionId !== parentSessionId)
			throw new OrchestratorError("not_found", `Automation ${automationId} does not exist`);
		return this.store.listAutomationRuns(automationId, limit).map((run) => this.#summarizeAutomationRun(run));
	}

	#summarizeAutomationRun(run: DurableAutomationRun): AutomationRunSummary {
		const goal = run.goalId ? this.store.loadGoal(run.goalId) : undefined;
		return summarizeAutomationRun(run, goal ? this.#summarizeStoredGoal(goal) : undefined);
	}

	async dispatchAutomationRun(runId: string, traceId?: string): Promise<AutomationRunSummary> {
		return this.#serializeCommand(`automation:dispatch:${runId}`, async () => {
			let run = this.store.loadAutomationRun(runId);
			if (!run) throw new OrchestratorError("not_found", `Automation run ${runId} does not exist`);
			if (run.dispatchError) return this.#summarizeAutomationRun(run);
			let goal = run.goalId ? this.store.loadGoal(run.goalId) : undefined;
			if (!goal) {
				const now = this.#clock();
				const candidate: DurableGoal = {
					id: this.#idFactory(),
					parentSessionId: run.parentSessionId,
					title: run.spec.title,
					objective: run.spec.objective,
					createdAt: now,
					updatedAt: now,
					...(run.spec.successCriteria === undefined || run.spec.maxRounds === undefined
						? {}
						: {
								review: {
									successCriteria: run.spec.successCriteria,
									maxRounds: run.spec.maxRounds,
									round: 0,
									phase: "pending" as const,
									runs: [],
									history: [],
								},
							}),
					...(run.spec.plan === undefined ? {} : { plan: durableGoalPlan(run.spec.plan) }),
				};
				try {
					run = this.store.attachAutomationRunGoal(run.id, candidate, now);
				} catch (error) {
					const latest = this.store.loadAutomationRun(run.id);
					if (!latest?.goalId) throw error;
					run = latest;
				}
				goal = run.goalId ? this.store.loadGoal(run.goalId) : undefined;
			}
			if (!goal) throw new OrchestratorError("corrupt_storage", `Automation run ${run.id} has no attached goal`);
			const needsStart = goal.plan ? goal.plan.phase === "pending" : goal.runSessionId === undefined;
			if (needsStart) {
				try {
					await this.startGoal({
						principalId: "system:automation",
						idempotencyKey: `automation:${run.id}:start`,
						sessionId: run.parentSessionId,
						goalId: goal.id,
					});
				} catch (error) {
					if (error instanceof OrchestratorError && error.code === "lease_conflict") throw error;
					run = this.store.setAutomationRunDispatchError(
						run.id,
						error instanceof Error ? error.message : String(error),
						this.#clock()
					);
					return this.#summarizeAutomationRun(run);
				}
			}
			await this.driveGoal(run.parentSessionId, goal.id, traceId);
			return this.#summarizeAutomationRun(this.store.loadAutomationRun(run.id) ?? run);
		});
	}

	async runDueAutomations(now = this.#clock(), limit = 20): Promise<number> {
		const claimed: DurableAutomationRun[] = [];
		for (const automation of this.store.listDueAutomations(now, limit)) {
			const run = this.store.claimScheduledAutomationRun({
				automationId: automation.id,
				runId: this.#idFactory(),
				scheduledFor: automation.nextRunAt!,
				now,
			});
			if (run) claimed.push(run);
		}
		await Promise.all(
			claimed.map((run) =>
				this.dispatchAutomationRun(run.id).catch((error) => {
					if (!(error instanceof OrchestratorError && error.code === "lease_conflict"))
						this.#logger.log("error", "orchestrator.automation.dispatch_failed", {
							automationId: run.automationId,
							runId: run.id,
							error,
						});
				})
			)
		);
		return claimed.length;
	}

	async resumeAutomationRuns(limit = 1000): Promise<number> {
		let resumed = 0;
		for (const run of this.store.listRecoverableAutomationRuns(limit)) {
			const summary = this.#summarizeAutomationRun(run);
			if (["completed", "failed", "cancelled"].includes(summary.status)) continue;
			try {
				await this.dispatchAutomationRun(run.id);
				resumed += 1;
			} catch (error) {
				if (!(error instanceof OrchestratorError && error.code === "lease_conflict"))
					this.#logger.log("error", "orchestrator.automation.resume_failed", {
						automationId: run.automationId,
						runId: run.id,
						error,
					});
			}
		}
		return resumed;
	}

	#loadSubagentSummary(sessionId: string): SubagentSummary | undefined {
		const snapshot = this.store.loadSnapshot(sessionId);
		const operation = this.store.listOperations(sessionId, 1)[0];
		return snapshot && operation ? summarizeSubagent(snapshot, operation, this.subagentDepth(sessionId)) : undefined;
	}

	#loadSessionGoalRun(goal: DurableGoal): GoalRunSummary | undefined {
		if (!goal.operationId) return undefined;
		const operation = this.store.getOperation(goal.operationId);
		if (!operation || operation.sessionId !== goal.parentSessionId) return undefined;
		const snapshot = this.store.loadSnapshot(goal.parentSessionId);
		if (!snapshot) return undefined;
		const status =
			snapshot.session.phase === "awaiting_approval" &&
			(operation.status === "queued" || operation.status === "running")
				? ("awaiting_approval" as const)
				: operation.abortRequested && (operation.status === "queued" || operation.status === "running")
					? ("cancelling" as const)
					: operation.status === "interrupted"
						? ("cancelled" as const)
						: operation.status;
		const result = operation.status === "completed" ? operationResult(snapshot, operation) : undefined;
		return {
			status,
			operationId: operation.id,
			updatedAt: Math.max(snapshot.session.updatedAt, operation.updatedAt),
			...(operation.startedAt === undefined ? {} : { startedAt: operation.startedAt }),
			...(operation.finishedAt === undefined ? {} : { finishedAt: operation.finishedAt }),
			usage: operation.usage ?? EMPTY_USAGE,
			pendingApprovals: snapshot.pendingApprovals,
			...(result === undefined ? {} : { result }),
			...(operation.error === undefined ? {} : { error: operation.error.slice(0, 4000) }),
		};
	}

	#summarizeStoredGoal(goal: DurableGoal): GoalSummary {
		if (goal.plan) return this.#summarizeStoredPlanGoal(goal);
		if (goal.executionMode === "session") {
			const active = this.#loadSessionGoalRun(goal);
			return summarizeGoal(goal, active);
		}
		const active = goal.runSessionId ? this.#loadSubagentSummary(goal.runSessionId) : undefined;
		if (!goal.review) return summarizeGoal(goal, active);
		let usage = EMPTY_USAGE;
		let startedAt: number | undefined;
		let finishedAt: number | undefined;
		const summaries = new Map<string, SubagentSummary>();
		for (const run of goal.review.runs) {
			for (const sessionId of [run.workerSessionId, run.reviewerSessionId]) {
				if (!sessionId || summaries.has(sessionId)) continue;
				const summary = this.#loadSubagentSummary(sessionId);
				if (!summary) continue;
				summaries.set(sessionId, summary);
				usage = addUsage(usage, summary.usage);
				startedAt = startedAt === undefined ? summary.startedAt : Math.min(startedAt, summary.startedAt ?? startedAt);
				finishedAt = Math.max(finishedAt ?? 0, summary.finishedAt ?? 0) || finishedAt;
			}
		}
		const workerSessionId = goal.review.runs.at(-1)?.workerSessionId;
		const worker = workerSessionId
			? (summaries.get(workerSessionId) ?? this.#loadSubagentSummary(workerSessionId))
			: undefined;
		const terminal =
			goal.review.phase === "passed" || goal.review.phase === "failed" || goal.review.phase === "cancelled";
		const feedback = goal.review.history.at(-1)?.feedback;
		return summarizeGoal(goal, active, {
			usage,
			...(terminal && worker?.result !== undefined ? { result: worker.result } : {}),
			...(goal.review.phase === "failed"
				? {
						error: goal.review.failure || feedback || active?.error || worker?.error || "Goal review failed",
					}
				: {}),
			...(startedAt === undefined ? {} : { startedAt }),
			...(terminal && finishedAt !== undefined ? { finishedAt } : {}),
		});
	}

	#summarizeStoredPlanGoal(goal: DurableGoal): GoalSummary {
		return this.store.withGoalPlanSnapshot(goal.id, (current, children) =>
			this.#projectStoredPlanGoal(current, children)
		);
	}

	#projectStoredPlanGoal(goal: DurableGoal, children: DurableGoal[]): GoalSummary {
		if (!goal.plan) return summarizeGoal(goal);
		const childGoals = new Map<string, GoalSummary>();
		const referenced = goal.plan.steps.filter((step) => step.goalId !== undefined);
		if (
			children.length !== referenced.length ||
			new Set(referenced.map((step) => step.goalId)).size !== referenced.length
		) {
			throw new OrchestratorError("corrupt_storage", "Goal plan has inconsistent child references");
		}
		for (const child of children) {
			const step = goal.plan.steps.find((candidate) => candidate.goalId === child.id);
			if (!step || step.id !== child.planStepId || child.parentSessionId !== goal.parentSessionId) {
				throw new OrchestratorError("corrupt_storage", "Goal plan child ownership does not match its step");
			}
			childGoals.set(child.id, this.#summarizeStoredGoal(child));
		}
		const plan = summarizeGoalPlan(goal.plan, childGoals);
		let usage = EMPTY_USAGE;
		let startedAt: number | undefined;
		let finishedAt: number | undefined;
		let updatedAt = goal.updatedAt;
		const pendingApprovals: GoalSummary["pendingApprovals"] = [];
		for (const child of childGoals.values()) {
			usage = addUsage(usage, child.usage);
			updatedAt = Math.max(updatedAt, child.updatedAt);
			if (child.startedAt !== undefined)
				startedAt = startedAt === undefined ? child.startedAt : Math.min(startedAt, child.startedAt);
			if (child.finishedAt !== undefined) finishedAt = Math.max(finishedAt ?? 0, child.finishedAt) || finishedAt;
			pendingApprovals.push(...child.pendingApprovals);
		}
		const dependedOn = new Set(goal.plan.steps.flatMap((step) => step.dependsOn));
		const sinks = plan.steps.filter(
			(step) => !dependedOn.has(step.id) && step.status === "completed" && step.result !== undefined
		);
		const sinkResults = sinks.map((step) => ({ title: step.title, result: step.result! }));
		const result =
			goal.plan.phase === "completed"
				? (sinkResults.length === 1
						? sinkResults[0]!.result
						: sinkResults.map((step) => `## ${step.title}\n\n${step.result}`).join("\n\n")
					).slice(0, 200_000)
				: undefined;
		const failed = plan.steps.find((step) => step.status === "failed");
		const error =
			goal.plan.phase === "failed"
				? (failed?.error ?? (failed ? `Plan step ${failed.title} failed` : "Goal plan failed"))
				: undefined;
		return summarizeGoal(goal, undefined, {
			usage,
			...(startedAt === undefined ? {} : { startedAt }),
			...((goal.plan.phase === "completed" || goal.plan.phase === "failed" || goal.plan.phase === "cancelled") &&
			finishedAt !== undefined
				? { finishedAt }
				: {}),
			updatedAt,
			pendingApprovals,
			plan,
			...(result === undefined ? {} : { result }),
			...(error === undefined ? {} : { error }),
		});
	}

	#goalPlanStepExecutionPrompt(goal: DurableGoal): string {
		if (!goal.ownerGoalId || !goal.planStepId) return goal.objective;
		const owner = this.store.loadGoal(goal.ownerGoalId);
		const step = owner?.plan?.steps.find((candidate) => candidate.id === goal.planStepId);
		if (!owner?.plan || owner.plan.phase !== "running" || !step || step.goalId !== goal.id)
			throw new OrchestratorError("conflict", `Plan step ${goal.planStepId} is not ready to execute`);
		return [
			"Execute this step of a durable multi-step goal. Work in the shared workspace, verify your changes, and return a concise result for downstream steps.",
			`Overall goal:\n${owner.objective.slice(0, 4000)}`,
			`Current step ${step.id} (${step.title}):\n${step.objective.slice(0, 7000)}`,
			this.#goalPlanDependencyContext(goal),
		]
			.filter(Boolean)
			.join("\n\n")
			.slice(0, 20_000);
	}

	#goalPlanDependencyContext(goal: DurableGoal): string {
		if (!goal.ownerGoalId || !goal.planStepId) return "";
		const owner = this.store.loadGoal(goal.ownerGoalId);
		const step = owner?.plan?.steps.find((candidate) => candidate.id === goal.planStepId);
		if (!owner?.plan || !step || step.goalId !== goal.id)
			throw new OrchestratorError("conflict", "Plan step owner is missing");
		const dependencies: Array<{ header: string; text: string }> = [];
		for (const dependencyId of step.dependsOn) {
			const dependency = owner.plan.steps.find((candidate) => candidate.id === dependencyId);
			const dependencyGoal = dependency?.goalId ? this.store.loadGoal(dependency.goalId) : undefined;
			const summary = dependencyGoal ? this.#summarizeStoredGoal(dependencyGoal) : undefined;
			if (!dependency || summary?.status !== "completed")
				throw new OrchestratorError("conflict", `Plan step ${step.id} is blocked by ${dependencyId}`);
			dependencies.push({
				header: `Dependency ${dependency.id} (${dependency.title.slice(0, 40)}):\n`,
				text: summary.result ?? "The dependency completed without a textual result.",
			});
		}
		if (dependencies.length === 0) return "";
		const prefix = "Completed dependency results:\n\n";
		const overhead = prefix.length + dependencies.reduce((sum, entry) => sum + entry.header.length + 2, 0);
		const allowance = Math.floor((6000 - overhead) / dependencies.length);
		const marker = "\n[truncated]";
		return (
			prefix +
			dependencies
				.map(
					({ header, text }) =>
						header + (text.length <= allowance ? text : text.slice(0, Math.max(0, allowance - marker.length)) + marker)
				)
				.join("\n\n")
		);
	}

	#goalPlanStepBudget(goal: DurableGoal): { costBudgetUsd?: number; tokenBudget?: number } {
		if (!goal.ownerGoalId || !goal.planStepId) return {};
		const owner = this.store.loadGoal(goal.ownerGoalId);
		const step = owner?.plan?.steps.find((candidate) => candidate.id === goal.planStepId);
		if (!step) throw new OrchestratorError("conflict", `Plan step ${goal.planStepId} no longer exists`);
		const usage = this.#summarizeStoredGoal(goal).usage;
		const costBudgetUsd = step.costBudgetUsd === undefined ? undefined : step.costBudgetUsd - usage.costUsd;
		const tokenBudget = step.tokenBudget === undefined ? undefined : step.tokenBudget - usage.totalTokens;
		if (costBudgetUsd !== undefined && costBudgetUsd <= 0)
			throw new OrchestratorError("budget_exceeded", `Plan step ${step.id} cost budget is exhausted`);
		if (tokenBudget !== undefined && tokenBudget <= 0)
			throw new OrchestratorError("budget_exceeded", `Plan step ${step.id} token budget is exhausted`);
		return {
			...(costBudgetUsd === undefined ? {} : { costBudgetUsd }),
			...(tokenBudget === undefined ? {} : { tokenBudget: Math.floor(tokenBudget) }),
		};
	}

	async startGoal(input: GoalCommandInput): Promise<Extract<CommandResult, { type: "goal.started" }>> {
		return this.#serializeCommand(`goal:start:${input.sessionId}:${input.goalId}`, () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "goal.start",
				sessionId: input.sessionId,
				goalId: input.goalId,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "goal.started" }>;
			const goal = this.store.loadGoal(input.goalId);
			if (!goal || goal.parentSessionId !== input.sessionId)
				throw new OrchestratorError("not_found", `Goal ${input.goalId} does not exist`);
			if (goal.cancelledAt !== undefined) throw new OrchestratorError("conflict", `Goal ${input.goalId} is cancelled`);
			if (goal.plan && goal.plan.phase !== "pending")
				throw new OrchestratorError("conflict", `Goal plan ${input.goalId} has already started`);
			if (goal.runSessionId !== undefined || goal.operationId !== undefined)
				throw new OrchestratorError("conflict", `Goal ${input.goalId} has already started`);
			const parent = this.store.loadSnapshot(goal.parentSessionId);
			if (!parent) throw new OrchestratorError("not_found", `Session ${goal.parentSessionId} does not exist`);
			if (parent.session.archivedAt !== undefined)
				throw new OrchestratorError("conflict", "Archived sessions cannot start goals");
			if (goal.executionMode === "session") {
				const result = this.#acceptTurnLocked({
					principalId: input.principalId,
					idempotencyKey: input.idempotencyKey,
					sessionId: goal.parentSessionId,
					mode: "prompt",
					content: [{ type: "text", text: goal.objective }],
					runtimeContent: [{ type: "text", text: sessionGoalPrompt(goal) }],
					...(goal.skillId === undefined ? {} : { skills: [goal.skillId] }),
					goalId: goal.id,
				});
				if (result.type !== "goal.started")
					throw new OrchestratorError("conflict", `Goal ${goal.id} did not start a session turn`);
				return result;
			}
			if (goal.plan) {
				const updated: DurableGoal = {
					...goal,
					startedAt: now,
					updatedAt: Math.max(now, goal.updatedAt + 1),
					plan: { ...goal.plan, phase: "running" },
				};
				const result = { type: "goal.started", goal: summarizeGoal(updated) } as const;
				return this.store.commitGoalMutation({
					goal: updated,
					expectedUpdatedAt: goal.updatedAt,
					idempotency: {
						principalId: input.principalId,
						key: input.idempotencyKey,
						commandHash: hash,
						result,
						expiresAt: now + this.#idempotencyTtlMs,
					},
				}).result as Extract<CommandResult, { type: "goal.started" }>;
			}
			const task = goal.ownerGoalId ? this.#goalPlanStepExecutionPrompt(goal) : goal.objective;
			const stepBudget = this.#goalPlanStepBudget(goal);
			const prepared = this.#prepareSubagent(
				parent,
				{
					task,
					name: `Goal: ${goal.title}`.slice(0, 500),
					...(goal.skillId === undefined ? {} : { skills: [goal.skillId] }),
					...stepBudget,
				},
				now
			);
			const updatedAt = Math.max(now, goal.updatedAt + 1);
			const review = goal.review
				? {
						...goal.review,
						round: 1,
						phase: "executing" as const,
						runs: [{ round: 1, workerSessionId: prepared.summary.sessionId }],
					}
				: undefined;
			const updated: DurableGoal = {
				...goal,
				startedAt: now,
				runSessionId: prepared.summary.sessionId,
				updatedAt,
				...(review === undefined ? {} : { review }),
			};
			const result = {
				type: "goal.started",
				goal: summarizeGoal(updated, prepared.summary),
			} as const;
			return this.store.commitMutation({
				sessionId: prepared.snapshot.session.id,
				expectedRevision: 0,
				events: prepared.events,
				snapshot: prepared.snapshot,
				operation: prepared.operation,
				attachGoalRun: {
					goalId: goal.id,
					parentSessionId: goal.parentSessionId,
					runSessionId: prepared.summary.sessionId,
					expectedUpdatedAt: goal.updatedAt,
					updatedAt,
					...(review === undefined ? {} : { review }),
				},
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			}).result as Extract<CommandResult, { type: "goal.started" }>;
		});
	}

	async pauseGoal(input: GoalCommandInput): Promise<Extract<CommandResult, { type: "goal.paused" }>> {
		return this.#serializeCommand("goal:pause:" + input.sessionId + ":" + input.goalId, async () => {
			const now = this.#clock();
			const hash = commandHash({ type: "goal.pause", sessionId: input.sessionId, goalId: input.goalId });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "goal.paused" }>;
			const goal = this.store.loadGoal(input.goalId);
			if (!goal || goal.parentSessionId !== input.sessionId)
				throw new OrchestratorError("not_found", "Goal " + input.goalId + " does not exist");
			const current = this.#summarizeStoredGoal(goal);
			if (!["pending", "queued", "running", "awaiting_approval", "cancelling"].includes(current.status))
				throw new OrchestratorError("conflict", "Goal " + input.goalId + " is not active");
			const worker = goal.runSessionId ? this.#loadSubagentSummary(goal.runSessionId) : undefined;
			const segmentStartedAt = goal.startedAt ?? worker?.startedAt;
			const accumulatedRunMs =
				(goal.accumulatedRunMs ?? 0) + (segmentStartedAt === undefined ? 0 : Math.max(0, now - segmentStartedAt));
			const updated: DurableGoal = {
				...goal,
				updatedAt: Math.max(now, goal.updatedAt + 1),
				pausedAt: now,
				accumulatedRunMs,
			};
			const result = { type: "goal.paused", goal: summarizeGoal(updated, worker) } as const;
			const committed = this.store.commitGoalMutation({
				goal: updated,
				expectedUpdatedAt: goal.updatedAt,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			}).result as Extract<CommandResult, { type: "goal.paused" }>;
			const children = goal.plan ? this.store.listPlanStepGoals(goal.id) : [];
			for (const child of children) {
				const childSummary = this.#summarizeStoredGoal(child);
				if (!["pending", "queued", "running", "awaiting_approval", "cancelling"].includes(childSummary.status))
					continue;
				try {
					await this.pauseGoal({
						principalId: "system:goal-plan",
						idempotencyKey: "goal-pause:" + goal.id + ":" + child.id,
						sessionId: input.sessionId,
						goalId: child.id,
					});
				} catch (error) {
					const latest = this.store.loadGoal(child.id);
					if (!(error instanceof OrchestratorError && error.code === "conflict" && latest?.pausedAt !== undefined))
						throw error;
				}
			}
			const runIds = [goal, ...(goal.plan ? this.store.listPlanStepGoals(goal.id) : [])]
				.map((candidate) => candidate.runSessionId)
				.filter((id): id is string => id !== undefined);
			for (const runId of runIds) this.#activeTurns.get(runId)?.controller.abort(new Error("Goal paused"));
			if (goal.executionMode === "session" && goal.operationId) {
				await this.abortTurn({
					principalId: input.principalId,
					idempotencyKey: `${input.idempotencyKey}:turn`,
					sessionId: goal.parentSessionId,
				}).catch((error) => {
					if (!(error instanceof OrchestratorError && error.code === "conflict")) throw error;
				});
			}
			return committed;
		});
	}

	async resumeGoal(input: GoalCommandInput): Promise<Extract<CommandResult, { type: "goal.resumed" }>> {
		return this.#serializeCommand("goal:resume:" + input.sessionId + ":" + input.goalId, async () => {
			const now = this.#clock();
			const hash = commandHash({ type: "goal.resume", sessionId: input.sessionId, goalId: input.goalId });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "goal.resumed" }>;
			const goal = this.store.loadGoal(input.goalId);
			if (!goal || goal.parentSessionId !== input.sessionId)
				throw new OrchestratorError("not_found", "Goal " + input.goalId + " does not exist");
			if (goal.pausedAt === undefined)
				throw new OrchestratorError("conflict", "Goal " + input.goalId + " is not paused");
			if (goal.executionMode === "session") {
				const { pausedAt: _pausedAt, operationId: _operationId, ...goalWithoutRuntime } = goal;
				const updated: DurableGoal = {
					...goalWithoutRuntime,
					startedAt: now,
					updatedAt: Math.max(now, goal.updatedAt + 1),
				};
				const result = { type: "goal.resumed", goal: summarizeGoal(updated) } as const;
				return this.store.commitGoalMutation({
					goal: updated,
					expectedUpdatedAt: goal.updatedAt,
					idempotency: {
						principalId: input.principalId,
						key: input.idempotencyKey,
						commandHash: hash,
						result,
						expiresAt: now + this.#idempotencyTtlMs,
					},
				}).result as Extract<CommandResult, { type: "goal.resumed" }>;
			}
			const worker = goal.runSessionId ? this.#loadSubagentSummary(goal.runSessionId) : undefined;
			const terminal = worker !== undefined && ["completed", "failed", "cancelled"].includes(worker.status);
			const { pausedAt: _pausedAt, runSessionId: _runSessionId, ...goalWithoutRuntime } = goal;
			const updated: DurableGoal = {
				...goalWithoutRuntime,
				startedAt: now,
				updatedAt: Math.max(now, goal.updatedAt + 1),
				...(terminal || goal.runSessionId === undefined ? {} : { runSessionId: goal.runSessionId }),
			};
			const withoutPausedAt = updated;
			const result = {
				type: "goal.resumed",
				goal: summarizeGoal(withoutPausedAt, terminal ? undefined : worker),
			} as const;
			const committed = this.store.commitGoalMutation({
				goal: withoutPausedAt,
				expectedUpdatedAt: goal.updatedAt,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			}).result as Extract<CommandResult, { type: "goal.resumed" }>;
			if (withoutPausedAt.plan) {
				for (const child of this.store.listPlanStepGoals(withoutPausedAt.id)) {
					if (child.pausedAt === undefined) continue;
					try {
						await this.resumeGoal({
							principalId: "system:goal-plan",
							idempotencyKey: "goal-resume:" + withoutPausedAt.id + ":" + child.id,
							sessionId: input.sessionId,
							goalId: child.id,
						});
					} catch (error) {
						const latest = this.store.loadGoal(child.id);
						if (!(error instanceof OrchestratorError && error.code === "conflict" && latest?.pausedAt === undefined))
							throw error;
					}
				}
			}
			return committed;
		});
	}

	async deleteGoal(input: GoalCommandInput): Promise<Extract<CommandResult, { type: "goal.deleted" }>> {
		return this.#serializeCommand("goal:delete:" + input.sessionId + ":" + input.goalId, async () => {
			const now = this.#clock();
			const hash = commandHash({ type: "goal.delete", sessionId: input.sessionId, goalId: input.goalId });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "goal.deleted" }>;
			const goal = this.store.loadGoal(input.goalId);
			if (!goal || goal.parentSessionId !== input.sessionId)
				throw new OrchestratorError("not_found", "Goal " + input.goalId + " does not exist");
			const summary = this.#summarizeStoredGoal(goal);
			if (["running", "queued", "awaiting_approval", "cancelling"].includes(summary.status)) {
				const paused = await this.pauseGoal({
					...input,
					idempotencyKey: input.idempotencyKey + ":pause",
				});
				void paused;
			}
			const latest = this.store.loadGoal(input.goalId);
			if (!latest) return { type: "goal.deleted", goalId: input.goalId };
			const runIds = [latest, ...(latest.plan ? this.store.listPlanStepGoals(latest.id) : [])]
				.map((candidate) => candidate.runSessionId)
				.filter((id): id is string => id !== undefined);
			for (const runId of runIds) this.#activeTurns.get(runId)?.controller.abort(new Error("Goal deleted"));
			const result = { type: "goal.deleted", goalId: input.goalId } as const;
			return this.store.deleteGoal({
				goalId: latest.id,
				parentSessionId: latest.parentSessionId,
				expectedUpdatedAt: latest.updatedAt,
				now,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			}).result as Extract<CommandResult, { type: "goal.deleted" }>;
		});
	}

	#attachGoalReviewRun(
		goal: DurableGoal,
		prepared: {
			events: SessionEvent[];
			snapshot: SessionSnapshot;
			operation: DurableOperation;
			summary: SubagentSummary;
		},
		review: NonNullable<DurableGoal["review"]>
	): DurableGoal {
		const updatedAt = Math.max(this.#clock(), goal.updatedAt + 1);
		const updated: DurableGoal = {
			...goal,
			runSessionId: prepared.summary.sessionId,
			updatedAt,
			review,
		};
		this.store.commitMutation({
			sessionId: prepared.snapshot.session.id,
			expectedRevision: 0,
			events: prepared.events,
			snapshot: prepared.snapshot,
			operation: prepared.operation,
			attachGoalRun: {
				goalId: goal.id,
				parentSessionId: goal.parentSessionId,
				runSessionId: prepared.summary.sessionId,
				...(goal.runSessionId === undefined ? {} : { expectedRunSessionId: goal.runSessionId }),
				expectedUpdatedAt: goal.updatedAt,
				updatedAt,
				review,
			},
		});
		return updated;
	}

	#settleGoalReview(
		goal: DurableGoal,
		review: NonNullable<DurableGoal["review"]>,
		runSessionId = goal.runSessionId,
		cancelled = false
	): DurableGoal {
		const updatedAt = Math.max(this.#clock(), goal.updatedAt + 1);
		const updated: DurableGoal = {
			...goal,
			updatedAt,
			...(runSessionId === undefined ? {} : { runSessionId }),
			...(cancelled ? { cancelledAt: updatedAt } : {}),
			review,
		};
		this.store.updateGoal(updated, goal.updatedAt);
		return updated;
	}

	#planStepAllocation(goal: DurableGoal, launchesRemaining: number): { costBudgetUsd?: number; tokenBudget?: number } {
		if (!goal.plan) return {};
		const parent = this.store.loadSnapshot(goal.parentSessionId);
		if (!parent) throw new OrchestratorError("not_found", `Session ${goal.parentSessionId} does not exist`);
		let reservedCost = 0;
		let reservedTokens = 0;
		const reservedSteps = this.store
			.listPlanGoals(goal.parentSessionId)
			.flatMap((candidate) => candidate.plan?.steps ?? []);
		for (const step of reservedSteps) {
			if (!step.goalId || (step.costBudgetUsd === undefined && step.tokenBudget === undefined)) continue;
			const child = this.store.loadGoal(step.goalId);
			const summary = child ? this.#summarizeStoredGoal(child) : undefined;
			if (!summary || ["completed", "failed", "cancelled"].includes(summary.status)) continue;
			// Parent usage is published at run boundaries, while an active child may
			// already have unreported usage. Keep its full reservation until terminal.
			reservedCost += step.costBudgetUsd ?? 0;
			reservedTokens += step.tokenBudget ?? 0;
		}
		const availableCost =
			parent.costBudgetUsd === undefined ? undefined : parent.costBudgetUsd - parent.usage.costUsd - reservedCost;
		const availableTokens =
			parent.tokenBudget === undefined ? undefined : parent.tokenBudget - parent.usage.totalTokens - reservedTokens;
		if (availableCost !== undefined && availableCost <= 0)
			throw new OrchestratorError(
				"budget_exceeded",
				"Parent session cost budget is fully allocated to active plan steps"
			);
		if (availableTokens !== undefined && availableTokens < launchesRemaining)
			throw new OrchestratorError(
				"budget_exceeded",
				"Parent session token budget is too small for the ready plan steps"
			);
		return {
			...(availableCost === undefined ? {} : { costBudgetUsd: availableCost / launchesRemaining }),
			...(availableTokens === undefined ? {} : { tokenBudget: Math.floor(availableTokens / launchesRemaining) }),
		};
	}

	#attachReadyPlanStep(goal: DurableGoal, step: DurableGoalPlanStep, launchesRemaining: number): DurableGoal {
		if (!goal.plan || goal.plan.phase !== "running" || step.goalId || step.skippedAt !== undefined)
			throw new OrchestratorError("conflict", `Plan step ${step.id} is not attachable`);
		const now = this.#clock();
		const childId = this.#idFactory();
		const allocation = this.#planStepAllocation(goal, launchesRemaining);
		const child: DurableGoal = {
			id: childId,
			parentSessionId: goal.parentSessionId,
			title: step.title,
			objective: step.objective,
			createdAt: now,
			updatedAt: now,
			ownerGoalId: goal.id,
			planStepId: step.id,
			...(step.successCriteria === undefined || step.maxRounds === undefined
				? {}
				: {
						review: {
							successCriteria: step.successCriteria,
							maxRounds: step.maxRounds,
							round: 0,
							phase: "pending",
							runs: [],
							history: [],
						},
					}),
		};
		const updatedAt = Math.max(now, goal.updatedAt + 1);
		const plan: DurableGoalPlan = {
			...goal.plan,
			steps: goal.plan.steps.map((candidate) =>
				candidate.id === step.id ? { ...candidate, goalId: childId, ...allocation } : candidate
			),
		};
		this.store.attachPlanStepGoal({
			parentGoal: { ...goal, updatedAt, plan },
			expectedUpdatedAt: goal.updatedAt,
			childGoal: child,
			verifyBudgetReservation: () => {
				// Re-read under the SQLite writer lock; another process may have reserved
				// the same parent balance since the initial allocation was calculated.
				const current = this.#planStepAllocation(goal, launchesRemaining);
				if (current.costBudgetUsd !== allocation.costBudgetUsd || current.tokenBudget !== allocation.tokenBudget) {
					throw new OrchestratorError("conflict", "Plan budget availability changed before reservation");
				}
			},
		});
		return child;
	}

	async #driveGoalPlanLocked(parentSessionId: string, goalId: string, traceId?: string): Promise<GoalSummary> {
		const inFlight = new Map<string, Promise<{ goalId: string; error?: unknown }>>();
		const yielded = new Set<string>();
		let failed = false;
		try {
			for (let iteration = 0; iteration < 200; iteration += 1) {
				let goal = this.store.loadGoal(goalId);
				if (!goal || goal.parentSessionId !== parentSessionId || !goal.plan)
					throw new OrchestratorError("not_found", `Goal plan ${goalId} does not exist`);
				if (goal.pausedAt !== undefined) return this.#summarizeStoredGoal(goal);
				if (goal.cancelledAt !== undefined || ["completed", "failed", "cancelled"].includes(goal.plan.phase))
					return this.#summarizeStoredGoal(goal);
				if (goal.plan.phase === "pending") return this.#summarizeStoredGoal(goal);

				let summary = this.#summarizeStoredPlanGoal(goal);
				const statusById = new Map(summary.plan!.steps.map((step) => [step.id, step.status]));
				const failedStep = summary.plan!.steps.find((step) => step.status === "failed" || step.status === "cancelled");
				if (failedStep && goal.plan.failurePolicy === "fail_fast") {
					for (const step of summary.plan!.steps) {
						if (!step.goalId || ["completed", "failed", "cancelled"].includes(step.status)) continue;
						try {
							await this.cancelGoal({
								principalId: "system:goal-plan",
								idempotencyKey: `plan:${goal.id}:fail-fast:${step.goalId}`,
								sessionId: parentSessionId,
								goalId: step.goalId,
							});
						} catch (error) {
							const latest = this.store.loadGoal(step.goalId);
							if (!(
								error instanceof OrchestratorError &&
								error.code === "conflict" &&
								latest?.cancelledAt !== undefined
							))
								throw error;
						}
					}
					goal = this.store.loadGoal(goalId)!;
					const now = this.#clock();
					const plan: DurableGoalPlan = {
						...goal.plan!,
						phase: "failed",
						steps: goal.plan!.steps.map((step) =>
							step.goalId || step.skippedAt !== undefined
								? step
								: { ...step, skippedAt: now, skipReason: `Fail-fast after step ${failedStep.id}` }
						),
					};
					this.store.updateGoal({ ...goal, updatedAt: Math.max(now, goal.updatedAt + 1), plan }, goal.updatedAt);
					return this.#summarizeStoredGoal(this.store.loadGoal(goalId)!);
				}

				const blocked = goal.plan.steps.filter(
					(step) =>
						!step.goalId &&
						step.skippedAt === undefined &&
						step.dependsOn.some((dependency) =>
							["failed", "cancelled", "skipped"].includes(statusById.get(dependency) ?? "")
						)
				);
				if (blocked.length > 0) {
					const blockedIds = new Set(blocked.map((step) => step.id));
					const now = this.#clock();
					const updated: DurableGoal = {
						...goal,
						updatedAt: Math.max(now, goal.updatedAt + 1),
						plan: {
							...goal.plan,
							steps: goal.plan.steps.map((step) =>
								blockedIds.has(step.id)
									? {
											...step,
											skippedAt: now,
											skipReason: "A required dependency did not complete",
										}
									: step
							),
						},
					};
					this.store.updateGoal(updated, goal.updatedAt);
					continue;
				}

				const terminal = summary.plan!.steps.every((step) =>
					["completed", "failed", "cancelled", "skipped"].includes(step.status)
				);
				if (terminal) {
					const phase = summary.plan!.steps.every((step) => step.status === "completed")
						? ("completed" as const)
						: ("failed" as const);
					const updated: DurableGoal = {
						...goal,
						updatedAt: Math.max(this.#clock(), goal.updatedAt + 1),
						plan: { ...goal.plan, phase },
					};
					this.store.updateGoal(updated, goal.updatedAt);
					return this.#summarizeStoredGoal(this.store.loadGoal(goalId)!);
				}

				const activeStatuses = new Set(["pending", "queued", "running", "awaiting_approval", "cancelling"]);
				const active = summary.plan!.steps.filter((step) => step.goalId && activeStatuses.has(step.status));
				const ready = goal.plan.steps.filter(
					(step) =>
						!step.goalId &&
						step.skippedAt === undefined &&
						step.dependsOn.every((dependency) => statusById.get(dependency) === "completed")
				);
				const launchCount = Math.min(ready.length, Math.max(0, goal.plan.maxParallel - active.length));
				if (launchCount > 0) {
					let attached = false;
					for (let index = 0; index < launchCount; index += 1) {
						goal = this.store.loadGoal(goalId)!;
						const latestStep = goal.plan!.steps.find((step) => step.id === ready[index]!.id)!;
						let child: DurableGoal;
						try {
							child = this.#attachReadyPlanStep(goal, latestStep, launchCount - index);
							attached = true;
						} catch (error) {
							if (error instanceof OrchestratorError && error.code === "conflict") continue;
							if (error instanceof OrchestratorError && error.code === "budget_exceeded") {
								if (active.length > 0 || attached) break;
								const now = this.#clock();
								const plan: DurableGoalPlan = {
									...goal.plan!,
									phase: "failed",
									steps: goal.plan!.steps.map((step) =>
										step.goalId || step.skippedAt !== undefined
											? step
											: { ...step, skippedAt: now, skipReason: error.message }
									),
								};
								this.store.updateGoal({ ...goal, updatedAt: Math.max(now, goal.updatedAt + 1), plan }, goal.updatedAt);
								return this.#summarizeStoredGoal(this.store.loadGoal(goalId)!);
							}
							throw error;
						}
						try {
							await this.startGoal({
								principalId: "system:goal-plan",
								idempotencyKey: `plan:${goalId}:start:${latestStep.id}`,
								sessionId: parentSessionId,
								goalId: child.id,
							});
						} catch (error) {
							if (!(error instanceof OrchestratorError && error.code === "budget_exceeded")) throw error;
							await this.cancelGoal({
								principalId: "system:goal-plan",
								idempotencyKey: `plan:${goalId}:budget:${latestStep.id}`,
								sessionId: parentSessionId,
								goalId: child.id,
							});
						}
					}
					if (attached) continue;
				}
				const pendingAttached = active.filter((step) => step.status === "pending" && step.goalId);
				if (pendingAttached.length > 0) {
					for (const step of pendingAttached) {
						try {
							await this.startGoal({
								principalId: "system:goal-plan",
								idempotencyKey: `plan:${goalId}:start:${step.id}`,
								sessionId: parentSessionId,
								goalId: step.goalId!,
							});
						} catch (error) {
							if (!(error instanceof OrchestratorError && error.code === "budget_exceeded")) throw error;
							await this.cancelGoal({
								principalId: "system:goal-plan",
								idempotencyKey: `plan:${goalId}:budget:${step.id}`,
								sessionId: parentSessionId,
								goalId: step.goalId!,
							});
						}
					}
					continue;
				}
				if (active.length === 0) {
					const now = this.#clock();
					const plan: DurableGoalPlan = {
						...goal.plan!,
						phase: "failed",
						steps: goal.plan!.steps.map((step) =>
							step.goalId || step.skippedAt !== undefined
								? step
								: { ...step, skippedAt: now, skipReason: "No runnable dependency path remains" }
						),
					};
					this.store.updateGoal({ ...goal, updatedAt: Math.max(now, goal.updatedAt + 1), plan }, goal.updatedAt);
					return this.#summarizeStoredGoal(this.store.loadGoal(goalId)!);
				}

				for (const step of active) {
					const childId = step.goalId!;
					if (inFlight.has(childId) || yielded.has(childId)) continue;
					inFlight.set(
						childId,
						this.driveGoal(parentSessionId, childId, traceId).then(
							() => ({ goalId: childId }),
							(error: unknown) => ({ goalId: childId, error })
						)
					);
				}
				if (inFlight.size === 0) return this.#summarizeStoredPlanGoal(this.store.loadGoal(goalId)!);
				// Refill available slots as soon as any branch settles, rather than
				// waiting for unrelated branches to complete the same batch.
				const settled = await Promise.race(inFlight.values());
				inFlight.delete(settled.goalId);
				yielded.add(settled.goalId);
				if (
					settled.error !== undefined &&
					!(settled.error instanceof OrchestratorError && settled.error.code === "lease_conflict")
				)
					throw settled.error;
			}
			throw new OrchestratorError(
				"conflict",
				`Goal plan ${goalId} did not converge within its bounded transition limit`
			);
		} catch (error) {
			failed = true;
			try {
				const current = this.store.loadGoal(goalId);
				if (current && inFlight.size > 0) await this.#cancelPlanChildren(current, `plan:${goalId}:driver-error`);
			} catch (cleanupError) {
				this.#logger.log("error", "orchestrator.goal_plan.cleanup_failed", {
					goalId,
					parentSessionId,
					error: cleanupError,
				});
			}
			throw error;
		} finally {
			const remaining = await Promise.all(inFlight.values());
			const failure = remaining.find(
				(result) =>
					result.error !== undefined &&
					!(result.error instanceof OrchestratorError && result.error.code === "lease_conflict")
			);
			if (!failed && failure) throw failure.error;
		}
	}

	async driveGoal(parentSessionId: string, goalId: string, traceId?: string): Promise<GoalSummary> {
		return this.#serializeCommand(`goal:${goalId}`, async () => {
			for (;;) {
				let goal = this.store.loadGoal(goalId);
				if (!goal || goal.parentSessionId !== parentSessionId)
					throw new OrchestratorError("not_found", `Goal ${goalId} does not exist`);
				if (goal.pausedAt !== undefined) return this.#summarizeStoredGoal(goal);
				if (goal.plan) return this.#driveGoalPlanLocked(parentSessionId, goalId, traceId);
				if (goal.executionMode === "session") {
					if (!goal.operationId || goal.cancelledAt !== undefined) return this.#summarizeStoredGoal(goal);
					await this.drainSession(parentSessionId, undefined, traceId);
					return this.#summarizeStoredGoal(this.store.loadGoal(goalId) ?? goal);
				}
				if (
					!goal.runSessionId ||
					goal.cancelledAt !== undefined ||
					goal.review?.phase === "passed" ||
					goal.review?.phase === "failed" ||
					goal.review?.phase === "cancelled"
				) {
					return this.#summarizeStoredGoal(goal);
				}

				const activeSessionId = goal.runSessionId;
				await this.drainSession(activeSessionId, undefined, traceId);
				await this.publishSubagentResult(parentSessionId, activeSessionId);
				goal = this.store.loadGoal(goalId);
				if (!goal || goal.parentSessionId !== parentSessionId)
					throw new OrchestratorError("not_found", `Goal ${goalId} does not exist`);
				if (goal.pausedAt !== undefined) return this.#summarizeStoredGoal(goal);
				if (goal.runSessionId !== activeSessionId) continue;
				if (goal.cancelledAt !== undefined || goal.review?.phase === "cancelled")
					return this.#summarizeStoredGoal(goal);

				const active = this.#loadSubagentSummary(activeSessionId);
				if (!active) throw new OrchestratorError("not_found", `Goal run ${activeSessionId} does not exist`);
				if (
					active.status === "queued" ||
					active.status === "running" ||
					active.status === "awaiting_approval" ||
					active.status === "cancelling"
				) {
					return this.#summarizeStoredGoal(goal);
				}
				if (!goal.review) return this.#summarizeStoredGoal(goal);

				if (active.status === "cancelled") {
					goal = this.#settleGoalReview(goal, { ...goal.review, phase: "cancelled" }, activeSessionId, true);
					return this.#summarizeStoredGoal(goal);
				}
				if (active.status === "failed") {
					goal = this.#settleGoalReview(goal, {
						...goal.review,
						phase: "failed",
						failure: active.error ?? "Goal run failed",
					});
					return this.#summarizeStoredGoal(goal);
				}

				const parent = this.store.loadSnapshot(parentSessionId);
				if (!parent) throw new OrchestratorError("not_found", `Session ${parentSessionId} does not exist`);
				if (goal.review.phase === "executing") {
					const currentRound = goal.review.round;
					const candidate = active.result ?? "";
					let prepared;
					try {
						prepared = this.#prepareSubagent(
							parent,
							{
								task: goalReviewPrompt(goal, candidate, this.#goalPlanDependencyContext(goal)),
								name: `Review: ${goal.title} (round ${goal.review.round})`.slice(0, 500),
								...(goal.skillId === undefined ? {} : { skills: [goal.skillId] }),
								...this.#goalPlanStepBudget(goal),
							},
							this.#clock()
						);
					} catch (error) {
						if (!(error instanceof OrchestratorError && error.code === "budget_exceeded")) throw error;
						goal = this.#settleGoalReview(goal, {
							...goal.review,
							phase: "failed",
							failure: "Parent session budget is exhausted before goal review",
						});
						return this.#summarizeStoredGoal(goal);
					}
					const runs = goal.review.runs.map((run) =>
						run.round === currentRound ? { ...run, reviewerSessionId: prepared.summary.sessionId } : run
					);
					goal = this.#attachGoalReviewRun(goal, prepared, {
						...goal.review,
						phase: "reviewing",
						runs,
					});
					continue;
				}

				if (goal.review.phase !== "reviewing") return this.#summarizeStoredGoal(goal);
				const parsed = parseGoalReview(active.result);
				const record = parsed ?? {
					verdict: "fail" as const,
					feedback: "Reviewer returned an invalid structured verdict.",
					checks: [
						{
							criterion: "Structured review output",
							status: "fail" as const,
							evidence: "The reviewer response did not match the required evidence schema.",
						},
					],
				};
				const reviewerSnapshot = this.store.loadSnapshot(activeSessionId);
				const toolsUsed = [
					...new Set(
						(reviewerSnapshot?.usageByTool ?? []).filter((tool) => tool.callCount > 0).map((tool) => tool.toolName)
					),
				].slice(0, 50);
				const history = [
					...goal.review.history,
					{
						round: goal.review.round,
						verdict: record.verdict,
						feedback: record.feedback,
						checks: record.checks,
						...(toolsUsed.length === 0 ? {} : { toolsUsed }),
						reviewedAt: this.#clock(),
					},
				];
				const workerSessionId = goal.review.runs.at(-1)?.workerSessionId;
				if (!parsed) {
					goal = this.#settleGoalReview(
						goal,
						{ ...goal.review, phase: "failed", history, failure: record.feedback },
						workerSessionId
					);
					return this.#summarizeStoredGoal(goal);
				}
				if (parsed.verdict === "pass") {
					goal = this.#settleGoalReview(goal, { ...goal.review, phase: "passed", history }, workerSessionId);
					return this.#summarizeStoredGoal(goal);
				}
				if (goal.review.round >= goal.review.maxRounds) {
					goal = this.#settleGoalReview(
						goal,
						{ ...goal.review, phase: "failed", history, failure: parsed.feedback },
						workerSessionId
					);
					return this.#summarizeStoredGoal(goal);
				}

				const previousWorker = workerSessionId ? this.#loadSubagentSummary(workerSessionId) : undefined;
				let prepared;
				try {
					prepared = this.#prepareSubagent(
						parent,
						{
							task: goalRetryPrompt(
								goal,
								previousWorker?.result ?? "",
								parsed.feedback,
								this.#goalPlanDependencyContext(goal)
							),
							name: `Goal: ${goal.title} (round ${goal.review.round + 1})`.slice(0, 500),
							...this.#goalPlanStepBudget(goal),
						},
						this.#clock()
					);
				} catch (error) {
					if (!(error instanceof OrchestratorError && error.code === "budget_exceeded")) throw error;
					goal = this.#settleGoalReview(
						goal,
						{
							...goal.review,
							phase: "failed",
							history,
							failure: "Parent session budget is exhausted before the next goal round",
						},
						workerSessionId
					);
					return this.#summarizeStoredGoal(goal);
				}
				const round = goal.review.round + 1;
				goal = this.#attachGoalReviewRun(goal, prepared, {
					...goal.review,
					round,
					phase: "executing",
					runs: [...goal.review.runs, { round, workerSessionId: prepared.summary.sessionId }],
					history,
				});
			}
		});
	}

	async resumeGoalReviews(): Promise<number> {
		let resumed = 0;
		for (const goal of this.store.listReviewGoals()) {
			if (
				!goal.runSessionId ||
				goal.cancelledAt !== undefined ||
				goal.review?.phase === "pending" ||
				goal.review?.phase === "passed" ||
				goal.review?.phase === "failed" ||
				goal.review?.phase === "cancelled"
			)
				continue;
			try {
				await this.driveGoal(goal.parentSessionId, goal.id);
				resumed += 1;
			} catch (error) {
				if (!(error instanceof OrchestratorError && error.code === "lease_conflict")) {
					this.#logger.log("error", "orchestrator.goal.resume_failed", {
						goalId: goal.id,
						parentSessionId: goal.parentSessionId,
						error,
					});
				}
			}
		}
		return resumed;
	}

	async resumeGoalPlans(): Promise<number> {
		let resumed = 0;
		for (const goal of this.store.listPlanGoals()) {
			if (!goal.plan) continue;
			try {
				if (goal.cancelledAt !== undefined || goal.plan.phase === "cancelled")
					await this.#cancelPlanChildren(goal, `recover-cancel:${goal.id}`);
				else if (goal.plan.phase === "running") await this.driveGoal(goal.parentSessionId, goal.id);
				else continue;
				resumed += 1;
			} catch (error) {
				if (!(error instanceof OrchestratorError && error.code === "lease_conflict"))
					this.#logger.log("error", "orchestrator.goal_plan.resume_failed", {
						goalId: goal.id,
						parentSessionId: goal.parentSessionId,
						error,
					});
			}
		}
		return resumed;
	}

	async #cancelPlanChildren(goal: DurableGoal, key: string): Promise<void> {
		if (!goal.plan) return;
		for (const step of goal.plan.steps) {
			if (!step.goalId) continue;
			const child = this.store.loadGoal(step.goalId);
			if (!child || child.cancelledAt !== undefined) continue;
			const summary = this.#summarizeStoredGoal(child);
			if (["completed", "failed", "cancelled"].includes(summary.status)) continue;
			try {
				await this.cancelGoal({
					principalId: "system:goal-plan",
					idempotencyKey: `${key}:${step.goalId}`,
					sessionId: goal.parentSessionId,
					goalId: step.goalId,
				});
			} catch (error) {
				const latest = this.store.loadGoal(step.goalId);
				if (!(
					error instanceof OrchestratorError &&
					error.code === "conflict" &&
					latest &&
					["completed", "failed", "cancelled"].includes(this.#summarizeStoredGoal(latest).status)
				))
					throw error;
			}
		}
	}

	async continueGoalForSession(sessionId: string): Promise<GoalSummary | undefined> {
		const goal = this.store.findGoalByRunSessionId(sessionId);
		if (!goal || (!goal.review && !goal.ownerGoalId)) return undefined;
		const result = await this.driveGoal(goal.parentSessionId, goal.id);
		return goal.ownerGoalId ? this.driveGoal(goal.parentSessionId, goal.ownerGoalId) : result;
	}

	async cancelGoal(input: GoalCommandInput): Promise<Extract<CommandResult, { type: "goal.cancel_requested" }>> {
		return this.#serializeCommand(`goal:cancel:${input.sessionId}:${input.goalId}`, async () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "goal.cancel",
				sessionId: input.sessionId,
				goalId: input.goalId,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "goal.cancel_requested" }>;
			const goal = this.store.loadGoal(input.goalId);
			if (!goal || goal.parentSessionId !== input.sessionId)
				throw new OrchestratorError("not_found", `Goal ${input.goalId} does not exist`);
			if (goal.cancelledAt !== undefined)
				throw new OrchestratorError("conflict", `Goal ${input.goalId} is already cancelled`);
			if (goal.review?.phase === "passed" || goal.review?.phase === "failed" || goal.review?.phase === "cancelled")
				throw new OrchestratorError("conflict", `Goal ${input.goalId} is already ${goal.review.phase}`);
			if (goal.plan && ["completed", "failed", "cancelled"].includes(goal.plan.phase))
				throw new OrchestratorError("conflict", `Goal plan ${input.goalId} is already ${goal.plan.phase}`);
			if (goal.plan) {
				const updatedAt = Math.max(now, goal.updatedAt + 1);
				const updated: DurableGoal = {
					...goal,
					updatedAt,
					cancelledAt: updatedAt,
					plan: {
						...goal.plan,
						phase: "cancelled",
						steps: goal.plan.steps.map((step) =>
							step.goalId || step.skippedAt !== undefined
								? step
								: { ...step, skippedAt: updatedAt, skipReason: "Parent Goal was cancelled" }
						),
					},
				};
				const result = { type: "goal.cancel_requested", goal: summarizeGoal(updated) } as const;
				const committed = this.store.commitGoalMutation({
					goal: updated,
					expectedUpdatedAt: goal.updatedAt,
					idempotency: {
						principalId: input.principalId,
						key: input.idempotencyKey,
						commandHash: hash,
						result,
						expiresAt: now + this.#idempotencyTtlMs,
					},
				}).result as Extract<CommandResult, { type: "goal.cancel_requested" }>;
				await this.#cancelPlanChildren(updated, `plan-cancel:${input.idempotencyKey}`);
				return committed;
			}
			if (goal.executionMode === "session") {
				const updatedAt = Math.max(now, goal.updatedAt + 1);
				const updated: DurableGoal = { ...goal, updatedAt, cancelledAt: updatedAt };
				const result = { type: "goal.cancel_requested", goal: summarizeGoal(updated) } as const;
				const committed = this.store.commitGoalMutation({
					goal: updated,
					expectedUpdatedAt: goal.updatedAt,
					idempotency: {
						principalId: input.principalId,
						key: input.idempotencyKey,
						commandHash: hash,
						result,
						expiresAt: now + this.#idempotencyTtlMs,
					},
				}).result as Extract<CommandResult, { type: "goal.cancel_requested" }>;
				if (goal.operationId) {
					await this.abortTurn({
						principalId: input.principalId,
						idempotencyKey: `${input.idempotencyKey}:turn`,
						sessionId: goal.parentSessionId,
					}).catch((error) => {
						if (!(error instanceof OrchestratorError && error.code === "conflict")) throw error;
					});
				}
				return committed;
			}
			let updated: DurableGoal;
			let summary: GoalSummary;
			if (goal.runSessionId === undefined) {
				const updatedAt = Math.max(now, goal.updatedAt + 1);
				updated = {
					...goal,
					updatedAt,
					cancelledAt: updatedAt,
					...(goal.review === undefined ? {} : { review: { ...goal.review, phase: "cancelled" as const } }),
				};
				summary = summarizeGoal(updated);
			} else if (
				goal.review &&
				["completed", "failed", "cancelled"].includes(this.#loadSubagentSummary(goal.runSessionId)?.status ?? "")
			) {
				const updatedAt = Math.max(now, goal.updatedAt + 1);
				updated = {
					...goal,
					updatedAt,
					cancelledAt: updatedAt,
					review: { ...goal.review, phase: "cancelled" },
				};
				summary = this.#summarizeStoredGoal(updated);
			} else {
				const cancelled = await this.cancelSubagent({
					principalId: input.principalId,
					idempotencyKey: `goal-cancel:${goal.id}`,
					sessionId: goal.parentSessionId,
					subagentId: goal.runSessionId,
				});
				updated = { ...goal, updatedAt: Math.max(now, goal.updatedAt + 1) };
				summary = summarizeGoal(updated, cancelled.subagent);
			}
			const result = { type: "goal.cancel_requested", goal: summary } as const;
			try {
				return this.store.commitGoalMutation({
					goal: updated,
					expectedUpdatedAt: goal.updatedAt,
					idempotency: {
						principalId: input.principalId,
						key: input.idempotencyKey,
						commandHash: hash,
						result,
						expiresAt: now + this.#idempotencyTtlMs,
					},
				}).result as Extract<CommandResult, { type: "goal.cancel_requested" }>;
			} catch (error) {
				if (!(error instanceof OrchestratorError && error.code === "conflict")) throw error;
				const latest = this.store.loadGoal(goal.id);
				if (!latest || (latest.cancelledAt === undefined && latest.review?.phase !== "cancelled")) throw error;
				const reconciled: DurableGoal = {
					...latest,
					updatedAt: Math.max(now, latest.updatedAt + 1),
				};
				const reconciledResult = {
					type: "goal.cancel_requested",
					goal: this.#summarizeStoredGoal(reconciled),
				} as const;
				return this.store.commitGoalMutation({
					goal: reconciled,
					expectedUpdatedAt: latest.updatedAt,
					idempotency: {
						principalId: input.principalId,
						key: input.idempotencyKey,
						commandHash: hash,
						result: reconciledResult,
						expiresAt: now + this.#idempotencyTtlMs,
					},
				}).result as Extract<CommandResult, { type: "goal.cancel_requested" }>;
			}
		});
	}

	async cancelSubagent(
		input: CancelSubagentInput
	): Promise<Extract<CommandResult, { type: "subagent.cancel_requested" }>> {
		const requestedParent = this.store.loadSnapshot(input.sessionId);
		const requestedChild = this.store.loadSnapshot(input.subagentId);
		if (!requestedParent || !requestedChild || requestedChild.session.parentSessionId !== requestedParent.session.id)
			throw new OrchestratorError("not_found", `Subagent ${input.subagentId} does not exist`);
		for (const descendant of this.store.listAllDirectChildSnapshots(input.subagentId)) {
			const descendantOperation = this.store.listOperations(descendant.session.id, 1)[0];
			if (!descendantOperation || (descendantOperation.status !== "queued" && descendantOperation.status !== "running"))
				continue;
			try {
				await this.cancelSubagent({
					principalId: input.principalId,
					idempotencyKey: `cascade:${input.idempotencyKey}:${descendant.session.id}`,
					sessionId: input.subagentId,
					subagentId: descendant.session.id,
				});
			} catch (error) {
				const latest = this.store.listOperations(descendant.session.id, 1)[0];
				if (
					error instanceof OrchestratorError &&
					error.code === "conflict" &&
					latest &&
					(latest.abortRequested || !["queued", "running"].includes(latest.status))
				)
					continue;
				throw error;
			}
		}
		const result = await this.#serializeCommand(`subagent:cancel:${input.sessionId}:${input.subagentId}`, () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "subagent.cancel",
				sessionId: input.sessionId,
				subagentId: input.subagentId,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "subagent.cancel_requested" }>;
			const parent = this.store.loadSnapshot(input.sessionId);
			const child = this.store.loadSnapshot(input.subagentId);
			if (!parent || !child || child.session.parentSessionId !== parent.session.id)
				throw new OrchestratorError("not_found", `Subagent ${input.subagentId} does not exist`);
			const operation = this.store.listOperations(child.session.id, 1)[0];
			if (!operation) throw new OrchestratorError("not_found", `Subagent ${input.subagentId} has no operation`);
			if (operation.status !== "queued" && operation.status !== "running")
				throw new OrchestratorError("conflict", `Subagent ${input.subagentId} is already ${operation.status}`);
			const projected = { ...operation, abortRequested: true, updatedAt: now };
			const result = {
				type: "subagent.cancel_requested",
				subagent: summarizeSubagent(child, projected, this.subagentDepth(child.session.id)),
			} as const;
			const committed = this.store.requestOperationAbort({
				principalId: input.principalId,
				idempotencyKey: input.idempotencyKey,
				commandHash: hash,
				sessionId: child.session.id,
				result,
				now,
				expiresAt: now + this.#idempotencyTtlMs,
			});
			const active = this.#activeTurns.get(child.session.id);
			active?.controller.abort(new Error("Subagent cancelled by user"));
			if (!active) {
				const approvalExecutions = this.store.listApprovalExecutionsForOperation(operation.id);
				if (
					operation.status === "running" &&
					approvalExecutions.some((approval) => approval.state === "waiting" || approval.state === "approved")
				) {
					for (const approval of approvalExecutions) this.store.interruptApprovalExecution(approval.approvalId, now);
					const lease = this.store.acquireWriterLease(
						child.session.id,
						`subagent-approval-abort:${this.#idFactory()}`,
						now,
						this.#leaseTtlMs
					);
					try {
						this.#commitRuntimeFailure(
							operation,
							lease,
							"Subagent cancelled by user",
							true,
							true,
							undefined,
							undefined,
							undefined,
							"user_abort"
						);
					} finally {
						this.store.releaseWriterLease(lease);
					}
				}
			}
			return committed as Extract<CommandResult, { type: "subagent.cancel_requested" }>;
		});
		const operation = this.store.listOperations(input.subagentId, 1)[0];
		if (operation?.status === "queued" && operation.abortRequested) {
			try {
				await this.drainSession(input.subagentId, `subagent-cancel:${this.#idFactory()}`);
			} catch (error) {
				if (!(error instanceof OrchestratorError && error.code === "lease_conflict")) throw error;
			}
		}
		await this.publishSubagentResult(input.sessionId, input.subagentId);
		return result;
	}

	async publishSubagentResult(parentSessionId: string, subagentId: string): Promise<SubagentSummary> {
		return this.#serializeCommand(`subagent:publish:${parentSessionId}:${subagentId}`, () => {
			const parent = this.store.loadSnapshot(parentSessionId);
			const child = this.store.loadSnapshot(subagentId);
			if (!parent || !child || child.session.parentSessionId !== parent.session.id)
				throw new OrchestratorError("not_found", `Subagent ${subagentId} does not exist`);
			const operation = this.store.listOperations(subagentId, 1)[0];
			if (!operation) throw new OrchestratorError("not_found", `Subagent ${subagentId} has no operation`);
			const summary = summarizeSubagent(child, operation, this.subagentDepth(child.session.id));
			if (!this.#subagentPublishPending(parent, child, operation)) return summary;
			const inline = operation.payload.deliverInline === true;
			const now = this.#clock();
			const text =
				summary.result ??
				summary.error ??
				(summary.status === "cancelled"
					? "Subagent was cancelled."
					: `Subagent finished with status ${summary.status}.`);
			const events: SessionEvent[] = [];
			let snapshot = parent;
			if (!inline) {
				const itemEvent: SessionEvent = {
					type: "session.item.upserted",
					eventId: this.#idFactory(),
					sessionId: parentSessionId,
					revision: snapshot.revision + 1,
					timestamp: now,
					item: {
						id: `subagent:${subagentId}`,
						type: "tool",
						createdAt: now,
						toolCallId: subagentId,
						toolName: "subagent",
						status: summary.status === "completed" ? "complete" : summary.status === "cancelled" ? "aborted" : "error",
						input: { subagentId, task: summary.task },
						content: [{ type: "text", text: text.slice(0, 200_000) }],
						isError: summary.status !== "completed",
					},
				};
				events.push(itemEvent);
				snapshot = reduceSessionEvent(snapshot, itemEvent);
			}
			if (hasUsage(child.usage)) {
				const usage = addUsage(snapshot.usage, child.usage);
				const replaced: SessionEvent = {
					type: "session.usage.replaced",
					eventId: this.#idFactory(),
					sessionId: parentSessionId,
					revision: snapshot.revision + 1,
					timestamp: now,
					usage,
				};
				events.push(replaced);
				snapshot = reduceSessionEvent(snapshot, replaced);
				const recorded: SessionEvent = {
					type: "session.usage.recorded",
					eventId: this.#idFactory(),
					sessionId: parentSessionId,
					revision: snapshot.revision + 1,
					timestamp: now,
					turnId: subagentId,
					mode: "prompt",
					model: child.model,
					attempt: Math.max(1, operation.attempt),
					usage: child.usage,
					tools: [
						{
							toolName: "subagent",
							callCount: 1,
							usage: child.usage,
							durationMs:
								operation.startedAt === undefined
									? 0
									: Math.max(0, (operation.finishedAt ?? operation.updatedAt) - operation.startedAt),
							succeededCount: operation.status === "completed" ? 1 : 0,
							failedCount: operation.status === "failed" ? 1 : 0,
							abortedCount: operation.status === "interrupted" ? 1 : 0,
						},
					],
					requests: [],
				};
				events.push(recorded);
				snapshot = reduceSessionEvent(snapshot, recorded);
			}
			this.store.commitMutation({
				sessionId: parentSessionId,
				expectedRevision: parent.revision,
				events,
				snapshot,
			});
			return summary;
		});
	}

	/**
	 * Whether publishing this subagent to its parent would still change anything.
	 *
	 * A subagent created by the browser is published as a parent transcript item, so
	 * that item's presence is the marker. A subagent the model created inside its own
	 * turn already returned its answer as that tool call's result: publishing only
	 * folds in the child's usage, the parent's per-turn usage entry is the marker, and
	 * it has to wait for the parent turn to finish. Adding to the parent aggregate
	 * mid-turn would race the runtime's own cumulative usage for that turn and lose
	 * one of the two.
	 */
	#subagentPublishPending(parent: SessionSnapshot, child: SessionSnapshot, operation: DurableOperation): boolean {
		if (operation.status === "queued" || operation.status === "running") return false;
		if (operation.payload.deliverInline !== true) {
			return !parent.transcript.some((item) => item.id === `subagent:${child.session.id}`);
		}
		if (parent.session.phase !== "idle" || !hasUsage(child.usage)) return false;
		return !(parent.usageByTurn ?? []).some((turn) => turn.turnId === child.session.id);
	}

	/**
	 * Fold in the usage of subagents the model ran during a turn that has now ended.
	 * Their results were already delivered as tool results; this is what keeps the
	 * parent's cost and token budgets honest across delegated work.
	 */
	async #settleInlineSubagents(parentSessionId: string): Promise<void> {
		const parent = this.store.loadSnapshot(parentSessionId);
		if (!parent) return;
		for (const child of this.store.listChildSnapshots(parentSessionId, 100)) {
			const operation = this.store.listOperations(child.session.id, 1)[0];
			if (!operation || operation.payload.deliverInline !== true) continue;
			if (!this.#subagentPublishPending(parent, child, operation)) continue;
			await this.publishSubagentResult(parentSessionId, child.session.id);
		}
	}

	/** The parent-scoped view of one subagent, for callers acting on the parent's behalf. */
	subagentSummary(parentSessionId: string, subagentId: string): SubagentSummary {
		const child = this.store.loadSnapshot(subagentId);
		if (!child || child.session.parentSessionId !== parentSessionId)
			throw new OrchestratorError("not_found", `Subagent ${subagentId} does not exist`);
		const summary = this.#loadSubagentSummary(subagentId);
		if (!summary) throw new OrchestratorError("not_found", `Subagent ${subagentId} has no operation`);
		return summary;
	}

	async forkSession(input: ForkSessionInput): Promise<Extract<CommandResult, { type: "session.forked" }>> {
		return this.#serializeCommand(`fork:${input.sessionId}:${input.idempotencyKey}`, () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "session.fork",
				sessionId: input.sessionId,
				fromItemId: input.fromItemId,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.forked" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle")
				throw new OrchestratorError("conflict", "Only an idle session can be forked");
			const end =
				input.fromItemId === undefined
					? current.transcript.length
					: current.transcript.findIndex((item) => item.id === input.fromItemId) + 1;
			if (input.fromItemId !== undefined && end === 0) {
				throw new OrchestratorError("not_found", `Transcript item ${input.fromItemId} does not exist`);
			}
			const sessionId = this.#idFactory();
			const sourceName = !isAutomaticSessionTitle(current.session.name)
				? current.session.name
				: suggestSessionTitleFromTranscript(current.transcript);
			const forkName = sourceName ? appendForkTitle(sourceName) : undefined;
			const event: SessionEvent = {
				type: "session.created",
				eventId: this.#idFactory(),
				sessionId,
				revision: 1,
				timestamp: now,
				session: {
					id: sessionId,
					workspaceId: current.session.workspaceId,
					...(forkName === undefined ? {} : { name: forkName }),
					phase: "idle",
					createdAt: now,
					updatedAt: now,
				},
				model: current.model,
				thinkingLevel: current.thinkingLevel,
				sandboxMode: current.sandboxMode,
				approvalPolicy: current.approvalPolicy,
				usage: EMPTY_USAGE,
				...(current.costBudgetUsd === undefined ? {} : { costBudgetUsd: current.costBudgetUsd }),
				...(current.tokenBudget === undefined ? {} : { tokenBudget: current.tokenBudget }),
				...(current.budgetWarningThreshold === undefined
					? {}
					: { budgetWarningThreshold: current.budgetWarningThreshold }),
			};
			const events: SessionEvent[] = [event];
			let snapshot = reduceSessionEvent(undefined, event);
			for (const item of current.transcript.slice(0, end)) {
				const itemEvent: SessionEvent = {
					type: "session.item.upserted",
					eventId: this.#idFactory(),
					sessionId,
					revision: snapshot.revision + 1,
					timestamp: item.createdAt,
					item,
				};
				events.push(itemEvent);
				snapshot = reduceSessionEvent(snapshot, itemEvent);
			}
			const result = { type: "session.forked", snapshot } as const;
			const committed = this.store.commitMutation({
				sessionId,
				expectedRevision: 0,
				events,
				snapshot,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			return committed.result as Extract<CommandResult, { type: "session.forked" }>;
		});
	}

	async setSessionModel(input: SetSessionModelInput): Promise<Extract<CommandResult, { type: "session.configured" }>> {
		return this.#serializeCommand(input.sessionId, () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "session.model.set",
				sessionId: input.sessionId,
				model: input.model,
				...(input.thinkingLevels ? { thinkingLevels: input.thinkingLevels } : {}),
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.configured" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle")
				throw new OrchestratorError("conflict", "Only an idle session can change model");
			if (current.model.provider === input.model.provider && current.model.id === input.model.id) {
				throw new OrchestratorError("conflict", "Session already uses that model");
			}
			const event: SessionEvent = {
				type: "session.model.changed",
				eventId: this.#idFactory(),
				sessionId: input.sessionId,
				revision: current.revision + 1,
				timestamp: now,
				model: input.model,
			};
			const events: SessionEvent[] = [event];
			let snapshot = reduceSessionEvent(current, event);
			if (input.thinkingLevels) {
				const thinkingLevel = clampModelThinkingLevel(
					{ reasoning: true, thinkingLevels: input.thinkingLevels },
					current.thinkingLevel
				);
				if (thinkingLevel !== current.thinkingLevel) {
					const thinkingEvent: SessionEvent = {
						type: "session.thinking.changed",
						eventId: this.#idFactory(),
						sessionId: input.sessionId,
						revision: snapshot.revision + 1,
						timestamp: now,
						thinkingLevel,
					};
					events.push(thinkingEvent);
					snapshot = reduceSessionEvent(snapshot, thinkingEvent);
				}
			}
			const result = { type: "session.configured", snapshot } as const;
			const committed = this.store.commitMutation({
				sessionId: input.sessionId,
				expectedRevision: current.revision,
				events,
				snapshot,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			return committed.result as Extract<CommandResult, { type: "session.configured" }>;
		});
	}

	async setSessionPolicy(
		input: SetSessionPolicyInput
	): Promise<Extract<CommandResult, { type: "session.configured" }>> {
		return this.#serializeCommand(input.sessionId, () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "session.policy.set",
				sessionId: input.sessionId,
				sandboxMode: input.sandboxMode,
				approvalPolicy: input.approvalPolicy,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.configured" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle")
				throw new OrchestratorError("conflict", "Only an idle session can change permissions");
			if (current.sandboxMode === input.sandboxMode && current.approvalPolicy === input.approvalPolicy) {
				throw new OrchestratorError("conflict", "Session already uses those permissions");
			}
			const event: SessionEvent = {
				type: "session.policy.changed",
				eventId: this.#idFactory(),
				sessionId: input.sessionId,
				revision: current.revision + 1,
				timestamp: now,
				sandboxMode: input.sandboxMode,
				approvalPolicy: input.approvalPolicy,
			};
			const snapshot = reduceSessionEvent(current, event);
			const result = { type: "session.configured", snapshot } as const;
			const committed = this.store.commitMutation({
				sessionId: input.sessionId,
				expectedRevision: current.revision,
				events: [event],
				snapshot,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			return committed.result as Extract<CommandResult, { type: "session.configured" }>;
		});
	}

	async setSessionThinking(
		input: SetSessionThinkingInput
	): Promise<Extract<CommandResult, { type: "session.configured" }>> {
		return this.#serializeCommand(input.sessionId, () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "session.thinking.set",
				sessionId: input.sessionId,
				thinkingLevel: input.thinkingLevel,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.configured" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle")
				throw new OrchestratorError("conflict", "Only an idle session can change thinking level");
			if (current.thinkingLevel === input.thinkingLevel)
				throw new OrchestratorError("conflict", "Session already uses that thinking level");
			const event: SessionEvent = {
				type: "session.thinking.changed",
				eventId: this.#idFactory(),
				sessionId: input.sessionId,
				revision: current.revision + 1,
				timestamp: now,
				thinkingLevel: input.thinkingLevel,
			};
			const snapshot = reduceSessionEvent(current, event);
			const result = { type: "session.configured", snapshot } as const;
			const committed = this.store.commitMutation({
				sessionId: input.sessionId,
				expectedRevision: current.revision,
				events: [event],
				snapshot,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			return committed.result as Extract<CommandResult, { type: "session.configured" }>;
		});
	}

	async setSessionBudget(
		input: SetSessionBudgetInput
	): Promise<Extract<CommandResult, { type: "session.configured" }>> {
		return this.#serializeCommand(input.sessionId, () => {
			const now = this.#clock();
			if (
				input.costBudgetUsd === undefined &&
				input.tokenBudget === undefined &&
				input.budgetWarningThreshold === undefined
			)
				throw new OrchestratorError("conflict", "At least one budget setting is required");
			if (
				input.costBudgetUsd !== undefined &&
				input.costBudgetUsd !== null &&
				(!Number.isFinite(input.costBudgetUsd) || input.costBudgetUsd <= 0)
			)
				throw new OrchestratorError("conflict", "costBudgetUsd must be positive");
			if (
				input.tokenBudget !== undefined &&
				input.tokenBudget !== null &&
				(!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)
			)
				throw new OrchestratorError("conflict", "tokenBudget must be a positive integer");
			if (
				input.budgetWarningThreshold !== undefined &&
				(!Number.isFinite(input.budgetWarningThreshold) ||
					input.budgetWarningThreshold <= 0 ||
					input.budgetWarningThreshold > 1)
			)
				throw new OrchestratorError("conflict", "budgetWarningThreshold must be between 0 and 1");
			const hash = commandHash({
				type: "session.budget.set",
				sessionId: input.sessionId,
				costBudgetUsd: input.costBudgetUsd,
				tokenBudget: input.tokenBudget,
				budgetWarningThreshold: input.budgetWarningThreshold,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.configured" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle")
				throw new OrchestratorError("conflict", "Only an idle session can change budget");
			const event: SessionEvent = {
				type: "session.budget.changed",
				eventId: this.#idFactory(),
				sessionId: input.sessionId,
				revision: current.revision + 1,
				timestamp: now,
				...(input.costBudgetUsd === undefined ? {} : { costBudgetUsd: input.costBudgetUsd }),
				...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
				...(input.budgetWarningThreshold === undefined ? {} : { budgetWarningThreshold: input.budgetWarningThreshold }),
			};
			const snapshot = reduceSessionEvent(current, event);
			const result = { type: "session.configured", snapshot } as const;
			const committed = this.store.commitMutation({
				sessionId: input.sessionId,
				expectedRevision: current.revision,
				events: [event],
				snapshot,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			return committed.result as Extract<CommandResult, { type: "session.configured" }>;
		});
	}

	async compactSession(input: CompactSessionInput): Promise<Extract<CommandResult, { type: "session.compacted" }>> {
		return this.#serializeCommand(input.sessionId, async () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "session.compact",
				sessionId: input.sessionId,
				instructions: input.instructions,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.compacted" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle")
				throw new OrchestratorError("conflict", "Only an idle session can be compacted");
			if (!this.runtime.compact)
				throw new OrchestratorError("conflict", "The active runtime does not support compaction");
			const controller = new AbortController();
			const result = await this.runtime.compact({
				snapshot: current,
				signal: controller.signal,
				...(input.instructions === undefined ? {} : { instructions: input.instructions }),
			});
			const summary = result.summary.trim();
			if (!summary) throw new OrchestratorError("conflict", "Runtime returned an empty compaction summary");
			const memories = compactionMemories(
				this.#idFactory,
				current,
				undefined,
				[{ reason: "manual", ...result, summary }],
				now
			);
			const item: TranscriptItem = {
				id: this.#idFactory(),
				type: "assistant",
				createdAt: now,
				status: "complete",
				content: [{ type: "text", text: `[Context compacted]\n\n${summary.slice(0, 100_000)}` }],
				model: current.model,
			};
			const itemEvent: SessionEvent = {
				type: "session.item.upserted",
				eventId: this.#idFactory(),
				sessionId: input.sessionId,
				revision: current.revision + 1,
				timestamp: now,
				item,
			};
			const events: SessionEvent[] = [itemEvent];
			let snapshot = reduceSessionEvent(current, itemEvent);
			snapshot = this.#appendContextUsage(
				snapshot,
				{
					model: current.model,
					tokens: result.estimatedTokensAfter ?? null,
					basis: "compaction",
				},
				events,
				now
			);
			if (result.usage) {
				const usageEvent: SessionEvent = {
					type: "session.usage.replaced",
					eventId: this.#idFactory(),
					sessionId: input.sessionId,
					revision: snapshot.revision + 1,
					timestamp: now,
					usage: addUsage(snapshot.usage, result.usage),
				};
				events.push(usageEvent);
				snapshot = reduceSessionEvent(snapshot, usageEvent);
			}
			const response = { type: "session.compacted", snapshot } as const;
			const committed = this.store.commitMutation({
				sessionId: input.sessionId,
				expectedRevision: current.revision,
				events,
				snapshot,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result: response,
					expiresAt: now + this.#idempotencyTtlMs,
				},
				memories,
			});
			return committed.result as Extract<CommandResult, { type: "session.compacted" }>;
		});
	}

	async manageMemory(input: ManageMemoryInput): Promise<Extract<CommandResult, { type: "session.memory.managed" }>> {
		return this.#serializeCommand(input.sessionId, () => {
			const now = this.#clock();
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.archivedAt !== undefined)
				throw new OrchestratorError("conflict", "Archived sessions are read-only");
			if (current.session.phase !== "idle")
				throw new OrchestratorError("conflict", "Memory can only be managed while the session is idle");
			return this.store.manageMemory({
				principalId: input.principalId,
				idempotencyKey: input.idempotencyKey,
				commandHash: commandHash({
					type: "session.memory.manage",
					sessionId: input.sessionId,
					memoryId: input.memoryId,
					action: input.action,
				}),
				sessionId: input.sessionId,
				memoryId: input.memoryId,
				action: input.action,
				now,
				expiresAt: now + this.#idempotencyTtlMs,
			});
		});
	}

	async renameSession(input: RenameSessionInput): Promise<Extract<CommandResult, { type: "session.renamed" }>> {
		return this.#serializeCommand(input.sessionId, () => {
			const name = input.name.trim();
			if (!name) throw new OrchestratorError("conflict", "Session name cannot be empty");
			const now = this.#clock();
			const hash = commandHash({ type: "session.rename", sessionId: input.sessionId, name });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.renamed" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle")
				throw new OrchestratorError("conflict", "Only an idle session can be renamed");
			if (current.session.name === name) throw new OrchestratorError("conflict", "Session already has that name");
			const event: SessionEvent = {
				type: "session.renamed",
				eventId: this.#idFactory(),
				sessionId: input.sessionId,
				revision: current.revision + 1,
				timestamp: now,
				name,
			};
			const snapshot = reduceSessionEvent(current, event);
			const result = { type: "session.renamed", snapshot } as const;
			const committed = this.store.commitMutation({
				sessionId: input.sessionId,
				expectedRevision: current.revision,
				events: [event],
				snapshot,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			return committed.result as Extract<CommandResult, { type: "session.renamed" }>;
		});
	}

	async archiveSession(input: ArchiveSessionInput): Promise<Extract<CommandResult, { type: "session.archived" }>> {
		return this.#serializeCommand(input.sessionId, () => {
			const now = this.#clock();
			const hash = commandHash({
				type: "session.archive",
				sessionId: input.sessionId,
				archived: input.archived,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.archived" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle")
				throw new OrchestratorError("conflict", "Only an idle session can be archived");
			const currentlyArchived = current.session.archivedAt !== undefined;
			if (currentlyArchived === input.archived) {
				throw new OrchestratorError("conflict", `Session is already ${input.archived ? "archived" : "active"}`);
			}
			const event: SessionEvent = {
				type: "session.archived",
				eventId: this.#idFactory(),
				sessionId: input.sessionId,
				revision: current.revision + 1,
				timestamp: now,
				...(input.archived ? { archivedAt: now } : {}),
			};
			const snapshot = reduceSessionEvent(current, event);
			const result = { type: "session.archived", snapshot } as const;
			const committed = this.store.commitMutation({
				sessionId: input.sessionId,
				expectedRevision: current.revision,
				events: [event],
				snapshot,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			return committed.result as Extract<CommandResult, { type: "session.archived" }>;
		});
	}

	async acceptTurn(input: AcceptTurnInput): Promise<Extract<CommandResult, { type: "turn.accepted" }>> {
		const result = await this.#serializeCommand(input.sessionId, () => this.#acceptTurnLocked(input));
		if (result.type !== "turn.accepted")
			throw new OrchestratorError("conflict", "A normal turn returned an unexpected result");
		return result;
	}

	#acceptTurnLocked(input: AcceptTurnInput): CommandResult {
		if (input.content.length === 0) throw new OrchestratorError("conflict", "A turn requires content");
		const now = this.#clock();
		const skills = normalizeSkills(input.skills);
		const hash = input.goalId
			? commandHash({ type: "goal.start", sessionId: input.sessionId, goalId: input.goalId })
			: commandHash({
					type: `turn.${input.mode}`,
					sessionId: input.sessionId,
					content: input.content,
					skills,
				});
		const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
		if (existing) return existing;
		const current = this.store.loadSnapshot(input.sessionId);
		if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
		if (current.session.archivedAt !== undefined)
			throw new OrchestratorError("conflict", "Archived sessions are read-only");
		const goal = input.goalId ? this.store.loadGoal(input.goalId) : undefined;
		if (input.goalId && (!goal || goal.parentSessionId !== input.sessionId))
			throw new OrchestratorError("not_found", `Goal ${input.goalId} does not exist`);
		if (goal && (goal.executionMode !== "session" || goal.operationId !== undefined || goal.runSessionId !== undefined))
			throw new OrchestratorError("conflict", `Goal ${goal.id} is not available for a session turn`);
		if (goal && input.mode !== "prompt")
			throw new OrchestratorError("conflict", "A session goal must start from an idle turn");
		if (current.costBudgetUsd !== undefined && current.usage.costUsd >= current.costBudgetUsd) {
			throw new OrchestratorError(
				"budget_exceeded",
				`Session cost budget of $${current.costBudgetUsd.toFixed(4)} has been exhausted`
			);
		}
		if (current.tokenBudget !== undefined && current.usage.totalTokens >= current.tokenBudget) {
			throw new OrchestratorError(
				"budget_exceeded",
				`Session token budget of ${current.tokenBudget} has been exhausted`
			);
		}
		if (input.mode === "prompt" && current.session.phase !== "idle") {
			throw new OrchestratorError("conflict", `Session ${input.sessionId} is not idle`);
		}
		if (input.mode !== "prompt" && current.session.phase === "idle") {
			throw new OrchestratorError("conflict", `${input.mode} requires an active turn`);
		}

		const userItemId = this.#idFactory();
		const events: SessionEvent[] = [];
		let snapshot = current;
		const userItem: TranscriptItem = {
			id: userItemId,
			type: "user",
			createdAt: now,
			content: input.content,
		};
		const itemEvent: SessionEvent = {
			type: "session.item.upserted",
			eventId: this.#idFactory(),
			sessionId: input.sessionId,
			revision: snapshot.revision + 1,
			timestamp: now,
			item: userItem,
		};
		events.push(itemEvent);
		snapshot = reduceSessionEvent(snapshot, itemEvent);

		if (input.mode === "prompt") {
			const phaseEvent: SessionEvent = {
				type: "session.phase.changed",
				eventId: this.#idFactory(),
				sessionId: input.sessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				phase: "turn",
			};
			events.push(phaseEvent);
			snapshot = reduceSessionEvent(snapshot, phaseEvent);
		} else {
			const queueEvent: SessionEvent = {
				type: "session.queue.changed",
				eventId: this.#idFactory(),
				sessionId: input.sessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				queuedSteerCount: snapshot.queuedSteerCount + (input.mode === "steer" ? 1 : 0),
				queuedFollowUpCount: snapshot.queuedFollowUpCount + (input.mode === "follow_up" ? 1 : 0),
			};
			events.push(queueEvent);
			snapshot = reduceSessionEvent(snapshot, queueEvent);
		}

		if (isAutomaticSessionTitle(current.session.name)) {
			const suggested = suggestSessionTitleFromTranscript(current.transcript) ?? suggestSessionTitle(input.content);
			if (suggested) {
				const titleEvent: SessionEvent = {
					type: "session.renamed",
					eventId: this.#idFactory(),
					sessionId: input.sessionId,
					revision: snapshot.revision + 1,
					timestamp: now,
					name: wasLegacyForkTitle(current.session.name) ? appendForkTitle(suggested) : suggested,
				};
				events.push(titleEvent);
				snapshot = reduceSessionEvent(snapshot, titleEvent);
			}
		}

		const operation: DurableOperation = {
			id: this.#idFactory(),
			sessionId: input.sessionId,
			type: "turn",
			status: "queued",
			payload: {
				type: "turn",
				mode: input.mode,
				userItemId,
				content: input.content,
				...(input.runtimeContent === undefined ? {} : { runtimeContent: input.runtimeContent }),
				...(skills.length > 0 ? { skills } : {}),
				...(input.goalId === undefined ? {} : { goalId: input.goalId }),
			},
			attempt: 0,
			createdAt: now,
			updatedAt: now,
			abortRequested: false,
		};
		const goalUpdatedAt = goal ? Math.max(now, goal.updatedAt + 1) : undefined;
		const startedGoal = goal
			? { ...goal, operationId: operation.id, startedAt: now, updatedAt: goalUpdatedAt! }
			: undefined;
		const result: CommandResult = startedGoal
			? {
					type: "goal.started",
					goal: summarizeGoal(startedGoal, {
						status: "queued",
						operationId: operation.id,
						updatedAt: goalUpdatedAt!,
						startedAt: now,
						usage: EMPTY_USAGE,
						pendingApprovals: [],
					}),
				}
			: {
					type: "turn.accepted",
					sessionId: input.sessionId,
					revision: snapshot.revision,
					queue: input.mode === "prompt" ? "active" : input.mode,
				};
		const committed = this.store.commitMutation({
			sessionId: input.sessionId,
			expectedRevision: current.revision,
			events,
			snapshot,
			operation,
			...(goal === undefined
				? {}
				: {
						attachGoalOperation: {
							goalId: goal.id,
							parentSessionId: input.sessionId,
							operationId: operation.id,
							expectedUpdatedAt: goal.updatedAt,
							updatedAt: goalUpdatedAt!,
							startedAt: now,
						},
					}),
			idempotency: {
				principalId: input.principalId,
				key: input.idempotencyKey,
				commandHash: hash,
				result,
				expiresAt: now + this.#idempotencyTtlMs,
			},
		});
		if (!committed.result) throw new OrchestratorError("conflict", `Turn ${operation.id} did not persist a result`);
		return committed.result;
	}

	async abortTurn(input: AbortTurnInput): Promise<Extract<CommandResult, { type: "turn.abort_requested" }>> {
		return this.#serializeCommand(input.sessionId, () => {
			const now = this.#clock();
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			const hash = commandHash({ type: "turn.abort", sessionId: input.sessionId });
			const result = {
				type: "turn.abort_requested",
				sessionId: input.sessionId,
				revision: current.revision,
			} as const;
			const committed = this.store.requestOperationAbort({
				principalId: input.principalId,
				idempotencyKey: input.idempotencyKey,
				commandHash: hash,
				sessionId: input.sessionId,
				result,
				now,
				expiresAt: now + this.#idempotencyTtlMs,
			});
			const active = this.#activeTurns.get(input.sessionId);
			active?.controller.abort(new Error("Turn aborted by user"));
			if (!active) {
				const operation = this.store.getRunningOperation(input.sessionId);
				const approvalExecutions = operation ? this.store.listApprovalExecutionsForOperation(operation.id) : [];
				if (
					operation?.abortRequested &&
					approvalExecutions.some((approval) => approval.state === "waiting" || approval.state === "approved")
				) {
					for (const approval of approvalExecutions) this.store.interruptApprovalExecution(approval.approvalId, now);
					const lease = this.store.acquireWriterLease(
						input.sessionId,
						`approval-abort:${this.#idFactory()}`,
						now,
						this.#leaseTtlMs
					);
					try {
						this.#commitRuntimeFailure(
							operation,
							lease,
							"Turn aborted by user",
							true,
							true,
							undefined,
							undefined,
							undefined,
							"user_abort"
						);
					} finally {
						this.store.releaseWriterLease(lease);
					}
				}
			}
			return committed as Extract<CommandResult, { type: "turn.abort_requested" }>;
		});
	}

	async drainSession(sessionId: string, workerId = this.#idFactory(), traceId?: string): Promise<number> {
		const startedAt = this.#clock();
		const trace = traceId === undefined ? {} : { traceId };
		this.#logger.log("debug", "orchestrator.drain.started", { sessionId, workerId, ...trace });
		let lease = this.store.acquireWriterLease(sessionId, workerId, this.#clock(), this.#leaseTtlMs);
		let completed = 0;
		try {
			for (;;) {
				const operation = this.store.claimNextOperation(sessionId, this.#clock(), traceId);
				if (!operation) break;
				this.#logger.log("info", "orchestrator.operation.claimed", {
					sessionId,
					operationId: operation.id,
					attempt: operation.attempt,
					mode: operation.payload.mode,
					...trace,
				});
				lease = await this.#executeOperation(operation, lease, traceId);
				completed += 1;
			}
		} finally {
			this.store.releaseWriterLease(lease);
		}
		const snapshot = this.store.loadSnapshot(sessionId);
		if (snapshot?.session.parentSessionId) {
			await this.publishSubagentResult(snapshot.session.parentSessionId, sessionId);
		} else if (snapshot) {
			await this.#settleInlineSubagents(sessionId);
		}
		this.#logger.log("debug", "orchestrator.drain.finished", {
			sessionId,
			workerId,
			completed,
			durationMs: Math.max(0, this.#clock() - startedAt),
			...trace,
		});
		return completed;
	}

	async #ensureCapabilityPlan(
		operation: DurableOperation & { payload: TurnOperationPayload },
		snapshot: SessionSnapshot,
		signal: AbortSignal,
		traceId?: string
	): Promise<DurableOperation & { payload: TurnOperationPayload }> {
		if (operation.capabilityPlan || !this.runtime.resolveCapabilities) return operation;
		const capabilityPlan = await this.runtime.resolveCapabilities({ operation, snapshot, signal });
		if (signal.aborted) throw signal.reason;
		let planned: DurableOperation & { payload: TurnOperationPayload };
		if (!this.store.storeCapabilityPlan(operation.id, capabilityPlan, this.#clock())) {
			const persisted = this.store.getOperation(operation.id)?.capabilityPlan;
			if (!persisted)
				throw new OrchestratorError("conflict", `Operation ${operation.id} could not persist its capability plan`);
			planned = { ...operation, capabilityPlan: persisted };
		} else {
			planned = { ...operation, capabilityPlan };
		}
		const persistedPlan = planned.capabilityPlan;
		if (!persistedPlan)
			throw new OrchestratorError("conflict", `Operation ${operation.id} has no persisted capability plan`);
		this.#logger.log("info", "orchestrator.capabilities.resolved", {
			sessionId: operation.sessionId,
			operationId: operation.id,
			digest: persistedPlan.digest,
			count: persistedPlan.capabilities.length,
			...(traceId === undefined ? {} : { traceId }),
		});
		return planned;
	}

	async #ensureContextPlan(
		operation: DurableOperation & { payload: TurnOperationPayload },
		snapshot: SessionSnapshot,
		signal: AbortSignal,
		traceId?: string
	): Promise<DurableOperation & { payload: TurnOperationPayload }> {
		if (operation.contextPlan || !this.runtime.resolveContext) return operation;
		const contextPlan = await this.runtime.resolveContext({
			operation,
			snapshot,
			signal,
			onProgress: (event) => {
				if (signal.aborted) return;
				const progress = operation.payload.goalId
					? { ...event, goalId: operation.payload.goalId, runSessionId: operation.sessionId }
					: event;
				for (const listener of this.#progressListeners) listener(progress);
			},
			...(operation.capabilityPlan === undefined ? {} : { capabilityPlan: operation.capabilityPlan }),
		});
		if (signal.aborted) throw signal.reason;
		let planned: DurableOperation & { payload: TurnOperationPayload };
		if (!this.store.storeContextPlan(operation.id, contextPlan, this.#clock())) {
			const persisted = this.store.getOperation(operation.id)?.contextPlan;
			if (!persisted)
				throw new OrchestratorError("conflict", `Operation ${operation.id} could not persist its context plan`);
			planned = { ...operation, contextPlan: persisted };
		} else {
			planned = { ...operation, contextPlan };
		}
		const persistedPlan = planned.contextPlan;
		if (!persistedPlan)
			throw new OrchestratorError("conflict", `Operation ${operation.id} has no persisted context plan`);
		this.#logger.log("info", "orchestrator.context.resolved", {
			sessionId: operation.sessionId,
			operationId: operation.id,
			digest: persistedPlan.digest,
			fragmentCount: persistedPlan.fragments.length,
			estimatedSystemTokens: persistedPlan.estimatedSystemTokens,
			availableSystemTokens: persistedPlan.budget.availableSystemTokens,
			...(traceId === undefined ? {} : { traceId }),
		});
		return planned;
	}

	async #dispatchOperationHooks(
		point: HookPoint,
		operation: DurableOperation & { payload: TurnOperationPayload },
		data: CapabilityJson,
		signal: AbortSignal,
		traceId?: string,
		enforce = true
	): Promise<void> {
		const plan = operation.capabilityPlan;
		if (!plan?.capabilities.some((capability) => capability.kind === "hook" && capability.hook?.points.includes(point)))
			return;
		const result = await this.#hookPipeline.dispatch({
			plan,
			point,
			operationId: operation.id,
			sessionId: operation.sessionId,
			timestamp: this.#clock(),
			data,
			signal,
		});
		this.store.appendHookAuditRecords(operation.id, result.records);
		for (const record of result.records) {
			this.#logger.log(
				record.outcome === "failed" || record.outcome === "timed_out" || record.outcome === "denied" ? "warn" : "info",
				"orchestrator.hook.executed",
				{
					sessionId: operation.sessionId,
					operationId: operation.id,
					hookId: record.hookId,
					hookVersion: record.hookVersion,
					point: record.point,
					mode: record.mode,
					outcome: record.outcome,
					durationMs: record.durationMs,
					...(record.code === undefined ? {} : { code: record.code }),
					...(traceId === undefined ? {} : { traceId }),
				}
			);
		}
		if (!result.allowed && enforce) {
			throw new OrchestratorError(
				"conflict",
				`Hook ${result.denial?.hookId ?? "unknown"} blocked operation ${operation.id}: ${result.denial?.reason ?? "hook execution failed"}`
			);
		}
	}

	async #executeOperation(
		operation: DurableOperation,
		initialLease: WriterLease,
		traceId?: string
	): Promise<WriterLease> {
		if (operation.payload.type !== "turn")
			throw new OrchestratorError("conflict", `Unsupported operation ${operation.type}`);
		let lease = initialLease;
		let leaseFailure: unknown;
		const abortController = new AbortController();
		const durableTraceId = operation.traceId ?? traceId;
		const trace = durableTraceId === undefined ? {} : { traceId: durableTraceId };
		this.#logger.log("info", "orchestrator.runtime.started", {
			sessionId: operation.sessionId,
			operationId: operation.id,
			attempt: operation.attempt,
			mode: operation.payload.mode,
			...trace,
		});
		const activeTurn = { operationId: operation.id, controller: abortController };
		this.#activeTurns.set(operation.sessionId, activeTurn);
		const checkAbortRequest = () => {
			const persisted = this.store.getOperation(operation.id);
			if (persisted?.abortRequested && !abortController.signal.aborted) {
				abortController.abort(new Error("Turn aborted by user"));
			}
		};
		checkAbortRequest();
		const abortPoll = setInterval(checkAbortRequest, 250);
		const heartbeat = setInterval(
			() => {
				try {
					lease = this.store.renewWriterLease(lease, this.#clock(), this.#leaseTtlMs);
				} catch (error) {
					leaseFailure = error;
					abortController.abort(error);
				}
			},
			Math.max(10, Math.floor(this.#leaseTtlMs / 3))
		);
		const timeout = setTimeout(() => abortController.abort(new Error("Turn timed out")), this.#turnTimeoutMs);
		const injectionStop = new AbortController();
		const injectionPump = this.runtime.injectTurn
			? this.#pumpInjectedOperations(operation.sessionId, abortController.signal, injectionStop.signal)
			: Promise.resolve();

		try {
			const planSnapshot = this.store.loadSnapshot(operation.sessionId);
			if (!planSnapshot) throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
			operation = await this.#ensureCapabilityPlan(operation, planSnapshot, abortController.signal, durableTraceId);
			operation = await this.#ensureContextPlan(operation, planSnapshot, abortController.signal, durableTraceId);
			await this.#dispatchOperationHooks(
				"operation.before_execute",
				operation,
				{
					mode: operation.payload.mode,
					attempt: operation.attempt,
					model: planSnapshot.model,
					sandboxMode: planSnapshot.sandboxMode,
					approvalPolicy: planSnapshot.approvalPolicy,
					capabilityPlanDigest: operation.capabilityPlan?.digest ?? "",
					contextPlanDigest: operation.contextPlan?.digest ?? "",
				},
				abortController.signal,
				durableTraceId
			);
			for (;;) {
				if (abortController.signal.aborted) throw abortController.signal.reason;
				const before = this.store.loadSnapshot(operation.sessionId);
				if (!before) throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
				if (before.tokenBudget !== undefined && before.usage.totalTokens >= before.tokenBudget) {
					throw new OrchestratorError(
						"budget_exceeded",
						`Session token budget of ${before.tokenBudget} has been exhausted`
					);
				}
				if (
					before.costBudgetUsd !== undefined &&
					(before.tokenBudget === undefined || before.usage.costUsd > 0) &&
					before.usage.costUsd >= before.costBudgetUsd
				) {
					throw new OrchestratorError(
						"budget_exceeded",
						`Session cost budget of $${before.costBudgetUsd.toFixed(4)} has been exhausted`
					);
				}
				const result = await this.#executeRuntimeWithAbortFallback(
					{
						operation: operation as DurableOperation & { payload: typeof operation.payload },
						snapshot: before,
						signal: abortController.signal,
						onProgress: (event) => {
							if (!abortController.signal.aborted) {
								const progress = operation.payload.goalId
									? {
											...event,
											goalId: operation.payload.goalId,
											runSessionId: operation.sessionId,
										}
									: event;
								for (const listener of this.#progressListeners) listener(progress);
							}
						},
						onContextUsage: (contextUsage) => {
							if (abortController.signal.aborted) return;
							const current = this.store.loadSnapshot(operation.sessionId);
							if (!current) return;
							const events: SessionEvent[] = [];
							const snapshot = this.#appendContextUsage(current, contextUsage, events, this.#clock());
							if (events.length === 0) return;
							this.store.commitMutation({
								sessionId: operation.sessionId,
								expectedRevision: current.revision,
								events,
								snapshot,
								lease,
							});
						},
						onRetry: (event) => {
							const currentHistory = operation.retryHistory ?? [];
							operation = {
								...operation,
								retryHistory: [...currentHistory, { ...event, timestamp: this.#clock() }].slice(-32),
							};
						},
						...(before.costBudgetUsd === undefined ? {} : { costBudgetUsd: before.costBudgetUsd }),
						...(before.tokenBudget === undefined ? {} : { tokenBudget: before.tokenBudget }),
						...(operation.capabilityPlan === undefined ? {} : { capabilityPlan: operation.capabilityPlan }),
						...(operation.contextPlan === undefined ? {} : { contextPlan: operation.contextPlan }),
					},
					abortController.signal,
					durableTraceId
				);
				if (result.tools) operation = { ...operation, tools: mergeTools(operation.tools, result.tools) ?? [] };
				injectionStop.abort();
				await injectionPump;
				if (leaseFailure) throw leaseFailure;
				if (abortController.signal.aborted) throw abortController.signal.reason;
				const tokenBudgetExceeded =
					before.tokenBudget !== undefined &&
					result.usage !== undefined &&
					result.usage.totalTokens > before.tokenBudget;
				const budgetExceeded =
					before.costBudgetUsd !== undefined &&
					result.usage !== undefined &&
					(before.tokenBudget === undefined || result.usage.costUsd > 0) &&
					result.usage.costUsd > before.costBudgetUsd;
				if (budgetExceeded || tokenBudgetExceeded || result.failure) {
					const failure = budgetExceeded
						? {
								message: `Session cost budget of $${before.costBudgetUsd!.toFixed(4)} was exceeded`,
								code: "cost_budget_exceeded" as const,
							}
						: tokenBudgetExceeded
							? {
									message: `Session token budget of ${before.tokenBudget} was exceeded`,
									code: "cost_budget_exceeded" as const,
								}
							: result.failure!;
					const willRetry =
						failure.code === "runtime_error" && failure.retryable === true && operation.attempt <= this.#maxRetries;
					await this.#dispatchOperationHooks(
						"operation.on_error",
						operation,
						{
							mode: operation.payload.mode,
							attempt: operation.attempt,
							failureKind: budgetExceeded || tokenBudgetExceeded ? "budget" : (failure.kind ?? "provider"),
							error: failure.message.slice(0, 1000),
							willRetry,
						},
						abortController.signal,
						durableTraceId,
						false
					);
					if (willRetry) {
						const planDrifted = /(?:Context|Capability) plan drifted before operation/.test(failure.message);
						if (planDrifted) {
							this.store.clearExecutionPlans(operation.id, this.#clock());
							const {
								capabilityPlan: _capabilityPlan,
								contextPlan: _contextPlan,
								...operationWithoutPlans
							} = operation;
							operation = operationWithoutPlans;
							const refreshedSnapshot = this.store.loadSnapshot(operation.sessionId);
							if (!refreshedSnapshot)
								throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
							operation = await this.#ensureCapabilityPlan(
								operation,
								refreshedSnapshot,
								abortController.signal,
								durableTraceId
							);
							operation = await this.#ensureContextPlan(
								operation,
								refreshedSnapshot,
								abortController.signal,
								durableTraceId
							);
						}
						const nextAttempt = operation.attempt + 1;
						const delayMs = this.#retryBaseDelayMs * 2 ** Math.max(0, operation.attempt - 1);
						operation = {
							...operation,
							retryHistory: [
								...(operation.retryHistory ?? []),
								{
									attempt: operation.attempt,
									maxAttempts: this.#maxRetries,
									delayMs,
									error: failure.message,
									timestamp: this.#clock(),
								},
							].slice(-32),
						};
						this.#commitRuntimeRetry(
							operation,
							lease,
							result.usage,
							result.tools,
							result.requests,
							failure.message,
							delayMs,
							failure.kind ?? "provider",
							result.compactions,
							result.items,
							result.skills
						);
						for (const listener of this.#progressListeners)
							listener({
								type: "run.retrying",
								sessionId: operation.sessionId,
								...(operation.payload.goalId === undefined
									? {}
									: { goalId: operation.payload.goalId, runSessionId: operation.sessionId }),
								operationId: operation.id,
								attempt: operation.attempt,
								nextAttempt,
								maxAttempts: this.#maxRetries + 1,
								delayMs,
								failureKind: failure.kind ?? "provider",
								error: failure.message,
							});
						this.#logger.log("warn", "orchestrator.runtime.retry", {
							sessionId: operation.sessionId,
							operationId: operation.id,
							attempt: operation.attempt,
							nextAttempt,
							delayMs,
							error: failure.message,
							...trace,
						});
						await waitForWork(delayMs, abortController.signal);
						if (abortController.signal.aborted) throw abortController.signal.reason;
						this.store.startOperationRetry(operation.id, operation.attempt, this.#clock());
						operation = { ...operation, attempt: nextAttempt };
						continue;
					}
					const failureKind = budgetExceeded || tokenBudgetExceeded ? "budget" : (failure.kind ?? "provider");
					this.#commitRuntimeFailure(
						operation,
						lease,
						failure.message,
						false,
						false,
						result.usage,
						result.tools,
						result.requests,
						failureKind,
						result.compactions,
						result.items,
						result.skills
					);
					this.#logger.log("error", "orchestrator.runtime.failed", {
						sessionId: operation.sessionId,
						operationId: operation.id,
						attempt: operation.attempt,
						failureKind,
						error: failure.message,
						...trace,
					});
				} else {
					await this.#dispatchOperationHooks(
						"operation.after_execute",
						operation,
						{
							mode: operation.payload.mode,
							attempt: operation.attempt,
							itemCount: result.items.length,
							usage: result.usage ?? null,
							tools: (result.tools ?? []).map((tool) => tool.toolName),
						},
						abortController.signal,
						durableTraceId
					);
					this.#commitRuntimeCompletion(
						operation,
						lease,
						result.items,
						result.usage,
						result.tools,
						result.requests,
						result.compactions,
						result.skills
					);
					this.#logger.log("info", "orchestrator.runtime.completed", {
						sessionId: operation.sessionId,
						operationId: operation.id,
						attempt: operation.attempt,
						...trace,
					});
				}
				return lease;
			}
		} catch (error) {
			injectionStop.abort();
			await injectionPump;
			if (leaseFailure) throw leaseFailure;
			const aborted = this.store.getOperation(operation.id)?.abortRequested ?? false;
			const failureKind = aborted
				? "user_abort"
				: error instanceof OrchestratorError && error.code === "budget_exceeded"
					? "budget"
					: errorMessage(error) === "Turn timed out"
						? "provider_timeout"
						: "unknown";
			try {
				await this.#dispatchOperationHooks(
					"operation.on_error",
					operation,
					{
						mode: operation.payload.mode,
						attempt: operation.attempt,
						failureKind,
						error: (aborted ? "Turn aborted by user" : errorMessage(error)).slice(0, 1000),
						willRetry: false,
					},
					abortController.signal,
					durableTraceId,
					false
				);
			} catch (hookError) {
				this.#logger.log("warn", "orchestrator.hook.error_dispatch_failed", {
					sessionId: operation.sessionId,
					operationId: operation.id,
					error: errorMessage(hookError),
					...trace,
				});
			}
			this.#commitRuntimeFailure(
				operation,
				lease,
				aborted ? "Turn aborted by user" : errorMessage(error),
				aborted,
				false,
				undefined,
				undefined,
				undefined,
				failureKind
			);
			this.#logger.log(
				aborted ? "warn" : "error",
				aborted ? "orchestrator.runtime.aborted" : "orchestrator.runtime.exception",
				{
					sessionId: operation.sessionId,
					operationId: operation.id,
					attempt: operation.attempt,
					error: errorMessage(error),
					failureKind,
					...trace,
				}
			);
			return lease;
		} finally {
			clearInterval(heartbeat);
			clearTimeout(timeout);
			clearInterval(abortPoll);
			if (this.#activeTurns.get(operation.sessionId) === activeTurn) this.#activeTurns.delete(operation.sessionId);
		}
	}

	async #executeRuntimeWithAbortFallback(
		input: Parameters<AgentRuntime["executeTurn"]>[0],
		signal: AbortSignal,
		traceId?: string
	): Promise<RuntimeTurnResult> {
		const execution = this.runtime.executeTurn(input);
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let terminateTimer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const forced = new Promise<never>((_resolve, reject) => {
			onAbort = () => {
				graceTimer = setTimeout(() => {
					void (async () => {
						this.#logger.log("warn", "orchestrator.runtime.force_terminate", {
							sessionId: input.operation.sessionId,
							operationId: input.operation.id,
							graceMs: this.#abortGraceMs,
							...(traceId === undefined ? {} : { traceId }),
						});
						if (this.runtime.forceTerminate) {
							await Promise.race([
								this.runtime.forceTerminate(input.operation.sessionId).catch(() => {}),
								new Promise<void>((resolve) => {
									terminateTimer = setTimeout(resolve, this.#forceTerminateTimeoutMs);
								}),
							]);
						}
						reject(signal.reason ?? new Error("Turn aborted"));
					})();
				}, this.#abortGraceMs);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([execution, forced]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
			if (graceTimer) clearTimeout(graceTimer);
			if (terminateTimer) clearTimeout(terminateTimer);
		}
	}

	async #pumpInjectedOperations(sessionId: string, turnSignal: AbortSignal, stopSignal: AbortSignal): Promise<void> {
		const injectTurn = this.runtime.injectTurn;
		if (!injectTurn) return;
		while (!stopSignal.aborted && !turnSignal.aborted) {
			let operation = this.store.claimNextOperation(sessionId, this.#clock());
			if (!operation) {
				await waitForWork(75, stopSignal);
				continue;
			}
			if (operation.payload.mode === "prompt") {
				this.store.requeueOperation(operation.id, this.#clock());
				return;
			}
			const snapshot = this.store.loadSnapshot(sessionId);
			if (!snapshot) throw new OrchestratorError("not_found", `Session ${sessionId} does not exist`);
			try {
				operation = await this.#ensureCapabilityPlan(operation, snapshot, turnSignal, operation.traceId);
				operation = await this.#ensureContextPlan(operation, snapshot, turnSignal, operation.traceId);
				await this.#dispatchOperationHooks(
					"operation.before_execute",
					operation,
					{
						mode: operation.payload.mode,
						attempt: operation.attempt,
						model: snapshot.model,
						sandboxMode: snapshot.sandboxMode,
						approvalPolicy: snapshot.approvalPolicy,
						capabilityPlanDigest: operation.capabilityPlan?.digest ?? "",
						contextPlanDigest: operation.contextPlan?.digest ?? "",
						injected: true,
					},
					turnSignal,
					operation.traceId
				);
				await injectTurn.call(this.runtime, {
					operation,
					snapshot,
					signal: turnSignal,
					...(operation.capabilityPlan === undefined ? {} : { capabilityPlan: operation.capabilityPlan }),
					...(operation.contextPlan === undefined ? {} : { contextPlan: operation.contextPlan }),
				});
				await this.#dispatchOperationHooks(
					"operation.after_execute",
					operation,
					{
						mode: operation.payload.mode,
						attempt: operation.attempt,
						itemCount: 0,
						usage: null,
						tools: [],
						injected: true,
					},
					turnSignal,
					operation.traceId
				);
				this.#commitInjectedOperation(operation, turnSignal.aborted);
			} catch (error) {
				try {
					await this.#dispatchOperationHooks(
						"operation.on_error",
						operation,
						{
							mode: operation.payload.mode,
							attempt: operation.attempt,
							failureKind: "unknown",
							error: errorMessage(error).slice(0, 1000),
							willRetry: true,
							injected: true,
						},
						turnSignal,
						operation.traceId,
						false
					);
				} catch (hookError) {
					this.#logger.log("warn", "orchestrator.hook.error_dispatch_failed", {
						sessionId,
						operationId: operation.id,
						error: errorMessage(hookError),
						...(operation.traceId === undefined ? {} : { traceId: operation.traceId }),
					});
				}
				this.store.requeueOperation(operation.id, this.#clock(), errorMessage(error));
				return;
			}
		}
	}

	#commitInjectedOperation(operation: DurableOperation, interrupted: boolean): void {
		const current = this.store.loadSnapshot(operation.sessionId);
		if (!current) throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
		const now = this.#clock();
		const event: SessionEvent = {
			type: "session.queue.changed",
			eventId: this.#idFactory(),
			sessionId: operation.sessionId,
			revision: current.revision + 1,
			timestamp: now,
			queuedSteerCount: Math.max(0, current.queuedSteerCount - (operation.payload.mode === "steer" ? 1 : 0)),
			queuedFollowUpCount: Math.max(0, current.queuedFollowUpCount - (operation.payload.mode === "follow_up" ? 1 : 0)),
		};
		this.store.commitMutation({
			sessionId: operation.sessionId,
			expectedRevision: current.revision,
			events: [event],
			snapshot: reduceSessionEvent(current, event),
			settleOperation: {
				id: operation.id,
				status: interrupted ? "interrupted" : "completed",
				...(interrupted ? { error: "active turn aborted" } : {}),
			},
		});
	}

	#appendUsageAttribution(
		operation: DurableOperation,
		before: SessionSnapshot,
		snapshot: SessionSnapshot,
		usage: Usage | undefined,
		tools: UsageToolSummary[] | undefined,
		requests: UsageRequestSummary[] | undefined,
		events: SessionEvent[],
		now: number,
		skills: string[] = operation.payload.skills ?? []
	): SessionSnapshot {
		if (!usage) return snapshot;
		const delta = deltaUsage(usage, before.usage);
		if (!hasUsage(delta) && (!tools || tools.length === 0)) return snapshot;
		let next = snapshot;
		const usageEvent: SessionEvent = {
			type: "session.usage.recorded",
			eventId: this.#idFactory(),
			sessionId: operation.sessionId,
			revision: next.revision + 1,
			timestamp: now,
			turnId: operation.id,
			mode: operation.payload.mode,
			model: before.model,
			attempt: operation.attempt,
			usage: delta,
			tools: tools ?? [],
			requests: requests ?? [],
			skills: [...new Set(skills)].slice(0, 128),
		};
		events.push(usageEvent);
		next = reduceSessionEvent(next, usageEvent);
		const threshold = before.budgetWarningThreshold ?? 0.8;
		const warnings = next.budgetWarnings ?? [];
		const candidates: Array<{
			kind: "cost" | "tokens";
			budget: number;
			ratioBefore: number;
			ratioAfter: number;
		}> = [];
		if (before.tokenBudget !== undefined)
			candidates.push({
				kind: "tokens",
				budget: before.tokenBudget,
				ratioBefore: before.usage.totalTokens / before.tokenBudget,
				ratioAfter: usage.totalTokens / before.tokenBudget,
			});
		if (before.costBudgetUsd !== undefined && (before.tokenBudget === undefined || usage.costUsd > 0))
			candidates.push({
				kind: "cost",
				budget: before.costBudgetUsd,
				ratioBefore: before.usage.costUsd / before.costBudgetUsd,
				ratioAfter: usage.costUsd / before.costBudgetUsd,
			});
		for (const candidate of candidates) {
			const id = `${candidate.kind}:${candidate.budget}:${threshold}`;
			if (
				candidate.ratioBefore < threshold &&
				candidate.ratioAfter >= threshold &&
				!warnings.some((warning) => warning.id === id)
			) {
				const warning = {
					id,
					kind: candidate.kind,
					threshold,
					usage,
					budget: candidate.budget,
					createdAt: now,
				} as const;
				const warningEvent: SessionEvent = {
					type: "session.budget.warning",
					eventId: this.#idFactory(),
					sessionId: operation.sessionId,
					revision: next.revision + 1,
					timestamp: now,
					warning,
				};
				events.push(warningEvent);
				next = reduceSessionEvent(next, warningEvent);
			}
		}
		return next;
	}

	#checkVerificationGuard(
		operation: DurableOperation,
		snapshot: SessionSnapshot,
		tools: UsageToolSummary[] | undefined,
		items: TranscriptItem[],
		events: SessionEvent[],
		now: number
	): SessionSnapshot {
		const { changedTools, hasVerification } = verificationEvidence(items, tools);
		const hasCodeChanges = changedTools.length > 0;

		// 如果有代码变更但没有验证步骤，生成警告
		if (hasCodeChanges && !hasVerification) {
			const existing = snapshot.verificationWarnings ?? [];
			// 避免对同一个 operation 重复警告
			if (!existing.some((w) => w.operationId === operation.id)) {
				const warningEvent: SessionEvent = {
					type: "session.verification.missing",
					eventId: this.#idFactory(),
					sessionId: operation.sessionId,
					revision: snapshot.revision + 1,
					timestamp: now,
					operationId: operation.id,
					changedTools,
				};
				events.push(warningEvent);
				return reduceSessionEvent(snapshot, warningEvent);
			}
		}

		return snapshot;
	}

	#appendContextUsage(
		snapshot: SessionSnapshot,
		contextUsage: ContextUsageState,
		events: SessionEvent[],
		now: number
	): SessionSnapshot {
		if (contextUsage.model.provider !== snapshot.model.provider || contextUsage.model.id !== snapshot.model.id)
			return snapshot;
		const previous = snapshot.contextUsage;
		if (
			previous?.model.provider === contextUsage.model.provider &&
			previous.model.id === contextUsage.model.id &&
			previous.tokens === contextUsage.tokens &&
			previous.basis === contextUsage.basis
		)
			return snapshot;
		const event: SessionEvent = {
			type: "session.context.updated",
			eventId: this.#idFactory(),
			sessionId: snapshot.session.id,
			revision: snapshot.revision + 1,
			timestamp: now,
			contextUsage,
		};
		events.push(event);
		return reduceSessionEvent(snapshot, event);
	}

	#appendRuntimeItems(
		current: SessionSnapshot,
		items: TranscriptItem[],
		events: SessionEvent[],
		now: number
	): SessionSnapshot {
		let snapshot = current;
		for (const item of items) {
			const event: SessionEvent = {
				type: "session.item.upserted",
				eventId: this.#idFactory(),
				sessionId: current.session.id,
				revision: snapshot.revision + 1,
				timestamp: now,
				item,
			};
			events.push(event);
			snapshot = reduceSessionEvent(snapshot, event);
		}
		return snapshot;
	}

	#commitRuntimeCompletion(
		operation: DurableOperation,
		lease: WriterLease,
		items: TranscriptItem[],
		usage: SessionSnapshot["usage"] | undefined,
		tools: UsageToolSummary[] | undefined = operation.tools,
		requests: UsageRequestSummary[] | undefined = undefined,
		compactions: RuntimeCompactionRecord[] | undefined = undefined,
		skills?: string[]
	): void {
		const current = this.store.loadSnapshot(operation.sessionId);
		if (!current) throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
		const now = this.#clock();
		const events: SessionEvent[] = [];
		let snapshot = this.#appendRuntimeItems(current, items, events, now);
		if (usage && (usage.costUsd > snapshot.usage.costUsd || usage.totalTokens > snapshot.usage.totalTokens)) {
			const event: SessionEvent = {
				type: "session.usage.replaced",
				eventId: this.#idFactory(),
				sessionId: operation.sessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				usage,
			};
			events.push(event);
			snapshot = reduceSessionEvent(snapshot, event);
		}
		snapshot = this.#appendUsageAttribution(operation, current, snapshot, usage, tools, requests, events, now, skills);
		snapshot = this.#checkVerificationGuard(operation, snapshot, tools, items, events, now);
		if (operation.payload.mode !== "prompt") {
			const event: SessionEvent = {
				type: "session.queue.changed",
				eventId: this.#idFactory(),
				sessionId: operation.sessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				queuedSteerCount: Math.max(0, snapshot.queuedSteerCount - (operation.payload.mode === "steer" ? 1 : 0)),
				queuedFollowUpCount: Math.max(
					0,
					snapshot.queuedFollowUpCount - (operation.payload.mode === "follow_up" ? 1 : 0)
				),
			};
			events.push(event);
			snapshot = reduceSessionEvent(snapshot, event);
		}
		const phaseEvent: SessionEvent = {
			type: "session.phase.changed",
			eventId: this.#idFactory(),
			sessionId: operation.sessionId,
			revision: snapshot.revision + 1,
			timestamp: now,
			phase: this.store.countQueuedOperations(operation.sessionId) > 0 ? "turn" : "idle",
		};
		events.push(phaseEvent);
		snapshot = reduceSessionEvent(snapshot, phaseEvent);
		const memories = compactionMemories(this.#idFactory, snapshot, operation.id, compactions ?? [], now);
		this.store.commitMutation({
			sessionId: operation.sessionId,
			expectedRevision: current.revision,
			events,
			snapshot,
			settleOperation: {
				id: operation.id,
				status: "completed",
				...(usage ? { usage } : {}),
				...(operation.tools ? { tools: operation.tools } : {}),
				...(tools ? { trajectoryTools: tools } : {}),
				...(requests ? { requests } : {}),
				...(operation.retryHistory ? { retryHistory: operation.retryHistory } : {}),
			},
			...(memories.length === 0 ? {} : { memories }),
			lease,
		});
	}

	#commitRuntimeRetry(
		operation: DurableOperation,
		lease: WriterLease,
		usage: Usage | undefined,
		tools: UsageToolSummary[] | undefined,
		requests: UsageRequestSummary[] | undefined,
		message: string,
		delayMs: number,
		failureKind: DurableOperation["failureKind"] = "provider",
		compactions: RuntimeCompactionRecord[] | undefined = undefined,
		items: TranscriptItem[] = [],
		skills?: string[]
	): void {
		const current = this.store.loadSnapshot(operation.sessionId);
		if (!current) throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
		const now = this.#clock();
		const events: SessionEvent[] = [];
		let snapshot = this.#appendRuntimeItems(current, items, events, now);
		if (usage && (usage.costUsd > snapshot.usage.costUsd || usage.totalTokens > snapshot.usage.totalTokens)) {
			const event: SessionEvent = {
				type: "session.usage.replaced",
				eventId: this.#idFactory(),
				sessionId: operation.sessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				usage,
			};
			events.push(event);
			snapshot = reduceSessionEvent(snapshot, event);
		}
		snapshot = this.#appendUsageAttribution(operation, current, snapshot, usage, tools, requests, events, now, skills);
		const phase: SessionEvent = {
			type: "session.phase.changed",
			eventId: this.#idFactory(),
			sessionId: operation.sessionId,
			revision: snapshot.revision + 1,
			timestamp: now,
			phase: "retry",
		};
		events.push(phase);
		const retryHistory = operation.retryHistory ?? [];
		const finalSnapshot = reduceSessionEvent(snapshot, phase);
		const memories = compactionMemories(this.#idFactory, finalSnapshot, operation.id, compactions ?? [], now);
		this.store.commitMutation({
			sessionId: operation.sessionId,
			expectedRevision: current.revision,
			events,
			snapshot: finalSnapshot,
			retryOperation: {
				id: operation.id,
				error: message,
				retryAfter: now + delayMs,
				retryHistory,
				failureKind,
				...(usage ? { usage } : {}),
				...(operation.tools ? { tools: operation.tools } : {}),
				...(tools ? { trajectoryTools: tools } : {}),
				...(requests ? { requests } : {}),
			},
			...(memories.length === 0 ? {} : { memories }),
			lease,
		});
	}

	#commitRuntimeFailure(
		operation: DurableOperation,
		lease: WriterLease,
		message: string,
		aborted = false,
		cancelPendingApprovals = false,
		usage?: Usage,
		tools?: UsageToolSummary[],
		requests?: UsageRequestSummary[],
		failureKind: DurableOperation["failureKind"] = aborted ? "user_abort" : "unknown",
		compactions: RuntimeCompactionRecord[] | undefined = undefined,
		items: TranscriptItem[] = [],
		skills?: string[]
	): void {
		const current = this.store.loadSnapshot(operation.sessionId);
		if (!current) throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
		const now = this.#clock();
		const events: SessionEvent[] = [];
		let snapshot = this.#appendRuntimeItems(current, items, events, now);
		if (cancelPendingApprovals) {
			for (const pending of snapshot.pendingApprovals) {
				const approval = {
					...pending,
					status: "cancelled" as const,
					decidedAt: now,
					decidedBy: "system",
				};
				const approvalEvent: SessionEvent = {
					type: "approval.settled",
					eventId: this.#idFactory(),
					sessionId: operation.sessionId,
					revision: snapshot.revision + 1,
					timestamp: now,
					approval,
				};
				events.push(approvalEvent);
				snapshot = reduceSessionEvent(snapshot, approvalEvent);
			}
		}
		const errorItem: TranscriptItem = {
			id: `${operation.id}:error`,
			type: "assistant",
			createdAt: now,
			status: aborted ? "aborted" : "error",
			content: [],
			model: current.model,
			...(aborted ? {} : { error: message }),
		};
		const itemEvent: SessionEvent = {
			type: "session.item.upserted",
			eventId: this.#idFactory(),
			sessionId: operation.sessionId,
			revision: snapshot.revision + 1,
			timestamp: now,
			item: errorItem,
		};
		events.push(itemEvent);
		snapshot = reduceSessionEvent(snapshot, itemEvent);
		if (usage && (usage.costUsd > snapshot.usage.costUsd || usage.totalTokens > snapshot.usage.totalTokens)) {
			const usageEvent: SessionEvent = {
				type: "session.usage.replaced",
				eventId: this.#idFactory(),
				sessionId: operation.sessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				usage,
			};
			events.push(usageEvent);
			snapshot = reduceSessionEvent(snapshot, usageEvent);
		}
		snapshot = this.#appendUsageAttribution(operation, current, snapshot, usage, tools, requests, events, now, skills);
		if (operation.payload.mode !== "prompt") {
			const queueEvent: SessionEvent = {
				type: "session.queue.changed",
				eventId: this.#idFactory(),
				sessionId: operation.sessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				queuedSteerCount: Math.max(0, snapshot.queuedSteerCount - (operation.payload.mode === "steer" ? 1 : 0)),
				queuedFollowUpCount: Math.max(
					0,
					snapshot.queuedFollowUpCount - (operation.payload.mode === "follow_up" ? 1 : 0)
				),
			};
			events.push(queueEvent);
			snapshot = reduceSessionEvent(snapshot, queueEvent);
		}
		const phaseEvent: SessionEvent = {
			type: "session.phase.changed",
			eventId: this.#idFactory(),
			sessionId: operation.sessionId,
			revision: snapshot.revision + 1,
			timestamp: now,
			phase: this.store.countQueuedOperations(operation.sessionId) > 0 ? "turn" : "idle",
		};
		events.push(phaseEvent);
		snapshot = reduceSessionEvent(snapshot, phaseEvent);
		const memories = compactionMemories(this.#idFactory, snapshot, operation.id, compactions ?? [], now);
		this.store.commitMutation({
			sessionId: operation.sessionId,
			expectedRevision: current.revision,
			events,
			snapshot,
			settleOperation: {
				id: operation.id,
				status: aborted ? "interrupted" : "failed",
				error: message,
				...(usage ? { usage } : {}),
				...(operation.tools ? { tools: operation.tools } : {}),
				...(tools ? { trajectoryTools: tools } : {}),
				...(requests ? { requests } : {}),
				failureKind,
				...(operation.retryHistory ? { retryHistory: operation.retryHistory } : {}),
			},
			...(memories.length === 0 ? {} : { memories }),
			lease,
		});
	}
}

import { createHash, randomUUID } from "node:crypto";
import { EMPTY_USAGE, reduceSessionEvent, type SessionEvent } from "@wuming/domain";
import type {
	ApprovalPolicy,
	CommandResult,
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
import { SqliteOrchestratorStore } from "./store.js";
import type { AgentRuntime, DurableOperation, RuntimeTurnResult, StructuredLogger, TurnMode, WriterLease } from "./types.js";

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
	skills?: string[];
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
}

export interface SetSessionThinkingInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	thinkingLevel: ThinkingLevel;
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

export interface CreateSubagentInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	task: string;
	name?: string;
	costBudgetUsd?: number;
	tokenBudget?: number;
}

export interface CancelSubagentInput {
	principalId: string;
	idempotencyKey: string;
	sessionId: string;
	subagentId: string;
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
	return usage.totalTokens > 0 || usage.costUsd > 0 || usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0;
}

function mergeTools(left: UsageToolSummary[] | undefined, right: UsageToolSummary[] | undefined): UsageToolSummary[] | undefined {
	if (!left && !right) return undefined;
	const merged = new Map<string, UsageToolSummary>();
	for (const item of [...(left ?? []), ...(right ?? [])]) {
		const current = merged.get(item.toolName);
		merged.set(item.toolName, current ? {
			...current,
			callCount: current.callCount + item.callCount,
			usage: addUsage(current.usage, item.usage),
			...((current.durationMs !== undefined || item.durationMs !== undefined) ? { durationMs: (current.durationMs ?? 0) + (item.durationMs ?? 0) } : {}),
			...((current.succeededCount !== undefined || item.succeededCount !== undefined) ? { succeededCount: (current.succeededCount ?? 0) + (item.succeededCount ?? 0) } : {}),
			...((current.failedCount !== undefined || item.failedCount !== undefined) ? { failedCount: (current.failedCount ?? 0) + (item.failedCount ?? 0) } : {}),
			...((current.abortedCount !== undefined || item.abortedCount !== undefined) ? { abortedCount: (current.abortedCount ?? 0) + (item.abortedCount ?? 0) } : {}),
			...(current.mcpServerId || item.mcpServerId ? { mcpServerId: current.mcpServerId ?? item.mcpServerId! } : {}),
			...(current.mcpToolName || item.mcpToolName ? { mcpToolName: current.mcpToolName ?? item.mcpToolName! } : {}),
		} : item);
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
	return user.content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n").slice(0, 20_000) || snapshot.session.name || "Subagent task";
}

function subagentResult(snapshot: SessionSnapshot): string | undefined {
	const assistant = [...snapshot.transcript].reverse().find((item) => item.type === "assistant");
	if (!assistant || assistant.type !== "assistant") return undefined;
	const text = assistant.content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n");
	return (text || assistant.error)?.slice(0, 200_000);
}

function summarizeSubagent(snapshot: SessionSnapshot, operation: DurableOperation): SubagentSummary {
	const status = snapshot.session.phase === "awaiting_approval" && (operation.status === "queued" || operation.status === "running")
		? "awaiting_approval" as const
		: operation.abortRequested && (operation.status === "queued" || operation.status === "running")
			? "cancelling" as const
			: operation.status === "interrupted"
				? "cancelled" as const
				: operation.status;
	const result = operation.status === "completed" ? subagentResult(snapshot) : undefined;
	return {
		id: snapshot.session.id,
		parentSessionId: snapshot.session.parentSessionId!,
		sessionId: snapshot.session.id,
		operationId: operation.id,
		name: snapshot.session.name ?? "Subagent",
		task: subagentTask(snapshot),
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
	readonly #progressListeners = new Set<(event: ProgressEvent) => void>();
	readonly #commandTails = new Map<string, Promise<void>>();
	readonly #activeTurns = new Map<string, { operationId: string; controller: AbortController }>();

	constructor(
		readonly store: SqliteOrchestratorStore,
		readonly runtime: AgentRuntime,
		options: SessionOrchestratorOptions = {},
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
		if (this.#defaultCostBudgetUsd !== undefined && (!Number.isFinite(this.#defaultCostBudgetUsd) || this.#defaultCostBudgetUsd <= 0)) {
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
			const activeApprovalExecutions = approvalExecutions.filter((approval) => approval.state === "waiting" || approval.state === "approved" || approval.state === "executing");
			const recoverableApproval = activeApprovalExecutions.length === 1 && activeApprovalExecutions[0]?.mode === "preflight"
				? activeApprovalExecutions[0]
				: undefined;
			if (recoverableApproval?.state === "waiting") {
				const snapshot = this.store.loadSnapshot(operation.sessionId);
				if (snapshot?.pendingApprovals.length === 1 && snapshot.pendingApprovals[0]?.id === recoverableApproval.approvalId) {
					this.#logger.log("info", "orchestrator.recovery.approval_waiting", { sessionId: operation.sessionId, operationId: operation.id, approvalId: recoverableApproval.approvalId });
					recovered += 1;
					continue;
				}
			}
			if (recoverableApproval?.state === "approved" && this.store.requeueOperationForApproval(operation.id, recoverableApproval.approvalId, this.#clock())) {
				this.#logger.log("info", "orchestrator.recovery.approval_requeued", { sessionId: operation.sessionId, operationId: operation.id, approvalId: recoverableApproval.approvalId });
				recovered += 1;
				continue;
			}
			if (operation.retryAfter !== undefined && approvalExecutions.length === 0) {
				this.store.recoverRetryOperation(operation.id, this.#clock());
				this.#logger.log("info", "orchestrator.recovery.retry_requeued", { sessionId: operation.sessionId, operationId: operation.id, attempt: operation.attempt, retryAfter: operation.retryAfter });
				continue;
			}
			for (const approval of approvalExecutions) this.store.interruptApprovalExecution(approval.approvalId, this.#clock());
			const lease = this.store.acquireWriterLease(operation.sessionId, `recovery:${this.#idFactory()}`, this.#clock(), this.#leaseTtlMs);
			try {
				const unsafeToolState = approvalExecutions.some((approval) => approval.state === "executing" || approval.state === "completed" || approval.mode === "failure_retry");
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
					"runtime_restart",
				);
				this.#logger.log("warn", "orchestrator.recovery.operation_interrupted", { sessionId: operation.sessionId, operationId: operation.id, unsafeToolState });
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
		const lease = this.store.acquireWriterLease(operation.sessionId, `approval-recovery:${this.#idFactory()}`, now, this.#leaseTtlMs);
		try {
			this.#commitRuntimeFailure(operation, lease, `Recovered approval was ${approval.status}; the interrupted tool was not executed`, approval.status === "cancelled", false, undefined, undefined, undefined, approval.status === "cancelled" ? "user_abort" : "tool");
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
		const counts = await Promise.all([...sessions].map(async ([sessionId, dueAt]) => {
			const delayMs = Math.max(0, dueAt - this.#clock());
			if (delayMs > 0) await waitForWork(delayMs, new AbortController().signal);
			return this.drainSession(sessionId);
		}));
		return counts.reduce((total, count) => total + count, 0);
	}

	async reconcileSubagentResults(batchSize = 1000): Promise<number> {
		let published = 0;
		const size = Math.max(1, Math.min(10_000, Math.trunc(batchSize)));
		for (let offset = 0;; offset += size) {
			const children = this.store.listAllChildSnapshots(size, offset);
			for (const child of children) {
				const parentSessionId = child.session.parentSessionId;
				if (!parentSessionId) continue;
				const operation = this.store.listOperations(child.session.id, 1)[0];
				if (!operation || operation.status === "queued" || operation.status === "running") continue;
				const itemId = `subagent:${child.session.id}`;
				if (this.store.loadSnapshot(parentSessionId)?.transcript.some((item) => item.id === itemId)) continue;
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
			if (input.tokenBudget !== undefined && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)) throw new OrchestratorError("conflict", "tokenBudget must be a positive integer");
			if (input.budgetWarningThreshold !== undefined && (!Number.isFinite(input.budgetWarningThreshold) || input.budgetWarningThreshold <= 0 || input.budgetWarningThreshold > 1)) throw new OrchestratorError("conflict", "budgetWarningThreshold must be between 0 and 1");
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

	async createSubagent(input: CreateSubagentInput): Promise<Extract<CommandResult, { type: "subagent.created" }>> {
		return this.#serializeCommand(`subagent:create:${input.sessionId}:${input.idempotencyKey}`, () => {
			const now = this.#clock();
			const task = input.task.trim();
			if (!task) throw new OrchestratorError("conflict", "Subagent task cannot be empty");
			const hash = commandHash({ type: "subagent.create", sessionId: input.sessionId, task, name: input.name, costBudgetUsd: input.costBudgetUsd, tokenBudget: input.tokenBudget });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "subagent.created" }>;
			const parent = this.store.loadSnapshot(input.sessionId);
			if (!parent) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (parent.session.parentSessionId !== undefined) throw new OrchestratorError("conflict", "Nested subagents are not supported in this increment");
			if (parent.session.archivedAt !== undefined) throw new OrchestratorError("conflict", "Archived sessions cannot create subagents");
			const remainingCost = parent.costBudgetUsd === undefined ? undefined : Math.max(0, parent.costBudgetUsd - parent.usage.costUsd);
			const remainingTokens = parent.tokenBudget === undefined ? undefined : Math.max(0, parent.tokenBudget - parent.usage.totalTokens);
			if (remainingCost !== undefined && remainingCost <= 0) throw new OrchestratorError("budget_exceeded", "Parent session cost budget is exhausted");
			if (remainingTokens !== undefined && remainingTokens <= 0) throw new OrchestratorError("budget_exceeded", "Parent session token budget is exhausted");
			if (input.costBudgetUsd !== undefined && remainingCost !== undefined && input.costBudgetUsd > remainingCost) throw new OrchestratorError("budget_exceeded", "Subagent cost budget exceeds the parent session remaining budget");
			if (input.tokenBudget !== undefined && remainingTokens !== undefined && input.tokenBudget > remainingTokens) throw new OrchestratorError("budget_exceeded", "Subagent token budget exceeds the parent session remaining budget");
			const costBudgetUsd = input.costBudgetUsd ?? remainingCost;
			const tokenBudget = input.tokenBudget ?? remainingTokens;
			const sessionId = this.#idFactory();
			const operationId = this.#idFactory();
			const name = (input.name?.trim() || `Subagent: ${task.replace(/\s+/g, " ").slice(0, 80)}`).slice(0, 500);
			const created: SessionEvent = {
				type: "session.created",
				eventId: this.#idFactory(),
				sessionId,
				revision: 1,
				timestamp: now,
				session: { id: sessionId, workspaceId: parent.session.workspaceId, name, phase: "idle", createdAt: now, updatedAt: now, parentSessionId: parent.session.id },
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
				item: { id: userItemId, type: "user", createdAt: now, content: [{ type: "text", text: task }] },
			};
			snapshot = reduceSessionEvent(snapshot, item);
			const phase: SessionEvent = { type: "session.phase.changed", eventId: this.#idFactory(), sessionId, revision: 3, timestamp: now, phase: "turn" };
			snapshot = reduceSessionEvent(snapshot, phase);
			const operation: DurableOperation = {
				id: operationId,
				sessionId,
				type: "turn",
				status: "queued",
				payload: { type: "turn", mode: "prompt", userItemId, content: [{ type: "text", text: task }] },
				attempt: 0,
				createdAt: now,
				updatedAt: now,
				abortRequested: false,
			};
			const result = { type: "subagent.created", subagent: summarizeSubagent(snapshot, operation) } as const;
			const committed = this.store.commitMutation({
				sessionId,
				expectedRevision: 0,
				events: [created, item, phase],
				snapshot,
				operation,
				idempotency: { principalId: input.principalId, key: input.idempotencyKey, commandHash: hash, result, expiresAt: now + this.#idempotencyTtlMs },
			});
			return committed.result as Extract<CommandResult, { type: "subagent.created" }>;
		});
	}

	listSubagents(parentSessionId: string, limit = 100): SubagentSummary[] {
		if (!this.store.loadSnapshot(parentSessionId)) throw new OrchestratorError("not_found", `Session ${parentSessionId} does not exist`);
		return this.store.listChildSnapshots(parentSessionId, limit).flatMap((snapshot) => {
			const operation = this.store.listOperations(snapshot.session.id, 1)[0];
			return operation ? [summarizeSubagent(snapshot, operation)] : [];
		});
	}

	async cancelSubagent(input: CancelSubagentInput): Promise<Extract<CommandResult, { type: "subagent.cancel_requested" }>> {
		const result = await this.#serializeCommand(`subagent:cancel:${input.sessionId}:${input.subagentId}`, () => {
			const now = this.#clock();
			const parent = this.store.loadSnapshot(input.sessionId);
			const child = this.store.loadSnapshot(input.subagentId);
			if (!parent || !child || child.session.parentSessionId !== parent.session.id) throw new OrchestratorError("not_found", `Subagent ${input.subagentId} does not exist`);
			const operation = this.store.listOperations(child.session.id, 1)[0];
			if (!operation) throw new OrchestratorError("not_found", `Subagent ${input.subagentId} has no operation`);
			if (operation.status !== "queued" && operation.status !== "running") throw new OrchestratorError("conflict", `Subagent ${input.subagentId} is already ${operation.status}`);
			const projected = { ...operation, abortRequested: true, updatedAt: now };
			const result = { type: "subagent.cancel_requested", subagent: summarizeSubagent(child, projected) } as const;
			const committed = this.store.requestOperationAbort({
				principalId: input.principalId,
				idempotencyKey: input.idempotencyKey,
				commandHash: commandHash({ type: "subagent.cancel", sessionId: input.sessionId, subagentId: input.subagentId }),
				sessionId: child.session.id,
				result,
				now,
				expiresAt: now + this.#idempotencyTtlMs,
			});
			const active = this.#activeTurns.get(child.session.id);
			active?.controller.abort(new Error("Subagent cancelled by user"));
			if (!active) {
				const approvalExecutions = this.store.listApprovalExecutionsForOperation(operation.id);
				if (operation.status === "running" && approvalExecutions.some((approval) => approval.state === "waiting" || approval.state === "approved")) {
					for (const approval of approvalExecutions) this.store.interruptApprovalExecution(approval.approvalId, now);
					const lease = this.store.acquireWriterLease(child.session.id, `subagent-approval-abort:${this.#idFactory()}`, now, this.#leaseTtlMs);
					try {
						this.#commitRuntimeFailure(operation, lease, "Subagent cancelled by user", true, true, undefined, undefined, undefined, "user_abort");
					} finally {
						this.store.releaseWriterLease(lease);
					}
				}
			}
			return committed as Extract<CommandResult, { type: "subagent.cancel_requested" }>;
		});
		await this.publishSubagentResult(input.sessionId, input.subagentId);
		return result;
	}

	async publishSubagentResult(parentSessionId: string, subagentId: string): Promise<SubagentSummary> {
		return this.#serializeCommand(`subagent:publish:${parentSessionId}:${subagentId}`, () => {
			const parent = this.store.loadSnapshot(parentSessionId);
			const child = this.store.loadSnapshot(subagentId);
			if (!parent || !child || child.session.parentSessionId !== parent.session.id) throw new OrchestratorError("not_found", `Subagent ${subagentId} does not exist`);
			const operation = this.store.listOperations(subagentId, 1)[0];
			if (!operation) throw new OrchestratorError("not_found", `Subagent ${subagentId} has no operation`);
			const summary = summarizeSubagent(child, operation);
			if (operation.status === "queued" || operation.status === "running") return summary;
			const itemId = `subagent:${subagentId}`;
			if (parent.transcript.some((item) => item.id === itemId)) return summary;
			const now = this.#clock();
			const text = summary.result ?? summary.error ?? (summary.status === "cancelled" ? "Subagent was cancelled." : `Subagent finished with status ${summary.status}.`);
			const events: SessionEvent[] = [];
			let snapshot = parent;
			const itemEvent: SessionEvent = {
				type: "session.item.upserted",
				eventId: this.#idFactory(),
				sessionId: parentSessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				item: {
					id: itemId,
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
			if (hasUsage(child.usage)) {
				const usage = addUsage(snapshot.usage, child.usage);
				const replaced: SessionEvent = { type: "session.usage.replaced", eventId: this.#idFactory(), sessionId: parentSessionId, revision: snapshot.revision + 1, timestamp: now, usage };
				events.push(replaced);
				snapshot = reduceSessionEvent(snapshot, replaced);
				const recorded: SessionEvent = { type: "session.usage.recorded", eventId: this.#idFactory(), sessionId: parentSessionId, revision: snapshot.revision + 1, timestamp: now, turnId: subagentId, mode: "prompt", model: child.model, attempt: Math.max(1, operation.attempt), usage: child.usage, tools: [{ toolName: "subagent", callCount: 1, usage: child.usage, durationMs: operation.startedAt === undefined ? 0 : Math.max(0, (operation.finishedAt ?? operation.updatedAt) - operation.startedAt), succeededCount: operation.status === "completed" ? 1 : 0, failedCount: operation.status === "failed" ? 1 : 0, abortedCount: operation.status === "interrupted" ? 1 : 0 }], requests: [] };
				events.push(recorded);
				snapshot = reduceSessionEvent(snapshot, recorded);
			}
			this.store.commitMutation({ sessionId: parentSessionId, expectedRevision: parent.revision, events, snapshot });
			return summary;
		});
	}

	async forkSession(input: ForkSessionInput): Promise<Extract<CommandResult, { type: "session.forked" }>> {
		return this.#serializeCommand(`fork:${input.sessionId}:${input.idempotencyKey}`, () => {
			const now = this.#clock();
			const hash = commandHash({ type: "session.fork", sessionId: input.sessionId, fromItemId: input.fromItemId });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.forked" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle") throw new OrchestratorError("conflict", "Only an idle session can be forked");
			const end = input.fromItemId === undefined
				? current.transcript.length
				: current.transcript.findIndex((item) => item.id === input.fromItemId) + 1;
			if (input.fromItemId !== undefined && end === 0) {
				throw new OrchestratorError("not_found", `Transcript item ${input.fromItemId} does not exist`);
			}
			const sessionId = this.#idFactory();
			const sourceName = current.session.name ?? "Session";
			const event: SessionEvent = {
				type: "session.created",
				eventId: this.#idFactory(),
				sessionId,
				revision: 1,
				timestamp: now,
				session: {
					id: sessionId,
					workspaceId: current.session.workspaceId,
					name: `${sourceName} (fork)`.slice(0, 500),
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
				...(current.budgetWarningThreshold === undefined ? {} : { budgetWarningThreshold: current.budgetWarningThreshold }),
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
			const hash = commandHash({ type: "session.model.set", sessionId: input.sessionId, model: input.model });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.configured" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle") throw new OrchestratorError("conflict", "Only an idle session can change model");
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
			const snapshot = reduceSessionEvent(current, event);
			const result = { type: "session.configured", snapshot } as const;
			const committed = this.store.commitMutation({ sessionId: input.sessionId, expectedRevision: current.revision, events: [event], snapshot, idempotency: { principalId: input.principalId, key: input.idempotencyKey, commandHash: hash, result, expiresAt: now + this.#idempotencyTtlMs } });
			return committed.result as Extract<CommandResult, { type: "session.configured" }>;
		});
	}

	async setSessionThinking(input: SetSessionThinkingInput): Promise<Extract<CommandResult, { type: "session.configured" }>> {
		return this.#serializeCommand(input.sessionId, () => {
			const now = this.#clock();
			const hash = commandHash({ type: "session.thinking.set", sessionId: input.sessionId, thinkingLevel: input.thinkingLevel });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.configured" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle") throw new OrchestratorError("conflict", "Only an idle session can change thinking level");
			if (current.thinkingLevel === input.thinkingLevel) throw new OrchestratorError("conflict", "Session already uses that thinking level");
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
			const committed = this.store.commitMutation({ sessionId: input.sessionId, expectedRevision: current.revision, events: [event], snapshot, idempotency: { principalId: input.principalId, key: input.idempotencyKey, commandHash: hash, result, expiresAt: now + this.#idempotencyTtlMs } });
			return committed.result as Extract<CommandResult, { type: "session.configured" }>;
		});
	}

	async setSessionBudget(input: SetSessionBudgetInput): Promise<Extract<CommandResult, { type: "session.configured" }>> {
		return this.#serializeCommand(input.sessionId, () => {
			const now = this.#clock();
			if (input.costBudgetUsd === undefined && input.tokenBudget === undefined && input.budgetWarningThreshold === undefined) throw new OrchestratorError("conflict", "At least one budget setting is required");
			if (input.costBudgetUsd !== undefined && input.costBudgetUsd !== null && (!Number.isFinite(input.costBudgetUsd) || input.costBudgetUsd <= 0)) throw new OrchestratorError("conflict", "costBudgetUsd must be positive");
			if (input.tokenBudget !== undefined && input.tokenBudget !== null && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)) throw new OrchestratorError("conflict", "tokenBudget must be a positive integer");
			if (input.budgetWarningThreshold !== undefined && (!Number.isFinite(input.budgetWarningThreshold) || input.budgetWarningThreshold <= 0 || input.budgetWarningThreshold > 1)) throw new OrchestratorError("conflict", "budgetWarningThreshold must be between 0 and 1");
			const hash = commandHash({ type: "session.budget.set", sessionId: input.sessionId, costBudgetUsd: input.costBudgetUsd, tokenBudget: input.tokenBudget, budgetWarningThreshold: input.budgetWarningThreshold });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.configured" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle") throw new OrchestratorError("conflict", "Only an idle session can change budget");
			const event: SessionEvent = { type: "session.budget.changed", eventId: this.#idFactory(), sessionId: input.sessionId, revision: current.revision + 1, timestamp: now, ...(input.costBudgetUsd === undefined ? {} : { costBudgetUsd: input.costBudgetUsd }), ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }), ...(input.budgetWarningThreshold === undefined ? {} : { budgetWarningThreshold: input.budgetWarningThreshold }) };
			const snapshot = reduceSessionEvent(current, event);
			const result = { type: "session.configured", snapshot } as const;
			const committed = this.store.commitMutation({ sessionId: input.sessionId, expectedRevision: current.revision, events: [event], snapshot, idempotency: { principalId: input.principalId, key: input.idempotencyKey, commandHash: hash, result, expiresAt: now + this.#idempotencyTtlMs } });
			return committed.result as Extract<CommandResult, { type: "session.configured" }>;
		});
	}

	async compactSession(input: CompactSessionInput): Promise<Extract<CommandResult, { type: "session.compacted" }>> {
		return this.#serializeCommand(input.sessionId, async () => {
			const now = this.#clock();
			const hash = commandHash({ type: "session.compact", sessionId: input.sessionId, instructions: input.instructions });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.compacted" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle") throw new OrchestratorError("conflict", "Only an idle session can be compacted");
			if (!this.runtime.compact) throw new OrchestratorError("conflict", "The active runtime does not support compaction");
			const controller = new AbortController();
			const result = await this.runtime.compact({ snapshot: current, signal: controller.signal, ...(input.instructions === undefined ? {} : { instructions: input.instructions }) });
			const summary = result.summary.trim();
			if (!summary) throw new OrchestratorError("conflict", "Runtime returned an empty compaction summary");
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
			});
			return committed.result as Extract<CommandResult, { type: "session.compacted" }>;
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
			if (current.session.phase !== "idle") throw new OrchestratorError("conflict", "Only an idle session can be renamed");
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
			const hash = commandHash({ type: "session.archive", sessionId: input.sessionId, archived: input.archived });
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "session.archived" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.phase !== "idle") throw new OrchestratorError("conflict", "Only an idle session can be archived");
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
		return this.#serializeCommand(input.sessionId, () => {
			if (input.content.length === 0) throw new OrchestratorError("conflict", "A turn requires content");
			const now = this.#clock();
			const skills = normalizeSkills(input.skills);
			const hash = commandHash({
				type: `turn.${input.mode}`,
				sessionId: input.sessionId,
				content: input.content,
				skills,
			});
			const existing = this.store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
			if (existing) return existing as Extract<CommandResult, { type: "turn.accepted" }>;
			const current = this.store.loadSnapshot(input.sessionId);
			if (!current) throw new OrchestratorError("not_found", `Session ${input.sessionId} does not exist`);
			if (current.session.archivedAt !== undefined) throw new OrchestratorError("conflict", "Archived sessions are read-only");
			if (current.costBudgetUsd !== undefined && current.usage.costUsd >= current.costBudgetUsd) {
				throw new OrchestratorError("budget_exceeded", `Session cost budget of $${current.costBudgetUsd.toFixed(4)} has been exhausted`);
			}
			if (current.tokenBudget !== undefined && current.usage.totalTokens >= current.tokenBudget) {
				throw new OrchestratorError("budget_exceeded", `Session token budget of ${current.tokenBudget} has been exhausted`);
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

			const operation: DurableOperation = {
				id: this.#idFactory(),
				sessionId: input.sessionId,
				type: "turn",
				status: "queued",
				payload: { type: "turn", mode: input.mode, userItemId, content: input.content, ...(skills.length > 0 ? { skills } : {}) },
				attempt: 0,
				createdAt: now,
				updatedAt: now,
				abortRequested: false,
			};
			const result = {
				type: "turn.accepted",
				sessionId: input.sessionId,
				revision: snapshot.revision,
				queue: input.mode === "prompt" ? "active" : input.mode,
			} as const;
			const committed = this.store.commitMutation({
				sessionId: input.sessionId,
				expectedRevision: current.revision,
				events,
				snapshot,
				operation,
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			return committed.result as Extract<CommandResult, { type: "turn.accepted" }>;
		});
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
				if (operation?.abortRequested && approvalExecutions.some((approval) => approval.state === "waiting" || approval.state === "approved")) {
					for (const approval of approvalExecutions) this.store.interruptApprovalExecution(approval.approvalId, now);
					const lease = this.store.acquireWriterLease(input.sessionId, `approval-abort:${this.#idFactory()}`, now, this.#leaseTtlMs);
					try {
						this.#commitRuntimeFailure(operation, lease, "Turn aborted by user", true, true, undefined, undefined, undefined, "user_abort");
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
				this.#logger.log("info", "orchestrator.operation.claimed", { sessionId, operationId: operation.id, attempt: operation.attempt, mode: operation.payload.mode, ...trace });
				lease = await this.#executeOperation(operation, lease, traceId);
				completed += 1;
			}
		} finally {
			this.store.releaseWriterLease(lease);
		}
		const snapshot = this.store.loadSnapshot(sessionId);
		if (snapshot?.session.parentSessionId) {
			await this.publishSubagentResult(snapshot.session.parentSessionId, sessionId);
		}
		this.#logger.log("debug", "orchestrator.drain.finished", { sessionId, workerId, completed, durationMs: Math.max(0, this.#clock() - startedAt), ...trace });
		return completed;
	}

	async #executeOperation(operation: DurableOperation, initialLease: WriterLease, traceId?: string): Promise<WriterLease> {
		if (operation.payload.type !== "turn") throw new OrchestratorError("conflict", `Unsupported operation ${operation.type}`);
		let lease = initialLease;
		let leaseFailure: unknown;
		const abortController = new AbortController();
		const durableTraceId = operation.traceId ?? traceId;
		const trace = durableTraceId === undefined ? {} : { traceId: durableTraceId };
		this.#logger.log("info", "orchestrator.runtime.started", { sessionId: operation.sessionId, operationId: operation.id, attempt: operation.attempt, mode: operation.payload.mode, ...trace });
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
		const heartbeat = setInterval(() => {
			try {
				lease = this.store.renewWriterLease(lease, this.#clock(), this.#leaseTtlMs);
			} catch (error) {
				leaseFailure = error;
				abortController.abort(error);
			}
		}, Math.max(10, Math.floor(this.#leaseTtlMs / 3)));
		const timeout = setTimeout(() => abortController.abort(new Error("Turn timed out")), this.#turnTimeoutMs);
		const injectionStop = new AbortController();
		const injectionPump = this.runtime.injectTurn
			? this.#pumpInjectedOperations(operation.sessionId, abortController.signal, injectionStop.signal)
			: Promise.resolve();

		try {
			for (;;) {
			if (abortController.signal.aborted) throw abortController.signal.reason;
			const before = this.store.loadSnapshot(operation.sessionId);
			if (!before) throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
			if (before.tokenBudget !== undefined && before.usage.totalTokens >= before.tokenBudget) {
				throw new OrchestratorError("budget_exceeded", `Session token budget of ${before.tokenBudget} has been exhausted`);
			}
			if (before.costBudgetUsd !== undefined && (before.tokenBudget === undefined || before.usage.costUsd > 0) && before.usage.costUsd >= before.costBudgetUsd) {
				throw new OrchestratorError("budget_exceeded", `Session cost budget of $${before.costBudgetUsd.toFixed(4)} has been exhausted`);
			}
			const result = await this.#executeRuntimeWithAbortFallback({
				operation: operation as DurableOperation & { payload: typeof operation.payload },
				snapshot: before,
				signal: abortController.signal,
				onProgress: (event) => {
					if (!abortController.signal.aborted) {
						for (const listener of this.#progressListeners) listener(event);
					}
				},
				onRetry: (event) => {
					const currentHistory = operation.retryHistory ?? [];
					operation = { ...operation, retryHistory: [...currentHistory, { ...event, timestamp: this.#clock() }].slice(-32) };
				},
				...(before.costBudgetUsd === undefined ? {} : { costBudgetUsd: before.costBudgetUsd }),
				...(before.tokenBudget === undefined ? {} : { tokenBudget: before.tokenBudget }),
			}, abortController.signal, durableTraceId);
			if (result.tools) operation = { ...operation, tools: mergeTools(operation.tools, result.tools) ?? [] };
			if (result.skills) operation = { ...operation, payload: { ...operation.payload, skills: normalizeSkills(result.skills) } };
			injectionStop.abort();
			await injectionPump;
			if (leaseFailure) throw leaseFailure;
			if (abortController.signal.aborted) throw abortController.signal.reason;
			const tokenBudgetExceeded = before.tokenBudget !== undefined && result.usage !== undefined && result.usage.totalTokens > before.tokenBudget;
			const budgetExceeded = before.costBudgetUsd !== undefined && result.usage !== undefined && (before.tokenBudget === undefined || result.usage.costUsd > 0) && result.usage.costUsd > before.costBudgetUsd;
			if (budgetExceeded || tokenBudgetExceeded || result.failure) {
				const failure = budgetExceeded
					? { message: `Session cost budget of $${before.costBudgetUsd!.toFixed(4)} was exceeded`, code: "cost_budget_exceeded" as const }
					: tokenBudgetExceeded
						? { message: `Session token budget of ${before.tokenBudget} was exceeded`, code: "cost_budget_exceeded" as const }
					: result.failure!;
				if (failure.code === "runtime_error" && failure.retryable && operation.attempt <= this.#maxRetries) {
					const nextAttempt = operation.attempt + 1;
					const delayMs = this.#retryBaseDelayMs * 2 ** Math.max(0, operation.attempt - 1);
					operation = { ...operation, retryHistory: [...(operation.retryHistory ?? []), { attempt: operation.attempt, maxAttempts: this.#maxRetries, delayMs, error: failure.message, timestamp: this.#clock() }].slice(-32) };
					this.#commitRuntimeRetry(operation, lease, result.usage, result.tools, result.requests, failure.message, delayMs, failure.kind ?? "provider");
					this.#logger.log("warn", "orchestrator.runtime.retry", { sessionId: operation.sessionId, operationId: operation.id, attempt: operation.attempt, nextAttempt, delayMs, error: failure.message, ...trace });
					await waitForWork(delayMs, abortController.signal);
					if (abortController.signal.aborted) throw abortController.signal.reason;
					this.store.startOperationRetry(operation.id, operation.attempt, this.#clock());
				operation = { ...operation, attempt: nextAttempt };
					continue;
				}
				const failureKind = budgetExceeded || tokenBudgetExceeded ? "budget" : failure.kind ?? "provider";
				this.#commitRuntimeFailure(operation, lease, failure.message, false, false, result.usage, result.tools, result.requests, failureKind);
				this.#logger.log("error", "orchestrator.runtime.failed", { sessionId: operation.sessionId, operationId: operation.id, attempt: operation.attempt, failureKind, error: failure.message, ...trace });
			} else {
				this.#commitRuntimeCompletion(operation, lease, result.items, result.usage, result.tools, result.requests);
				this.#logger.log("info", "orchestrator.runtime.completed", { sessionId: operation.sessionId, operationId: operation.id, attempt: operation.attempt, ...trace });
			}
			return lease;
			}
		} catch (error) {
			injectionStop.abort();
			await injectionPump;
			if (leaseFailure) throw leaseFailure;
			const aborted = this.store.getOperation(operation.id)?.abortRequested ?? false;
			const failureKind = aborted ? "user_abort" : error instanceof OrchestratorError && error.code === "budget_exceeded" ? "budget" : errorMessage(error) === "Turn timed out" ? "provider_timeout" : "unknown";
			this.#commitRuntimeFailure(operation, lease, aborted ? "Turn aborted by user" : errorMessage(error), aborted, false, undefined, undefined, undefined, failureKind);
			this.#logger.log(aborted ? "warn" : "error", aborted ? "orchestrator.runtime.aborted" : "orchestrator.runtime.exception", { sessionId: operation.sessionId, operationId: operation.id, attempt: operation.attempt, error: errorMessage(error), failureKind, ...trace });
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
		traceId?: string,
	): Promise<RuntimeTurnResult> {
		const execution = this.runtime.executeTurn(input);
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let terminateTimer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const forced = new Promise<never>((_resolve, reject) => {
				onAbort = () => {
					graceTimer = setTimeout(() => {
						void (async () => {
							this.#logger.log("warn", "orchestrator.runtime.force_terminate", { sessionId: input.operation.sessionId, operationId: input.operation.id, graceMs: this.#abortGraceMs, ...(traceId === undefined ? {} : { traceId }) });
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
			const operation = this.store.claimNextOperation(sessionId, this.#clock());
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
				await injectTurn.call(this.runtime, { operation, snapshot, signal: turnSignal });
				this.#commitInjectedOperation(operation, turnSignal.aborted);
			} catch (error) {
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
			queuedFollowUpCount: Math.max(
				0,
				current.queuedFollowUpCount - (operation.payload.mode === "follow_up" ? 1 : 0),
			),
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
			skills: operation.payload.skills ?? [],
		};
		events.push(usageEvent);
		next = reduceSessionEvent(next, usageEvent);
		const threshold = before.budgetWarningThreshold ?? 0.8;
		const warnings = next.budgetWarnings ?? [];
		const candidates: Array<{ kind: "cost" | "tokens"; budget: number; ratioBefore: number; ratioAfter: number }> = [];
		if (before.tokenBudget !== undefined) candidates.push({ kind: "tokens", budget: before.tokenBudget, ratioBefore: before.usage.totalTokens / before.tokenBudget, ratioAfter: usage.totalTokens / before.tokenBudget });
		if (before.costBudgetUsd !== undefined && (before.tokenBudget === undefined || usage.costUsd > 0)) candidates.push({ kind: "cost", budget: before.costBudgetUsd, ratioBefore: before.usage.costUsd / before.costBudgetUsd, ratioAfter: usage.costUsd / before.costBudgetUsd });
		for (const candidate of candidates) {
			const id = `${candidate.kind}:${candidate.budget}:${threshold}`;
			if (candidate.ratioBefore < threshold && candidate.ratioAfter >= threshold && !warnings.some((warning) => warning.id === id)) {
				const warning = { id, kind: candidate.kind, threshold, usage, budget: candidate.budget, createdAt: now } as const;
				const warningEvent: SessionEvent = { type: "session.budget.warning", eventId: this.#idFactory(), sessionId: operation.sessionId, revision: next.revision + 1, timestamp: now, warning };
				events.push(warningEvent);
				next = reduceSessionEvent(next, warningEvent);
			}
		}
		return next;
	}

	#commitRuntimeCompletion(
		operation: DurableOperation,
		lease: WriterLease,
		items: TranscriptItem[],
		usage: SessionSnapshot["usage"] | undefined,
		tools: UsageToolSummary[] | undefined = operation.tools,
		requests: UsageRequestSummary[] | undefined = undefined,
	): void {
		const current = this.store.loadSnapshot(operation.sessionId);
		if (!current) throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
		const now = this.#clock();
		const events: SessionEvent[] = [];
		let snapshot = current;
		for (const item of items) {
			const event: SessionEvent = {
				type: "session.item.upserted",
				eventId: this.#idFactory(),
				sessionId: operation.sessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				item,
			};
			events.push(event);
			snapshot = reduceSessionEvent(snapshot, event);
		}
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
		snapshot = this.#appendUsageAttribution(operation, current, snapshot, usage, tools, requests, events, now);
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
					snapshot.queuedFollowUpCount - (operation.payload.mode === "follow_up" ? 1 : 0),
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
		this.store.commitMutation({
			sessionId: operation.sessionId,
			expectedRevision: current.revision,
			events,
			snapshot,
			settleOperation: { id: operation.id, status: "completed", ...(usage ? { usage } : {}), ...(operation.tools ? { tools: operation.tools } : {}), ...(operation.retryHistory ? { retryHistory: operation.retryHistory } : {}) },
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
	): void {
		const current = this.store.loadSnapshot(operation.sessionId);
		if (!current) throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
		const now = this.#clock();
		const events: SessionEvent[] = [];
		let snapshot = current;
		if (usage && (usage.costUsd > snapshot.usage.costUsd || usage.totalTokens > snapshot.usage.totalTokens)) {
			const event: SessionEvent = {
				type: "session.usage.replaced", eventId: this.#idFactory(), sessionId: operation.sessionId,
				revision: snapshot.revision + 1, timestamp: now, usage,
			};
			events.push(event);
			snapshot = reduceSessionEvent(snapshot, event);
		}
		snapshot = this.#appendUsageAttribution(operation, current, snapshot, usage, tools, requests, events, now);
		const phase: SessionEvent = {
			type: "session.phase.changed", eventId: this.#idFactory(), sessionId: operation.sessionId,
			revision: snapshot.revision + 1, timestamp: now, phase: "retry",
		};
		events.push(phase);
		const retryHistory = operation.retryHistory ?? [];
		this.store.commitMutation({
			sessionId: operation.sessionId,
			expectedRevision: current.revision,
			events,
			snapshot: reduceSessionEvent(snapshot, phase),
			retryOperation: { id: operation.id, error: message, retryAfter: now + delayMs, retryHistory, failureKind, ...(usage ? { usage } : {}), ...(operation.tools ? { tools: operation.tools } : {}) },
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
	): void {
		const current = this.store.loadSnapshot(operation.sessionId);
		if (!current) throw new OrchestratorError("not_found", `Session ${operation.sessionId} does not exist`);
		const now = this.#clock();
		const events: SessionEvent[] = [];
		let snapshot = current;
		if (cancelPendingApprovals) {
			for (const pending of snapshot.pendingApprovals) {
				const approval = { ...pending, status: "cancelled" as const, decidedAt: now, decidedBy: "system" };
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
				type: "session.usage.replaced", eventId: this.#idFactory(), sessionId: operation.sessionId,
				revision: snapshot.revision + 1, timestamp: now, usage,
			};
			events.push(usageEvent);
			snapshot = reduceSessionEvent(snapshot, usageEvent);
		}
		snapshot = this.#appendUsageAttribution(operation, current, snapshot, usage, tools, requests, events, now);
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
					snapshot.queuedFollowUpCount - (operation.payload.mode === "follow_up" ? 1 : 0),
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
		this.store.commitMutation({
			sessionId: operation.sessionId,
			expectedRevision: current.revision,
			events,
			snapshot,
			settleOperation: { id: operation.id, status: aborted ? "interrupted" : "failed", error: message, ...(usage ? { usage } : {}), ...(operation.tools ? { tools: operation.tools } : {}), failureKind, ...(operation.retryHistory ? { retryHistory: operation.retryHistory } : {}) },
			lease,
		});
	}
}

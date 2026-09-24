import type {
	ApprovalRequest,
	SessionSnapshot,
	TranscriptItem,
	Usage,
	UsageToolSummary,
	UsageTurnSummary,
} from "@wuming/protocol";
import type { SessionEvent } from "./events.js";
import { mergeUsageRequests, sessionUsageRequests } from "@wuming/protocol";

export class SessionInvariantError extends Error {
	constructor(
		readonly code: "missing_creation" | "duplicate_creation" | "session_mismatch" | "revision_gap" | "approval_invalid",
		message: string
	) {
		super(message);
		this.name = "SessionInvariantError";
	}
}

export const EMPTY_USAGE: Usage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
};

function upsertItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
	const index = items.findIndex((candidate) => candidate.id === item.id);
	if (index === -1) return [...items, item];
	const next = [...items];
	next[index] = item;
	return next;
}

function addPendingApproval(pending: ApprovalRequest[], approval: ApprovalRequest): ApprovalRequest[] {
	if (approval.status !== "pending") {
		throw new SessionInvariantError("approval_invalid", "A requested approval must be pending");
	}
	if (pending.some((candidate) => candidate.id === approval.id)) {
		throw new SessionInvariantError("approval_invalid", `Approval ${approval.id} already exists`);
	}
	return [...pending, approval];
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

function upsertUsageTool(items: UsageToolSummary[], tool: UsageToolSummary): UsageToolSummary[] {
	const index = items.findIndex((candidate) => candidate.toolName === tool.toolName);
	if (index === -1) return [...items, tool];
	const existing = items[index]!;
	const next = [...items];
	next[index] = {
		toolName: existing.toolName,
		callCount: existing.callCount + tool.callCount,
		usage: addUsage(existing.usage, tool.usage),
		...(existing.durationMs !== undefined || tool.durationMs !== undefined
			? { durationMs: (existing.durationMs ?? 0) + (tool.durationMs ?? 0) }
			: {}),
		...(existing.succeededCount !== undefined || tool.succeededCount !== undefined
			? { succeededCount: (existing.succeededCount ?? 0) + (tool.succeededCount ?? 0) }
			: {}),
		...(existing.failedCount !== undefined || tool.failedCount !== undefined
			? { failedCount: (existing.failedCount ?? 0) + (tool.failedCount ?? 0) }
			: {}),
		...(existing.abortedCount !== undefined || tool.abortedCount !== undefined
			? { abortedCount: (existing.abortedCount ?? 0) + (tool.abortedCount ?? 0) }
			: {}),
		...(existing.mcpServerId || tool.mcpServerId ? { mcpServerId: existing.mcpServerId ?? tool.mcpServerId! } : {}),
		...(existing.mcpToolName || tool.mcpToolName ? { mcpToolName: existing.mcpToolName ?? tool.mcpToolName! } : {}),
	};
	return next;
}

function settlePendingApproval(pending: ApprovalRequest[], approval: ApprovalRequest): ApprovalRequest[] {
	if (approval.status === "pending") {
		throw new SessionInvariantError("approval_invalid", "A settled approval cannot remain pending");
	}
	const existing = pending.find((candidate) => candidate.id === approval.id);
	if (!existing) {
		throw new SessionInvariantError("approval_invalid", `Approval ${approval.id} is not pending`);
	}
	if (
		existing.sessionId !== approval.sessionId ||
		existing.workspaceId !== approval.workspaceId ||
		existing.toolCallId !== approval.toolCallId
	) {
		throw new SessionInvariantError("approval_invalid", `Approval ${approval.id} changed its protected operation`);
	}
	return pending.filter((candidate) => candidate.id !== approval.id);
}

export function reduceSessionEvent(current: SessionSnapshot | undefined, event: SessionEvent): SessionSnapshot {
	if (event.type === "session.created") {
		if (current) throw new SessionInvariantError("duplicate_creation", `Session ${event.sessionId} already exists`);
		if (event.revision !== 1) {
			throw new SessionInvariantError("revision_gap", "A session must start at revision 1");
		}
		if (event.session.id !== event.sessionId) {
			throw new SessionInvariantError("session_mismatch", "Creation metadata has a different session ID");
		}
		return {
			session: { ...event.session, updatedAt: event.timestamp },
			revision: event.revision,
			model: event.model,
			thinkingLevel: event.thinkingLevel,
			sandboxMode: event.sandboxMode,
			approvalPolicy: event.approvalPolicy,
			transcript: [],
			...(event.runtimeHistoryId === undefined ? {} : { runtimeHistoryId: event.runtimeHistoryId }),
			queuedSteerCount: 0,
			queuedFollowUpCount: 0,
			pendingApprovals: [],
			usage: event.usage,
			usageByModel: [],
			usageByTool: [],
			usageByTurn: [],
			budgetWarnings: [],
			verificationWarnings: [],
			...(event.costBudgetUsd === undefined ? {} : { costBudgetUsd: event.costBudgetUsd }),
			...(event.tokenBudget === undefined ? {} : { tokenBudget: event.tokenBudget }),
			...(event.budgetWarningThreshold === undefined ? {} : { budgetWarningThreshold: event.budgetWarningThreshold }),
		};
	}

	if (!current) throw new SessionInvariantError("missing_creation", "The first event must create the session");
	if (current.session.id !== event.sessionId) {
		throw new SessionInvariantError("session_mismatch", `Event targets ${event.sessionId}, not ${current.session.id}`);
	}
	if (event.revision !== current.revision + 1) {
		throw new SessionInvariantError(
			"revision_gap",
			`Expected revision ${current.revision + 1}, received ${event.revision}`
		);
	}

	const next: SessionSnapshot = {
		...current,
		session: { ...current.session, updatedAt: event.timestamp },
		revision: event.revision,
	};

	switch (event.type) {
		case "session.history.rewound": {
			const index = current.transcript.findIndex((item) => item.id === event.beforeItemId);
			if (index < 0 || current.transcript[index]?.type !== "user")
				throw new SessionInvariantError("session_mismatch", "The edited user message no longer exists");
			return {
				...next,
				transcript: current.transcript.slice(0, index),
				runtimeHistoryId: event.runtimeHistoryId,
				contextUsage: { model: current.model, tokens: null, basis: "unknown" },
			};
		}
		case "session.item.upserted":
			return { ...next, transcript: upsertItem(current.transcript, event.item) };
		case "session.phase.changed":
			return { ...next, session: { ...next.session, phase: event.phase } };
		case "session.queue.changed":
			return {
				...next,
				queuedSteerCount: event.queuedSteerCount,
				queuedFollowUpCount: event.queuedFollowUpCount,
			};
		case "session.model.changed":
			return {
				...next,
				model: event.model,
				contextUsage: { model: event.model, tokens: null, basis: "unknown" },
			};
		case "session.thinking.changed":
			return { ...next, thinkingLevel: event.thinkingLevel };
		case "session.policy.changed":
			return { ...next, sandboxMode: event.sandboxMode, approvalPolicy: event.approvalPolicy };
		case "approval.requested":
			return {
				...next,
				pendingApprovals: addPendingApproval(current.pendingApprovals, event.approval),
			};
		case "approval.settled":
			return {
				...next,
				pendingApprovals: settlePendingApproval(current.pendingApprovals, event.approval),
			};
		case "session.usage.replaced":
			return { ...next, usage: event.usage };
		case "session.context.updated":
			return { ...next, contextUsage: event.contextUsage };
		case "session.request.usage.updated":
			return { ...next, usageRequests: mergeUsageRequests(sessionUsageRequests(current), [event.request]) };
		case "session.usage.recorded": {
			const previousTurns = current.usageByTurn ?? [];
			const previousModels = current.usageByModel ?? [];
			const previousTools = current.usageByTool ?? [];
			const turnIndex = previousTurns.findIndex((candidate) => candidate.turnId === event.turnId);
			const existingTurn = turnIndex === -1 ? undefined : previousTurns[turnIndex]!;
			const requests = mergeUsageRequests(existingTurn?.requests ?? [], event.requests);
			const eventSkills = event.skills ?? [];
			const skills =
				turnIndex === -1 ? eventSkills : [...new Set([...(existingTurn?.skills ?? []), ...eventSkills])].slice(0, 128);
			const turn: UsageTurnSummary =
				turnIndex === -1
					? {
							turnId: event.turnId,
							mode: event.mode,
							model: event.model,
							attempts: event.attempt,
							usage: event.usage,
							tools: event.tools,
							requests,
							skills,
						}
					: {
							turnId: existingTurn!.turnId,
							mode: existingTurn!.mode,
							model: existingTurn!.model,
							attempts: Math.max(existingTurn!.attempts, event.attempt),
							usage: addUsage(existingTurn!.usage, event.usage),
							tools: event.tools.reduce(upsertUsageTool, existingTurn!.tools),
							requests,
							skills,
						};
			const turns = [...previousTurns];
			if (turnIndex === -1) turns.push(turn);
			else turns[turnIndex] = turn;
			const modelIndex = previousModels.findIndex(
				(candidate) => candidate.model.provider === event.model.provider && candidate.model.id === event.model.id
			);
			const models = [...previousModels];
			if (modelIndex === -1) models.push({ model: event.model, turnCount: 1, usage: event.usage });
			else {
				const existingModel = models[modelIndex]!;
				models[modelIndex] = {
					model: existingModel.model,
					usage: addUsage(existingModel.usage, event.usage),
					turnCount: existingModel.turnCount + (turnIndex === -1 ? 1 : 0),
				};
			}
			const tools = event.tools.reduce(upsertUsageTool, previousTools);
			return {
				...next,
				usageByTurn: turns.slice(-500),
				usageRequests: mergeUsageRequests(sessionUsageRequests(current), event.requests),
				usageByModel: models.slice(-100),
				usageByTool: tools.slice(-500),
			};
		}
		case "session.budget.warning":
			return {
				...next,
				budgetWarnings: [...(current.budgetWarnings ?? []), event.warning].slice(-32),
			};
		case "session.verification.missing":
			return {
				...next,
				verificationWarnings: [
					...(current.verificationWarnings ?? []),
					{
						id: event.eventId,
						operationId: event.operationId,
						changedTools: event.changedTools,
						createdAt: event.timestamp,
					},
				].slice(-32),
			};
		case "session.budget.changed": {
			const budgeted = { ...next };
			if (event.costBudgetUsd === null) delete budgeted.costBudgetUsd;
			else if (event.costBudgetUsd !== undefined) budgeted.costBudgetUsd = event.costBudgetUsd;
			if (event.tokenBudget === null) delete budgeted.tokenBudget;
			else if (event.tokenBudget !== undefined) budgeted.tokenBudget = event.tokenBudget;
			if (event.budgetWarningThreshold !== undefined) budgeted.budgetWarningThreshold = event.budgetWarningThreshold;
			return budgeted;
		}
		case "session.renamed": {
			const { name: _previousName, ...sessionWithoutName } = next.session;
			return {
				...next,
				session: event.name === undefined ? sessionWithoutName : { ...sessionWithoutName, name: event.name },
			};
		}
		case "session.archived": {
			const { archivedAt: _previousArchivedAt, ...sessionWithoutArchive } = next.session;
			return {
				...next,
				session:
					event.archivedAt === undefined
						? sessionWithoutArchive
						: { ...sessionWithoutArchive, archivedAt: event.archivedAt },
			};
		}
	}
}

export function replaySessionEvents(events: Iterable<SessionEvent>): SessionSnapshot {
	let snapshot: SessionSnapshot | undefined;
	for (const event of events) snapshot = reduceSessionEvent(snapshot, event);
	if (!snapshot) throw new SessionInvariantError("missing_creation", "Cannot replay an empty session event stream");
	return snapshot;
}

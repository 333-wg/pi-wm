import {
	type ApprovalPolicy,
	ApprovalPolicySchema,
	type ApprovalRequest,
	ApprovalRequestSchema,
	type ModelRef,
	ModelRefSchema,
	type SandboxMode,
	SandboxModeSchema,
	type SessionPhase,
	SessionPhaseSchema,
	type SessionSummary,
	SessionSummarySchema,
	type ThinkingLevel,
	ThinkingLevelSchema,
	type TranscriptItem,
	TranscriptItemSchema,
	type Usage,
	UsageSchema,
	UsageToolSummarySchema,
	UsageRequestSummarySchema,
	BudgetWarningSchema,
	ContextUsageStateSchema,
} from "@wuming/protocol";
import Type, { type Static } from "typebox";

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Revision = Type.Integer({ minimum: 1 });
const Timestamp = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const EventBase = {
	eventId: Id,
	sessionId: Id,
	revision: Revision,
	timestamp: Timestamp,
} as const;

export const SessionEventSchema = Type.Union([
	StrictObject({
		...EventBase,
		type: Type.Literal("session.created"),
		session: SessionSummarySchema,
		model: ModelRefSchema,
		thinkingLevel: ThinkingLevelSchema,
		sandboxMode: SandboxModeSchema,
		approvalPolicy: ApprovalPolicySchema,
		usage: UsageSchema,
		costBudgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		tokenBudget: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })),
		budgetWarningThreshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.item.upserted"),
		item: TranscriptItemSchema,
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.phase.changed"),
		phase: SessionPhaseSchema,
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.queue.changed"),
		queuedSteerCount: Type.Integer({ minimum: 0 }),
		queuedFollowUpCount: Type.Integer({ minimum: 0 }),
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.model.changed"),
		model: ModelRefSchema,
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.thinking.changed"),
		thinkingLevel: ThinkingLevelSchema,
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.policy.changed"),
		sandboxMode: SandboxModeSchema,
		approvalPolicy: ApprovalPolicySchema,
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("approval.requested"),
		approval: ApprovalRequestSchema,
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("approval.settled"),
		approval: ApprovalRequestSchema,
	}),
	StrictObject({ ...EventBase, type: Type.Literal("session.usage.replaced"), usage: UsageSchema }),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.request.usage.updated"),
		request: UsageRequestSummarySchema,
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.context.updated"),
		contextUsage: ContextUsageStateSchema,
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.usage.recorded"),
		turnId: Id,
		mode: Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("follow_up")]),
		model: ModelRefSchema,
		attempt: Type.Integer({ minimum: 1 }),
		usage: UsageSchema,
		tools: Type.Array(UsageToolSummarySchema, { maxItems: 100 }),
		requests: Type.Array(
			Type.Object({ requestId: Id, model: ModelRefSchema, usage: UsageSchema }, { additionalProperties: false }),
			{ maxItems: 100 }
		),
		skills: Type.Optional(Type.Array(Id, { maxItems: 128, uniqueItems: true })),
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.budget.warning"),
		warning: BudgetWarningSchema,
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.verification.missing"),
		operationId: Id,
		changedTools: Type.Array(Id, { minItems: 1, maxItems: 20 }),
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.budget.changed"),
		costBudgetUsd: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()])),
		tokenBudget: Type.Optional(Type.Union([Type.Integer({ exclusiveMinimum: 0 }), Type.Null()])),
		budgetWarningThreshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.renamed"),
		name: Type.Optional(Type.String({ maxLength: 500 })),
	}),
	StrictObject({
		...EventBase,
		type: Type.Literal("session.archived"),
		archivedAt: Type.Optional(Timestamp),
	}),
]);

export type SessionEvent = Static<typeof SessionEventSchema>;

export type SessionCreatedFields = {
	session: SessionSummary;
	model: ModelRef;
	thinkingLevel: ThinkingLevel;
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
	usage: Usage;
	costBudgetUsd?: number;
	tokenBudget?: number;
	budgetWarningThreshold?: number;
};
export type SessionItemFields = { item: TranscriptItem };
export type SessionPhaseFields = { phase: SessionPhase };
export type ApprovalFields = { approval: ApprovalRequest };

import Type, { type Static } from "typebox";

export const PROTOCOL_VERSION = 1 as const;

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Timestamp = Type.Integer({ minimum: 0 });
const Revision = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

export const CapabilitySchema = Type.Union([
	Type.Literal("session.resume"),
	Type.Literal("session.fork"),
	Type.Literal("session.compaction"),
	Type.Literal("turn.steer"),
	Type.Literal("turn.follow_up"),
	Type.Literal("approval"),
	Type.Literal("artifact"),
	Type.Literal("image_input"),
	Type.Literal("terminal"),
	Type.Literal("git"),
	Type.Literal("skills"),
	Type.Literal("mcp"),
	Type.Literal("tools"),
	Type.Literal("subagents"),
	Type.Literal("goals"),
	Type.Literal("model.custom"),
]);
export type Capability = Static<typeof CapabilitySchema>;

export const ModelRefSchema = StrictObject({ provider: Id, id: Id });
export type ModelRef = Static<typeof ModelRefSchema>;

export const ModelMetadataSchema = StrictObject({
	model: ModelRefSchema,
	name: Type.String({ minLength: 1, maxLength: 500 }),
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxOutputTokens: Type.Integer({ minimum: 1 }),
	authenticated: Type.Boolean(),
	custom: Type.Optional(Type.Boolean()),
});
export type ModelMetadata = Static<typeof ModelMetadataSchema>;

export const CustomModelApiSchema = Type.Union([
	Type.Literal("openai-completions"),
	Type.Literal("openai-responses"),
	Type.Literal("anthropic-messages"),
]);
export type CustomModelApi = Static<typeof CustomModelApiSchema>;

export const CustomModelConnectionSchema = StrictObject({
	baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
	apiKey: Type.String({ minLength: 1, maxLength: 1000 }),
});
export type CustomModelConnection = Static<typeof CustomModelConnectionSchema>;

export const CustomModelServiceSchema = StrictObject({
	provider: Id,
	baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
	api: CustomModelApiSchema,
	authenticated: Type.Boolean(),
	modelCount: Type.Integer({ minimum: 0 }),
});
export type CustomModelService = Static<typeof CustomModelServiceSchema>;

export const CustomModelCandidateSchema = StrictObject({
	id: Id,
	name: Type.String({ minLength: 1, maxLength: 500 }),
});
export type CustomModelCandidate = Static<typeof CustomModelCandidateSchema>;

export const CustomModelConfigSchema = StrictObject({
	provider: Id,
	id: Id,
	name: Type.String({ minLength: 1, maxLength: 500 }),
	api: CustomModelApiSchema,
	baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
	apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { minItems: 1, uniqueItems: true }),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxOutputTokens: Type.Integer({ minimum: 1 }),
});
export type CustomModelConfig = Static<typeof CustomModelConfigSchema>;

export const CustomModelSettingsSchema = StrictObject({
	model: ModelRefSchema,
	name: Type.String({ minLength: 1, maxLength: 500 }),
	api: CustomModelApiSchema,
	baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { minItems: 1, uniqueItems: true }),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxOutputTokens: Type.Integer({ minimum: 1 }),
});
export type CustomModelSettings = Static<typeof CustomModelSettingsSchema>;

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export const SandboxModeSchema = Type.Union([
	Type.Literal("read_only"),
	Type.Literal("workspace_write"),
	Type.Literal("unrestricted"),
]);
export const ApprovalPolicySchema = Type.Union([
	Type.Literal("always"),
	Type.Literal("on_risk"),
	Type.Literal("on_failure"),
	Type.Literal("never"),
]);
export type SandboxMode = Static<typeof SandboxModeSchema>;
export type ApprovalPolicy = Static<typeof ApprovalPolicySchema>;

export const ArtifactRefSchema = StrictObject({
	id: Id,
	name: Type.String({ minLength: 1, maxLength: 500 }),
	mimeType: Type.String({ minLength: 1, maxLength: 200 }),
	size: Type.Integer({ minimum: 0 }),
});
export type ArtifactRef = Static<typeof ArtifactRefSchema>;

export const UserContentPartSchema = Type.Union([
	StrictObject({ type: Type.Literal("text"), text: Type.String() }),
	StrictObject({ type: Type.Literal("artifact"), artifact: ArtifactRefSchema }),
]);
export const ContentPartSchema = Type.Union([
	UserContentPartSchema,
	StrictObject({ type: Type.Literal("thinking"), text: Type.String(), redacted: Type.Optional(Type.Boolean()) }),
	StrictObject({ type: Type.Literal("tool_call"), toolCallId: Id, toolName: Id, input: JsonValueSchema }),
]);
export type UserContentPart = Static<typeof UserContentPartSchema>;
export type ContentPart = Static<typeof ContentPartSchema>;

export const UsageSchema = StrictObject({
	inputTokens: Type.Integer({ minimum: 0 }),
	outputTokens: Type.Integer({ minimum: 0 }),
	cacheReadTokens: Type.Integer({ minimum: 0 }),
	cacheWriteTokens: Type.Integer({ minimum: 0 }),
	totalTokens: Type.Integer({ minimum: 0 }),
	costUsd: Type.Number({ minimum: 0 }),
});
export type Usage = Static<typeof UsageSchema>;

export const DailyUsageSchema = StrictObject({
	date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
	usage: UsageSchema,
	turnCount: Type.Integer({ minimum: 0 }),
	requestCount: Type.Integer({ minimum: 0 }),
});
export type DailyUsage = Static<typeof DailyUsageSchema>;

export const UsageOverviewSchema = StrictObject({
	workspaceId: Id,
	generatedAt: Timestamp,
	today: UsageSchema,
	month: UsageSchema,
	daily: Type.Array(DailyUsageSchema, { minItems: 7, maxItems: 31 }),
});
export type UsageOverview = Static<typeof UsageOverviewSchema>;

export const UsageToolSummarySchema = StrictObject({
	toolName: Id,
	callCount: Type.Integer({ minimum: 1 }),
	usage: UsageSchema,
	durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
	succeededCount: Type.Optional(Type.Integer({ minimum: 0 })),
	failedCount: Type.Optional(Type.Integer({ minimum: 0 })),
	abortedCount: Type.Optional(Type.Integer({ minimum: 0 })),
	mcpServerId: Type.Optional(Id),
	mcpToolName: Type.Optional(Id),
});
export type UsageToolSummary = Static<typeof UsageToolSummarySchema>;

export const UsageRequestSummarySchema = StrictObject({
	requestId: Id,
	model: ModelRefSchema,
	usage: UsageSchema,
});
export type UsageRequestSummary = Static<typeof UsageRequestSummarySchema>;

export const UsageTurnSummarySchema = StrictObject({
	turnId: Id,
	mode: Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("follow_up")]),
	model: ModelRefSchema,
	attempts: Type.Integer({ minimum: 1 }),
	usage: UsageSchema,
	tools: Type.Array(UsageToolSummarySchema),
	requests: Type.Array(UsageRequestSummarySchema),
	skills: Type.Optional(Type.Array(Id, { maxItems: 8 })),
});
export type UsageTurnSummary = Static<typeof UsageTurnSummarySchema>;

export const UsageModelSummarySchema = StrictObject({
	model: ModelRefSchema,
	turnCount: Type.Integer({ minimum: 1 }),
	usage: UsageSchema,
});
export type UsageModelSummary = Static<typeof UsageModelSummarySchema>;

export const BudgetWarningSchema = StrictObject({
	id: Id,
	kind: Type.Union([Type.Literal("cost"), Type.Literal("tokens")]),
	threshold: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
	usage: UsageSchema,
	budget: Type.Number({ exclusiveMinimum: 0 }),
	createdAt: Timestamp,
});
export type BudgetWarning = Static<typeof BudgetWarningSchema>;

export const RunStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("interrupted"),
]);
export const RunFailureKindSchema = Type.Union([
	Type.Literal("provider"),
	Type.Literal("provider_auth"),
	Type.Literal("provider_rate_limit"),
	Type.Literal("provider_timeout"),
	Type.Literal("provider_network"),
	Type.Literal("tool"),
	Type.Literal("user_abort"),
	Type.Literal("runtime_restart"),
	Type.Literal("budget"),
	Type.Literal("unknown"),
]);
export type RunFailureKind = Static<typeof RunFailureKindSchema>;
export const RunSummarySchema = StrictObject({
	id: Id,
	sessionId: Id,
	mode: Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("follow_up")]),
	status: RunStatusSchema,
	attempt: Type.Integer({ minimum: 0 }),
	createdAt: Timestamp,
	updatedAt: Timestamp,
	startedAt: Type.Optional(Timestamp),
	finishedAt: Type.Optional(Timestamp),
	abortRequested: Type.Boolean(),
	traceId: Type.Optional(Id),
	error: Type.Optional(Type.String({ maxLength: 4000 })),
	usage: Type.Optional(UsageSchema),
	model: Type.Optional(ModelRefSchema),
	tools: Type.Optional(Type.Array(UsageToolSummarySchema)),
	failureKind: Type.Optional(RunFailureKindSchema),
	retryHistory: Type.Optional(Type.Array(StrictObject({ attempt: Type.Integer({ minimum: 1 }), maxAttempts: Type.Integer({ minimum: 1 }), delayMs: Type.Integer({ minimum: 0 }), error: Type.String({ maxLength: 4000 }), timestamp: Timestamp }), { maxItems: 32 })),
});
export type RunStatus = Static<typeof RunStatusSchema>;
export type RunSummary = Static<typeof RunSummarySchema>;

export const WorkspaceSummarySchema = StrictObject({
	id: Id,
	name: Type.String({ minLength: 1, maxLength: 500 }),
	status: Type.Union([
		Type.Literal("provisioning"),
		Type.Literal("ready"),
		Type.Literal("suspended"),
		Type.Literal("error"),
	]),
	repositoryUrl: Type.Optional(Type.String({ maxLength: 4000 })),
	defaultBranch: Type.Optional(Type.String({ maxLength: 500 })),
	createdAt: Timestamp,
	updatedAt: Timestamp,
});
export type WorkspaceSummary = Static<typeof WorkspaceSummarySchema>;

export const SkillSummarySchema = StrictObject({
	id: Id,
	workspaceId: Id,
	name: Type.String({ minLength: 1, maxLength: 200 }),
	description: Type.String({ maxLength: 2000 }),
	path: Type.String({ minLength: 1, maxLength: 4000 }),
	updatedAt: Timestamp,
});
export type SkillSummary = Static<typeof SkillSummarySchema>;

export const SkillSchema = StrictObject({
	...SkillSummarySchema.properties,
	content: Type.String({ maxLength: 200_000 }),
	truncated: Type.Boolean(),
});
export type Skill = Static<typeof SkillSchema>;

export const McpTransportSchema = Type.Literal("stdio");
export type McpTransport = Static<typeof McpTransportSchema>;

export const McpToolSummarySchema = StrictObject({
	name: Id,
	description: Type.Optional(Type.String({ maxLength: 4000 })),
	inputSchema: Type.Optional(JsonValueSchema),
});
export type McpToolSummary = Static<typeof McpToolSummarySchema>;

export const McpServerSummarySchema = StrictObject({
	id: Id,
	workspaceId: Id,
	name: Type.String({ minLength: 1, maxLength: 200 }),
	transport: McpTransportSchema,
	readOnly: Type.Boolean(),
	trusted: Type.Boolean(),
	toolCount: Type.Integer({ minimum: 0, maximum: 100 }),
});
export type McpServerSummary = Static<typeof McpServerSummarySchema>;

export const McpServerSchema = StrictObject({
	...McpServerSummarySchema.properties,
	tools: Type.Array(McpToolSummarySchema, { maxItems: 100 }),
});
export type McpServer = Static<typeof McpServerSchema>;

export const WorkspaceEntrySchema = StrictObject({
	path: Type.String({ minLength: 1, maxLength: 4000 }),
	name: Type.String({ minLength: 1, maxLength: 1000 }),
	kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
	size: Type.Optional(Type.Integer({ minimum: 0 })),
	modifiedAt: Timestamp,
});
export type WorkspaceEntry = Static<typeof WorkspaceEntrySchema>;

export const WorkspaceDirectorySchema = StrictObject({
	path: Type.String({ minLength: 1, maxLength: 4000 }),
	entries: Type.Array(WorkspaceEntrySchema),
	truncated: Type.Boolean(),
});
export type WorkspaceDirectory = Static<typeof WorkspaceDirectorySchema>;

export const WorkspaceSearchSchema = StrictObject({
	query: Type.String({ maxLength: 400 }),
	entries: Type.Array(WorkspaceEntrySchema),
	/** True when the walk stopped early, so better matches may exist. */
	truncated: Type.Boolean(),
});
export type WorkspaceSearch = Static<typeof WorkspaceSearchSchema>;

export const WorkspaceFileViewSchema = StrictObject({
	path: Type.String({ minLength: 1, maxLength: 4000 }),
	content: Type.String(),
	bytesRead: Type.Integer({ minimum: 0 }),
	totalBytes: Type.Integer({ minimum: 0 }),
	truncated: Type.Boolean(),
	binary: Type.Boolean(),
});
export type WorkspaceFileView = Static<typeof WorkspaceFileViewSchema>;

export const GitStatusEntrySchema = StrictObject({
	path: Type.String({ minLength: 1, maxLength: 4000 }),
	indexStatus: Type.String({ minLength: 1, maxLength: 1 }),
	worktreeStatus: Type.String({ minLength: 1, maxLength: 1 }),
	originalPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
});
export type GitStatusEntry = Static<typeof GitStatusEntrySchema>;

export const GitStatusSchema = StrictObject({
	isRepository: Type.Boolean(),
	branch: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
	entries: Type.Array(GitStatusEntrySchema),
	truncated: Type.Boolean(),
});
export type GitStatus = Static<typeof GitStatusSchema>;

export const GitDiffSchema = StrictObject({
	path: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
	staged: Type.Boolean(),
	content: Type.String(),
	truncated: Type.Boolean(),
});
export type GitDiff = Static<typeof GitDiffSchema>;

export const ToolCapabilitySchema = Type.Union([
	StrictObject({ type: Type.Literal("filesystem.read"), paths: Type.Array(Type.String(), { minItems: 1 }) }),
	StrictObject({ type: Type.Literal("filesystem.write"), paths: Type.Array(Type.String(), { minItems: 1 }) }),
	StrictObject({
		type: Type.Literal("process.exec"),
		executable: Type.String({ minLength: 1 }),
		args: Type.Array(Type.String()),
	}),
	StrictObject({ type: Type.Literal("network.connect"), hosts: Type.Array(Type.String(), { minItems: 1 }) }),
	StrictObject({ type: Type.Literal("secret.use"), names: Type.Array(Type.String(), { minItems: 1 }) }),
	StrictObject({ type: Type.Literal("mcp.call"), serverId: Id, toolName: Type.String({ minLength: 1, maxLength: 200 }), readOnly: Type.Boolean() }),
]);
export type ToolCapability = Static<typeof ToolCapabilitySchema>;

export const ToolStatusSchema = StrictObject({
	name: Id,
	label: Type.String({ minLength: 1, maxLength: 200 }),
	description: Type.String({ minLength: 1, maxLength: 1000 }),
	category: Type.Union([
		Type.Literal("filesystem"),
		Type.Literal("process"),
		Type.Literal("network"),
		Type.Literal("agent"),
	]),
	status: Type.Union([
		Type.Literal("ready"),
		Type.Literal("requires_configuration"),
		Type.Literal("disabled"),
	]),
	backend: Type.String({ minLength: 1, maxLength: 500 }),
	risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
	sandboxModes: Type.Array(SandboxModeSchema, { minItems: 1, uniqueItems: true }),
	reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
});
export type ToolStatus = Static<typeof ToolStatusSchema>;

export const ApprovalStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("approved"),
	Type.Literal("denied"),
	Type.Literal("expired"),
	Type.Literal("cancelled"),
]);
export type ApprovalStatus = Static<typeof ApprovalStatusSchema>;
export const ApprovalRequestSchema = StrictObject({
	id: Id,
	sessionId: Id,
	workspaceId: Id,
	toolCallId: Id,
	risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
	summary: Type.String({ minLength: 1, maxLength: 2000 }),
	capabilities: Type.Array(ToolCapabilitySchema, { minItems: 1 }),
	status: ApprovalStatusSchema,
	createdAt: Timestamp,
	expiresAt: Timestamp,
	decidedAt: Type.Optional(Timestamp),
	decidedBy: Type.Optional(Id),
});
export type ApprovalRequest = Static<typeof ApprovalRequestSchema>;

export const SubagentStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("awaiting_approval"),
	Type.Literal("cancelling"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
]);
export type SubagentStatus = Static<typeof SubagentStatusSchema>;

export const SubagentSummarySchema = StrictObject({
	id: Id,
	parentSessionId: Id,
	sessionId: Id,
	operationId: Id,
	name: Type.String({ minLength: 1, maxLength: 500 }),
	task: Type.String({ minLength: 1, maxLength: 20_000 }),
	depth: Type.Integer({ minimum: 1, maximum: 3 }),
	status: SubagentStatusSchema,
	createdAt: Timestamp,
	updatedAt: Timestamp,
	startedAt: Type.Optional(Timestamp),
	finishedAt: Type.Optional(Timestamp),
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	sandboxMode: SandboxModeSchema,
	approvalPolicy: ApprovalPolicySchema,
	usage: UsageSchema,
	costBudgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	tokenBudget: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })),
	pendingApprovals: Type.Array(ApprovalRequestSchema),
	result: Type.Optional(Type.String({ maxLength: 200_000 })),
	error: Type.Optional(Type.String({ maxLength: 4000 })),
});
export type SubagentSummary = Static<typeof SubagentSummarySchema>;

export const GoalStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("awaiting_approval"),
	Type.Literal("cancelling"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
]);
export type GoalStatus = Static<typeof GoalStatusSchema>;

export const GoalReviewPhaseSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("executing"),
	Type.Literal("reviewing"),
	Type.Literal("passed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
]);
export type GoalReviewPhase = Static<typeof GoalReviewPhaseSchema>;

export const GoalReviewCheckSchema = StrictObject({
	criterion: Type.String({ minLength: 1, maxLength: 500 }),
	status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
	evidence: Type.String({ minLength: 1, maxLength: 2000 }),
});
export type GoalReviewCheck = Static<typeof GoalReviewCheckSchema>;

export const GoalReviewRecordSchema = StrictObject({
	round: Type.Integer({ minimum: 1, maximum: 5 }),
	verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
	feedback: Type.String({ maxLength: 4000 }),
	checks: Type.Optional(Type.Array(GoalReviewCheckSchema, { minItems: 1, maxItems: 20 })),
	toolsUsed: Type.Optional(Type.Array(Id, { maxItems: 50, uniqueItems: true })),
	reviewedAt: Timestamp,
});
export type GoalReviewRecord = Static<typeof GoalReviewRecordSchema>;

export const GoalSummarySchema = StrictObject({
	id: Id,
	parentSessionId: Id,
	title: Type.String({ minLength: 1, maxLength: 500 }),
	objective: Type.String({ minLength: 1, maxLength: 20_000 }),
	status: GoalStatusSchema,
	createdAt: Timestamp,
	updatedAt: Timestamp,
	runSessionId: Type.Optional(Id),
	operationId: Type.Optional(Id),
	startedAt: Type.Optional(Timestamp),
	finishedAt: Type.Optional(Timestamp),
	usage: UsageSchema,
	pendingApprovals: Type.Array(ApprovalRequestSchema),
	result: Type.Optional(Type.String({ maxLength: 200_000 })),
	error: Type.Optional(Type.String({ maxLength: 4000 })),
	successCriteria: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
	round: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
	maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	reviewPhase: Type.Optional(GoalReviewPhaseSchema),
	reviewHistory: Type.Optional(Type.Array(GoalReviewRecordSchema, { maxItems: 5 })),
});
export type GoalSummary = Static<typeof GoalSummarySchema>;

const TranscriptBase = {
	id: Id,
	createdAt: Timestamp,
} as const;
export const TranscriptItemSchema = Type.Union([
	StrictObject({ ...TranscriptBase, type: Type.Literal("user"), content: Type.Array(ContentPartSchema) }),
	StrictObject({
		...TranscriptBase,
		type: Type.Literal("assistant"),
		status: Type.Union([
			Type.Literal("streaming"),
			Type.Literal("complete"),
			Type.Literal("error"),
			Type.Literal("aborted"),
		]),
		content: Type.Array(ContentPartSchema),
		model: ModelRefSchema,
		usage: Type.Optional(UsageSchema),
		error: Type.Optional(Type.String()),
	}),
	StrictObject({
		...TranscriptBase,
		type: Type.Literal("tool"),
		toolCallId: Id,
		toolName: Id,
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("awaiting_approval"),
			Type.Literal("running"),
			Type.Literal("complete"),
			Type.Literal("error"),
			Type.Literal("aborted"),
		]),
		input: JsonValueSchema,
		content: Type.Array(ContentPartSchema),
		isError: Type.Boolean(),
	}),
]);
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

export const SessionPhaseSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("turn"),
	Type.Literal("awaiting_approval"),
	Type.Literal("compaction"),
	Type.Literal("retry"),
	Type.Literal("error"),
]);
export type SessionPhase = Static<typeof SessionPhaseSchema>;

export const SessionSummarySchema = StrictObject({
	id: Id,
	workspaceId: Id,
	name: Type.Optional(Type.String({ maxLength: 500 })),
	phase: SessionPhaseSchema,
	createdAt: Timestamp,
	updatedAt: Timestamp,
	archivedAt: Type.Optional(Timestamp),
	parentSessionId: Type.Optional(Id),
});
export const SessionSnapshotSchema = StrictObject({
	session: SessionSummarySchema,
	revision: Revision,
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	sandboxMode: SandboxModeSchema,
	approvalPolicy: ApprovalPolicySchema,
	transcript: Type.Array(TranscriptItemSchema),
	queuedSteerCount: Type.Integer({ minimum: 0 }),
	queuedFollowUpCount: Type.Integer({ minimum: 0 }),
	pendingApprovals: Type.Array(ApprovalRequestSchema),
	usage: UsageSchema,
	costBudgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	tokenBudget: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })),
	budgetWarningThreshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
	usageByModel: Type.Optional(Type.Array(UsageModelSummarySchema, { maxItems: 100 })),
	usageByTool: Type.Optional(Type.Array(UsageToolSummarySchema, { maxItems: 500 })),
	usageByTurn: Type.Optional(Type.Array(UsageTurnSummarySchema, { maxItems: 500 })),
	budgetWarnings: Type.Optional(Type.Array(BudgetWarningSchema, { maxItems: 32 })),
});
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;

const PromptContent = Type.Array(UserContentPartSchema, { minItems: 1, maxItems: 32 });
export const CommandSchema = Type.Union([
	StrictObject({ type: Type.Literal("workspace.list") }),
	StrictObject({ type: Type.Literal("usage.overview"), workspaceId: Id, days: Type.Optional(Type.Integer({ minimum: 7, maximum: 31 })) }),
	StrictObject({ type: Type.Literal("tool.list"), workspaceId: Id }),
	StrictObject({ type: Type.Literal("skill.list"), workspaceId: Id }),
	StrictObject({ type: Type.Literal("skill.get"), workspaceId: Id, skillId: Id }),
	StrictObject({ type: Type.Literal("mcp.list"), workspaceId: Id }),
	StrictObject({ type: Type.Literal("mcp.get"), workspaceId: Id, serverId: Id }),
	StrictObject({ type: Type.Literal("model.list") }),
	StrictObject({ type: Type.Literal("model.custom.discover"), connection: CustomModelConnectionSchema }),
	StrictObject({ type: Type.Literal("model.custom.service.list") }),
	StrictObject({ type: Type.Literal("model.custom.service.refresh"), provider: Id }),
	StrictObject({ type: Type.Literal("model.custom.service.remove"), provider: Id }),
	StrictObject({ type: Type.Literal("model.custom.get"), model: ModelRefSchema }),
	StrictObject({ type: Type.Literal("model.custom.set"), config: CustomModelConfigSchema }),
	StrictObject({ type: Type.Literal("model.custom.remove"), model: ModelRefSchema }),
	StrictObject({ type: Type.Literal("model.custom.test"), model: ModelRefSchema }),
	StrictObject({
		type: Type.Literal("session.list"),
		workspaceId: Id,
		query: Type.Optional(Type.String({ maxLength: 200 })),
		archived: Type.Optional(Type.Boolean()),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	}),
	StrictObject({
		type: Type.Literal("session.create"),
		workspaceId: Id,
		name: Type.Optional(Type.String({ maxLength: 500 })),
		model: ModelRefSchema,
		thinkingLevel: ThinkingLevelSchema,
		sandboxMode: SandboxModeSchema,
		approvalPolicy: ApprovalPolicySchema,
		costBudgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		tokenBudget: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })),
		budgetWarningThreshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
	}),
	StrictObject({ type: Type.Literal("session.attach"), sessionId: Id }),
	StrictObject({ type: Type.Literal("session.detach"), sessionId: Id }),
	StrictObject({ type: Type.Literal("session.snapshot.get"), sessionId: Id }),
	StrictObject({ type: Type.Literal("session.rename"), sessionId: Id, name: Type.String({ minLength: 1, maxLength: 500 }) }),
	StrictObject({ type: Type.Literal("session.archive"), sessionId: Id, archived: Type.Boolean() }),
	StrictObject({
		type: Type.Literal("session.run.list"),
		sessionId: Id,
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	}),
	StrictObject({ type: Type.Literal("subagent.create"), sessionId: Id, task: Type.String({ minLength: 1, maxLength: 20_000 }), name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), costBudgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), tokenBudget: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })), wait: Type.Optional(Type.Boolean()) }),
	StrictObject({ type: Type.Literal("subagent.list"), sessionId: Id, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
	StrictObject({ type: Type.Literal("subagent.cancel"), sessionId: Id, subagentId: Id }),
	StrictObject({ type: Type.Literal("goal.create"), sessionId: Id, title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), objective: Type.String({ minLength: 1, maxLength: 20_000 }), successCriteria: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })), maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })) }),
	StrictObject({ type: Type.Literal("goal.list"), sessionId: Id, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
	StrictObject({ type: Type.Literal("goal.start"), sessionId: Id, goalId: Id }),
	StrictObject({ type: Type.Literal("goal.cancel"), sessionId: Id, goalId: Id }),
	StrictObject({ type: Type.Literal("session.fork"), sessionId: Id, fromItemId: Type.Optional(Id) }),
	StrictObject({ type: Type.Literal("session.compact"), sessionId: Id, instructions: Type.Optional(Type.String({ maxLength: 4000 })) }),
	StrictObject({ type: Type.Literal("session.model.set"), sessionId: Id, model: ModelRefSchema }),
	StrictObject({ type: Type.Literal("session.policy.set"), sessionId: Id, sandboxMode: SandboxModeSchema, approvalPolicy: ApprovalPolicySchema }),
	StrictObject({
		type: Type.Literal("session.thinking.set"),
		sessionId: Id,
		thinkingLevel: ThinkingLevelSchema,
	}),
	StrictObject({ type: Type.Literal("session.budget.set"), sessionId: Id, costBudgetUsd: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()])), tokenBudget: Type.Optional(Type.Union([Type.Integer({ exclusiveMinimum: 0 }), Type.Null()])), budgetWarningThreshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })) }),
	StrictObject({ type: Type.Literal("turn.prompt"), sessionId: Id, content: PromptContent, skills: Type.Optional(Type.Array(Id, { maxItems: 8, uniqueItems: true })) }),
	StrictObject({ type: Type.Literal("turn.steer"), sessionId: Id, content: PromptContent, skills: Type.Optional(Type.Array(Id, { maxItems: 8, uniqueItems: true })) }),
	StrictObject({ type: Type.Literal("turn.follow_up"), sessionId: Id, content: PromptContent, skills: Type.Optional(Type.Array(Id, { maxItems: 8, uniqueItems: true })) }),
	StrictObject({ type: Type.Literal("turn.abort"), sessionId: Id }),
	StrictObject({
		type: Type.Literal("approval.respond"),
		sessionId: Id,
		approvalId: Id,
		decision: Type.Union([Type.Literal("approve"), Type.Literal("deny")]),
	}),
]);
export type Command = Static<typeof CommandSchema>;

export const ErrorCodeSchema = Type.Union([
	Type.Literal("unauthenticated"),
	Type.Literal("forbidden"),
	Type.Literal("not_found"),
	Type.Literal("conflict"),
	Type.Literal("invalid_request"),
	Type.Literal("not_implemented"),
	Type.Literal("rate_limited"),
	Type.Literal("budget_exceeded"),
	Type.Literal("resync_required"),
	Type.Literal("internal_error"),
]);
export const ProtocolErrorSchema = StrictObject({
	code: ErrorCodeSchema,
	message: Type.String(),
	retryable: Type.Boolean(),
	details: Type.Optional(JsonValueSchema),
});
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

export const CommandResultSchema = Type.Union([
	StrictObject({ type: Type.Literal("workspace.list"), workspaces: Type.Array(WorkspaceSummarySchema) }),
	StrictObject({
		type: Type.Literal("tool.list"),
		workspaceId: Id,
		runtime: Type.Union([Type.Literal("pi"), Type.Literal("demo")]),
		tools: Type.Array(ToolStatusSchema, { maxItems: 200 }),
	}),
	StrictObject({ type: Type.Literal("skill.list"), workspaceId: Id, skills: Type.Array(SkillSummarySchema) }),
	StrictObject({ type: Type.Literal("skill.get"), skill: SkillSchema }),
	StrictObject({ type: Type.Literal("mcp.list"), workspaceId: Id, servers: Type.Array(McpServerSummarySchema) }),
	StrictObject({ type: Type.Literal("mcp.get"), server: McpServerSchema }),
	StrictObject({ type: Type.Literal("model.list"), models: Type.Array(ModelMetadataSchema) }),
	StrictObject({
		type: Type.Literal("model.custom.discovered"),
		provider: Id,
		baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
		api: CustomModelApiSchema,
		models: Type.Array(CustomModelCandidateSchema, { minItems: 1, maxItems: 1000 }),
		latencyMs: Type.Integer({ minimum: 0 }),
	}),
	StrictObject({ type: Type.Literal("model.custom.service.list"), services: Type.Array(CustomModelServiceSchema, { maxItems: 100 }) }),
	StrictObject({ type: Type.Literal("model.custom.service.removed"), provider: Id }),
	StrictObject({ type: Type.Literal("model.custom.settings"), settings: CustomModelSettingsSchema }),
	StrictObject({ type: Type.Literal("model.custom.configured"), model: ModelMetadataSchema }),
	StrictObject({ type: Type.Literal("model.custom.removed"), model: ModelRefSchema }),
	StrictObject({ type: Type.Literal("model.custom.tested"), model: ModelRefSchema, latencyMs: Type.Integer({ minimum: 0 }) }),
	StrictObject({ type: Type.Literal("session.list"), sessions: Type.Array(SessionSummarySchema) }),
	StrictObject({ type: Type.Literal("usage.overview"), overview: UsageOverviewSchema }),
	StrictObject({ type: Type.Literal("session.created"), snapshot: SessionSnapshotSchema }),
	StrictObject({ type: Type.Literal("session.attached"), snapshot: SessionSnapshotSchema }),
	StrictObject({ type: Type.Literal("session.detached"), sessionId: Id }),
	StrictObject({ type: Type.Literal("session.snapshot"), snapshot: SessionSnapshotSchema }),
	StrictObject({ type: Type.Literal("session.renamed"), snapshot: SessionSnapshotSchema }),
	StrictObject({ type: Type.Literal("session.archived"), snapshot: SessionSnapshotSchema }),
	StrictObject({ type: Type.Literal("session.run.list"), sessionId: Id, runs: Type.Array(RunSummarySchema) }),
	StrictObject({ type: Type.Literal("subagent.created"), subagent: SubagentSummarySchema }),
	StrictObject({ type: Type.Literal("subagent.list"), sessionId: Id, depth: Type.Integer({ minimum: 0, maximum: 3 }), canCreate: Type.Boolean(), subagents: Type.Array(SubagentSummarySchema) }),
	StrictObject({ type: Type.Literal("subagent.cancel_requested"), subagent: SubagentSummarySchema }),
	StrictObject({ type: Type.Literal("goal.created"), goal: GoalSummarySchema }),
	StrictObject({ type: Type.Literal("goal.list"), sessionId: Id, goals: Type.Array(GoalSummarySchema) }),
	StrictObject({ type: Type.Literal("goal.started"), goal: GoalSummarySchema }),
	StrictObject({ type: Type.Literal("goal.cancel_requested"), goal: GoalSummarySchema }),
	StrictObject({ type: Type.Literal("session.forked"), snapshot: SessionSnapshotSchema }),
	StrictObject({ type: Type.Literal("session.compacted"), snapshot: SessionSnapshotSchema }),
	StrictObject({ type: Type.Literal("session.configured"), snapshot: SessionSnapshotSchema }),
	StrictObject({
		type: Type.Literal("turn.accepted"),
		sessionId: Id,
		revision: Revision,
		queue: Type.Union([Type.Literal("active"), Type.Literal("steer"), Type.Literal("follow_up")]),
	}),
	StrictObject({ type: Type.Literal("turn.abort_requested"), sessionId: Id, revision: Revision }),
	StrictObject({ type: Type.Literal("approval.accepted"), approval: ApprovalRequestSchema }),
]);
export type CommandResult = Static<typeof CommandResultSchema>;

export const TerminalClientMessageSchema = Type.Union([
	StrictObject({ type: Type.Literal("terminal.create"), requestId: Id, terminalId: Id, workspaceId: Id, cols: Type.Integer({ minimum: 20, maximum: 400 }), rows: Type.Integer({ minimum: 5, maximum: 200 }) }),
	StrictObject({ type: Type.Literal("terminal.attach"), requestId: Id, terminalId: Id, sinceSeq: Type.Integer({ minimum: 0 }), cols: Type.Integer({ minimum: 20, maximum: 400 }), rows: Type.Integer({ minimum: 5, maximum: 200 }) }),
	StrictObject({ type: Type.Literal("terminal.input"), terminalId: Id, data: Type.String({ maxLength: 65536 }) }),
	StrictObject({ type: Type.Literal("terminal.resize"), terminalId: Id, cols: Type.Integer({ minimum: 20, maximum: 400 }), rows: Type.Integer({ minimum: 5, maximum: 200 }) }),
	StrictObject({ type: Type.Literal("terminal.close"), requestId: Id, terminalId: Id }),
]);
export type TerminalClientMessage = Static<typeof TerminalClientMessageSchema>;

export const TerminalServerMessageSchema = Type.Union([
	StrictObject({ type: Type.Literal("terminal.ready"), requestId: Id, terminalId: Id, shell: Type.String({ minLength: 1, maxLength: 1000 }), seq: Type.Integer({ minimum: 0 }) }),
	StrictObject({ type: Type.Literal("terminal.output"), terminalId: Id, seq: Type.Integer({ minimum: 1 }), data: Type.String() }),
	StrictObject({ type: Type.Literal("terminal.reset"), terminalId: Id, seq: Type.Integer({ minimum: 0 }), data: Type.String() }),
	StrictObject({ type: Type.Literal("terminal.exit"), terminalId: Id, exitCode: Type.Optional(Type.Integer()), signal: Type.Optional(Type.Integer()) }),
	StrictObject({ type: Type.Literal("terminal.closed"), requestId: Id, terminalId: Id }),
	StrictObject({ type: Type.Literal("terminal.error"), requestId: Type.Optional(Id), terminalId: Type.Optional(Id), code: Type.String({ minLength: 1, maxLength: 100 }), message: Type.String({ minLength: 1, maxLength: 4000 }) }),
]);
export type TerminalServerMessage = Static<typeof TerminalServerMessageSchema>;

export const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	protocolVersion: Type.Integer({ minimum: 1 }),
	clientId: Id,
	capabilities: Type.Array(CapabilitySchema, { uniqueItems: true }),
	resumeCursor: Type.Optional(Id),
});
export const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	requestId: Id,
	idempotencyKey: Id,
	command: CommandSchema,
});
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema, TerminalClientMessageSchema]);
export type ClientHello = Static<typeof ClientHelloSchema>;
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export type ClientMessage = Static<typeof ClientMessageSchema>;

export const DurableEventSchema = Type.Union([
	StrictObject({ type: Type.Literal("session.snapshot"), snapshot: SessionSnapshotSchema }),
	StrictObject({ type: Type.Literal("session.item.upserted"), sessionId: Id, revision: Revision, item: TranscriptItemSchema }),
	StrictObject({ type: Type.Literal("session.phase.changed"), sessionId: Id, revision: Revision, phase: SessionPhaseSchema }),
	StrictObject({ type: Type.Literal("approval.requested"), sessionId: Id, revision: Revision, approval: ApprovalRequestSchema }),
	StrictObject({ type: Type.Literal("approval.settled"), sessionId: Id, revision: Revision, approval: ApprovalRequestSchema }),
	StrictObject({ type: Type.Literal("session.removed"), sessionId: Id, revision: Revision }),
	StrictObject({ type: Type.Literal("resync_required"), reason: Type.String() }),
]);
export const ProgressEventSchema = Type.Union([
	StrictObject({
		type: Type.Literal("assistant.delta"),
		sessionId: Id,
		itemId: Id,
		streamSeq: Type.Integer({ minimum: 0 }),
		contentIndex: Type.Integer({ minimum: 0 }),
		kind: Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("tool_call")]),
		delta: Type.String(),
	}),
	StrictObject({
		type: Type.Literal("tool.started"),
		sessionId: Id,
		toolCallId: Id,
		toolName: Id,
		input: JsonValueSchema,
	}),
	StrictObject({
		type: Type.Literal("tool.progress"),
		sessionId: Id,
		toolCallId: Id,
		streamSeq: Type.Integer({ minimum: 0 }),
		preview: Type.String(),
		truncated: Type.Boolean(),
		artifact: Type.Optional(ArtifactRefSchema),
	}),
]);
export type DurableEvent = Static<typeof DurableEventSchema>;
export type ProgressEvent = Static<typeof ProgressEventSchema>;

export const ServerMessageSchema = Type.Union([
	StrictObject({
		type: Type.Literal("hello"),
		protocolVersion: Type.Literal(PROTOCOL_VERSION),
		connectionId: Id,
		capabilities: Type.Array(CapabilitySchema, { uniqueItems: true }),
		serverTime: Timestamp,
	}),
	StrictObject({ type: Type.Literal("hello_error"), error: ProtocolErrorSchema }),
	StrictObject({
		type: Type.Literal("response"),
		requestId: Id,
		ok: Type.Literal(true),
		result: CommandResultSchema,
	}),
	StrictObject({ type: Type.Literal("response"), requestId: Id, ok: Type.Literal(false), error: ProtocolErrorSchema }),
	StrictObject({ type: Type.Literal("event"), cursor: Id, event: DurableEventSchema }),
	StrictObject({ type: Type.Literal("progress"), event: ProgressEventSchema }),
	TerminalServerMessageSchema,
]);
export type ServerMessage = Static<typeof ServerMessageSchema>;

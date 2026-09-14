export type CapabilityJson = null | boolean | number | string | CapabilityJson[] | { [key: string]: CapabilityJson };

export type CapabilityKind = "tool" | "skill" | "mcp" | "hook" | "memory" | "model" | "executor" | "prompt";
export type CapabilityScope = "system" | "organization" | "user" | "workspace" | "session" | "agent" | "turn";
export type CapabilityActivation = "always" | "requested" | "deferred";

export const HOOK_POINTS = ["operation.before_execute", "operation.after_execute", "operation.on_error"] as const;
export type HookPoint = (typeof HOOK_POINTS)[number];
export type HookMode = "enforce" | "observe";

export interface CapabilityPermission {
	type: string;
	constraints?: CapabilityJson;
}

export interface ToolCapability {
	name: string;
	description?: string;
	inputSchema?: CapabilityJson;
	executionMode: "sequential" | "parallel";
	exposure: "direct" | "deferred";
}

export interface HookCapability {
	points: HookPoint[];
	mode: HookMode;
	timeoutMs?: number;
}

export interface CapabilityManifest {
	id: string;
	version: string;
	kind: CapabilityKind;
	provider: string;
	scope: CapabilityScope;
	activation?: CapabilityActivation;
	priority?: number;
	description?: string;
	modelVisible?: boolean;
	required?: boolean;
	dependencies?: string[];
	conflicts?: string[];
	permissions?: CapabilityPermission[];
	tool?: ToolCapability;
	hook?: HookCapability;
	promptFragment?: string;
	metadata?: Record<string, CapabilityJson>;
}

export interface CapabilityResolutionContext {
	workspaceId: string;
	sessionId: string;
	agentId?: string;
	turnId?: string;
	model: { provider: string; id: string };
	sandboxMode: string;
	approvalPolicy: string;
}

export interface CapabilityPlan {
	schemaVersion: 1;
	digest: string;
	context: CapabilityResolutionContext;
	capabilities: CapabilityManifest[];
	modelVisible: {
		tools: string[];
		promptFragments: string[];
	};
	permissions: CapabilityPermission[];
}

export interface CapabilityResolveOptions {
	requested?: string[];
	denied?: string[];
}

export interface CapabilityRegistration {
	readonly id: string;
	readonly disposed: boolean;
	dispose(): void;
}

export type CapabilityPredicate = (context: CapabilityResolutionContext) => boolean;

export interface CapabilityRegisterOptions {
	when?: CapabilityPredicate;
}

export interface HookInvocation {
	hookId: string;
	hookVersion: string;
	point: HookPoint;
	operationId: string;
	sessionId: string;
	timestamp: number;
	data: CapabilityJson;
	signal: AbortSignal;
}

export interface HookHandlerResult {
	decision?: "continue" | "deny";
	code?: string;
	reason?: string;
	annotations?: Record<string, CapabilityJson>;
}

export type HookHandler = (invocation: HookInvocation) => void | HookHandlerResult | Promise<void | HookHandlerResult>;

export type HookOutcome = "completed" | "denied" | "denial_ignored" | "failed" | "timed_out";

export interface HookAuditRecord {
	hookId: string;
	hookVersion: string;
	point: HookPoint;
	mode: HookMode;
	outcome: HookOutcome;
	startedAt: number;
	finishedAt: number;
	durationMs: number;
	code?: string;
	reason?: string;
	annotations?: Record<string, CapabilityJson>;
}

export interface HookDispatchInput {
	plan: CapabilityPlan;
	point: HookPoint;
	operationId: string;
	sessionId: string;
	timestamp: number;
	data?: CapabilityJson;
	signal: AbortSignal;
}

export interface HookDispatchResult {
	allowed: boolean;
	records: HookAuditRecord[];
	denial?: {
		hookId: string;
		code: string;
		reason: string;
	};
}

export interface HookRegistration {
	readonly id: string;
	readonly disposed: boolean;
	dispose(): void;
}

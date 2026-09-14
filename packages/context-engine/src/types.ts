export type ContextJson = null | boolean | number | string | ContextJson[] | { [key: string]: ContextJson };

export type ContextFragmentKind = "system" | "policy" | "skill" | "workspace" | "memory";
export type ContextCacheScope = "stable" | "session" | "turn";
export type ContextTruncation = "none" | "tail" | "head_tail";

export interface ContextFragment {
	id: string;
	version: string;
	kind: Exclude<ContextFragmentKind, "system">;
	source: string;
	content: string;
	label?: string;
	priority?: number;
	required?: boolean;
	cacheScope?: ContextCacheScope;
	truncation?: ContextTruncation;
	metadata?: Record<string, ContextJson>;
}

export interface ContextAssemblyInput {
	workspaceId: string;
	sessionId: string;
	operationId: string;
	model: { provider: string; id: string };
	query: string;
	baseSystemPrompt: string;
	baseSystemVersion?: string;
	fragments: ContextFragment[];
	budget: {
		contextWindowTokens: number;
		observedContextTokens?: number;
		userInputTokens: number;
		reservedOutputTokens: number;
		maxSystemTokens: number;
	};
}

export interface ContextPlanFragment {
	id: string;
	version: string;
	kind: ContextFragmentKind;
	source: string;
	label?: string;
	priority: number;
	required: boolean;
	cacheScope: ContextCacheScope;
	contentDigest: string;
	renderedDigest: string;
	originalTokens: number;
	renderedTokens: number;
	relevance: number;
	truncated: boolean;
	metadata?: Record<string, ContextJson>;
}

export interface OmittedContextFragment {
	id: string;
	version: string;
	kind: ContextFragment["kind"];
	source: string;
	contentDigest: string;
	estimatedTokens: number;
	reason: "budget";
}

export interface ContextPlan {
	schemaVersion: 1;
	digest: string;
	cachePrefixDigest: string;
	context: {
		workspaceId: string;
		sessionId: string;
		operationId: string;
		model: { provider: string; id: string };
	};
	budget: {
		contextWindowTokens: number;
		observedContextTokens: number;
		userInputTokens: number;
		reservedOutputTokens: number;
		maxSystemTokens: number;
		availableSystemTokens: number;
	};
	estimatedSystemTokens: number;
	fragments: ContextPlanFragment[];
	omitted: OmittedContextFragment[];
}

export interface ContextAssembly {
	plan: ContextPlan;
	systemPrompt: string;
	injectedPromptSuffix: string;
}

export type ContextTokenEstimator = (text: string) => number;

export interface ContextEngineOptions {
	estimateTokens?: ContextTokenEstimator;
	maxFragments?: number;
	maxFragmentChars?: number;
}

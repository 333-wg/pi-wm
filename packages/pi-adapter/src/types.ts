import type { AgentSessionEvent, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage, Usage as PiUsage } from "@earendil-works/pi-ai";
import type { CapabilityManifest } from "@wuming/capability-kernel";
import type { ContextFragment } from "@wuming/context-engine";
import type { ArtifactRef, SessionSnapshot } from "@wuming/protocol";
import type { DurableOperation } from "@wuming/orchestrator";

export interface PiPreparedPrompt {
	text: string;
	images: Array<{ type: "image"; data: string; mimeType: string }>;
}

export interface PiSessionRecovery {
	snapshot: SessionSnapshot;
	operations: DurableOperation[];
	loadPrompt: (operation: DurableOperation) => Promise<PiPreparedPrompt>;
	signal: AbortSignal;
}

export interface PiSessionLike {
	readonly isStreaming: boolean;
	prepareForPrompt?(recovery?: PiSessionRecovery): void | Promise<void>;
	getSystemPrompt?(): string;
	setSystemPrompt?(prompt: string): void;
	getCapabilityManifests?(): CapabilityManifest[];
	getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(
		text: string,
		options?: {
			operationId?: string;
			images?: Array<{ type: "image"; data: string; mimeType: string }>;
			streamingBehavior?: "steer" | "followUp";
			expandPromptTemplates?: boolean;
			source?: "interactive" | "rpc" | "extension";
		}
	): Promise<void>;
	compact?(instructions?: string): Promise<{
		summary: string;
		firstKeptEntryId?: string;
		tokensBefore?: number;
		estimatedTokensAfter?: number;
		usage?: PiUsage;
	}>;
	abort(): Promise<void>;
	setAutoRetryEnabled?(enabled: boolean): void;
	setAutoCompactionEnabled?(enabled: boolean): void;
	resumeApprovedTool?(
		toolCallId: string,
		signal: AbortSignal,
		onUpdate?: (result: {
			content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
			details: unknown;
		}) => void
	): Promise<{ message: ToolResultMessage; input: unknown }>;
	dispose(): void;
}

export type PiSessionFactory = (snapshot: SessionSnapshot) => Promise<PiSessionLike>;

export interface PiProviderRegistration {
	provider: string;
	config: ProviderConfig;
}

export interface ArtifactContent {
	data: string;
	mimeType: string;
	binary?: boolean;
	extractedText?: string;
	extractionNotice?: string;
}

export type ArtifactResolver = (artifact: ArtifactRef, snapshot: SessionSnapshot) => Promise<ArtifactContent>;

export type WorkspaceResolver = (workspaceId: string) => Promise<string> | string;

export interface ResolvedSkill {
	id: string;
	name: string;
	content: string;
	/** True when the resolver could not load the entire instruction body. */
	truncated?: boolean;
}

export type SkillResolver = (snapshot: SessionSnapshot, skillIds: string[]) => Promise<ResolvedSkill[]>;

export type ContextFragmentResolver = (
	snapshot: SessionSnapshot,
	operationId: string,
	query: string
) => ContextFragment[] | Promise<ContextFragment[]>;

export interface PiContextBudget {
	contextWindowTokens?: number;
	reservedOutputTokens?: number;
	maxSystemTokens?: number;
}

export type PiContextBudgetResolver = (snapshot: SessionSnapshot) => PiContextBudget | Promise<PiContextBudget>;

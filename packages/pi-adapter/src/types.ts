import type { AgentSessionEvent, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage, Usage as PiUsage } from "@earendil-works/pi-ai";
import type { ArtifactRef, SessionSnapshot } from "@wuming/protocol";

export interface PiSessionLike {
	readonly isStreaming: boolean;
	getSystemPrompt?(): string;
	setSystemPrompt?(prompt: string): void;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(
		text: string,
		options?: {
			images?: Array<{ type: "image"; data: string; mimeType: string }>;
			streamingBehavior?: "steer" | "followUp";
			expandPromptTemplates?: boolean;
			source?: "interactive" | "rpc" | "extension";
		},
	): Promise<void>;
	compact?(instructions?: string): Promise<{ summary: string; usage?: PiUsage }>;
	abort(): Promise<void>;
	setAutoRetryEnabled?(enabled: boolean): void;
	resumeApprovedTool?(
		toolCallId: string,
		signal: AbortSignal,
		onUpdate?: (result: { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: unknown }) => void,
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
}

export type ArtifactResolver = (artifact: ArtifactRef, snapshot: SessionSnapshot) => Promise<ArtifactContent>;

export type WorkspaceResolver = (workspaceId: string) => Promise<string> | string;

export interface ResolvedSkill {
	id: string;
	name: string;
	content: string;
}

export type SkillResolver = (snapshot: SessionSnapshot, skillIds: string[]) => Promise<ResolvedSkill[]>;

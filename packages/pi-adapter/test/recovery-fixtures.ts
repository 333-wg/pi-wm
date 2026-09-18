import type { DurableOperation } from "@wuming/orchestrator";
import type { SessionSnapshot } from "@wuming/protocol";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export function recoveryOperation(id = "original", overrides: Partial<DurableOperation> = {}): DurableOperation {
	return {
		id,
		sessionId: "recovery-session",
		type: "turn",
		status: "interrupted",
		attempt: 1,
		createdAt: 10,
		startedAt: 10,
		updatedAt: 30,
		finishedAt: 30,
		abortRequested: false,
		failureKind: "runtime_restart",
		payload: {
			type: "turn",
			mode: "prompt",
			userItemId: `user-${id}`,
			content: [{ type: "text", text: "Build a library management system" }],
		},
		...overrides,
	};
}

export function recoverySnapshot(operations = [recoveryOperation()]): SessionSnapshot {
	return {
		session: { id: "recovery-session", workspaceId: "workspace", phase: "idle", createdAt: 1, updatedAt: 31 },
		revision: 1,
		model: { provider: "recovery-test", id: "recovery-model" },
		thinkingLevel: "off",
		sandboxMode: "workspace_write",
		approvalPolicy: "never",
		pendingApprovals: [],
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		transcript: operations.map((operation) => ({
			id: operation.payload.userItemId,
			type: "user",
			createdAt: operation.createdAt,
			content: operation.payload.content,
		})),
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
	};
}

export function recoveryAssistant(content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "recovery-test",
		model: "recovery-model",
		content,
		stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 20,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

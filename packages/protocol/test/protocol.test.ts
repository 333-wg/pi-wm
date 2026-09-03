import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
	ApprovalRequestSchema,
	ClientMessageSchema,
	RequestEnvelopeSchema,
	ServerMessageSchema,
	ToolStatusSchema,
} from "../src/index.ts";

describe("wire protocol", () => {
	it("accepts a prompt command with an artifact reference", () => {
		const check = Compile(RequestEnvelopeSchema);
		expect(
			check.Check({
				type: "request",
				requestId: "req-1",
				idempotencyKey: "idem-1",
				command: {
					type: "turn.prompt",
					sessionId: "session-1",
					content: [
						{ type: "text", text: "Review this image" },
						{
							type: "artifact",
							artifact: { id: "artifact-1", name: "screen.png", mimeType: "image/png", size: 1024 },
						},
					],
				},
			}),
		).toBe(true);
	});

	it("rejects unknown command fields", () => {
		const check = Compile(ClientMessageSchema);
		expect(
			check.Check({
				type: "request",
				requestId: "req-1",
				idempotencyKey: "idem-1",
				command: { type: "turn.abort", sessionId: "session-1", force: true },
			}),
		).toBe(false);
	});

	it("requires concrete capabilities for an approval", () => {
		const check = Compile(ApprovalRequestSchema);
		expect(
			check.Check({
				id: "approval-1",
				sessionId: "session-1",
				workspaceId: "workspace-1",
				toolCallId: "tool-1",
				risk: "high",
				summary: "Run a package installation",
				capabilities: [],
				status: "pending",
				createdAt: 1,
				expiresAt: 2,
			}),
		).toBe(false);
	});

	it("separates replayable events from ephemeral progress", () => {
		const check = Compile(ServerMessageSchema);
		expect(
			check.Check({
				type: "progress",
				event: {
					type: "assistant.delta",
					sessionId: "session-1",
					itemId: "assistant-1",
					streamSeq: 3,
					contentIndex: 0,
					kind: "text",
					delta: "hello",
				},
			}),
		).toBe(true);
	});

	it("rejects an untyped successful response", () => {
		const check = Compile(ServerMessageSchema);
		expect(
			check.Check({
				type: "response",
				requestId: "req-1",
				ok: true,
				result: { arbitrary: "data" },
			}),
		).toBe(false);
	});

	it("validates the tool catalog command and status payload", () => {
		const client = Compile(ClientMessageSchema);
		expect(client.Check({
			type: "request",
			requestId: "tools-1",
			idempotencyKey: "tools-key-1",
			command: { type: "tool.list", workspaceId: "workspace-1" },
		})).toBe(true);

		const tool = {
			name: "web_search",
			label: "网络搜索",
			description: "搜索公开网页",
			category: "network",
			status: "ready",
			backend: "bing via SafeWebClient",
			risk: "low",
			sandboxModes: ["read_only", "workspace_write", "unrestricted"],
		};
		expect(Compile(ToolStatusSchema).Check(tool)).toBe(true);
		expect(Compile(ServerMessageSchema).Check({
			type: "response",
			requestId: "tools-1",
			ok: true,
			result: { type: "tool.list", workspaceId: "workspace-1", runtime: "pi", tools: [tool] },
		})).toBe(true);
	});

	it("validates bounded session run history requests", () => {
		const check = Compile(ClientMessageSchema);
		expect(check.Check({
			type: "request",
			requestId: "runs-1",
			idempotencyKey: "runs-key-1",
			command: { type: "session.run.list", sessionId: "session-1", limit: 20 },
		})).toBe(true);
		expect(check.Check({
			type: "request",
			requestId: "runs-2",
			idempotencyKey: "runs-key-2",
			command: { type: "session.run.list", sessionId: "session-1", limit: 101 },
		})).toBe(false);
	});

	it("validates session search and lifecycle commands", () => {
		const check = Compile(ClientMessageSchema);
		expect(check.Check({
			type: "request",
			requestId: "policy",
			idempotencyKey: "policy-key",
			command: { type: "session.policy.set", sessionId: "session-1", sandboxMode: "unrestricted", approvalPolicy: "never" },
		})).toBe(true);
		expect(check.Check({
			type: "request",
			requestId: "sessions",
			idempotencyKey: "sessions-key",
			command: { type: "session.list", workspaceId: "workspace-1", query: "release", archived: true, limit: 50 },
		})).toBe(true);
		expect(check.Check({
			type: "request",
			requestId: "rename",
			idempotencyKey: "rename-key",
			command: { type: "session.rename", sessionId: "session-1", name: "Release review" },
		})).toBe(true);
		expect(check.Check({
			type: "request",
			requestId: "archive",
			idempotencyKey: "archive-key",
			command: { type: "session.archive", sessionId: "session-1", archived: true },
		})).toBe(true);
	});

	it("validates bounded subagent commands", () => {
		const check = Compile(ClientMessageSchema);
		for (const [requestId, command] of [
			["subagent-create", { type: "subagent.create", sessionId: "session-1", task: "Review authentication", name: "Auth review", costBudgetUsd: 0.5, tokenBudget: 10_000 }],
			["subagent-list", { type: "subagent.list", sessionId: "session-1", limit: 50 }],
			["subagent-cancel", { type: "subagent.cancel", sessionId: "session-1", subagentId: "child-1" }],
		] as const) {
			expect(check.Check({ type: "request", requestId, idempotencyKey: `${requestId}-key`, command })).toBe(true);
		}
		expect(check.Check({
			type: "request",
			requestId: "subagent-list-too-large",
			idempotencyKey: "subagent-list-too-large-key",
			command: { type: "subagent.list", sessionId: "session-1", limit: 101 },
		})).toBe(false);
	});

	it("validates goal lifecycle commands and summaries", () => {
		const client = Compile(ClientMessageSchema);
		for (const [requestId, command] of [
			["goal-create", { type: "goal.create", sessionId: "session-1", title: "Release", objective: "Prepare and verify the release", successCriteria: "All checks pass", maxRounds: 3 }],
			["goal-list", { type: "goal.list", sessionId: "session-1", limit: 50 }],
			["goal-start", { type: "goal.start", sessionId: "session-1", goalId: "goal-1" }],
			["goal-cancel", { type: "goal.cancel", sessionId: "session-1", goalId: "goal-1" }],
		] as const) {
			expect(client.Check({ type: "request", requestId, idempotencyKey: `${requestId}-key`, command })).toBe(true);
		}
		expect(client.Check({
			type: "request",
			requestId: "goal-list-too-large",
			idempotencyKey: "goal-list-too-large-key",
			command: { type: "goal.list", sessionId: "session-1", limit: 101 },
		})).toBe(false);
		expect(client.Check({
			type: "request",
			requestId: "goal-too-many-rounds",
			idempotencyKey: "goal-too-many-rounds-key",
			command: { type: "goal.create", sessionId: "session-1", objective: "Release", successCriteria: "All checks pass", maxRounds: 6 },
		})).toBe(false);

		expect(Compile(ServerMessageSchema).Check({
			type: "response",
			requestId: "goal-list",
			ok: true,
			result: {
				type: "goal.list",
				sessionId: "session-1",
				goals: [{
					id: "goal-1",
					parentSessionId: "session-1",
					title: "Release",
					objective: "Prepare and verify the release",
					status: "pending",
					createdAt: 1,
					updatedAt: 1,
					usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
					pendingApprovals: [],
					successCriteria: "All checks pass",
					round: 1,
					maxRounds: 3,
					reviewPhase: "reviewing",
					reviewHistory: [{ round: 1, verdict: "fail", feedback: "Missing evidence", reviewedAt: 2 }],
				}],
			},
		})).toBe(true);
	});

	it("validates custom model discovery without exposing provider details in the request", () => {
		const client = Compile(ClientMessageSchema);
		expect(client.Check({
			type: "request",
			requestId: "discover-models",
			idempotencyKey: "discover-models-key",
			command: { type: "model.custom.discover", connection: { baseUrl: "https://gateway.example/v1", apiKey: "secret" } },
		})).toBe(true);
		expect(client.Check({
			type: "request",
			requestId: "discover-models-missing-key",
			idempotencyKey: "discover-models-missing-key-key",
			command: { type: "model.custom.discover", connection: { baseUrl: "https://gateway.example/v1" } },
		})).toBe(false);
		expect(client.Check({
			type: "request",
			requestId: "get-model-settings",
			idempotencyKey: "get-model-settings-key",
			command: { type: "model.custom.get", model: { provider: "custom-provider", id: "model-1" } },
		})).toBe(true);
		for (const [requestId, command] of [
			["list-model-services", { type: "model.custom.service.list" }],
			["refresh-model-service", { type: "model.custom.service.refresh", provider: "custom-provider" }],
			["remove-model-service", { type: "model.custom.service.remove", provider: "custom-provider" }],
		] as const) {
			expect(client.Check({ type: "request", requestId, idempotencyKey: `${requestId}-key`, command })).toBe(true);
		}
		expect(client.Check({
			type: "request",
			requestId: "update-model-with-stored-key",
			idempotencyKey: "update-model-with-stored-key-idempotency",
			command: {
				type: "model.custom.set",
				config: {
					provider: "custom-provider", id: "model-1", name: "Model 1", api: "openai-completions",
					baseUrl: "https://gateway.example/v1", reasoning: false, input: ["text"], contextWindow: 128000, maxOutputTokens: 4096,
				},
			},
		})).toBe(true);

		const server = Compile(ServerMessageSchema);
		expect(server.Check({
			type: "response",
			requestId: "discover-models",
			ok: true,
				result: {
					type: "model.custom.discovered",
					provider: "custom-gateway-example-1234567890",
					baseUrl: "https://gateway.example/v1",
				api: "openai-completions",
				models: [{ id: "model-1", name: "Model 1" }],
				latencyMs: 42,
			},
		})).toBe(true);
		expect(server.Check({
			type: "response",
			requestId: "get-model-settings",
			ok: true,
			result: {
				type: "model.custom.settings",
				settings: {
					model: { provider: "custom-provider", id: "model-1" },
					name: "Model 1",
					api: "openai-completions",
					baseUrl: "https://gateway.example/v1",
					reasoning: false,
					input: ["text"],
					contextWindow: 128000,
					maxOutputTokens: 4096,
				},
			},
		})).toBe(true);
		expect(server.Check({
			type: "response",
			requestId: "list-model-services",
			ok: true,
			result: {
				type: "model.custom.service.list",
				services: [{ provider: "custom-provider", baseUrl: "https://gateway.example/v1", api: "openai-completions", authenticated: true, modelCount: 1 }],
			},
		})).toBe(true);
	});
});

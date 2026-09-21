import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
	ApprovalRequestSchema,
	ClientMessageSchema,
	RequestEnvelopeSchema,
	ServerMessageSchema,
	ToolStatusSchema,
} from "../src/index.js";

describe("wire protocol", () => {
	it("validates durable per-request usage updates", () => {
		const check = Compile(ServerMessageSchema);
		const request = {
			requestId: "r",
			model: { provider: "test", id: "model" },
			usage: {
				inputTokens: 100,
				cacheReadTokens: 900,
				cacheWriteTokens: 0,
				outputTokens: 10,
				totalTokens: 1010,
				costUsd: 0,
			},
		};
		const event = { type: "session.request.usage.updated", sessionId: "s", revision: 4, request };
		expect(check.Check({ type: "event", cursor: "cursor", event })).toBe(true);
		expect(
			check.Check({
				type: "event",
				cursor: "cursor",
				event: { ...event, request: { ...request, usage: { ...request.usage, cacheReadTokens: -1 } } },
			})
		).toBe(false);
	});
	it("validates compaction progress states", () => {
		const check = Compile(ServerMessageSchema);
		for (const status of ["running", "complete", "failed", "cancelled"]) {
			expect(check.Check({ type: "progress", event: { type: "context.compaction", sessionId: "s", status } })).toBe(
				true
			);
		}
		expect(
			check.Check({ type: "progress", event: { type: "context.compaction", sessionId: "s", status: "unknown" } })
		).toBe(false);
	});
	it("accepts explicit context estimates and unknown occupancy, rejecting invalid counts", () => {
		const check = Compile(ServerMessageSchema);
		const message = {
			type: "event",
			cursor: "cursor",
			event: {
				type: "session.context.updated",
				sessionId: "s",
				revision: 3,
				contextUsage: { model: { provider: "test", id: "model" }, basis: "compaction", tokens: 12000 },
			},
		};
		expect(check.Check(message)).toBe(true);
		for (const tokens of [null, 0, 42000]) {
			expect(
				check.Check({
					...message,
					event: { ...message.event, contextUsage: { ...message.event.contextUsage, tokens } },
				})
			).toBe(true);
		}
		for (const tokens of [-1, 0.5, "12000"]) {
			expect(
				check.Check({
					...message,
					event: { ...message.event, contextUsage: { ...message.event.contextUsage, tokens } },
				})
			).toBe(false);
		}
	});
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
			})
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
			})
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
			})
		).toBe(false);
	});

	it("accepts explicit local skill and MCP management capabilities", () => {
		const check = Compile(ApprovalRequestSchema);
		for (const capability of [
			{ type: "skill.manage", skillId: "review", action: "install" },
			{ type: "mcp.manage", serverId: "docs", action: "trust" },
		]) {
			expect(
				check.Check({
					id: `approval-${capability.type}`,
					sessionId: "session-1",
					workspaceId: "workspace-1",
					toolCallId: "tool-1",
					risk: "high",
					summary: "Manage a local user capability",
					capabilities: [capability],
					status: "pending",
					createdAt: 1,
					expiresAt: 2,
				})
			).toBe(true);
		}
	});

	it("validates global MCP configuration scopes", () => {
		const request = Compile(RequestEnvelopeSchema);
		const envelope = {
			type: "request",
			requestId: "scope",
			idempotencyKey: "scope",
			command: {
				type: "mcp.configure",
				workspaceId: "workspace-1",
				scope: "global",
				previousScope: "workspace",
				config: { id: "docs", command: "node" },
			},
		};
		expect(request.Check(envelope)).toBe(true);
		expect(request.Check({ ...envelope, command: { ...envelope.command, scope: "unknown" } })).toBe(false);
		expect(request.Check({ ...envelope, command: { ...envelope.command, previousScope: "unknown" } })).toBe(false);
	});

	it("accepts local MCP management commands and results", () => {
		const request = Compile(RequestEnvelopeSchema);
		expect(
			request.Check({
				type: "request",
				requestId: "mcp-configure",
				idempotencyKey: "mcp-configure",
				command: {
					type: "mcp.configure",
					workspaceId: "workspace-1",
					config: {
						id: "docs",
						transport: "stdio",
						command: "node",
						args: ["tools/docs-mcp.cjs"],
						readOnly: true,
					},
				},
			})
		).toBe(true);
		for (const type of ["mcp.trust", "mcp.untrust"] as const) {
			expect(
				request.Check({
					type: "request",
					requestId: type,
					idempotencyKey: type,
					command: { type, workspaceId: "workspace-1", serverId: "docs" },
				})
			).toBe(true);
		}

		const response = Compile(ServerMessageSchema);
		expect(
			response.Check({
				type: "response",
				requestId: "mcp-configure",
				ok: true,
				result: {
					type: "mcp.updated",
					workspaceId: "workspace-1",
					server: {
						id: "docs",
						workspaceId: "workspace-1",
						name: "docs",
						transport: "stdio",
						readOnly: true,
						trusted: false,
						toolCount: 0,
						discoveryStatus: "untrusted",
						tools: [],
					},
				},
			})
		).toBe(true);
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
			})
		).toBe(true);
		expect(
			check.Check({
				type: "progress",
				event: {
					type: "tool.finished",
					sessionId: "session-1",
					toolCallId: "tool-1",
					preview: "ok",
					truncated: false,
					isError: false,
				},
			})
		).toBe(true);
		expect(
			check.Check({
				type: "progress",
				event: {
					type: "run.retrying",
					sessionId: "session-1",
					operationId: "operation-1",
					attempt: 1,
					nextAttempt: 2,
					maxAttempts: 3,
					delayMs: 1000,
					failureKind: "provider_network",
					error: "connection reset",
				},
			})
		).toBe(true);
	});

	it("reports where commands actually execute during the handshake", () => {
		expect(
			Compile(ServerMessageSchema).Check({
				type: "hello",
				protocolVersion: 1,
				connectionId: "connection-1",
				capabilities: ["tools", "terminal"],
				executionEnvironment: {
					placement: "local_device",
					processMode: "local",
					terminalMode: "host",
					previewEnabled: true,
					platform: "win32",
					shell: "C:\\Windows\\System32\\cmd.exe",
				},
				serverTime: 1,
			})
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
			})
		).toBe(false);
	});

	it("validates the tool catalog command and status payload", () => {
		const client = Compile(ClientMessageSchema);
		expect(
			client.Check({
				type: "request",
				requestId: "tools-1",
				idempotencyKey: "tools-key-1",
				command: { type: "tool.list", workspaceId: "workspace-1" },
			})
		).toBe(true);

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
		expect(
			Compile(ServerMessageSchema).Check({
				type: "response",
				requestId: "tools-1",
				ok: true,
				result: { type: "tool.list", workspaceId: "workspace-1", runtime: "pi", tools: [tool] },
			})
		).toBe(true);
	});

	it("validates bounded session run history requests", () => {
		const check = Compile(ClientMessageSchema);
		expect(
			check.Check({
				type: "request",
				requestId: "runs-1",
				idempotencyKey: "runs-key-1",
				command: { type: "session.run.list", sessionId: "session-1", limit: 20 },
			})
		).toBe(true);
		expect(
			check.Check({
				type: "request",
				requestId: "runs-2",
				idempotencyKey: "runs-key-2",
				command: { type: "session.run.list", sessionId: "session-1", limit: 101 },
			})
		).toBe(false);
		expect(
			Compile(ServerMessageSchema).Check({
				type: "response",
				requestId: "runs-1",
				ok: true,
				result: {
					type: "session.run.list",
					sessionId: "session-1",
					runs: [
						{
							id: "operation-1",
							sessionId: "session-1",
							mode: "prompt",
							status: "completed",
							attempt: 1,
							createdAt: 1,
							updatedAt: 2,
							abortRequested: false,
							capabilityPlan: {
								digest: `sha256:${"a".repeat(64)}`,
								capabilityCount: 2,
								tools: ["read_file"],
								promptFragments: ["skill:review@sha256:abc"],
							},
							contextPlan: {
								digest: `sha256:${"b".repeat(64)}`,
								cachePrefixDigest: `sha256:${"c".repeat(64)}`,
								estimatedSystemTokens: 1200,
								availableSystemTokens: 3200,
								fragmentCount: 2,
								omittedCount: 1,
								fragments: [
									{
										id: "system:base",
										kind: "system",
										source: "pi:system-prompt",
										renderedTokens: 800,
										truncated: false,
										cacheScope: "stable",
									},
									{
										id: "workspace:README.md",
										kind: "workspace",
										source: "workspace:README.md",
										renderedTokens: 400,
										truncated: true,
										cacheScope: "turn",
									},
								],
							},
							hookEvents: [
								{
									hookId: "hook:policy",
									hookVersion: "1",
									point: "operation.before_execute",
									mode: "enforce",
									outcome: "completed",
									startedAt: 1,
									finishedAt: 2,
									durationMs: 1,
								},
							],
						},
					],
				},
			})
		).toBe(true);
	});

	it("validates bounded, body-free trajectory reports", () => {
		const client = Compile(ClientMessageSchema);
		expect(
			client.Check({
				type: "request",
				requestId: "trajectory-1",
				idempotencyKey: "trajectory-key-1",
				command: {
					type: "session.run.trajectory.get",
					sessionId: "session-1",
					runId: "operation-1",
				},
			})
		).toBe(true);
		const criteria = ["integrity", "completion", "reliability", "policy", "observability"].map((id) => ({
			id,
			status: "warn",
			score: 0,
			weight: 20,
			evidence: "No terminal evidence yet.",
		}));
		expect(
			Compile(ServerMessageSchema).Check({
				type: "response",
				requestId: "trajectory-1",
				ok: true,
				result: {
					type: "session.run.trajectory",
					sessionId: "session-1",
					runId: "operation-1",
					report: {
						replay: {
							operationId: "operation-1",
							integrity: true,
							eventCount: 0,
							headDigest: null,
							events: [],
						},
						evaluation: {
							schemaVersion: 1,
							algorithm: "structural-v1",
							verdict: "incomplete",
							score: 0,
							semanticCorrectness: "not_evaluated",
							criteria,
							metrics: { modelRequestCount: 0, toolCallCount: 0, retryCount: 0, approvalCount: 0 },
							digest: `sha256:${"d".repeat(64)}`,
						},
					},
				},
			})
		).toBe(true);
		expect(
			client.Check({
				type: "request",
				requestId: "trajectory-2",
				idempotencyKey: "trajectory-key-2",
				command: {
					type: "session.run.trajectory.get",
					sessionId: "session-1",
					runId: "operation-1",
					includeBodies: true,
				},
			})
		).toBe(false);
	});

	it("validates reusable evaluation graders and signed attestations", () => {
		const client = Compile(ClientMessageSchema);
		const server = Compile(ServerMessageSchema);
		const digest = (character: string) => `sha256:${character.repeat(64)}`;
		const graders = [
			{
				id: "trajectory-check",
				label: "Trajectory integrity",
				type: "trajectory",
				requireIntegrity: true,
				minStructuralScore: 70,
			},
			{
				id: "artifact-check",
				label: "Report status",
				type: "artifact",
				artifactId: "artifact-1",
				assertion: { kind: "json_equals", pointer: "/status", expected: "ready" },
			},
			{
				id: "command-check",
				label: "Tests pass",
				type: "command",
				command: "npm test",
				expectedExitCode: 0,
				stdoutContains: "passed",
				timeoutMs: 120_000,
			},
		];
		expect(
			client.Check({
				type: "request",
				requestId: "evaluation-create-1",
				idempotencyKey: "evaluation-create-key-1",
				command: {
					type: "evaluation.dataset.create",
					workspaceId: "workspace-1",
					name: "Release regression",
					graders,
				},
			})
		).toBe(true);
		expect(
			client.Check({
				type: "request",
				requestId: "evaluation-run-1",
				idempotencyKey: "evaluation-run-key-1",
				command: {
					type: "session.run.evaluate",
					sessionId: "session-1",
					runId: "run-1",
					datasetId: "dataset-1",
				},
			})
		).toBe(true);

		const evaluation = {
			id: "evaluation-1",
			sessionId: "session-1",
			runId: "run-1",
			workspaceId: "workspace-1",
			name: "Release regression",
			datasetId: "dataset-1",
			graders,
			specDigest: digest("a"),
			status: "pass",
			checks: [
				{
					graderId: "trajectory-check",
					label: "Trajectory integrity",
					type: "trajectory",
					status: "pass",
					evidence: "Trajectory integrity=true; structural score=89.",
					durationMs: 1,
				},
				{
					graderId: "artifact-check",
					label: "Report status",
					type: "artifact",
					status: "pass",
					evidence: "JSON value matched.",
					durationMs: 2,
					artifactId: "artifact-1",
					artifactSha256: "b".repeat(64),
				},
				{
					graderId: "command-check",
					label: "Tests pass",
					type: "command",
					status: "pass",
					evidence: "Command exited with code 0.",
					durationMs: 20,
					outputDigest: digest("c"),
				},
			],
			trajectoryHeadDigest: digest("d"),
			trajectoryEventCount: 9,
			createdAt: 100,
			finishedAt: 123,
			digest: digest("e"),
		};
		expect(
			server.Check({
				type: "response",
				requestId: "evaluation-run-1",
				ok: true,
				result: { type: "session.run.evaluated", evaluation },
			})
		).toBe(true);
		expect(
			server.Check({
				type: "response",
				requestId: "evaluation-attest-1",
				ok: true,
				result: {
					type: "session.run.attested",
					attestation: {
						schemaVersion: 1,
						id: "attestation-1",
						evaluationId: "evaluation-1",
						evaluationDigest: digest("e"),
						sessionId: "session-1",
						runId: "run-1",
						trajectoryHeadDigest: digest("d"),
						issuedAt: 124,
						algorithm: "ed25519",
						keyId: digest("f"),
						publicKey: "MCowBQYDK2VwAyEAexample",
						payloadDigest: digest("0"),
						signature: "example-signature",
					},
				},
			})
		).toBe(true);

		expect(
			client.Check({
				type: "request",
				requestId: "evaluation-invalid-1",
				idempotencyKey: "evaluation-invalid-key-1",
				command: {
					type: "evaluation.dataset.create",
					workspaceId: "workspace-1",
					name: "Invalid",
					graders: [],
				},
			})
		).toBe(false);
		expect(
			client.Check({
				type: "request",
				requestId: "evaluation-invalid-2",
				idempotencyKey: "evaluation-invalid-key-2",
				command: {
					type: "session.run.evaluate",
					sessionId: "session-1",
					runId: "run-1",
					graders: [
						{
							id: "bad-command",
							label: "Too fast",
							type: "command",
							command: "true",
							timeoutMs: 99,
						},
					],
				},
			})
		).toBe(false);
		expect(
			server.Check({
				type: "response",
				requestId: "evaluation-run-1",
				ok: true,
				result: {
					type: "session.run.evaluated",
					evaluation: { ...evaluation, checks: [{ ...evaluation.checks[2], rawOutput: "secret" }] },
				},
			})
		).toBe(false);
	});

	it("validates goal automation schedules and run history", () => {
		const client = Compile(ClientMessageSchema);
		const server = Compile(ServerMessageSchema);
		const usage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			costUsd: 0,
		};
		expect(
			client.Check({
				type: "request",
				requestId: "automation-create-1",
				idempotencyKey: "automation-create-key-1",
				command: {
					type: "automation.create",
					sessionId: "session-1",
					title: "Release monitor",
					objective: "Check the release",
					schedule: { kind: "interval", startsAt: 1000, everyMinutes: 60 },
					successCriteria: "The report has a status.",
					maxRounds: 2,
				},
			})
		).toBe(true);
		expect(
			client.Check({
				type: "request",
				requestId: "automation-trigger-1",
				idempotencyKey: "automation-trigger-key-1",
				command: {
					type: "automation.trigger",
					sessionId: "session-1",
					automationId: "automation-1",
				},
			})
		).toBe(true);
		expect(
			server.Check({
				type: "response",
				requestId: "automation-list-1",
				ok: true,
				result: {
					type: "automation.list",
					sessionId: "session-1",
					automations: [
						{
							id: "automation-1",
							parentSessionId: "session-1",
							title: "Release monitor",
							objective: "Check the release",
							schedule: { kind: "interval", startsAt: 1000, everyMinutes: 60 },
							status: "active",
							createdAt: 1,
							updatedAt: 2,
							nextRunAt: 1000,
							successCriteria: "The report has a status.",
							maxRounds: 2,
						},
					],
				},
			})
		).toBe(true);
		expect(
			server.Check({
				type: "response",
				requestId: "automation-runs-1",
				ok: true,
				result: {
					type: "automation.run.list",
					sessionId: "session-1",
					automationId: "automation-1",
					runs: [
						{
							id: "automation-run-1",
							automationId: "automation-1",
							trigger: "schedule",
							scheduledFor: 1000,
							triggeredAt: 1001,
							status: "completed",
							goalId: "goal-1",
							runSessionId: "session-2",
							finishedAt: 1200,
							usage,
							result: "ready",
						},
					],
				},
			})
		).toBe(true);
		expect(
			client.Check({
				type: "request",
				requestId: "automation-invalid-1",
				idempotencyKey: "automation-invalid-key-1",
				command: {
					type: "automation.create",
					sessionId: "session-1",
					objective: "Invalid",
					schedule: { kind: "interval", startsAt: 1000, everyMinutes: 0 },
				},
			})
		).toBe(false);
		expect(
			client.Check({
				type: "request",
				requestId: "automation-invalid-2",
				idempotencyKey: "automation-invalid-key-2",
				command: {
					type: "automation.create",
					sessionId: "session-1",
					objective: "Invalid",
					schedule: { kind: "once", runAt: 1000 },
					successCriteria: "Valid",
					maxRounds: 6,
				},
			})
		).toBe(false);
		expect(
			server.Check({
				type: "response",
				requestId: "automation-invalid-3",
				ok: true,
				result: {
					type: "automation.run.list",
					sessionId: "session-1",
					automationId: "automation-1",
					runs: [
						{
							id: "automation-run-1",
							automationId: "automation-1",
							trigger: "manual",
							scheduledFor: 1000,
							triggeredAt: 1000,
							status: "dispatching",
							usage,
							rawPrompt: "secret",
						},
					],
				},
			})
		).toBe(false);
	});

	it("validates authorized session memory list messages with source citations", () => {
		const client = Compile(ClientMessageSchema);
		expect(
			client.Check({
				type: "request",
				requestId: "memory-1",
				idempotencyKey: "memory-key-1",
				command: { type: "session.memory.list", sessionId: "session-1", limit: 20 },
			})
		).toBe(true);
		expect(
			Compile(ServerMessageSchema).Check({
				type: "response",
				requestId: "memory-1",
				ok: true,
				result: {
					type: "session.memory.list",
					sessionId: "session-1",
					memories: [
						{
							memory: {
								id: "memory-1",
								sessionId: "session-1",
								operationId: "operation-1",
								kind: "compaction",
								reason: "overflow",
								summary: "Preserve the verified repository decisions.",
								digest: `sha256:${"e".repeat(64)}`,
								source: { revision: 12, fromItemId: "item-1", throughItemId: "item-8" },
								tokensBefore: 9000,
								estimatedTokensAfter: 2200,
								createdAt: 100,
							},
							status: "active",
							retention: "retained",
							updatedAt: 101,
						},
					],
				},
			})
		).toBe(true);
		expect(
			client.Check({
				type: "request",
				requestId: "memory-2",
				idempotencyKey: "memory-key-2",
				command: { type: "session.memory.list", sessionId: "session-1", limit: 21 },
			})
		).toBe(false);
		expect(
			client.Check({
				type: "request",
				requestId: "memory-3",
				idempotencyKey: "memory-key-3",
				command: {
					type: "session.memory.search",
					sessionId: "session-1",
					query: "repository decision",
					limit: 5,
				},
			})
		).toBe(true);
		expect(
			client.Check({
				type: "request",
				requestId: "memory-4",
				idempotencyKey: "memory-key-4",
				command: {
					type: "session.memory.manage",
					sessionId: "session-1",
					memoryId: "memory-1",
					action: "promote",
				},
			})
		).toBe(true);
		expect(
			client.Check({
				type: "request",
				requestId: "memory-5",
				idempotencyKey: "memory-key-5",
				command: { type: "session.memory.search", sessionId: "session-1", query: "", limit: 5 },
			})
		).toBe(false);
		expect(
			Compile(ServerMessageSchema).Check({
				type: "response",
				requestId: "memory-4",
				ok: true,
				result: {
					type: "session.memory.managed",
					sessionId: "session-1",
					memoryId: "memory-1",
					action: "forget",
					status: "forgotten",
					retention: "automatic",
				},
			})
		).toBe(true);
	});

	it("validates session search and lifecycle commands", () => {
		const check = Compile(ClientMessageSchema);
		expect(
			check.Check({
				type: "request",
				requestId: "policy",
				idempotencyKey: "policy-key",
				command: {
					type: "session.policy.set",
					sessionId: "session-1",
					sandboxMode: "unrestricted",
					approvalPolicy: "never",
				},
			})
		).toBe(true);
		expect(
			check.Check({
				type: "request",
				requestId: "sessions",
				idempotencyKey: "sessions-key",
				command: {
					type: "session.list",
					workspaceId: "workspace-1",
					query: "release",
					archived: true,
					limit: 50,
				},
			})
		).toBe(true);
		expect(
			check.Check({
				type: "request",
				requestId: "rename",
				idempotencyKey: "rename-key",
				command: { type: "session.rename", sessionId: "session-1", name: "Release review" },
			})
		).toBe(true);
		expect(
			check.Check({
				type: "request",
				requestId: "archive",
				idempotencyKey: "archive-key",
				command: { type: "session.archive", sessionId: "session-1", archived: true },
			})
		).toBe(true);
	});

	it("validates bounded subagent commands", () => {
		const check = Compile(ClientMessageSchema);
		for (const [requestId, command] of [
			[
				"subagent-create",
				{
					type: "subagent.create",
					sessionId: "session-1",
					task: "Review authentication",
					name: "Auth review",
					costBudgetUsd: 0.5,
					tokenBudget: 10_000,
				},
			],
			["subagent-list", { type: "subagent.list", sessionId: "session-1", limit: 50 }],
			["subagent-cancel", { type: "subagent.cancel", sessionId: "session-1", subagentId: "child-1" }],
		] as const) {
			expect(check.Check({ type: "request", requestId, idempotencyKey: `${requestId}-key`, command })).toBe(true);
		}
		expect(
			check.Check({
				type: "request",
				requestId: "subagent-list-too-large",
				idempotencyKey: "subagent-list-too-large-key",
				command: { type: "subagent.list", sessionId: "session-1", limit: 101 },
			})
		).toBe(false);
	});

	it("validates goal lifecycle commands and summaries", () => {
		const client = Compile(ClientMessageSchema);
		for (const [requestId, command] of [
			[
				"goal-create",
				{
					type: "goal.create",
					sessionId: "session-1",
					title: "Release",
					objective: "Prepare and verify the release",
					successCriteria: "All checks pass",
					maxRounds: 3,
				},
			],
			["goal-list", { type: "goal.list", sessionId: "session-1", limit: 50 }],
			["goal-start", { type: "goal.start", sessionId: "session-1", goalId: "goal-1" }],
			["goal-cancel", { type: "goal.cancel", sessionId: "session-1", goalId: "goal-1" }],
		] as const) {
			expect(client.Check({ type: "request", requestId, idempotencyKey: `${requestId}-key`, command })).toBe(true);
		}
		expect(
			client.Check({
				type: "request",
				requestId: "goal-list-too-large",
				idempotencyKey: "goal-list-too-large-key",
				command: { type: "goal.list", sessionId: "session-1", limit: 101 },
			})
		).toBe(false);
		expect(
			client.Check({
				type: "request",
				requestId: "goal-too-many-rounds",
				idempotencyKey: "goal-too-many-rounds-key",
				command: {
					type: "goal.create",
					sessionId: "session-1",
					objective: "Release",
					successCriteria: "All checks pass",
					maxRounds: 6,
				},
			})
		).toBe(false);

		expect(
			Compile(ServerMessageSchema).Check({
				type: "response",
				requestId: "goal-list",
				ok: true,
				result: {
					type: "goal.list",
					sessionId: "session-1",
					goals: [
						{
							id: "goal-1",
							parentSessionId: "session-1",
							title: "Release",
							objective: "Prepare and verify the release",
							status: "pending",
							createdAt: 1,
							updatedAt: 1,
							usage: {
								inputTokens: 0,
								outputTokens: 0,
								cacheReadTokens: 0,
								cacheWriteTokens: 0,
								totalTokens: 0,
								costUsd: 0,
							},
							pendingApprovals: [],
							successCriteria: "All checks pass",
							round: 1,
							maxRounds: 3,
							reviewPhase: "reviewing",
							reviewHistory: [
								{
									round: 1,
									verdict: "fail",
									feedback: "Missing evidence",
									checks: [
										{
											criterion: "All checks pass",
											status: "fail",
											evidence: "The test command exited with code 1.",
										},
									],
									toolsUsed: ["exec"],
									reviewedAt: 2,
								},
							],
						},
					],
				},
			})
		).toBe(true);
	});

	it("validates custom model discovery without exposing provider details in the request", () => {
		const client = Compile(ClientMessageSchema);
		expect(
			client.Check({
				type: "request",
				requestId: "discover-models",
				idempotencyKey: "discover-models-key",
				command: {
					type: "model.custom.discover",
					connection: { baseUrl: "https://gateway.example/v1", apiKey: "secret" },
				},
			})
		).toBe(true);
		expect(
			client.Check({
				type: "request",
				requestId: "discover-models-missing-key",
				idempotencyKey: "discover-models-missing-key-key",
				command: {
					type: "model.custom.discover",
					connection: { baseUrl: "https://gateway.example/v1" },
				},
			})
		).toBe(false);
		expect(
			client.Check({
				type: "request",
				requestId: "get-model-settings",
				idempotencyKey: "get-model-settings-key",
				command: {
					type: "model.custom.get",
					model: { provider: "custom-provider", id: "model-1" },
				},
			})
		).toBe(true);
		for (const [requestId, command] of [
			["list-model-services", { type: "model.custom.service.list" }],
			["refresh-model-service", { type: "model.custom.service.refresh", provider: "custom-provider" }],
			["remove-model-service", { type: "model.custom.service.remove", provider: "custom-provider" }],
		] as const) {
			expect(client.Check({ type: "request", requestId, idempotencyKey: `${requestId}-key`, command })).toBe(true);
		}
		expect(
			client.Check({
				type: "request",
				requestId: "update-model-with-stored-key",
				idempotencyKey: "update-model-with-stored-key-idempotency",
				command: {
					type: "model.custom.set",
					config: {
						provider: "custom-provider",
						id: "model-1",
						name: "Model 1",
						api: "openai-completions",
						baseUrl: "https://gateway.example/v1",
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxOutputTokens: 4096,
					},
				},
			})
		).toBe(true);

		const server = Compile(ServerMessageSchema);
		expect(
			server.Check({
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
			})
		).toBe(true);
		expect(
			server.Check({
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
			})
		).toBe(true);
		expect(
			server.Check({
				type: "response",
				requestId: "list-model-services",
				ok: true,
				result: {
					type: "model.custom.service.list",
					services: [
						{
							provider: "custom-provider",
							baseUrl: "https://gateway.example/v1",
							api: "openai-completions",
							authenticated: true,
							modelCount: 1,
						},
					],
				},
			})
		).toBe(true);
	});
});

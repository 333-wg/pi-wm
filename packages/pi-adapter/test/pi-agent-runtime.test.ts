import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { verifyCapabilityPlan, type CapabilityManifest } from "@wuming/capability-kernel";
import { verifyContextPlan } from "@wuming/context-engine";
import { SessionOrchestrator, SqliteOrchestratorStore, type DurableOperation } from "@wuming/orchestrator";
import type { ContextUsageState, SessionSnapshot, TranscriptItem, UsageRequestSummary } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { PiAgentRuntime, type PiSessionLike } from "../src/index.js";

const zeroUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
};

const snapshot: SessionSnapshot = {
	session: {
		id: "session-1",
		workspaceId: "workspace-1",
		phase: "turn",
		createdAt: 1,
		updatedAt: 1,
	},
	revision: 3,
	model: { provider: "anthropic", id: "claude-test" },
	thinkingLevel: "medium",
	sandboxMode: "workspace_write",
	approvalPolicy: "on_risk",
	transcript: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	pendingApprovals: [],
	usage: zeroUsage,
};

function piUsage(input: number, output: number) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	};
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	input: number,
	output: number
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: piUsage(input, output),
		stopReason,
		timestamp: 10,
	};
}

class FakePiSession implements PiSessionLike {
	readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	isStreaming = false;
	prompts: Array<{ text: string; options: Parameters<PiSessionLike["prompt"]>[1] }> = [];
	abortCalls = 0;
	disposed = false;
	systemPrompt = "base system prompt";
	referenceContext: string | undefined;
	capabilityManifests: CapabilityManifest[] = [];
	contextUsage: ReturnType<NonNullable<PiSessionLike["getContextUsage"]>> = undefined;
	compactCalls = 0;
	emitScript: (session: FakePiSession) => Promise<void> = async () => {};
	resumeScript: (
		session: FakePiSession,
		toolCallId: string,
		onUpdate?: Parameters<NonNullable<PiSessionLike["resumeApprovedTool"]>>[2]
	) => Promise<{ message: ToolResultMessage; input: unknown }> = async (_session, toolCallId) => ({
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "write",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 11,
		},
		input: { path: "value.txt", content: "value" },
	});

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	async prompt(text: string, options?: Parameters<PiSessionLike["prompt"]>[1]): Promise<void> {
		this.prompts.push({ text: (this.referenceContext ?? "") + text, options });
		if (this.isStreaming) return;
		this.isStreaming = true;
		try {
			await this.emitScript(this);
		} finally {
			this.isStreaming = false;
		}
	}

	async abort(): Promise<void> {
		this.abortCalls += 1;
	}

	async compact() {
		this.compactCalls += 1;
		this.contextUsage = { tokens: 200, contextWindow: 1000, percent: 20 };
		return { summary: "compacted", tokensBefore: 995, estimatedTokensAfter: 200 };
	}

	getSystemPrompt(): string {
		return this.systemPrompt;
	}

	setSystemPrompt(prompt: string): void {
		this.systemPrompt = prompt;
	}

	setReferenceContext(content: string | undefined): void {
		this.referenceContext = content;
	}

	getCapabilityManifests(): CapabilityManifest[] {
		return this.capabilityManifests;
	}

	getContextUsage() {
		return this.contextUsage;
	}

	async resumeApprovedTool(
		toolCallId: string,
		_signal: AbortSignal,
		onUpdate?: Parameters<NonNullable<PiSessionLike["resumeApprovedTool"]>>[2]
	) {
		return this.resumeScript(this, toolCallId, onUpdate);
	}

	dispose(): void {
		this.disposed = true;
	}
}

it.each(["stop", "error"] as const)(
	"uses the final assistant outcome after in-turn recovery (%s)",
	async (stopReason) => {
		const session = new FakePiSession();
		session.emitScript = async (current) => {
			for (const message of [
				{ ...assistant([], "error", 2, 0), errorMessage: "Earlier failure" },
				{
					...assistant([{ type: "text", text: "Final response" }], stopReason, 3, 1),
					...(stopReason === "error" ? { errorMessage: "Final failure" } : {}),
				},
			]) {
				current.emit({ type: "message_start", message });
				current.emit({ type: "message_end", message });
			}
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session });
		const result = await runtime.executeTurn({
			operation: operation([{ type: "text", text: "recover" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		if (stopReason === "stop") expect(result.failure).toBeUndefined();
		else expect(result.failure?.message).toBe("Final failure");
		expect(result.requests?.map((request) => request.status)).toEqual([
			"error",
			stopReason === "stop" ? "complete" : "error",
		]);
		expect(result.usage?.inputTokens).toBe(5);
	}
);

it("records request timing, first content and failure without carrying timing into the next request", async () => {
	const session = new FakePiSession();
	const observations: UsageRequestSummary[] = [];
	let now = 100;
	session.emitScript = async (current) => {
		const partial = assistant([{ type: "text", text: "hello" }], "stop", 1, 1);
		current.emit({ type: "message_start", message: partial });
		expect(observations.at(-1)).toMatchObject({ startedAt: 100, status: "pending" });
		now = 150;
		current.emit({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial },
		});
		now = 200;
		current.emit({ type: "message_end", message: partial });
		now = 300;
		current.emit({ type: "message_start", message: partial });
		now = 350;
		current.emit({ type: "message_end", message: assistant([], "error", 0, 0) });
	};
	const runtime = new PiAgentRuntime({ createSession: async () => session, clock: () => now });
	const result = await runtime.executeTurn({
		operation: operation([{ type: "text", text: "inspect" }]),
		snapshot,
		signal: new AbortController().signal,
		onProgress: () => {},
		onRequestUsage: (request) => observations.push(request),
	});
	expect(result.requests?.[0]).toMatchObject({
		startedAt: 100,
		firstContentAt: 150,
		finishedAt: 200,
		status: "complete",
	});
	expect(result.requests?.[1]).toMatchObject({ startedAt: 300, finishedAt: 350, status: "error" });
	expect(result.requests?.[1]).not.toHaveProperty("firstContentAt");
});

it("reports each completed model request while the tool loop is still running", async () => {
	const session = new FakePiSession();
	const observed: UsageRequestSummary[] = [];
	session.emitScript = async (current) => {
		const message = assistant([{ type: "text", text: "inspecting" }], "toolUse", 100, 10);
		message.usage.cacheRead = 900;
		message.usage.totalTokens = 1010;
		current.emit({ type: "message_end", message });
		expect(observed).toHaveLength(1);
		expect(observed[0]?.usage).toMatchObject({ inputTokens: 100, cacheReadTokens: 900, totalTokens: 1010 });
		current.emit({ type: "message_end", message: assistant([{ type: "text", text: "done" }], "stop", 50, 5) });
		expect(observed).toHaveLength(2);
	};
	const runtime = new PiAgentRuntime({ createSession: async () => session });
	const result = await runtime.executeTurn({
		operation: operation([{ type: "text", text: "inspect" }]),
		snapshot,
		signal: new AbortController().signal,
		onProgress: () => {},
		onRequestUsage: (request) => observed.push(request),
	});
	expect(result.requests).toEqual(observed);
	expect(new Set(observed.map((request) => request.requestId)).size).toBe(2);
});

it("records verified mid-turn skill loads without mutating operation selections", async () => {
	const session = new FakePiSession();
	session.emitScript = async (current) => {
		for (const [index, scenario] of [
			{ toolName: "skill_load", id: "debug", instructions: true, isError: false },
			{ toolName: "skill_load", id: "debug", instructions: true, isError: false },
			{ toolName: "skill_load", id: "failed", instructions: true, isError: true },
			{ toolName: "skill_load", id: "resource", instructions: false, isError: false },
			{ toolName: "mcp__untrusted__load", id: "spoofed", instructions: true, isError: false },
		].entries()) {
			const toolCallId = `load-${index}`;
			current.emit({
				type: "tool_execution_start",
				toolCallId,
				toolName: scenario.toolName,
				args: { skillId: scenario.id },
			});
			current.emit({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId,
					toolName: scenario.toolName,
					timestamp: index,
					isError: scenario.isError,
					content: [{ type: "text", text: "skill result" }],
					details: {
						wumingSkill: {
							id: scenario.id,
							mode: "implicit",
							instructions: scenario.instructions,
							digest: "a".repeat(64),
						},
					},
				},
			});
		}
	};
	const op = operation([{ type: "text", text: "Investigate the crash" }]);
	const runtime = new PiAgentRuntime({ createSession: async () => session });
	const result = await runtime.executeTurn({
		operation: op,
		snapshot,
		signal: new AbortController().signal,
		onProgress: () => {},
	});
	expect(result.skills).toEqual(["debug"]);
	expect(op.payload.skills).toBeUndefined();
	expect(result.items.filter((item) => item.type === "tool")).toHaveLength(5);
});

it("surfaces native provider retries as visible progress", async () => {
	const session = new FakePiSession();
	session.emitScript = async (current) => {
		current.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 2000,
			errorMessage: "429 rate limit exceeded",
		});
	};
	const runtime = new PiAgentRuntime({ createSession: async () => session });
	const progress: string[] = [];
	const retries: Array<{ attempt: number; maxAttempts: number; delayMs: number; error: string }> = [];
	await runtime.executeTurn({
		operation: operation([{ type: "text", text: "retry" }]),
		snapshot,
		signal: new AbortController().signal,
		onProgress: (event) => {
			progress.push(event.type);
			if (event.type === "run.retrying")
				expect(event).toMatchObject({
					attempt: 1,
					nextAttempt: 2,
					maxAttempts: 4,
					delayMs: 2000,
					failureKind: "provider_rate_limit",
				});
		},
		onRetry: (event) => retries.push(event),
	});
	expect(progress).toContain("run.retrying");
	expect(retries).toEqual([{ attempt: 1, maxAttempts: 3, delayMs: 2000, error: "429 rate limit exceeded" }]);
});

it.each(["threshold", "overflow"] as const)(
	"publishes %s compaction lifecycle including failed and cancelled attempts",
	async (reason) => {
		const session = new FakePiSession();
		const statuses: string[] = [];
		session.emitScript = async (current) => {
			for (const outcome of ["complete", "failed", "cancelled", "empty"] as const) {
				current.emit({ type: "compaction_start", reason });
				current.emit({
					type: "compaction_end",
					reason,
					aborted: outcome === "cancelled",
					willRetry: false,
					result:
						outcome === "complete" || outcome === "empty"
							? { summary: outcome === "empty" ? " " : "Keep decisions", firstKeptEntryId: "kept", tokensBefore: 9000 }
							: undefined,
				});
			}
		};
		await new PiAgentRuntime({ createSession: async () => session }).executeTurn({
			operation: operation([{ type: "text", text: "continue" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: (event) => {
				if (event.type === "context.compaction") statuses.push(event.status);
			},
		});
		expect(statuses).toEqual(["running", "complete", "running", "failed", "running", "cancelled", "running", "failed"]);
	}
);

it("captures native automatic compaction summaries and accounts for their model usage", async () => {
	const session = new FakePiSession();
	session.emitScript = async (current) => {
		current.emit({
			type: "compaction_end",
			reason: "threshold",
			result: {
				summary: "Keep the verified implementation decisions.",
				firstKeptEntryId: "pi-entry-8",
				tokensBefore: 9000,
				estimatedTokensAfter: 2100,
				usage: piUsage(20, 5),
			},
			aborted: false,
			willRetry: false,
		});
	};
	const runtime = new PiAgentRuntime({
		createSession: async () => session,
		idFactory: () => "compaction-request-1",
	});
	const result = await runtime.executeTurn({
		operation: operation([{ type: "text", text: "continue" }]),
		snapshot,
		signal: new AbortController().signal,
		onProgress: () => {},
	});
	expect(result.compactions).toEqual([
		{
			reason: "threshold",
			summary: "Keep the verified implementation decisions.",
			tokensBefore: 9000,
			estimatedTokensAfter: 2100,
			usage: {
				inputTokens: 20,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 25,
				costUsd: 0.03,
			},
		},
	]);
	expect(result.usage).toMatchObject({ totalTokens: 25, costUsd: 0.03 });
	expect(result.requests).toEqual([
		{
			requestId: "compaction-request-1",
			purpose: "compaction",
			dataSource: "provider",
			model: snapshot.model,
			usage: expect.objectContaining({ totalTokens: 25 }),
		},
	]);
});

it.each([2100, undefined])(
	"publishes compacted occupancy %s separately from summarization usage",
	async (estimatedTokensAfter) => {
		const session = new FakePiSession();
		const observations: ContextUsageState[] = [];
		session.emitScript = async (current) => {
			current.emit({ type: "message_end", message: assistant([], "toolUse", 9000, 100) });
			current.emit({
				type: "compaction_end",
				reason: "threshold",
				aborted: false,
				willRetry: false,
				result: {
					summary: "Keep the decision",
					firstKeptEntryId: "kept",
					tokensBefore: 9100,
					...(estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter }),
					usage: piUsage(8000, 1000),
				},
			});
			// API failures with zero usage must not erase the post-compaction estimate.
			current.emit({ type: "message_end", message: assistant([], "error", 0, 0) });
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session });
		await runtime.executeTurn({
			operation: operation([{ type: "text", text: "continue" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
			onContextUsage: (value) => observations.push(value),
		});
		expect(observations).toEqual([
			{ model: snapshot.model, tokens: 9100, basis: "request" },
			{ model: snapshot.model, tokens: estimatedTokensAfter ?? null, basis: "compaction" },
		]);
	}
);

it("does not publish a failed compaction as a successful reset", async () => {
	const session = new FakePiSession();
	const observations: ContextUsageState[] = [];
	session.emitScript = async (current) => {
		current.emit({ type: "message_end", message: assistant([], "toolUse", 9000, 100) });
		current.emit({
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			willRetry: false,
			result: undefined,
			errorMessage: "Failed",
		});
		current.emit({ type: "message_end", message: assistant([], "stop", 80, 20) });
	};
	await new PiAgentRuntime({ createSession: async () => session }).executeTurn({
		operation: operation([{ type: "text", text: "continue" }]),
		snapshot,
		signal: new AbortController().signal,
		onProgress: () => {},
		onContextUsage: (value) => observations.push(value),
	});
	expect(observations.map((value) => [value.basis, value.tokens])).toEqual([
		["request", 9100],
		["request", 100],
	]);
});

function operation(content: DurableOperation["payload"]["content"], skills?: string[]): DurableOperation {
	return {
		id: "operation-1",
		sessionId: snapshot.session.id,
		type: "turn",
		status: "running",
		payload: {
			type: "turn",
			mode: "prompt",
			userItemId: "user-1",
			content,
			...(skills ? { skills } : {}),
		},
		attempt: 1,
		createdAt: 1,
		updatedAt: 1,
		abortRequested: false,
	};
}

describe("PiAgentRuntime", () => {
	it("recovers a connection failure after desktop tools through the real event store", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const session = new FakePiSession();
		let launches = 0;
		session.emitScript = async (current) => {
			if (current.prompts.length > 1) {
				expect(current.prompts.at(-1)?.text).toContain("Resume the same unfinished task");
				expect(current.prompts.at(-1)?.text).toContain('"toolCallId":"launch"');
				expect(current.prompts.at(-1)?.text).toContain("Inspect current app/window state");
				const done = assistant([{ type: "text", text: "continued" }], "stop", 5, 2);
				current.emit({ type: "message_start", message: done });
				current.emit({ type: "message_end", message: done });
				return;
			}
			const call = assistant(
				[{ type: "toolCall", id: "launch", name: "computer_open", arguments: { app_ref: "ref" } }],
				"toolUse",
				5,
				2
			);
			current.emit({ type: "message_start", message: call });
			current.emit({ type: "message_end", message: call });
			current.emit({
				type: "tool_execution_start",
				toolCallId: "launch",
				toolName: "computer_open",
				args: { app_ref: "ref" },
			});
			launches++;
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "launch",
				toolName: "computer_open",
				content: [{ type: "text", text: '{"performed":true,"outcome":"launch_requested"}' }],
				isError: false,
				timestamp: 11,
			};
			current.emit({
				type: "tool_execution_end",
				toolCallId: "launch",
				toolName: "computer_open",
				result,
				isError: false,
			});
			current.emit({ type: "message_end", message: result });
			const failure = { ...assistant([], "error", 0, 0), errorMessage: "Connection error." };
			current.emit({ type: "message_start", message: failure });
			current.emit({ type: "message_end", message: failure });
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session });
		try {
			const orchestrator = new SessionOrchestrator(store, runtime, { maxRetries: 1, retryBaseDelayMs: 0 });
			const created = await orchestrator.createSession({
				principalId: "test",
				idempotencyKey: "create",
				workspaceId: "test",
				model: snapshot.model,
				thinkingLevel: "off",
				sandboxMode: "unrestricted",
				approvalPolicy: "never",
			});
			const sessionId = created.snapshot.session.id;
			await orchestrator.acceptTurn({
				principalId: "test",
				idempotencyKey: "turn",
				sessionId,
				mode: "prompt",
				content: [{ type: "text", text: "Open the app and inspect it" }],
			});
			await orchestrator.drainSession(sessionId);
			expect(store.listOperations(sessionId)[0]).toMatchObject({ status: "completed", attempt: 2 });
			expect(launches).toBe(1);
			expect(session.prompts).toHaveLength(2);
			const saved = store.loadSnapshot(sessionId)!;
			expect(saved.transcript.filter((item) => item.type === "tool")).toHaveLength(1);
			expect(saved.usageByTurn?.[0]?.requests).toHaveLength(3);
			expect(saved.usageByTurn?.[0]?.requests.every((request) => request.finishedAt !== undefined)).toBe(true);
			expect(saved.usage.totalTokens).toBe(14);
			expect(saved.usageByTurn?.[0]?.tools[0]?.callCount).toBe(1);
		} finally {
			await runtime[Symbol.asyncDispose]();
			store.close();
		}
	});

	it("rebuilds changed MCP tools in the same conversation at the next idle boundary", async () => {
		let key = "before";
		const sessions: FakePiSession[] = [];
		const runtime = new PiAgentRuntime({
			resolveSessionConfigurationKey: async () => key,
			createSession: async (value) => {
				expect(value.session.id).toBe(snapshot.session.id);
				const session = new FakePiSession();
				sessions.push(session);
				return session;
			},
		});
		const input = {
			operation: operation([{ type: "text" as const, text: "test" }]),
			snapshot,
			signal: new AbortController().signal,
		};
		await runtime.resolveCapabilities!(input);
		await runtime.resolveCapabilities!(input);
		expect(sessions).toHaveLength(1);
		key = "configured";
		sessions[0]!.isStreaming = true;
		await runtime.resolveCapabilities!(input);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.disposed).toBe(false);
		sessions[0]!.isStreaming = false;
		await runtime.resolveCapabilities!(input);
		expect(sessions).toHaveLength(2);
		expect(sessions[0]!.disposed).toBe(true);
		await runtime.resolveContext!(input);
		expect(sessions).toHaveLength(2);
		await runtime[Symbol.asyncDispose]();
	});
	for (const phase of ["capabilities", "context", "execute", "inject"] as const) {
		for (const fault of ["truncated", "missing", "duplicate", "unexpected", "unconfigured"] as const) {
			it("rejects " + fault + " selected skills during " + phase + " before prompting", async () => {
				const session = new FakePiSession();
				if (phase === "inject") session.isStreaming = true;
				const skill = {
					id: "review-code",
					name: "Review",
					content: "Full instructions",
					truncated: fault === "truncated",
				};
				const runtime = new PiAgentRuntime({
					createSession: async () => session,
					...(fault === "unconfigured"
						? {}
						: {
								resolveSkills: async () =>
									fault === "missing"
										? []
										: fault === "duplicate"
											? [skill, skill]
											: fault === "unexpected"
												? [{ ...skill, id: "unselected" }]
												: [skill],
							}),
				});
				const turn = operation([{ type: "text", text: "review" }], ["review-code"]);
				if (phase === "inject") turn.payload.mode = "steer";
				const input = {
					operation: turn,
					snapshot,
					signal: new AbortController().signal,
					onProgress: () => {},
				};
				const attempt =
					phase === "capabilities"
						? runtime.resolveCapabilities(input)
						: phase === "context"
							? runtime.resolveContext(input)
							: phase === "execute"
								? runtime.executeTurn(input)
								: runtime.injectTurn(input);
				await expect(attempt).rejects.toThrow(/skill/i);
				expect(session.prompts).toEqual([]);
				expect(session.systemPrompt).toBe("base system prompt");
			});
		}
	}

	it("resolves actual Pi tools and selected skills into a verifiable capability plan", async () => {
		const session = new FakePiSession();
		session.capabilityManifests = [
			{
				id: "tool:read_file",
				version: "tool-v1",
				kind: "tool",
				provider: "wuming",
				scope: "session",
				tool: { name: "read_file", executionMode: "parallel", exposure: "direct" },
			},
		];
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveSkills: async (_snapshot, ids) =>
				ids.map((id) => ({ id, name: "Review", content: "Check the diff carefully." })),
		});
		const plan = await runtime.resolveCapabilities({
			operation: operation([{ type: "text", text: "review" }], ["review-code"]),
			snapshot,
			signal: new AbortController().signal,
		});
		expect(plan.capabilities.map((capability) => capability.id)).toEqual(["skill:review-code", "tool:read_file"]);
		expect(plan.modelVisible.tools).toEqual(["read_file"]);
		expect(plan.modelVisible.promptFragments[0]).toMatch(/^skill:review-code@sha256:/);
		expect(verifyCapabilityPlan(plan)).toBe(true);
	});

	it("includes deployment-provided hook manifests in resolution and drift checks", async () => {
		const session = new FakePiSession();
		let version = "1";
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveCapabilityManifests: async (_snapshot, turn) => [
				{
					id: "hook:deployment-policy",
					version,
					kind: "hook",
					provider: "deployment",
					scope: "system",
					description: `Policy for ${turn.id}`,
					hook: { points: ["operation.before_execute"], mode: "enforce", timeoutMs: 100 },
				},
			],
		});
		const turn = operation([{ type: "text", text: "run" }]);
		const signal = new AbortController().signal;
		const plan = await runtime.resolveCapabilities({ operation: turn, snapshot, signal });
		expect(plan.capabilities).toEqual([expect.objectContaining({ id: "hook:deployment-policy", version: "1" })]);
		version = "2";
		await expect(
			runtime.executeTurn({
				operation: turn,
				snapshot,
				signal,
				capabilityPlan: plan,
				onProgress: () => {},
			})
		).rejects.toThrow("Capability plan drifted");
		expect(session.prompts).toEqual([]);
	});

	it("rejects capability drift before sending a model request", async () => {
		const session = new FakePiSession();
		let skillContent = "First version";
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveSkills: async (_snapshot, ids) => ids.map((id) => ({ id, name: "Review", content: skillContent })),
		});
		const turn = operation([{ type: "text", text: "review" }], ["review-code"]);
		const signal = new AbortController().signal;
		const plan = await runtime.resolveCapabilities({ operation: turn, snapshot, signal });
		skillContent = "Changed version";
		await expect(
			runtime.executeTurn({
				operation: turn,
				snapshot,
				signal,
				capabilityPlan: plan,
				onProgress: () => {},
			})
		).rejects.toThrow("Capability plan drifted");
		expect(session.prompts).toEqual([]);
	});

	it("resolves a verifiable context plan without persisting source bodies", async () => {
		const session = new FakePiSession();
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveSkills: async (_snapshot, ids) =>
				ids.map((id) => ({ id, name: "Review", content: "Check the diff carefully." })),
			resolveContextFragments: () => [
				{
					id: "workspace:README.md",
					version: "readme-v1",
					kind: "workspace",
					source: "workspace:README.md",
					content: "Authentication token refresh implementation.",
					cacheScope: "turn",
				},
			],
		});
		const plan = await runtime.resolveContext!({
			operation: operation([{ type: "text", text: "review authentication" }], ["review-code"]),
			snapshot,
			signal: new AbortController().signal,
		});
		expect(verifyContextPlan(plan)).toBe(true);
		expect(plan.fragments.map((fragment) => fragment.id)).toEqual([
			"system:base",
			"skill:review-code",
			"workspace:README.md",
		]);
		expect(JSON.stringify(plan)).not.toContain("Authentication token refresh implementation.");
	});

	it("reconciles history before context budgeting and does not reinsert it after compaction", async () => {
		const session = new FakePiSession();
		let recovered = false;
		let preparations = 0;
		const turn = operation([{ type: "text", text: "continue" }]);
		const previous = { ...turn, id: "previous", status: "interrupted" as const };
		Object.assign(session, {
			prepareForPrompt: async (input: import("../src/types.js").PiSessionRecovery) => {
				preparations++;
				expect(input.operations.map((item) => item.id)).toEqual(["previous"]);
				if (recovered) return;
				recovered = true;
				session.contextUsage = { tokens: 995, contextWindow: 1000, percent: 99.5 };
			},
		});
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveRecoveryOperations: () => [previous, turn],
			resolveContextBudget: () => ({ contextWindowTokens: 1000, reservedOutputTokens: 50, maxSystemTokens: 250 }),
		});
		try {
			const signal = new AbortController().signal;
			const contextPlan = await runtime.resolveContext({ snapshot, operation: turn, signal });
			expect(session.compactCalls).toBe(1);
			expect(contextPlan.budget.observedContextTokens).toBe(200);
			await runtime.executeTurn({ snapshot, operation: turn, signal, contextPlan, onProgress: () => {} });
			expect(preparations).toBe(2);
			expect(session.compactCalls).toBe(1);
			expect(session.prompts).toHaveLength(1);
		} finally {
			await runtime[Symbol.asyncDispose]();
		}
	});

	it("does not reconcile historical messages while a tool approval is being resumed", async () => {
		const session = new FakePiSession();
		let recoveryReads = 0;
		Object.assign(session, {
			prepareForPrompt: async () => {
				throw new Error("Approval leaf must not change");
			},
		});
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveRecoveryOperations: () => {
				recoveryReads++;
				return [];
			},
		});
		try {
			await runtime.resolveContext({
				snapshot,
				operation: { ...operation([{ type: "text", text: "approved" }]), approvalToolCallId: "pending" },
				signal: new AbortController().signal,
			});
			expect(recoveryReads).toBe(0);
		} finally {
			await runtime[Symbol.asyncDispose]();
		}
	});

	it("rejects context drift before sending a model request", async () => {
		const session = new FakePiSession();
		let workspaceContext = "First version";
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveContextFragments: () => [
				{
					id: "workspace:README.md",
					version: workspaceContext,
					kind: "workspace",
					source: "workspace:README.md",
					content: workspaceContext,
				},
			],
		});
		const turn = operation([{ type: "text", text: "read context" }]);
		const signal = new AbortController().signal;
		const plan = await runtime.resolveContext!({ operation: turn, snapshot, signal });
		workspaceContext = "Changed version";
		await expect(
			runtime.executeTurn({
				operation: turn,
				snapshot,
				signal,
				contextPlan: plan,
				onProgress: () => {},
			})
		).rejects.toThrow("Context plan drifted");
		expect(session.prompts).toEqual([]);
	});

	it.each([undefined, "parent-session"])(
		"compacts before assembling when context fills (parent=%s)",
		async (parentSessionId) => {
			const compactSnapshot = {
				...snapshot,
				session: { ...snapshot.session, ...(parentSessionId ? { parentSessionId } : {}) },
			};
			const session = new FakePiSession();
			const statuses: string[] = [];
			session.contextUsage = { tokens: 995, contextWindow: 1000, percent: 99.5 };
			const runtime = new PiAgentRuntime({
				createSession: async () => session,
				resolveContextBudget: () => ({
					contextWindowTokens: 1000,
					reservedOutputTokens: 50,
					maxSystemTokens: 250,
				}),
			});
			const plan = await runtime.resolveContext!({
				operation: operation([{ type: "text", text: "continue" }]),
				snapshot: compactSnapshot,
				signal: new AbortController().signal,
				onProgress: (event) => {
					if (event.type === "context.compaction") statuses.push(event.status);
				},
			});
			expect(statuses).toEqual(["running", "complete"]);
			expect(session.compactCalls).toBe(1);
			expect(plan.budget.observedContextTokens).toBe(200);
			const observations: ContextUsageState[] = [];
			const result = await runtime.executeTurn({
				operation: operation([{ type: "text", text: "continue" }]),
				snapshot: compactSnapshot,
				signal: new AbortController().signal,
				contextPlan: plan,
				onProgress: () => {},
				onContextUsage: (value) => observations.push(value),
			});
			expect(observations).toEqual([{ model: snapshot.model, tokens: 200, basis: "compaction" }]);
			expect(result.compactions).toEqual([expect.objectContaining({ reason: "threshold", summary: "compacted" })]);
		}
	);

	it("maps Pi streaming, assistant, and tool events into Wuming contracts", async () => {
		const session = new FakePiSession();
		const checkpoints: TranscriptItem[] = [];
		const outputArtifact = {
			id: "artifact-1",
			name: "read-output.txt",
			mimeType: "text/plain",
			size: 9,
		};
		session.emitScript = async (current) => {
			const partial = assistant([], "pending", 0, 0);
			current.emit({ type: "message_start", message: partial });
			partial.content = [{ type: "thinking", thinking: "plan" }];
			current.emit({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan", partial },
			});
			partial.content.push({ type: "text", text: "run" });
			current.emit({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "run", partial },
			});
			partial.content.push({ type: "toolCall", id: "", name: "", arguments: {} });
			current.emit({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{", partial },
			});
			expect(checkpoints.at(-1)!.content).toEqual([
				{ type: "thinking", text: "plan" },
				{ type: "text", text: "run" },
			]);
			current.emit({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "a.ts" },
			});
			current.emit({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "a.ts" },
				partialResult: {
					content: [{ type: "text", text: "file data" }],
					details: { artifact: outputArtifact },
				},
			});
			current.emit({
				type: "message_end",
				message: assistant(
					[
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "run" },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
					],
					"toolUse",
					4,
					2
				),
			});
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file data" }],
				details: { artifact: outputArtifact },
				isError: false,
				timestamp: 11,
			};
			current.emit({ type: "message_end", message: toolResult });
			expect(checkpoints).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "assistant",
						status: "streaming",
						content: [
							{ type: "thinking", text: "plan" },
							{ type: "text", text: "run" },
						],
					}),
					expect.objectContaining({ type: "tool", status: "running", toolName: "read", input: { path: "a.ts" } }),
					expect.objectContaining({
						type: "tool",
						status: "complete",
						content: expect.arrayContaining([{ type: "artifact", artifact: outputArtifact }]),
					}),
				])
			);
			const final = assistant([{ type: "text", text: "finished" }], "stop", 5, 1);
			current.emit({ type: "message_start", message: final });
			current.emit({ type: "message_end", message: final });
		};

		let nextId = 0;
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			idFactory: () => `item-${++nextId}`,
		});
		const progress: string[] = [];
		const progressArtifacts: unknown[] = [];
		const finishedTools: unknown[] = [];
		const result = await runtime.executeTurn({
			operation: operation([{ type: "text", text: "inspect" }]),
			snapshot,
			signal: new AbortController().signal,
			onTranscriptItem: (item) => checkpoints.push(structuredClone(item)),
			onProgress: (event) => {
				progress.push(`${event.type}:${"streamSeq" in event ? event.streamSeq : "-"}`);
				if (event.type === "tool.progress") progressArtifacts.push(event.artifact);
				if (event.type === "tool.finished") finishedTools.push(event);
			},
		});

		expect(progress).toEqual([
			"assistant.delta:0",
			"assistant.delta:1",
			"assistant.delta:2",
			"tool.started:-",
			"tool.progress:0",
			"tool.finished:-",
		]);
		expect(result.items.map((item) => item.type)).toEqual(["assistant", "tool", "assistant"]);
		expect(result.items[0]).toMatchObject({
			content: expect.arrayContaining([
				expect.objectContaining({ type: "tool_call", toolCallId: "call-1", toolName: "read" }),
			]),
		});
		expect(result.items[1]).toMatchObject({ input: { path: "a.ts" }, status: "complete" });
		expect(result.items[1]).toMatchObject({
			content: expect.arrayContaining([{ type: "artifact", artifact: outputArtifact }]),
		});
		expect(progressArtifacts).toEqual([outputArtifact]);
		expect(finishedTools).toEqual([
			expect.objectContaining({
				toolCallId: "call-1",
				preview: "file data",
				isError: false,
				artifact: outputArtifact,
			}),
		]);
		expect(result.usage).toMatchObject({
			inputTokens: 9,
			outputTokens: 3,
			totalTokens: 12,
			costUsd: 0.06,
		});
		expect(session.prompts[0]).toMatchObject({
			text: "inspect",
			options: { expandPromptTemplates: false, source: "rpc" },
		});
	});

	it.each([
		{ toolName: "browser_snapshot", level: "page_content", isError: false, expected: true },
		{ toolName: "web_search", level: "candidate_links", isError: false, expected: true },
		{ toolName: "browser_open", level: "access_blocked", isError: false, expected: true },
		{ toolName: "browser_open", level: "verified", isError: false, expected: false },
		{ toolName: "read_file", level: "page_content", isError: false, expected: false },
		{ toolName: "browser_open", level: "page_content", isError: true, expected: false },
	])(
		"propagates only validated web evidence: $toolName / $level / error=$isError",
		async ({ toolName, level, isError, expected }) => {
			const session = new FakePiSession();
			const webEvidence = { level, note: "Retrieved, not verified." };
			session.emitScript = async (current) => {
				current.emit({ type: "tool_execution_start", toolCallId: "evidence-call", toolName, args: {} });
				current.emit({
					type: "message_end",
					message: {
						role: "toolResult",
						toolCallId: "evidence-call",
						toolName,
						content: [{ type: "text", text: "page" }],
						details: { webEvidence },
						isError,
						timestamp: 11,
					},
				});
				current.emit({ type: "message_end", message: assistant([{ type: "text", text: "finished" }], "stop", 5, 1) });
			};
			const finished: unknown[] = [];
			const runtime = new PiAgentRuntime({ createSession: async () => session });
			const result = await runtime.executeTurn({
				operation: operation([{ type: "text", text: "inspect" }]),
				snapshot,
				signal: new AbortController().signal,
				onProgress: (event) => {
					if (event.type === "tool.finished") finished.push(event.webEvidence);
				},
			});
			const item = result.items.find((entry) => entry.type === "tool");
			expect(item?.type === "tool" ? item.webEvidence : undefined).toEqual(expected ? webEvidence : undefined);
			expect(finished).toEqual([expected ? webEvidence : undefined]);
		}
	);

	it("explains malformed browser calls instead of exposing a generic stream error", async () => {
		const session = new FakePiSession();
		session.emitScript = async (current) => {
			current.emit({
				type: "message_end",
				message: assistant(
					[{ type: "toolCall", id: "browser-call", name: "browser_open", arguments: {} }],
					"error",
					1,
					1
				),
			});
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session });

		const result = await runtime.executeTurn({
			operation: operation([{ type: "text", text: "查今天的 GitHub 热榜" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});

		expect(result.items[0]).toMatchObject({
			type: "assistant",
			status: "error",
			error: expect.stringContaining("browser_open 需要 url 参数"),
		});
		expect(result.failure).toMatchObject({
			kind: "provider",
			message: expect.stringContaining("browser_open 需要 url 参数"),
		});
	});

	it("attributes MCP server, tool, duration, and outcome to tool usage", async () => {
		const session = new FakePiSession();
		let now = 100;
		session.emitScript = async (current) => {
			current.emit({
				type: "tool_execution_start",
				toolCallId: "mcp-call-1",
				toolName: "mcp__docs__search",
				args: { query: "api" },
			});
			now = 145;
			const result = {
				content: [{ type: "text" as const, text: "match" }],
				details: {
					mcpServerId: "docs",
					mcpToolName: "search",
					durationMs: 45,
					mcpStatus: "complete",
				},
			};
			current.emit({
				type: "tool_execution_end",
				toolCallId: "mcp-call-1",
				toolName: "mcp__docs__search",
				result,
				isError: false,
			});
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "mcp-call-1",
				toolName: "mcp__docs__search",
				...result,
				isError: false,
				timestamp: 145,
			};
			current.emit({ type: "message_end", message: toolResult });
			const final = assistant([{ type: "text", text: "done" }], "stop", 1, 1);
			current.emit({ type: "message_start", message: final });
			current.emit({ type: "message_end", message: final });
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session, clock: () => now });

		const result = await runtime.executeTurn({
			operation: operation([{ type: "text", text: "search docs" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});

		expect(result.tools).toEqual([
			expect.objectContaining({
				toolName: "mcp__docs__search",
				callCount: 1,
				durationMs: 45,
				succeededCount: 1,
				failedCount: 0,
				abortedCount: 0,
				mcpServerId: "docs",
				mcpToolName: "search",
			}),
		]);
	});

	it("injects resolved skills through the bounded context bundle and restores the system prompt", async () => {
		const session = new FakePiSession();
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveSkills: async (_snapshot, ids) =>
				ids.map((id) => ({ id, name: "Review", content: "Check the diff carefully." })),
		});
		session.emitScript = async (current) => {
			expect(current.systemPrompt).toContain("## Active context bundle");
			expect(current.systemPrompt).toContain('"id":"skill:review-code"');
			expect(current.systemPrompt).toContain("Check the diff carefully.");
			const final = assistant([{ type: "text", text: "done" }], "stop", 1, 1);
			current.emit({ type: "message_start", message: final });
			current.emit({ type: "message_end", message: final });
		};
		const result = await runtime.executeTurn({
			operation: operation([{ type: "text", text: "review" }], ["review-code"]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		expect(result.skills).toEqual(["review-code"]);
		expect(session.systemPrompt).toBe("base system prompt");
	});

	it("refreshes appended reference data after compaction and deletion without changing policy", async () => {
		const session = new FakePiSession();
		let content: string | undefined = "original README";
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			appendReferenceContext: true,
			resolveContextBudget: () => ({ contextWindowTokens: 10000, maxSystemTokens: 2000 }),
			resolveContextFragments: () => [
				{
					id: "policy:agents",
					source: "workspace:AGENTS.md",
					version: "1",
					content: "current rules",
					kind: "policy",
					required: true,
				},
				...(content === undefined
					? []
					: [
							{
								id: "workspace:readme",
								source: "workspace:README.md",
								version: content,
								content,
								kind: "workspace" as const,
								delivery: "user" as const,
							},
						]),
			],
		});
		const systems: string[] = [];
		session.emitScript = async (current) => {
			systems.push(current.systemPrompt);
		};
		const input = {
			operation: operation([{ type: "text", text: "latest request" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		};
		const planned = await runtime.resolveContext(input);
		await runtime.executeTurn({ ...input, contextPlan: planned });
		content = "updated README";
		await session.compact();
		await runtime.executeTurn(input);
		content = undefined;
		await runtime.executeTurn(input);
		expect(session.prompts[0]?.text).toContain("original README");
		expect(session.prompts[1]?.text).toContain("updated README");
		expect(session.prompts[1]?.text).not.toContain("original README");
		expect(session.prompts[2]?.text).toContain("\n[]\n");
		for (const prompt of session.prompts) expect(prompt.text.endsWith("latest request")).toBe(true);
		expect(new Set(systems).size).toBe(1);
		expect(systems[0]).toContain("current rules");
		expect(systems[0]).not.toContain("README");
	});

	it("retains fresh reference data on approval resume without injecting a second user request", async () => {
		const session = new FakePiSession();
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			appendReferenceContext: true,
			resolveContextFragments: () => [
				{
					id: "workspace:readme",
					source: "workspace:README.md",
					version: "1",
					content: "current reference",
					kind: "workspace",
					delivery: "user",
				},
			],
		});
		const originalResume = session.resumeScript;
		session.resumeScript = async (...args) => {
			expect(session.systemPrompt).toContain("current reference");
			return originalResume(...args);
		};
		const input = {
			operation: {
				...operation([{ type: "text", text: "continue" }]),
				approvalId: "approval",
				approvalToolCallId: "approved",
			},
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		};
		const contextPlan = await runtime.resolveContext(input);
		await runtime.executeTurn({ ...input, contextPlan });
		expect(session.prompts).toHaveLength(0);
		expect(contextPlan.estimatedReferenceTokens).toBeUndefined();
	});

	it("resumes the exact approved tool call without prompting the provider again", async () => {
		const session = new FakePiSession();
		session.resumeScript = async (current, toolCallId, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "writing" }], details: { running: true } });
			const final = assistant([{ type: "text", text: "recovered after write" }], "stop", 3, 2);
			current.emit({ type: "message_start", message: final });
			current.emit({ type: "message_end", message: final });
			return {
				message: {
					role: "toolResult",
					toolCallId,
					toolName: "write",
					content: [{ type: "text", text: "Wrote value.txt" }],
					isError: false,
					timestamp: 11,
				},
				input: { path: "value.txt", content: "value" },
			};
		};
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			idFactory: () => "assistant-recovered",
		});
		const resumedOperation = {
			...operation([{ type: "text", text: "write value" }]),
			approvalId: "approval-1",
			approvalToolCallId: "call-write-1",
			attempt: 2,
		};
		const progress: string[] = [];
		const result = await runtime.executeTurn({
			operation: resumedOperation,
			snapshot: {
				...snapshot,
				transcript: [
					{
						id: "tool:call-write-1",
						type: "tool",
						toolCallId: "call-write-1",
						toolName: "write",
						createdAt: 1,
						status: "awaiting_approval",
						input: { path: "value.txt", content: "value" },
						content: [],
						isError: false,
					},
				],
			},
			signal: new AbortController().signal,
			onTranscriptItem: (item) =>
				progress.push("checkpoint:" + item.type + ":" + (item.type === "user" ? "user" : item.status)),
			onProgress: (event) => progress.push(event.type),
		});
		expect(session.prompts).toEqual([]);
		expect(progress).toContain("tool.progress");
		expect(progress).toContain("checkpoint:tool:running");
		expect(progress).toContain("checkpoint:tool:complete");
		expect(result.items).toEqual([
			expect.objectContaining({
				type: "tool",
				toolCallId: "call-write-1",
				input: { path: "value.txt", content: "value" },
				status: "complete",
			}),
			expect.objectContaining({ type: "assistant", status: "complete" }),
		]);
		expect(result.usage).toMatchObject({ totalTokens: 5, costUsd: 0.03 });
	});

	it("resolves image artifacts server-side and reuses the Pi session", async () => {
		const session = new FakePiSession();
		let factoryCalls = 0;
		const runtime = new PiAgentRuntime({
			createSession: async () => {
				factoryCalls += 1;
				return session;
			},
			resolveArtifact: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
		});
		const imageOperation = operation([
			{
				type: "artifact",
				artifact: { id: "image-1", name: "screen.png", mimeType: "image/png", size: 5 },
			},
		]);
		const run = () =>
			runtime.executeTurn({
				operation: imageOperation,
				snapshot,
				signal: new AbortController().signal,
				onProgress: () => {},
			});
		await run();
		await run();
		expect(factoryCalls).toBe(1);
		expect(session.prompts[0]?.text).toContain('"artifactId":"image-1"');
		expect(session.prompts[0]?.text).toContain('"name":"screen.png"');
		expect(session.prompts[0]?.text).toContain("generate_image.referenceArtifactId");
		expect(session.prompts[0]?.options?.images).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
	});

	it("recreates the Pi session when its security policy changes", async () => {
		const sessions = [new FakePiSession(), new FakePiSession()];
		let factoryCalls = 0;
		const runtime = new PiAgentRuntime({
			createSession: async () => sessions[factoryCalls++]!,
		});
		const run = (current: SessionSnapshot) =>
			runtime.executeTurn({
				operation: operation([{ type: "text", text: "run" }]),
				snapshot: current,
				signal: new AbortController().signal,
				onProgress: () => {},
			});
		await run(snapshot);
		await run({ ...snapshot, sandboxMode: "unrestricted", approvalPolicy: "never" });
		expect(factoryCalls).toBe(2);
		expect(sessions[0]?.disposed).toBe(true);
		expect(sessions[1]?.prompts).toHaveLength(1);
	});

	it("includes validated UTF-8 artifacts in the model prompt", async () => {
		const session = new FakePiSession();
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveArtifact: async () => ({
				data: Buffer.from("export const value = 42;\n", "utf8").toString("base64"),
				mimeType: "text/plain",
			}),
		});
		await runtime.executeTurn({
			operation: operation([
				{ type: "text", text: "Review this file" },
				{
					type: "artifact",
					artifact: { id: "source-1", name: "value.ts", mimeType: "text/plain", size: 25 },
				},
			]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		expect(session.prompts[0]?.text).toContain("Review this file");
		expect(session.prompts[0]?.text).toContain('<attached_file name="value.ts" mime_type="text/plain">');
		expect(session.prompts[0]?.text).toContain("export const value = 42;");
	});

	it("includes extracted document text in the model prompt", async () => {
		const session = new FakePiSession();
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveArtifact: async () => ({
				data: "UEsDBA==",
				mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				extractedText: "Quarterly result: 42",
			}),
		});
		await runtime.executeTurn({
			operation: operation([
				{ type: "text", text: "Summarize this document" },
				{
					type: "artifact",
					artifact: {
						id: "doc-1",
						name: "report.docx",
						mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
						size: 1024,
					},
				},
			]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		expect(session.prompts[0]?.text).toContain('name="report.docx"');
		expect(session.prompts[0]?.text).toContain('extracted="true"');
		expect(session.prompts[0]?.text).toContain("Quarterly result: 42");
	});

	it("keeps unsupported binary attachments in the prompt without failing the turn", async () => {
		const session = new FakePiSession();
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveArtifact: async () => ({
				data: "AAEC",
				mimeType: "application/octet-stream",
				binary: true,
			}),
		});
		await runtime.executeTurn({
			operation: operation([
				{
					type: "artifact",
					artifact: {
						id: "binary-1",
						name: "archive.bin",
						mimeType: "application/octet-stream",
						size: 3,
					},
				},
			]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		expect(session.prompts[0]?.text).toContain('binary="true"');
		expect(session.prompts[0]?.text).toContain("uploaded successfully");
	});

	it("propagates abort to the active Pi session", async () => {
		const session = new FakePiSession();
		let release!: () => void;
		let signalStarted!: () => void;
		const started = new Promise<void>((resolve) => (signalStarted = resolve));
		session.emitScript = () => {
			signalStarted();
			return new Promise<void>((resolve) => (release = resolve));
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session });
		const controller = new AbortController();
		const pending = runtime.executeTurn({
			operation: operation([{ type: "text", text: "wait" }]),
			snapshot,
			signal: controller.signal,
			onProgress: () => {},
		});
		const assertion = expect(pending).rejects.toThrow("cancelled");
		await started;
		controller.abort(new Error("cancelled"));
		release();
		await assertion;
		expect(session.abortCalls).toBe(1);
	});

	it.each([
		["429 rate limit exceeded", true, "provider_rate_limit"],
		["Upstream HTTP/2 stream failed", true, "provider_network"],
		["ERR_HTTP2_STREAM_ERROR: RST_STREAM", true, "provider_network"],
		["Stream ended without finish_reason", true, "provider_network"],
		["503 Service Unavailable", true, "provider"],
		["Model temporarily unavailable", true, "provider"],
		["No available channel", true, "provider"],
		["429 insufficient_quota", false, "budget"],
		["quota exceeded", false, "budget"],
		["insufficient balance", false, "budget"],
		["404 model_not_found", false, "provider"],
		["Request timed out while reading provider response", true, "provider_timeout"],
		["401 invalid API key", false, "provider_auth"],
		["Request rejected [HTTP 401; request_id=req-test]", false, "provider_auth"],
		["Request rejected [HTTP 429]", true, "provider_rate_limit"],
		["Model response idle timeout after 600000ms without stream events", true, "provider_timeout"],
		["400 invalid request parameter", false, "provider"],
	] as const)("classifies provider failure %s as retryable=%s", async (errorMessage, retryable, kind) => {
		const session = new FakePiSession();
		session.emitScript = async (current) => {
			const failed = { ...assistant([], "error", 2, 0), errorMessage };
			current.emit({ type: "message_start", message: failed });
			current.emit({ type: "message_end", message: failed });
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session });
		const result = await runtime.executeTurn({
			operation: operation([{ type: "text", text: "test provider failure" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		expect(result.failure).toMatchObject({
			code: "runtime_error",
			message: errorMessage,
			retryable,
			kind,
		});
	});

	it.each([false, true])("bounds HTTP/2 recovery to five retries (exhausted=%s)", async (exhausted) => {
		using store = new SqliteOrchestratorStore(":memory:");
		const session = new FakePiSession();
		session.emitScript = async (current) => {
			const failed = exhausted || current.prompts.length < 6;
			const active = store.listOperationsByStatus("running")[0];
			if (active) expect(store.loadSnapshot(active.sessionId)!.session.phase).toBe("turn");
			const response = failed
				? { ...assistant([], "error", 0, 0), errorMessage: "Upstream HTTP/2 stream failed" }
				: assistant([{ type: "text", text: "recovered" }], "stop", 1, 1);
			current.emit({ type: "message_start", message: response });
			current.emit({ type: "message_end", message: response });
		};
		await using runtime = new PiAgentRuntime({ createSession: async () => session });
		const orchestrator = new SessionOrchestrator(store, runtime, { maxRetries: 5, retryBaseDelayMs: 0 });
		const created = await orchestrator.createSession({
			principalId: "test",
			idempotencyKey: "create",
			workspaceId: "test",
			model: snapshot.model,
			thinkingLevel: "off",
			sandboxMode: "unrestricted",
			approvalPolicy: "never",
		});
		const sessionId = created.snapshot.session.id;
		await orchestrator.acceptTurn({
			principalId: "test",
			idempotencyKey: "turn",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "Continue the task" }],
		});
		await orchestrator.drainSession(sessionId);
		const saved = store.listOperations(sessionId)[0]!;
		expect(saved).toMatchObject({ status: exhausted ? "failed" : "completed", attempt: 6 });
		expect(saved.retryHistory).toHaveLength(5);
		expect(session.prompts).toHaveLength(6);
		expect(saved.retryHistory?.map((entry) => entry.attempt)).toEqual([1, 2, 3, 4, 5]);
		expect(store.loadSnapshot(sessionId)!.transcript.filter((item) => item.id.endsWith(":error"))).toHaveLength(
			exhausted ? 1 : 0
		);
	});

	it("classifies thrown provider errors and redacts credentials", async () => {
		const session = new FakePiSession();
		session.emitScript = async () => {
			throw Object.assign(new Error("Unauthorized Bearer sk-secretvalue123456"), { status: 401 });
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session });
		const result = await runtime.executeTurn({
			operation: operation([{ type: "text", text: "test authentication" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		expect(result.failure).toMatchObject({
			code: "runtime_error",
			retryable: false,
			kind: "provider_auth",
		});
		expect(result.failure?.message).not.toContain("secretvalue");
		expect(result.failure?.message).toContain("[REDACTED]");
	});

	it("injects steer and follow-up messages into the active Pi stream", async () => {
		const session = new FakePiSession();
		let release!: () => void;
		let signalStarted!: () => void;
		const started = new Promise<void>((resolve) => (signalStarted = resolve));
		session.emitScript = () => {
			signalStarted();
			return new Promise<void>((resolve) => (release = resolve));
		};
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveSkills: async (_snapshot, ids) =>
				ids.map((id) => ({ id, name: "Review", content: "Stream-safe review guidance." })),
		});
		const active = runtime.executeTurn({
			operation: operation([{ type: "text", text: "start" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		await started;
		const steer = {
			...operation([{ type: "text" as const, text: "change direction" }], ["review-code"]),
			id: "operation-steer",
			payload: {
				type: "turn" as const,
				mode: "steer" as const,
				userItemId: "user-steer",
				content: [{ type: "text" as const, text: "change direction" }],
				skills: ["review-code"],
			},
		};
		const injectSignal = new AbortController().signal;
		const contextPlan = await runtime.resolveContext!({
			operation: steer,
			snapshot,
			signal: injectSignal,
		});
		await runtime.injectTurn({ operation: steer, snapshot, signal: injectSignal, contextPlan });
		await runtime.injectTurn({
			operation: {
				...steer,
				id: "operation-follow-up",
				payload: {
					...steer.payload,
					mode: "follow_up",
					content: [{ type: "text", text: "then summarize" }],
					skills: [],
				},
			},
			snapshot,
			signal: new AbortController().signal,
		});
		expect(session.prompts.slice(1)).toEqual([
			expect.objectContaining({
				text: expect.stringContaining("Stream-safe review guidance."),
				options: expect.objectContaining({ streamingBehavior: "steer" }),
			}),
			expect.objectContaining({
				text: "then summarize",
				options: expect.objectContaining({ streamingBehavior: "followUp" }),
			}),
		]);
		expect(session.systemPrompt).toBe("base system prompt");
		release();
		await active;
	});

	it("rejects capability drift before injecting into an active Pi stream", async () => {
		const session = new FakePiSession();
		let release!: () => void;
		let signalStarted!: () => void;
		let skillContent = "First version";
		const started = new Promise<void>((resolve) => (signalStarted = resolve));
		session.emitScript = () => {
			signalStarted();
			return new Promise<void>((resolve) => (release = resolve));
		};
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveSkills: async (_snapshot, ids) => ids.map((id) => ({ id, name: "Review", content: skillContent })),
		});
		const active = runtime.executeTurn({
			operation: operation([{ type: "text", text: "start" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		await started;
		const steer = {
			...operation([{ type: "text" as const, text: "change direction" }], ["review-code"]),
			id: "operation-steer-drift",
			payload: {
				type: "turn" as const,
				mode: "steer" as const,
				userItemId: "user-steer-drift",
				content: [{ type: "text" as const, text: "change direction" }],
				skills: ["review-code"],
			},
		};
		const signal = new AbortController().signal;
		const plan = await runtime.resolveCapabilities({ operation: steer, snapshot, signal });
		skillContent = "Changed version";
		try {
			await expect(runtime.injectTurn({ operation: steer, snapshot, signal, capabilityPlan: plan })).rejects.toThrow(
				"Capability plan drifted"
			);
			expect(session.prompts).toHaveLength(1);
		} finally {
			release();
			await active;
		}
	});

	it("disposes and evicts a force-terminated Pi session", async () => {
		const first = new FakePiSession();
		const second = new FakePiSession();
		let factoryCalls = 0;
		const runtime = new PiAgentRuntime({
			createSession: async () => {
				factoryCalls += 1;
				return factoryCalls === 1 ? first : second;
			},
		});
		const run = () =>
			runtime.executeTurn({
				operation: operation([{ type: "text", text: "run" }]),
				snapshot,
				signal: new AbortController().signal,
				onProgress: () => {},
			});
		await run();
		await runtime.forceTerminate(snapshot.session.id);
		expect(first.disposed).toBe(true);
		await run();
		expect(factoryCalls).toBe(2);
		expect(second.prompts).toHaveLength(1);
	});
});

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { DurableOperation } from "@wuming/orchestrator";
import type { SessionSnapshot } from "@wuming/protocol";
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
	output: number,
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
	emitScript: (session: FakePiSession) => Promise<void> = async () => {};
	resumeScript: (session: FakePiSession, toolCallId: string, onUpdate?: Parameters<NonNullable<PiSessionLike["resumeApprovedTool"]>>[2]) => Promise<{ message: ToolResultMessage; input: unknown }> = async (_session, toolCallId) => ({
		message: { role: "toolResult", toolCallId, toolName: "write", content: [{ type: "text", text: "done" }], isError: false, timestamp: 11 },
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
		this.prompts.push({ text, options });
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

	getSystemPrompt(): string {
		return this.systemPrompt;
	}

	setSystemPrompt(prompt: string): void {
		this.systemPrompt = prompt;
	}

	async resumeApprovedTool(toolCallId: string, _signal: AbortSignal, onUpdate?: Parameters<NonNullable<PiSessionLike["resumeApprovedTool"]>>[2]) {
		return this.resumeScript(this, toolCallId, onUpdate);
	}

	dispose(): void {
		this.disposed = true;
	}
}

function operation(content: DurableOperation["payload"]["content"], skills?: string[]): DurableOperation {
	return {
		id: "operation-1",
		sessionId: snapshot.session.id,
		type: "turn",
		status: "running",
		payload: { type: "turn", mode: "prompt", userItemId: "user-1", content, ...(skills ? { skills } : {}) },
		attempt: 1,
		createdAt: 1,
		updatedAt: 1,
		abortRequested: false,
	};
}

describe("PiAgentRuntime", () => {
	it("maps Pi streaming, assistant, and tool events into Wuming contracts", async () => {
		const session = new FakePiSession();
		const outputArtifact = { id: "artifact-1", name: "read-output.txt", mimeType: "text/plain", size: 9 };
		session.emitScript = async (current) => {
			const partial = assistant([], "pending", 0, 0);
			current.emit({ type: "message_start", message: partial });
			current.emit({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan", partial },
			});
			current.emit({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "run", partial },
			});
			current.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a.ts" } });
			current.emit({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "a.ts" },
				partialResult: { content: [{ type: "text", text: "file data" }], details: { artifact: outputArtifact } },
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
					2,
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
			const final = assistant([{ type: "text", text: "finished" }], "stop", 5, 1);
			current.emit({ type: "message_start", message: final });
			current.emit({ type: "message_end", message: final });
		};

		let nextId = 0;
		const runtime = new PiAgentRuntime({ createSession: async () => session, idFactory: () => `item-${++nextId}` });
		const progress: string[] = [];
		const progressArtifacts: unknown[] = [];
		const result = await runtime.executeTurn({
			operation: operation([{ type: "text", text: "inspect" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: (event) => {
				progress.push(`${event.type}:${"streamSeq" in event ? event.streamSeq : "-"}`);
				if (event.type === "tool.progress") progressArtifacts.push(event.artifact);
			},
		});

		expect(progress).toEqual([
			"assistant.delta:0",
			"assistant.delta:1",
			"tool.started:-",
			"tool.progress:0",
		]);
		expect(result.items.map((item) => item.type)).toEqual(["assistant", "tool", "assistant"]);
		expect(result.items[0]).toMatchObject({
			content: expect.arrayContaining([
				expect.objectContaining({ type: "tool_call", toolCallId: "call-1", toolName: "read" }),
			]),
		});
		expect(result.items[1]).toMatchObject({ input: { path: "a.ts" }, status: "complete" });
		expect(result.items[1]).toMatchObject({ content: expect.arrayContaining([{ type: "artifact", artifact: outputArtifact }]) });
		expect(progressArtifacts).toEqual([outputArtifact]);
		expect(result.usage).toMatchObject({ inputTokens: 9, outputTokens: 3, totalTokens: 12, costUsd: 0.06 });
		expect(session.prompts[0]).toMatchObject({ text: "inspect", options: { expandPromptTemplates: false, source: "rpc" } });
	});

	it("attributes MCP server, tool, duration, and outcome to tool usage", async () => {
		const session = new FakePiSession();
		let now = 100;
		session.emitScript = async (current) => {
			current.emit({ type: "tool_execution_start", toolCallId: "mcp-call-1", toolName: "mcp__docs__search", args: { query: "api" } });
			now = 145;
			const result = {
				content: [{ type: "text" as const, text: "match" }],
				details: { mcpServerId: "docs", mcpToolName: "search", durationMs: 45, mcpStatus: "complete" },
			};
			current.emit({ type: "tool_execution_end", toolCallId: "mcp-call-1", toolName: "mcp__docs__search", result, isError: false });
			const toolResult: ToolResultMessage = { role: "toolResult", toolCallId: "mcp-call-1", toolName: "mcp__docs__search", ...result, isError: false, timestamp: 145 };
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

		expect(result.tools).toEqual([expect.objectContaining({
			toolName: "mcp__docs__search",
			callCount: 1,
			durationMs: 45,
			succeededCount: 1,
			failedCount: 0,
			abortedCount: 0,
			mcpServerId: "docs",
			mcpToolName: "search",
		})]);
	});

	it("injects resolved skills into the system prompt and restores it afterward", async () => {
		const session = new FakePiSession();
		const runtime = new PiAgentRuntime({
			createSession: async () => session,
			resolveSkills: async (_snapshot, ids) => ids.map((id) => ({ id, name: "Review", content: "Check the diff carefully." })),
		});
		session.emitScript = async (current) => {
			expect(current.systemPrompt).toContain("<skill-instructions>\nCheck the diff carefully.");
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

	it("resumes the exact approved tool call without prompting the provider again", async () => {
		const session = new FakePiSession();
		session.resumeScript = async (current, toolCallId, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "writing" }], details: { running: true } });
			const final = assistant([{ type: "text", text: "recovered after write" }], "stop", 3, 2);
			current.emit({ type: "message_start", message: final });
			current.emit({ type: "message_end", message: final });
			return {
				message: { role: "toolResult", toolCallId, toolName: "write", content: [{ type: "text", text: "Wrote value.txt" }], isError: false, timestamp: 11 },
				input: { path: "value.txt", content: "value" },
			};
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session, idFactory: () => "assistant-recovered" });
		const resumedOperation = { ...operation([{ type: "text", text: "write value" }]), approvalId: "approval-1", approvalToolCallId: "call-write-1", attempt: 2 };
		const progress: string[] = [];
		const result = await runtime.executeTurn({
			operation: resumedOperation,
			snapshot,
			signal: new AbortController().signal,
			onProgress: (event) => progress.push(event.type),
		});
		expect(session.prompts).toEqual([]);
		expect(progress).toContain("tool.progress");
		expect(result.items).toEqual([
			expect.objectContaining({ type: "tool", toolCallId: "call-write-1", input: { path: "value.txt", content: "value" }, status: "complete" }),
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
			{ type: "artifact", artifact: { id: "image-1", name: "screen.png", mimeType: "image/png", size: 5 } },
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
		expect(session.prompts[0]?.text).toBe("Inspect the attached image.");
		expect(session.prompts[0]?.options?.images).toEqual([
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		]);
	});

	it("recreates the Pi session when its security policy changes", async () => {
		const sessions = [new FakePiSession(), new FakePiSession()];
		let factoryCalls = 0;
		const runtime = new PiAgentRuntime({
			createSession: async () => sessions[factoryCalls++]!,
		});
		const run = (current: SessionSnapshot) => runtime.executeTurn({
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
				{ type: "artifact", artifact: { id: "source-1", name: "value.ts", mimeType: "text/plain", size: 25 } },
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
				{ type: "artifact", artifact: { id: "doc-1", name: "report.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1024 } },
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
			resolveArtifact: async () => ({ data: "AAEC", mimeType: "application/octet-stream", binary: true }),
		});
		await runtime.executeTurn({
			operation: operation([
				{ type: "artifact", artifact: { id: "binary-1", name: "archive.bin", mimeType: "application/octet-stream", size: 3 } },
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
		["Request timed out while reading provider response", true, "provider_timeout"],
		["401 invalid API key", false, "provider_auth"],
		["400 invalid request parameter", false, "provider"],
	] as const)("classifies provider failure %s as retryable=%s", async (errorMessage, retryable, kind) => {
		const session = new FakePiSession();
		session.emitScript = async (current) => {
			const failed = { ...assistant([], "error", 2, 0), errorMessage };
			current.emit({ type: "message_start", message: failed });
			current.emit({ type: "message_end", message: failed });
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session });
		const result = await runtime.executeTurn({ operation: operation([{ type: "text", text: "test provider failure" }]), snapshot, signal: new AbortController().signal, onProgress: () => {} });
		expect(result.failure).toMatchObject({ code: "runtime_error", message: errorMessage, retryable, kind });
	});

	it("classifies thrown provider errors and redacts credentials", async () => {
		const session = new FakePiSession();
		session.emitScript = async () => {
			throw Object.assign(new Error("Unauthorized Bearer sk-secretvalue123456"), { status: 401 });
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session });
		const result = await runtime.executeTurn({ operation: operation([{ type: "text", text: "test authentication" }]), snapshot, signal: new AbortController().signal, onProgress: () => {} });
		expect(result.failure).toMatchObject({ code: "runtime_error", retryable: false, kind: "provider_auth" });
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
		const runtime = new PiAgentRuntime({ createSession: async () => session });
		const active = runtime.executeTurn({
			operation: operation([{ type: "text", text: "start" }]),
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		await started;
		const steer = {
			...operation([{ type: "text" as const, text: "change direction" }]),
			id: "operation-steer",
			payload: {
				type: "turn" as const,
				mode: "steer" as const,
				userItemId: "user-steer",
				content: [{ type: "text" as const, text: "change direction" }],
			},
		};
		await runtime.injectTurn({ operation: steer, snapshot, signal: new AbortController().signal });
		await runtime.injectTurn({
			operation: {
				...steer,
				id: "operation-follow-up",
				payload: { ...steer.payload, mode: "follow_up", content: [{ type: "text", text: "then summarize" }] },
			},
			snapshot,
			signal: new AbortController().signal,
		});
		expect(session.prompts.slice(1)).toEqual([
			expect.objectContaining({ text: "change direction", options: expect.objectContaining({ streamingBehavior: "steer" }) }),
			expect.objectContaining({ text: "then summarize", options: expect.objectContaining({ streamingBehavior: "followUp" }) }),
		]);
		release();
		await active;
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
		const run = () => runtime.executeTurn({
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

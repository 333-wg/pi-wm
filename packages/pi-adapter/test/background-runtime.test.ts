import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot, ProgressEvent } from "@wuming/protocol";
import type { DurableOperation } from "@wuming/orchestrator";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { PiAgentRuntime } from "../src/pi-agent-runtime.js";
import { BackgroundTasks } from "../src/background-tasks.js";
import { createDefaultPiSessionFactory } from "../src/default-factory.js";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { PiSessionLike } from "../src/types.js";

const snapshot: SessionSnapshot = {
	session: { id: "session", workspaceId: "workspace", phase: "turn", createdAt: 1, updatedAt: 1 },
	revision: 1,
	model: { provider: "test", id: "test" },
	thinkingLevel: "off",
	sandboxMode: "workspace_write",
	approvalPolicy: "never",
	transcript: [],
	pendingApprovals: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
};
const operation: DurableOperation = {
	id: "operation",
	sessionId: "session",
	type: "turn",
	status: "running",
	attempt: 1,
	createdAt: 1,
	updatedAt: 1,
	abortRequested: false,
	payload: {
		type: "turn",
		mode: "prompt",
		userItemId: "user",
		content: [{ type: "text", text: "Check and document" }],
	},
};
const context = {} as Parameters<ToolDefinition["execute"]>[4];

it("runs the real Pi agent loop through background tools and host continuation without network calls", async () => {
	const directory = await mkdtemp(join(tmpdir(), "wuming-background-real-pi-"));
	await mkdir(join(directory, "agent"));
	let finish!: () => void;
	const work = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const order: string[] = [];
	let requests = 0;
	const factory = createDefaultPiSessionFactory({
		agentDir: join(directory, "agent"),
		sessionDataDir: join(directory, "sessions"),
		resolveWorkspace: () => directory,
		autoCompaction: false,
		createCustomTools: () => [
			defineTool({
				name: "exec",
				label: "Check",
				description: "Test check",
				parameters: Type.Object({}),
				execute: async () => {
					await work;
					order.push("check completed");
					return { content: [{ type: "text", text: "real background result" }], details: {} };
				},
			}),
			defineTool({
				name: "write_file",
				label: "Write",
				description: "Independent docs",
				parameters: Type.Object({ path: Type.String() }),
				execute: async () => {
					order.push("independent docs");
					finish();
					return { content: [{ type: "text", text: "docs ready" }], details: {} };
				},
			}),
		],
		registerProviders: () => [
			{
				provider: "background-test",
				config: {
					baseUrl: "https://example.invalid",
					api: "wuming-background-test",
					apiKey: "test-only",
					models: [
						{
							id: "test",
							name: "Test",
							reasoning: false,
							input: ["text"],
							contextWindow: 32000,
							maxTokens: 4096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
					streamSimple: (_model, modelContext) => {
						requests++;
						const content: AssistantMessage["content"] =
							requests === 1
								? [
										{
											type: "toolCall",
											id: "start",
											name: "background_start",
											arguments: {
												tool: "exec",
												arguments: {},
												label: "Checks",
												workspace_paths: ["src"],
												yield_ms: 0,
											},
										},
									]
								: requests === 2
									? [{ type: "toolCall", id: "docs", name: "write_file", arguments: { path: "docs/guide.md" } }]
									: [{ type: "text", text: requests === 3 ? "Independent work complete" : "Verified final result" }];
						if (requests === 4) {
							expect(JSON.stringify(modelContext.messages)).toContain("real background result");
							order.push("assistant resumed");
						}
						const message: AssistantMessage = {
							role: "assistant",
							content,
							api: "wuming-background-test",
							provider: "background-test",
							model: "test",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: requests < 3 ? "toolUse" : "stop",
							timestamp: Date.now(),
						};
						const stream = createAssistantMessageEventStream();
						queueMicrotask(() => {
							stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
							stream.end();
						});
						return stream;
					},
				},
			},
		],
	});
	const runtime = new PiAgentRuntime({ createSession: factory });
	try {
		const result = await runtime.executeTurn({
			operation,
			snapshot: { ...snapshot, model: { provider: "background-test", id: "test" } },
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		expect(result.failure).toBeUndefined();
		expect(requests).toBe(4);
		expect(order).toEqual(["independent docs", "check completed", "assistant resumed"]);
		expect(result.items.at(-1)).toMatchObject({
			type: "assistant",
			content: [{ type: "text", text: "Verified final result" }],
		});
	} finally {
		finish();
		await runtime[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});

it.each([false, true])(
	"keeps the operation open, delivers the real result and resumes the assistant (early completion: %s)",
	async (early) => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-background-runtime-"));
		const tasks = new BackgroundTasks("session", directory, join(directory, "tasks.json"));
		let finish!: () => void;
		const work = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const events: ProgressEvent[] = [];
		const order: string[] = [];
		const notices: string[] = [];
		const tool = defineTool({
			name: "mcp__test__check",
			label: "Check",
			description: "Check",
			parameters: Type.Object({}),
			execute: async () => {
				await work;
				order.push("check completed");
				return { content: [{ type: "text" as const, text: "actual check output" }], details: {} };
			},
		});
		const session: PiSessionLike = {
			isStreaming: false,
			backgroundTasks: tasks,
			subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
			prompt: async () => {
				await tasks.start(tool, {}, "start", "Check", [], 0, 10, undefined, context);
				order.push("independent docs completed");
				started();
				if (early) {
					finish();
					await tasks.next(new AbortController().signal);
				}
			},
			sendCustomMessage: async (message, options) => {
				expect(options?.triggerTurn).toBe(true);
				notices.push(JSON.stringify(message));
				order.push("assistant resumed");
			},
			abort: async () => {},
			dispose: () => tasks.dispose(),
		};
		const runtime = new PiAgentRuntime({ createSession: async () => session });
		try {
			let ended = false;
			const running = runtime
				.executeTurn({
					operation,
					snapshot,
					signal: new AbortController().signal,
					onProgress: (event) => events.push(event),
				})
				.then((result) => {
					ended = true;
					return result;
				});
			await ready;
			if (!early) {
				expect(ended).toBe(false);
				expect(order).toEqual(["independent docs completed"]);
				finish();
			}
			const result = await running;
			expect(result.failure).toBeUndefined();
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("actual check output");
			expect(order).toEqual(["independent docs completed", "check completed", "assistant resumed"]);
			expect(result.items.some((item) => item.type === "tool" && item.toolName === "mcp__test__check")).toBe(true);
			expect(
				events.some(
					(event) => event.type === "background.tasks" && event.tasks.some((task) => task.status === "running")
				)
			).toBe(true);
			expect(tasks.list()[0]?.consumed).toBe(true);
		} finally {
			finish();
			tasks.dispose();
			await tasks.end();
			await runtime[Symbol.asyncDispose]();
			await rm(directory, { recursive: true, force: true });
		}
	}
);

it("does not wake the assistant after the user stops the operation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "wuming-background-stop-"));
	const tasks = new BackgroundTasks("session", directory, join(directory, "tasks.json"));
	const controller = new AbortController();
	let wakeups = 0;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const tool = defineTool({
		name: "exec",
		label: "Check",
		description: "Check",
		parameters: Type.Object({}),
		execute: async (_id, _args, signal) => {
			await new Promise((_resolve, reject) =>
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
			);
			return { content: [], details: {} };
		},
	});
	const session: PiSessionLike = {
		isStreaming: false,
		backgroundTasks: tasks,
		subscribe: () => () => {},
		prompt: async () => {
			await tasks.start(tool, {}, "start", "Check", [], 0, 10, undefined, context);
			started();
		},
		sendCustomMessage: async () => {
			wakeups++;
		},
		abort: async () => {},
		dispose: () => tasks.dispose(),
	};
	const runtime = new PiAgentRuntime({ createSession: async () => session });
	try {
		const running = runtime.executeTurn({ operation, snapshot, signal: controller.signal, onProgress: () => {} });
		const assertion = expect(running).rejects.toThrow("user stopped");
		await ready;
		controller.abort(new Error("user stopped"));
		await assertion;
		expect(wakeups).toBe(0);
		expect(tasks.list()[0]?.status).toBe("cancelled");
	} finally {
		tasks.dispose();
		await tasks.end();
		await runtime[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});

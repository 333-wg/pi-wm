import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DurableOperation } from "@wuming/orchestrator";
import type { SessionSnapshot } from "@wuming/protocol";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultPiSessionFactory } from "../src/default-factory.js";
import { PiAgentRuntime } from "../src/pi-agent-runtime.js";
import { buildWumingSystemPrompt } from "../src/system-prompt.js";

interface WireRequest {
	messages: Array<{ role: string; content: unknown }>;
	tools?: unknown[];
	prompt_cache_key?: string;
}

const heading = "## Current host reference snapshot\n";
const sentinel = "CURRENT_REFERENCE_SENTINEL=reference-12345";
const system = (request: WireRequest) =>
	request.messages.filter((message) => ["system", "developer"].includes(message.role));
const snapshotMessages = (request: WireRequest) =>
	request.messages.filter((message) => JSON.stringify(message.content).includes("Current host reference snapshot"));

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function fixture(
	options: {
		overflowAt?: number;
		keepRecentTokens?: number;
		threshold?: boolean;
		crossMidnightInTool?: boolean;
		customPrompt?: "builder" | "project";
		loop?: {
			inputTokens?: number;
			resultSize?: number;
			disabled?: boolean;
			failSummary?: boolean;
			cancelSummary?: AbortController;
			queued?: boolean;
		};
	} = {}
) {
	const root = await mkdtemp(join(tmpdir(), "wuming-cache-lifecycle-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	await mkdir(workspace);
	await mkdir(agentDir);
	const customPrompt = buildWumingSystemPrompt({ tools: [], sandboxMode: "read_only", approvalPolicy: "never" });
	if (options.customPrompt === "project") {
		await mkdir(join(workspace, ".pi"));
		await writeFile(join(workspace, ".pi", "SYSTEM.md"), customPrompt);
	}
	const requests: WireRequest[] = [];
	const errors: unknown[] = [];
	let summaries = 0;
	let toolExecutions = 0;
	const sequence: string[] = [];
	const progress: string[] = [];
	const server = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest;
			const summary = JSON.stringify(system(body)).includes("You are a context summarization assistant.");
			if (summary) summaries++;
			else requests.push(body);
			sequence.push(summary ? "summary" : "inference");
			if (summary && options.loop?.cancelSummary) {
				options.loop.cancelSummary.abort(new Error("test cancellation"));
				return;
			}
			if (summary && options.loop?.failSummary) {
				response.writeHead(400, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: { message: "summary fixture rejected", type: "invalid_request_error" } }));
				return;
			}
			if (!summary && requests.length === options.overflowAt) {
				response.writeHead(400, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						error: {
							message: "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens.",
							type: "invalid_request_error",
							code: "context_length_exceeded",
						},
					})
				);
				return;
			}
			const callTool = !summary && (options.crossMidnightInTool || options.loop) && requests.length === 1;
			const input =
				!summary && requests.length === 1 ? (options.loop?.inputTokens ?? (options.threshold ? 127001 : 1000)) : 1000;
			const frame = {
				id: `response-${requests.length}-${summaries}`,
				object: "chat.completion.chunk",
				created: 1,
				model: "lifecycle-model",
				choices: [
					{
						index: 0,
						delta: callTool
							? {
									role: "assistant",
									tool_calls: Array.from({ length: options.loop ? 2 : 1 }, (_, index) => ({
										index,
										id: `check-${index}`,
										type: "function",
										function: { name: "check_clock", arguments: "{}" },
									})),
								}
							: {
									role: "assistant",
									content: summary ? "Continue the active task. Reference records were summarized." : "Task complete.",
								},
						finish_reason: callTool ? "tool_calls" : "stop",
					},
				],
				usage: {
					prompt_tokens: input,
					completion_tokens: 10,
					total_tokens: input + 10,
					prompt_tokens_details: { cached_tokens: 0 },
				},
			};
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
		} catch (error) {
			errors.push(error);
			response.writeHead(500).end("local fixture failure");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture port");
	const snapshot: SessionSnapshot = {
		session: { id: "lifecycle-session", workspaceId: "workspace", phase: "turn", createdAt: 1, updatedAt: 1 },
		revision: 1,
		model: { provider: "lifecycle-local", id: "lifecycle-model" },
		thinkingLevel: "off",
		sandboxMode: "read_only",
		approvalPolicy: "never",
		transcript: [],
		pendingApprovals: [],
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
	};
	let created = 0;
	let activeSession: AgentSession | undefined;
	let reference: string | undefined = sentinel;
	const createSession = createDefaultPiSessionFactory({
		agentDir,
		sessionDataDir: join(root, "sessions"),
		resolveWorkspace: () => workspace,
		autoRetry: false,
		autoCompaction: !options.loop?.disabled && Boolean(options.overflowAt || options.threshold || options.loop),
		...(options.customPrompt === "builder" ? { buildSystemPrompt: () => customPrompt } : {}),
		...(options.crossMidnightInTool || options.loop
			? {
					createCustomTools: () => [
						{
							name: "check_clock",
							label: "Check clock",
							description: "Advance the test clock",
							parameters: Type.Object({}),
							execute: async () => {
								toolExecutions++;
								await new Promise((resolve) => setTimeout(resolve, 5));
								sequence.push("tool-complete");
								if (options.crossMidnightInTool) vi.setSystemTime(new Date("2026-09-24T16:01:00Z"));
								if (options.loop?.queued && toolExecutions === 2 && activeSession!.getSteeringMessages().length === 0)
									await activeSession!.steer("QUEUED_CONSTRAINT_KEEP");
								return {
									content: [
										{ type: "text" as const, text: "Clock advanced" + "x".repeat(options.loop?.resultSize ?? 0) },
									],
									details: {},
								};
							},
						},
					],
				}
			: {}),
		registerProviders: () => [
			{
				provider: "lifecycle-local",
				config: {
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					api: "openai-completions",
					apiKey: "local-fixture-only",
					models: [
						{
							id: "lifecycle-model",
							name: "lifecycle-model",
							reasoning: false,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 256,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		],
	});
	const runtime = new PiAgentRuntime({
		appendReferenceContext: true,
		resolveContextFragments: () => [
			{
				id: "workspace:policy",
				version: "1",
				kind: "policy",
				source: "workspace:policy",
				content: "ACTIVE_POLICY_MUST_REMAIN",
			},
			...(reference === undefined
				? []
				: [
						{
							id: "workspace:reference",
							version: "1",
							kind: "workspace" as const,
							source: "workspace:reference",
							delivery: "user" as const,
							content: reference,
						},
					]),
		],
		createSession: async (input) => {
			created++;
			const session = await createSession(input);
			activeSession = session as AgentSession;
			if (options.overflowAt || options.threshold || (options.loop && !options.loop.disabled)) {
				// Exercise real SDK compaction with a small deterministic retained suffix.
				vi.spyOn(activeSession.settingsManager, "getCompactionSettings").mockReturnValue({
					enabled: true,
					reserveTokens: 1000,
					keepRecentTokens: options.keepRecentTokens ?? 1,
				});
			}
			return session;
		},
	});
	let turn = 0;
	return {
		requests,
		sequence,
		progress,
		toolExecutions: () => toolExecutions,
		created: () => created,
		summaryCount: () => summaries,
		setReference: (content: string | undefined) => {
			reference = content;
		},
		reopen: () => runtime.disposeSession(snapshot.session.id),
		compact: () => activeSession!.compact(),
		async run() {
			const id = `turn-${++turn}`;
			const operation: DurableOperation = {
				id,
				sessionId: snapshot.session.id,
				type: "turn",
				status: "running",
				attempt: 1,
				createdAt: turn,
				updatedAt: turn,
				abortRequested: false,
				payload: {
					type: "turn",
					mode: "prompt",
					userItemId: `user-${turn}`,
					content: [{ type: "text", text: `Continue task ${turn}` }],
				},
			};
			return runtime.executeTurn({
				operation,
				snapshot,
				onProgress: (event) => {
					if (event.type === "context.compaction") progress.push(event.status);
				},
				signal: options.loop?.cancelSummary?.signal ?? AbortSignal.timeout(15000),
			});
		},
		async close() {
			await runtime[Symbol.asyncDispose]();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
			expect(errors).toEqual([]);
		},
	};
}

it("refreshes a retained session across successive Shanghai midnights without rewriting history", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-24T15:59:00Z"));
	const test = await fixture();
	try {
		for (const date of [
			"2026-09-24T15:59:00Z",
			"2026-09-24T16:01:00Z",
			"2026-09-25T04:00:00Z",
			"2026-09-25T16:01:00Z",
		]) {
			vi.setSystemTime(new Date(date));
			expect((await test.run()).failure).toBeUndefined();
		}
		expect(test.created()).toBe(1);
		const systems = test.requests.map((request) => JSON.stringify(system(request)));
		expect(systems.map((text) => text.match(/Current date: ([0-9-]+)/)?.[1])).toEqual([
			"2026-09-24",
			"2026-09-25",
			"2026-09-25",
			"2026-09-26",
		]);
		expect(systems[2]).toBe(systems[1]);
		expect(new Set(systems.map((text) => text.split("<current_date>")[0])).size).toBe(1);
		for (let index = 1; index < test.requests.length; index++) {
			const prior = test.requests[index - 1]!.messages.filter(
				(message) => !["system", "developer"].includes(message.role)
			);
			const current = test.requests[index]!.messages.filter(
				(message) => !["system", "developer"].includes(message.role)
			);
			expect(current.slice(0, prior.length)).toEqual(prior);
			expect(systems[index]).toContain("ACTIVE_POLICY_MUST_REMAIN");
		}
		await test.reopen();
		expect((await test.run()).failure).toBeUndefined();
		expect(JSON.stringify(system(test.requests.at(-1)!))).toBe(systems.at(-1));
		expect(snapshotMessages(test.requests.at(-1)!)).toHaveLength(1);
	} finally {
		await test.close();
	}
}, 30000);

it.each(["builder", "project"] as const)(
	"does not rewrite a %s custom system prompt even if it copies the default",
	async (customPrompt) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-24T15:59:00Z"));
		const test = await fixture({ customPrompt });
		try {
			expect((await test.run()).failure).toBeUndefined();
			vi.setSystemTime(new Date("2026-09-24T16:01:00Z"));
			expect((await test.run()).failure).toBeUndefined();
			expect(system(test.requests[1]!)).toEqual(system(test.requests[0]!));
		} finally {
			await test.close();
		}
	},
	30000
);

it("refreshes the date on the next model call when a tool loop crosses midnight", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-24T15:59:00Z"));
	const test = await fixture({ crossMidnightInTool: true });
	try {
		expect((await test.run()).failure).toBeUndefined();
		expect(test.requests).toHaveLength(2);
		expect(JSON.stringify(system(test.requests[0]!))).toContain("Current date: 2026-09-24");
		expect(JSON.stringify(system(test.requests[1]!))).toContain("Current date: 2026-09-25");
		expect(test.requests[1]!.tools).toEqual(test.requests[0]!.tools);
		expect(snapshotMessages(test.requests[1]!)).toHaveLength(1);
	} finally {
		await test.close();
	}
}, 30000);

it.each([false, true])(
	"restores the latest snapshot before overflow retry and deduplicates after restart (empty=%s)",
	async (empty) => {
		const test = await fixture({ overflowAt: 3 });
		try {
			expect((await test.run()).failure).toBeUndefined();
			if (empty) test.setReference(undefined);
			expect((await test.run()).failure).toBeUndefined();
			const result = await test.run();
			expect(result.failure).toBeUndefined();
			expect(result.compactions).toEqual([expect.objectContaining({ reason: "overflow" })]);
			expect(
				result.requests?.filter((request) => request.purpose === "inference").map((request) => request.status)
			).toEqual(["error", "complete"]);
			expect(result.requests?.filter((request) => request.purpose === "compaction")).toHaveLength(1);
			expect(test.requests).toHaveLength(4);
			const retry = test.requests.at(-1)!;
			expect(snapshotMessages(retry)).toHaveLength(1);
			if (empty) {
				expect(snapshotMessages(retry)[0]?.content).toEqual([{ type: "text", text: heading + "[]\n" }]);
				expect(JSON.stringify(retry)).not.toContain(sentinel);
			} else expect(JSON.stringify(snapshotMessages(retry))).toContain(sentinel);
			expect(JSON.stringify(system(retry))).toContain("ACTIVE_POLICY_MUST_REMAIN");
			await test.reopen();
			expect((await test.run()).failure).toBeUndefined();
			expect(test.requests).toHaveLength(5);
			expect(snapshotMessages(test.requests.at(-1)!)).toHaveLength(1);
		} finally {
			await test.close();
		}
	},
	30000
);

it("does not duplicate a snapshot retained by compaction", async () => {
	const test = await fixture({ overflowAt: 2, keepRecentTokens: 100 });
	try {
		test.setReference(sentinel + " reference".repeat(200));
		expect((await test.run()).failure).toBeUndefined();
		const result = await test.run();
		expect(result.failure).toBeUndefined();
		expect(result.compactions).toHaveLength(1);
		expect(test.requests).toHaveLength(3);
		expect(snapshotMessages(test.requests.at(-1)!)).toHaveLength(1);
	} finally {
		await test.close();
	}
}, 30000);

it("restores data after completed-turn compaction without triggering another model call", async () => {
	const test = await fixture({ threshold: true });
	try {
		const result = await test.run();
		expect(result.failure).toBeUndefined();
		expect(result.compactions).toEqual([expect.objectContaining({ reason: "threshold" })]);
		expect(test.summaryCount()).toBeGreaterThan(0);
		expect(test.requests).toHaveLength(1);
		expect((await test.run()).failure).toBeUndefined();
		expect(test.requests).toHaveLength(2);
		expect(snapshotMessages(test.requests.at(-1)!)).toHaveLength(1);
	} finally {
		await test.close();
	}
}, 30000);

it.each([{ inputTokens: 123000 }, { inputTokens: 110000, resultSize: 40000 }, { inputTokens: 123000, queued: true }])(
	"compacts within a parallel tool loop before the next inference (%j)",
	async (loop) => {
		const test = await fixture({ loop });
		try {
			const result = await test.run();
			expect(result.failure).toBeUndefined();
			expect(test.toolExecutions()).toBe(2);
			expect(test.sequence.slice(0, 3)).toEqual(["inference", "tool-complete", "tool-complete"]);
			expect(test.sequence.indexOf("summary")).toBe(3);
			expect(test.sequence.at(-1)).toBe("inference");
			expect(test.requests).toHaveLength(2);
			const retained = JSON.stringify(test.requests[1]);
			expect(retained).toContain("check-0");
			expect(retained).toContain("check-1");
			expect(test.requests[1]!.messages.filter((message) => message.role === "tool")).toHaveLength(2);
			expect(result.compactions).toEqual([expect.objectContaining({ reason: "threshold" })]);
			expect(test.progress).toEqual(["running", "complete"]);
			expect(snapshotMessages(test.requests[1]!)).toHaveLength(1);
			expect(JSON.stringify(system(test.requests[1]!))).toContain("ACTIVE_POLICY_MUST_REMAIN");
			if ("queued" in loop) expect(JSON.stringify(test.requests[1])).toContain("QUEUED_CONSTRAINT_KEEP");
		} finally {
			await test.close();
		}
	},
	30000
);

it.each([{ inputTokens: 1000 }, { inputTokens: 123000, disabled: true }])(
	"does not compact low-budget or explicitly disabled tool loops (%j)",
	async (loop) => {
		const test = await fixture({ loop });
		try {
			expect((await test.run()).failure).toBeUndefined();
			expect(test.summaryCount()).toBe(0);
			expect(test.requests).toHaveLength(2);
			expect(test.toolExecutions()).toBe(2);
		} finally {
			await test.close();
		}
	},
	30000
);

it("pauses on summary failure without sending another inference or retrying compaction", async () => {
	const test = await fixture({ loop: { inputTokens: 123000, failSummary: true } });
	try {
		expect((await test.run()).failure).toBeDefined();
		expect(test.summaryCount()).toBe(1);
		expect(test.requests).toHaveLength(1);
		expect(test.toolExecutions()).toBe(2);
		expect(test.progress).toEqual(["running", "failed"]);
	} finally {
		await test.close();
	}
}, 30000);

it("stops when a retained tool batch is still over budget instead of compacting forever", async () => {
	const test = await fixture({ loop: { inputTokens: 110000, resultSize: 300000 } });
	try {
		const result = await test.run();
		expect(result.failure?.message).toContain("remains over budget");
		expect(test.requests).toHaveLength(1);
		expect(result.compactions).toHaveLength(1);
		expect(test.summaryCount()).toBeLessThanOrEqual(2);
		expect(test.toolExecutions()).toBe(2);
	} finally {
		await test.close();
	}
}, 30000);

it("cancels an in-loop summary without deadlock or a resumed inference", async () => {
	const test = await fixture({ loop: { inputTokens: 123000, cancelSummary: new AbortController() } });
	try {
		await test.run().catch((error: unknown) => expect(error).toBeDefined());
		expect(test.summaryCount()).toBe(1);
		expect(test.requests).toHaveLength(1);
		expect(test.toolExecutions()).toBe(2);
		expect(test.progress).toEqual(["running", "cancelled"]);
	} finally {
		await test.close();
	}
}, 30000);

it("resends the current snapshot on the next turn after manual compaction", async () => {
	const test = await fixture({ overflowAt: 999 });
	try {
		expect((await test.run()).failure).toBeUndefined();
		expect((await test.run()).failure).toBeUndefined();
		await test.compact();
		expect(test.requests).toHaveLength(2);
		expect((await test.run()).failure).toBeUndefined();
		expect(test.requests).toHaveLength(3);
		expect(snapshotMessages(test.requests.at(-1)!)).toHaveLength(1);
		expect(JSON.stringify(snapshotMessages(test.requests.at(-1)!))).toContain(sentinel);
	} finally {
		await test.close();
	}
}, 30000);

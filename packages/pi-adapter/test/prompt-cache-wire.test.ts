import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DurableOperation } from "@wuming/orchestrator";
import type { SessionSnapshot } from "@wuming/protocol";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultPiSessionFactory } from "../src/default-factory.js";
import { PiAgentRuntime } from "../src/pi-agent-runtime.js";

type Api = "openai-completions" | "openai-responses" | "anthropic-messages";
interface Scenario {
	api: Api;
	retention?: CacheRetention;
	supportsLong: boolean;
}
interface WireRequest {
	messages?: Array<Record<string, unknown>>;
	input?: Array<Record<string, unknown>>;
	system?: unknown;
	tools?: unknown[];
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
	tool_choice?: unknown;
}

const scenarios: Scenario[] = [
	{ api: "openai-completions", supportsLong: true },
	{ api: "openai-completions", retention: "long", supportsLong: true },
	{ api: "openai-completions", retention: "long", supportsLong: false },
	{ api: "openai-responses", retention: "long", supportsLong: true },
	{ api: "openai-responses", retention: "long", supportsLong: false },
	{ api: "openai-responses", retention: "none", supportsLong: true },
	{ api: "anthropic-messages", retention: "short", supportsLong: true },
	{ api: "anthropic-messages", retention: "long", supportsLong: true },
	{ api: "anthropic-messages", retention: "long", supportsLong: false },
	{ api: "anthropic-messages", retention: "none", supportsLong: true },
];

function sse(api: Api, step: number, cached: boolean): string {
	const read = cached ? 1024 : 0;
	const write = cached ? 256 : 0;
	const text = `reply-${step}`;
	if (api === "openai-completions") {
		return (
			[
				{ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
				{
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: {
						prompt_tokens: 1344,
						completion_tokens: 8,
						total_tokens: 1352,
						prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
					},
				},
			]
				.map(
					(frame) =>
						`data: ${JSON.stringify({ id: `completion_${step}`, object: "chat.completion.chunk", created: 1, model: "cache-model", ...frame })}\n\n`
				)
				.join("") + "data: [DONE]\n\n"
		);
	}
	const usage = {
		input_tokens: 1344 - read - write,
		output_tokens: 8,
		cache_read_input_tokens: read,
		cache_creation_input_tokens: write,
	};
	const item = {
		id: `msg_${step}`,
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const events =
		api === "anthropic-messages"
			? [
					{
						type: "message_start",
						message: {
							id: `msg_${step}`,
							type: "message",
							role: "assistant",
							model: "cache-model",
							content: [],
							usage,
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
					{ type: "message_stop" },
				]
			: [
					{ type: "response.created", response: { id: `resp_${step}` } },
					{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
					{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
					{ type: "response.output_item.done", output_index: 0, item },
					{
						type: "response.completed",
						response: {
							id: `resp_${step}`,
							status: "completed",
							output: [item],
							usage: {
								input_tokens: 1344,
								output_tokens: 8,
								total_tokens: 1352,
								input_tokens_details: { cached_tokens: read, cache_write_tokens: write },
							},
						},
					},
				];
	return events
		.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`)
		.join("");
}

// Cache markers move forward on Anthropic but are not prompt content.
function withoutCacheMarkers(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheMarkers);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "cache_control")
				.map(([key, child]) => [key, withoutCacheMarkers(child)])
		);
	return value;
}

afterEach(() => vi.unstubAllEnvs());

it.each(scenarios)(
	"preserves wire prefixes and provider cache controls: $api / $retention / long=$supportsLong",
	async (scenario) => {
		vi.stubEnv("PI_CACHE_RETENTION", "short");
		const root = await mkdtemp(join(tmpdir(), "wuming-cache-wire-"));
		const requests: WireRequest[] = [];
		const errors: unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest);
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.end(sse(scenario.api, requests.length, scenario.retention !== "none"));
			} catch (error) {
				errors.push(error);
				response.writeHead(500).end("local fixture failure");
			}
		});
		let runtime: PiAgentRuntime | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture port");
			const workspace = join(root, "workspace");
			await mkdir(workspace);
			let reopened = false;
			let content = "authentication refresh";
			const tool = (name: string): ToolDefinition => ({
				name,
				label: name,
				description: `Inspect ${name}`,
				promptSnippet: `Inspect ${name}`,
				parameters: Type.Object(
					reopened
						? { alpha: Type.Optional(Type.String()), zebra: Type.Optional(Type.String()) }
						: { zebra: Type.Optional(Type.String()), alpha: Type.Optional(Type.String()) }
				),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
			runtime = new PiAgentRuntime({
				resolveContextFragments: () => [
					{
						id: "workspace:auth",
						source: "workspace:auth",
						version: content,
						kind: "workspace",
						cacheScope: "turn",
						content,
					},
					{
						id: "workspace:colors",
						source: "workspace:colors",
						version: "1",
						kind: "workspace",
						cacheScope: "turn",
						content: "button typography",
					},
				],
				createSession: createDefaultPiSessionFactory({
					agentDir: join(root, "agent"),
					sessionDataDir: join(root, "sessions"),
					resolveWorkspace: () => workspace,
					autoRetry: false,
					autoCompaction: false,
					...(scenario.retention === undefined ? {} : { cacheRetention: scenario.retention }),
					...(scenario.api === "openai-completions" ? { initialToolChoice: "required" as const } : {}),
					createCustomTools: () => (reopened ? [tool("alpha"), tool("zeta")] : [tool("zeta"), tool("alpha")]),
					registerProviders: () => [
						{
							provider: "cache-wire",
							config: {
								baseUrl: `http://127.0.0.1:${address.port}/v1`,
								api: scenario.api,
								apiKey: "local-fixture-only",
								models: [
									{
										id: "cache-model",
										name: "cache-model",
										reasoning: false,
										input: ["text"],
										contextWindow: 128000,
										maxTokens: 256,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
										compat: { supportsLongCacheRetention: scenario.supportsLong },
									},
								],
							},
						},
					],
				}),
			});
			const snapshot: SessionSnapshot = {
				session: { id: "cache-session", workspaceId: "workspace", phase: "turn", createdAt: 1, updatedAt: 1 },
				revision: 1,
				model: { provider: "cache-wire", id: "cache-model" },
				thinkingLevel: "off",
				sandboxMode: "read_only",
				approvalPolicy: "never",
				transcript: [],
				pendingApprovals: [],
				queuedSteerCount: 0,
				queuedFollowUpCount: 0,
				usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
			};
			for (const [index, query] of [
				"authentication refresh",
				"button typography",
				"resume the task",
				"check updated policy",
			].entries()) {
				if (index === 2) {
					await runtime.disposeSession(snapshot.session.id);
					reopened = true;
				}
				if (index === 3) content = "UPDATED_CONTEXT_MUST_APPLY";
				const operation: DurableOperation = {
					id: `turn-${index}`,
					sessionId: snapshot.session.id,
					type: "turn",
					status: "running",
					attempt: 1,
					createdAt: index,
					updatedAt: index,
					abortRequested: false,
					payload: {
						type: "turn",
						mode: "prompt",
						userItemId: `user-${index}`,
						content: [{ type: "text", text: query }],
					},
				};
				const result = await runtime.executeTurn({
					operation,
					snapshot,
					onProgress: () => {},
					signal: AbortSignal.timeout(10000),
				});
				expect(result.failure).toBeUndefined();
				expect(result.requests).toHaveLength(1);
				expect(result.requests?.[0]?.usage).toMatchObject({
					inputTokens: scenario.retention === "none" ? 1344 : 64,
					cacheReadTokens: scenario.retention === "none" ? 0 : 1024,
					cacheWriteTokens: scenario.retention === "none" ? 0 : 256,
					outputTokens: 8,
					totalTokens: 1352,
				});
			}
			expect(errors).toEqual([]);
			expect(requests).toHaveLength(4);
			const system = (request: WireRequest) =>
				request.system ??
				(request.messages ?? request.input)?.filter((message) =>
					["system", "developer"].includes(String(message.role))
				);
			for (const request of requests.slice(1, 3)) {
				expect(JSON.stringify(system(request))).toBe(JSON.stringify(system(requests[0]!)));
				expect(JSON.stringify(request.tools)).toBe(JSON.stringify(requests[0]!.tools));
				expect(request.prompt_cache_key).toBe(requests[0]!.prompt_cache_key);
			}
			expect(JSON.stringify(system(requests[3]!))).toContain("UPDATED_CONTEXT_MUST_APPLY");
			expect(JSON.stringify(system(requests[3]!))).not.toBe(JSON.stringify(system(requests[2]!)));
			for (let index = 1; index < 3; index++) {
				const prior = requests[index - 1]!.messages ?? requests[index - 1]!.input ?? [];
				const current = requests[index]!.messages ?? requests[index]!.input ?? [];
				expect(current.length).toBeGreaterThan(prior.length);
				expect(withoutCacheMarkers(current.slice(0, prior.length))).toEqual(withoutCacheMarkers(prior));
			}
			const first = requests[0]!;
			if (scenario.api === "anthropic-messages") {
				const serialized = JSON.stringify(first);
				if (scenario.retention === "none") expect(serialized).not.toContain('"cache_control"');
				else expect(serialized).toContain('"cache_control":{"type":"ephemeral"');
				if (scenario.retention === "long" && scenario.supportsLong) expect(serialized).toContain('"ttl":"1h"');
				else expect(serialized).not.toContain('"ttl"');
			} else {
				expect(first.prompt_cache_retention).toBe(
					scenario.retention === "long" && scenario.supportsLong ? "24h" : undefined
				);
				if (
					scenario.retention !== "none" &&
					(scenario.api === "openai-responses" || (scenario.retention === "long" && scenario.supportsLong))
				)
					expect(first.prompt_cache_key).toBeTruthy();
				else expect(first.prompt_cache_key).toBeUndefined();
				if (scenario.api === "openai-completions") {
					expect(first.tool_choice).toBe("required");
					expect(requests[1]?.tool_choice).not.toBe("required");
				}
			}
		} finally {
			await runtime?.[Symbol.asyncDispose]();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	},
	20000
);

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqliteOrchestratorStore } from "@wuming/orchestrator";
import { Type } from "typebox";
import { createDefaultPiSessionFactory } from "../src/default-factory.js";
import { PiAgentRuntime } from "../src/pi-agent-runtime.js";

export type RecoveryApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export type CrashStage = "first-response" | "tool-side-effect" | "tool-result";

export function crashRuntime(
	root: string,
	baseUrl: string,
	api: RecoveryApi,
	store: SqliteOrchestratorStore,
	stage?: CrashStage
) {
	return new PiAgentRuntime({
		resolveRecoveryOperations: (snapshot) => store.listRecoveryOperations(snapshot.session.id),
		createSession: createDefaultPiSessionFactory({
			agentDir: join(root, "agent"),
			sessionDataDir: join(root, "sessions"),
			resolveWorkspace: () => root,
			autoCompaction: false,
			autoRetry: false,
			registerProviders: () => [
				{
					provider: "recovery-test",
					config: {
						baseUrl,
						api,
						apiKey: "local-fixture-only",
						models: [
							{
								id: "recovery-model",
								name: "recovery-model",
								reasoning: false,
								input: ["text"],
								contextWindow: 128000,
								maxTokens: 256,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						],
					},
				},
			],
			createCustomTools: () => [
				{
					name: "write",
					label: "write",
					description: "Create the library app",
					parameters: Type.Object({}),
					execute: async () => {
						await appendFile(join(root, "writes.txt"), "library-manager\n");
						if (stage === "tool-side-effect") {
							process.stdout.write("SIDE_EFFECT_READY\n");
							await new Promise<never>(() => {});
						}
						return { content: [{ type: "text", text: "Created library-manager: RAW_TOOL_RESULT" }], details: {} };
					},
				},
				{
					name: "inspect",
					label: "inspect",
					description: "Inspect existing state before resuming",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: await readFile(join(root, "writes.txt"), "utf8") }],
						details: {},
					}),
				},
			],
		}),
	});
}

export function recoverySse(api: RecoveryApi, tool?: string, text = "Recovery context verified"): string {
	if (api === "openai-completions") {
		const frames = [
			{
				choices: [
					{
						index: 0,
						delta: tool
							? {
									role: "assistant",
									tool_calls: [
										{ index: 0, id: `call_${tool}`, type: "function", function: { name: tool, arguments: "{}" } },
									],
								}
							: { role: "assistant", content: text },
						finish_reason: null,
					},
				],
			},
			{ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
		];
		return (
			frames
				.map(
					(frame) =>
						`data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "recovery-model", ...frame })}\n\n`
				)
				.join("") + "data: [DONE]\n\n"
		);
	}
	const usage = { input_tokens: 20, output_tokens: 5 };
	const item = tool
		? {
				id: `fc_${tool}`,
				type: "function_call",
				call_id: `call_${tool}`,
				name: tool,
				arguments: "{}",
				status: "completed",
			}
		: {
				id: "msg_done",
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
							id: "msg_done",
							type: "message",
							role: "assistant",
							model: "recovery-model",
							content: [],
							usage,
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: tool
							? { type: "tool_use", id: `call_${tool}`, name: tool, input: {} }
							: { type: "text", text: "" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: tool ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text },
					},
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage },
					{ type: "message_stop" },
				]
			: [
					{ type: "response.created", response: { id: "resp_done" } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: tool ? { ...item, arguments: "" } : { ...item, content: [] },
					},
					...(tool
						? [{ type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" }]
						: [{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }]),
					{ type: "response.output_item.done", output_index: 0, item },
					{
						type: "response.completed",
						response: { id: "resp_done", status: "completed", output: [item], usage: { ...usage, total_tokens: 25 } },
					},
				];
	return events
		.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
		.join("");
}

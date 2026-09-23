import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createDefaultPiSessionFactory } from "../src/default-factory.js";
import { PiAgentRuntime } from "../src/pi-agent-runtime.js";

it("recovers a silent real provider stream without replaying a completed long-running tool", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-idle-recovery-"));
	const requests: Array<{ messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> }> = [];
	const errors: unknown[] = [];
	let writes = 0;
	let silentConnectionClosed = false;
	const server = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			const step = requests.length;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.flushHeaders();
			const frame = (delta: object, finishReason: string | null = null) =>
				`data: ${JSON.stringify({
					id: `completion-${step}`,
					object: "chat.completion.chunk",
					created: 1,
					model: "test-model",
					choices: [{ index: 0, delta, finish_reason: finishReason }],
				})}\n\n`;
			if (step === 1) {
				response.write(
					frame({
						role: "assistant",
						tool_calls: [
							{ index: 0, id: "write-once", type: "function", function: { name: "write_once", arguments: "{}" } },
						],
					})
				);
				response.write(frame({}, "tool_calls"));
			} else if (step === 2) {
				response.once("close", () => {
					silentConnectionClosed = true;
				});
				return;
			} else {
				response.write(frame({ role: "assistant", content: "Recovered and finished." }));
				response.write(frame({}, "stop"));
			}
			response.end("data: [DONE]\n\n");
		} catch (error) {
			errors.push(error);
			response.destroy();
		}
	});
	let runtime: PiAgentRuntime | undefined;
	using store = new SqliteOrchestratorStore(":memory:");
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No loopback port");
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		runtime = new PiAgentRuntime({
			createSession: createDefaultPiSessionFactory({
				agentDir: join(root, "agent"),
				sessionDataDir: join(root, "sessions"),
				resolveWorkspace: () => workspace,
				modelIdleTimeoutMs: 1000,
				autoRetry: false,
				autoCompaction: false,
				registerProviders: () => [
					{
						provider: "idle-test",
						config: {
							baseUrl: `http://127.0.0.1:${address.port}/v1`,
							api: "openai-completions",
							apiKey: "local-test-only",
							models: [
								{
									id: "test-model",
									name: "test-model",
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
				createCustomTools: () => [
					{
						name: "write_once",
						label: "Write",
						description: "Perform a durable write once",
						parameters: Type.Object({}),
						execute: async () => {
							writes++;
							// Tool work may be silent for longer than the model-specific idle limit.
							await delay(1250);
							return { content: [{ type: "text", text: "WRITE_CONFIRMED" }], details: {} };
						},
					},
				],
			}),
		});
		const orchestrator = new SessionOrchestrator(store, runtime, { retryBaseDelayMs: 0, maxRetries: 1 });
		const created = await orchestrator.createSession({
			principalId: "test",
			idempotencyKey: "create",
			workspaceId: "workspace",
			model: { provider: "idle-test", id: "test-model" },
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "never",
		});
		const sessionId = created.snapshot.session.id;
		await orchestrator.acceptTurn({
			principalId: "test",
			idempotencyKey: "turn",
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "Write once, then report the result" }],
		});
		await orchestrator.drainSession(sessionId);
		const operation = store.listOperations(sessionId)[0]!;
		expect(operation).toMatchObject({ status: "completed", attempt: 2 });
		expect(operation.retryHistory).toHaveLength(1);
		expect(operation.retryHistory?.[0]?.error).toContain("idle timeout");
		expect(writes).toBe(1);
		expect(requests).toHaveLength(3);
		expect(requests[2]!.messages.find((message) => message.tool_call_id === "write-once")).toMatchObject({
			role: "tool",
			content: "WRITE_CONFIRMED",
		});
		expect(JSON.stringify(requests[2])).toContain("Resume the same unfinished task");
		await expect.poll(() => silentConnectionClosed).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await runtime?.[Symbol.asyncDispose]();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
}, 20000);

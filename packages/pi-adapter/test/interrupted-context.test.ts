import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableOperation } from "@wuming/orchestrator";
import type { SessionSnapshot } from "@wuming/protocol";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createDefaultPiSessionFactory } from "../src/default-factory.js";
import { PiAgentRuntime } from "../src/pi-agent-runtime.js";

interface WireMessage {
	role: string;
	content?: unknown;
	tool_call_id?: string;
	tool_calls?: { id: string }[];
}

const snapshot: SessionSnapshot = {
	session: { id: "interrupted-context", workspaceId: "workspace", phase: "idle", createdAt: 1, updatedAt: 1 },
	revision: 1,
	model: { provider: "interruption-test", id: "test-model" },
	thinkingLevel: "off",
	sandboxMode: "workspace_write",
	approvalPolicy: "never",
	transcript: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	pendingApprovals: [],
	usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
};

function operation(id: string, text: string): DurableOperation {
	return {
		id,
		sessionId: snapshot.session.id,
		type: "turn",
		status: "running",
		attempt: 1,
		createdAt: 1,
		updatedAt: 1,
		abortRequested: false,
		payload: { type: "turn", mode: "prompt", userItemId: id, content: [{ type: "text", text }] },
	};
}

// Exercise real SDK persistence and provider serialization through a local SSE
// server: visible transcript state alone cannot prove the model receives history.
it.each([false, true])(
	"sends interrupted task context on continue (restart=%s)",
	async (restart) => {
		const root = await mkdtemp(join(tmpdir(), "wuming-interruption-wire-"));
		const requests: { messages: WireMessage[] }[] = [];
		const serverErrors: unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				const step = requests.length;
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				const frame = (delta: object, finishReason: string | null = null) =>
					"data: " +
					JSON.stringify({
						id: `completion-${step}`,
						object: "chat.completion.chunk",
						created: 1,
						model: "test-model",
						choices: [{ index: 0, delta, finish_reason: finishReason }],
					}) +
					"\n\n";
				if (step === 1) {
					response.write(frame({ role: "assistant", content: "I will implement book search and borrowing." }));
					response.write(
						frame({
							tool_calls: [
								{
									index: 0,
									id: "write-package",
									type: "function",
									function: { name: "write", arguments: JSON.stringify({ path: "package.json" }) },
								},
							],
						})
					);
					response.write(frame({}, "tool_calls"));
				} else if (step === 2) {
					response.write(frame({ role: "assistant", content: "INCOMPLETE_RESPONSE" }));
					// Keep this provider request open until the runtime is aborted.
					return;
				} else {
					response.write(frame({ role: "assistant", content: "Context retained." }));
					response.write(frame({}, "stop"));
				}
				response.end("data: [DONE]\n\n");
			} catch (error) {
				serverErrors.push(error);
				response.destroy();
			}
		});
		let runtime: PiAgentRuntime | undefined;
		let firstTurn: ReturnType<PiAgentRuntime["executeTurn"]> | undefined;
		const controller = new AbortController();
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("No loopback port");
			const workspace = join(root, "workspace");
			const agentDir = join(root, "agent");
			await mkdir(workspace);
			await mkdir(agentDir);
			let writes = 0;
			const factory = createDefaultPiSessionFactory({
				agentDir,
				sessionDataDir: join(root, "sessions"),
				resolveWorkspace: () => workspace,
				autoRetry: false,
				autoCompaction: false,
				registerProviders: () => [
					{
						provider: "interruption-test",
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
						name: "write",
						label: "write",
						description: "Write the initial package file",
						parameters: Type.Object({ path: Type.Literal("package.json") }),
						execute: async () => {
							writes += 1;
							await writeFile(join(workspace, "package.json"), '{"name":"library-manager"}\n');
							return { content: [{ type: "text", text: "Created package.json: library-manager" }], details: {} };
						},
					},
				],
			});
			runtime = new PiAgentRuntime({ createSession: factory });
			firstTurn = runtime.executeTurn({
				snapshot,
				operation: operation("first", "Build a library management system"),
				signal: controller.signal,
				onProgress: () => {},
			});
			await expect.poll(() => requests.length, { timeout: 10000 }).toBe(2);
			controller.abort(new Error("User cancelled"));
			await expect(firstTurn).rejects.toThrow("User cancelled");
			expect(writes).toBe(1);
			if (restart) {
				await runtime[Symbol.asyncDispose]();
				runtime = new PiAgentRuntime({ createSession: factory });
			}
			const result = await runtime.executeTurn({
				snapshot,
				operation: operation("continue", "Continue"),
				signal: new AbortController().signal,
				onProgress: () => {},
			});
			expect(result.failure).toBeUndefined();
			expect(requests).toHaveLength(3);
			const continued = requests[2]!.messages;
			expect(
				continued.some(
					(message) =>
						message.role === "user" && JSON.stringify(message.content).includes("Build a library management system")
				)
			).toBe(true);
			expect(
				continued.some(
					(message) => message.role === "assistant" && message.tool_calls?.some((call) => call.id === "write-package")
				)
			).toBe(true);
			expect(continued.find((message) => message.tool_call_id === "write-package")).toMatchObject({
				role: "tool",
				content: "Created package.json: library-manager",
			});
			expect(JSON.stringify(continued)).toContain("The previous execution was interrupted");
			expect(JSON.stringify(continued)).not.toContain("INCOMPLETE_RESPONSE");
			expect(continued.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "Continue" }] });
			expect(writes).toBe(1);
			expect(await readFile(join(workspace, "package.json"), "utf8")).toContain("library-manager");
			expect(serverErrors).toEqual([]);
		} finally {
			controller.abort();
			await firstTurn?.catch(() => {});
			await runtime?.[Symbol.asyncDispose]();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	},
	20000
);

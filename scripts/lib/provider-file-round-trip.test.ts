import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { createDefaultPiSessionFactory, PiAgentRuntime } from "@wuming/pi-adapter";
import { ApprovalBroker, createSandboxTools, WorkspaceFileExecutor } from "@wuming/sandbox";
import { expect, it } from "vitest";
import { verifyFileRoundTrip } from "./file-acceptance.js";

interface WireMessage {
	role: string;
	content?: string;
	tool_call_id?: string;
	tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}
interface WireRequest {
	model: string;
	stream: boolean;
	tool_choice?: string;
	max_tokens?: number;
	max_completion_tokens?: number;
	messages: WireMessage[];
	tools: { function: { name: string } }[];
}

// Real SDK serialization/SSE parsing and real durable/tool plumbing, without a
// remote provider or user credentials. The server learns the proof only from
// the tool-result message, never from the prompt or fixture variable.
it.each([false, true])(
	"preserves provider wire evidence and rejects corrupt output (corrupt=%s)",
	async (corrupt) => {
		const root = await mkdtemp(join(tmpdir(), "wuming-provider-wire-"));
		const store = new SqliteOrchestratorStore(join(root, "test.db"));
		const requests: WireRequest[] = [];
		const serverErrors: unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				expect(request.method).toBe("POST");
				expect(request.url).toBe("/v1/chat/completions");
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest;
				requests.push(body);
				const step = requests.length;
				expect(step).toBeLessThanOrEqual(4);
				let call: { name: string; arguments: string } | undefined;
				if (step === 1) call = { name: "read_file", arguments: JSON.stringify({ path: "input.txt" }) };
				if (step === 2) {
					const observed = body.messages.at(-1);
					expect(observed?.role).toBe("tool");
					expect(typeof observed?.content).toBe("string");
					const content = observed!.content!;
					call = {
						name: "write_file",
						arguments: JSON.stringify({
							path: "output.txt",
							content: corrupt ? content.slice(17) : content,
						}),
					};
				}
				if (step === 3) call = { name: "read_file", arguments: JSON.stringify({ path: "output.txt" }) };
				const deltas: Record<string, unknown>[] = [{ role: "assistant", content: "" }];
				if (call) {
					deltas.push({
						tool_calls: [
							{
								index: 0,
								id: "call_" + step,
								type: "function",
								function: { name: call.name, arguments: "" },
							},
						],
					});
					for (let start = 0; start < call.arguments.length; start += 7) {
						deltas.push({
							tool_calls: [{ index: 0, function: { arguments: call.arguments.slice(start, start + 7) } }],
						});
					}
				} else deltas.push({ content: "WUMING_FILE_OK" });
				const frames = deltas.map((delta) => ({
					id: "completion_" + step,
					object: "chat.completion.chunk",
					created: 1,
					model: "wire-model",
					choices: [{ index: 0, delta, finish_reason: null }],
				}));
				const end = {
					id: "completion_" + step,
					object: "chat.completion.chunk",
					created: 1,
					model: "wire-model",
					choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
				};
				const wire = Buffer.from(
					[...frames, end].map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n"
				);
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				// Fragment UTF-8 and SSE JSON boundaries as a transport may do.
				for (let start = 0; start < wire.length; start += 11) response.write(wire.subarray(start, start + 11));
				response.end();
			} catch (error) {
				serverErrors.push(error);
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
			if (!address || typeof address === "string") throw new Error("No loopback port");
			const workspace = join(root, "workspace");
			const agentDir = join(root, "agent");
			await mkdir(workspace);
			await mkdir(agentDir);
			const proof = "WUMING_FILE_PROOF_" + randomUUID() + "\n中文🙂\r\n";
			await writeFile(join(workspace, "input.txt"), proof, "utf8");
			const files = await WorkspaceFileExecutor.create(workspace, {
				maxReadBytes: 4096,
				maxWriteBytes: 4096,
			});
			const approvals = new ApprovalBroker({ store });
			runtime = new PiAgentRuntime({
				createSession: createDefaultPiSessionFactory({
					agentDir,
					sessionDataDir: join(root, "sessions"),
					resolveWorkspace: () => workspace,
					autoRetry: false,
					autoCompaction: false,
					initialToolChoice: "required",
					registerProviders: () => [
						{
							provider: "wire-test",
							config: {
								baseUrl: "http://127.0.0.1:" + address.port + "/v1",
								api: "openai-completions",
								apiKey: "local-test-only",
								models: [
									{
										id: "wire-model",
										name: "wire-model",
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
					createCustomTools: (snapshot) =>
						createSandboxTools({ snapshot, executor: { files }, approvals }).filter(
							(tool) => tool.name === "read_file" || tool.name === "write_file"
						),
				}),
			});
			const orchestrator = new SessionOrchestrator(store, runtime, {
				turnTimeoutMs: 10000,
				maxRetries: 0,
			});
			const created = await orchestrator.createSession({
				principalId: "test",
				idempotencyKey: "create",
				workspaceId: "test",
				model: { provider: "wire-test", id: "wire-model" },
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
				content: [
					{
						type: "text",
						text: "Read input.txt, copy it exactly to output.txt, read back, then say WUMING_FILE_OK.",
					},
				],
			});
			await orchestrator.drainSession(sessionId);
			expect(serverErrors).toEqual([]);
			expect(
				store.listOperations(sessionId).map((operation) => ({ status: operation.status, error: operation.error }))
			).toEqual([{ status: "completed", error: undefined }]);
			expect(requests).toHaveLength(4);
			for (const request of requests) {
				expect(request.model).toBe("wire-model");
				expect(request.stream).toBe(true);
				expect(request.max_tokens ?? request.max_completion_tokens).toBe(256);
				expect(request.tools.map((tool) => tool.function.name).sort()).toEqual(["read_file", "write_file"]);
			}
			expect(requests[0]!.tool_choice).toBe("required");
			expect(requests.slice(1).every((request) => request.tool_choice !== "required")).toBe(true);
			expect(requests[1]!.messages.at(-1)).toMatchObject({
				role: "tool",
				tool_call_id: "call_1",
				content: proof,
			});
			const expectedOutput = corrupt ? proof.slice(17) : proof;
			expect(requests[3]!.messages.at(-1)).toMatchObject({
				role: "tool",
				tool_call_id: "call_3",
				content: expectedOutput,
			});
			const snapshot = store.loadSnapshot(sessionId)!;
			expect(snapshot.session.phase).toBe("idle");
			const tools = snapshot.transcript.filter((item) => item.type === "tool");
			expect(tools[1]!.input).toEqual({ path: "output.txt", content: expectedOutput });
			const output = await readFile(join(workspace, "output.txt"), "utf8");
			expect(output).toBe(expectedOutput);
			const verify = () => verifyFileRoundTrip(proof, output, tools, workspace);
			if (corrupt) expect(verify).toThrow("File round-trip content does not match");
			else expect(verify).not.toThrow();
			const assistant = snapshot.transcript.findLast((item) => item.type === "assistant");
			expect(assistant).toMatchObject({
				status: "complete",
				content: [{ type: "text", text: "WUMING_FILE_OK" }],
			});
		} finally {
			try {
				await runtime?.[Symbol.asyncDispose]();
			} finally {
				store.close();
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await rm(root, { recursive: true, force: true });
			}
		}
	},
	20000
);

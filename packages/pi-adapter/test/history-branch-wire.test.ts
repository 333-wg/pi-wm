import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createDefaultPiSessionFactory } from "../src/default-factory.js";
import { PiAgentRuntime } from "../src/pi-agent-runtime.js";

it.each([false, true])(
	"preserves provider history on edit, continue and fork (restart=%s)",
	async (restart) => {
		const root = await mkdtemp(join(tmpdir(), "wuming-history-wire-"));
		const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
		const server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			requests.push(body);
			const step = requests.length;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			const frame = (delta: object, finish_reason: string | null = null) =>
				"data: " +
				JSON.stringify({
					id: `history-${step}`,
					object: "chat.completion.chunk",
					created: 1,
					model: "history-model",
					choices: [{ index: 0, delta, finish_reason }],
				}) +
				"\n\n";
			if (step === 1) {
				response.write(
					frame({
						role: "assistant",
						tool_calls: [
							{ index: 0, id: "confirmed-write", type: "function", function: { name: "write", arguments: "{}" } },
						],
					})
				);
				response.write(frame({}, "tool_calls"));
			} else {
				response.write(
					frame({
						role: "assistant",
						content: step === 2 ? "CONFIRMED_PROGRESS" : step === 3 ? "OBSOLETE_ANSWER" : "CURRENT_ANSWER",
					})
				);
				response.write(frame({}, "stop"));
			}
			response.end("data: [DONE]\n\n");
		});
		let store: SqliteOrchestratorStore | undefined;
		let runtime: PiAgentRuntime | undefined;
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("No test port");
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
						provider: "history-test",
						config: {
							baseUrl: `http://127.0.0.1:${address.port}/v1`,
							api: "openai-completions",
							apiKey: "test-only",
							models: [
								{
									id: "history-model",
									name: "history-model",
									reasoning: false,
									input: ["text"],
									contextWindow: 128000,
									maxTokens: 128,
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
						description: "Write once",
						parameters: Type.Object({}),
						execute: async () => {
							writes++;
							return { content: [{ type: "text", text: "RAW_CONFIRMED_RESULT" }], details: {} };
						},
					},
				],
			});
			store = new SqliteOrchestratorStore(join(root, "test.db"));
			const createRuntime = () =>
				new PiAgentRuntime({
					createSession: factory,
					resolveRecoveryOperations: (snapshot) => store!.listRecoveryOperations(snapshot.session.id),
				});
			runtime = createRuntime();
			let orchestrator = new SessionOrchestrator(store, runtime);
			const { snapshot: created } = await orchestrator.createSession({
				principalId: "test",
				idempotencyKey: "create",
				workspaceId: "workspace",
				model: { provider: "history-test", id: "history-model" },
				thinkingLevel: "off",
				sandboxMode: "workspace_write",
				approvalPolicy: "never",
			});
			const id = created.session.id;
			const send = async (text: string, sessionId = id, edit?: { itemId: string; expectedRevision: number }) => {
				await orchestrator.acceptTurn({
					principalId: "test",
					idempotencyKey: `${sessionId}:${text}`,
					sessionId,
					mode: "prompt",
					content: [{ type: "text", text }],
					...(edit ? { edit } : {}),
				});
				await orchestrator.drainSession(sessionId);
				const last = store!.listOperations(sessionId, 1)[0]!;
				expect(last.status, last.error).toBe("completed");
			};
			await send("ORIGINAL_RELEASE_TASK");
			const first = store.loadSnapshot(id)!;
			const firstReply = first.transcript.at(-1)!;
			await send("OBSOLETE_TASK");
			const source = store.loadSnapshot(id)!;
			const obsolete = source.transcript.find(
				(item) =>
					item.type === "user" && item.content.some((part) => part.type === "text" && part.text === "OBSOLETE_TASK")
			)!;
			await orchestrator.acceptTurn({
				principalId: "test",
				idempotencyKey: "edit",
				sessionId: id,
				mode: "prompt",
				content: [{ type: "text", text: "REVISED_TASK" }],
				edit: { itemId: obsolete.id, expectedRevision: source.revision },
			});
			if (restart) {
				await runtime[Symbol.asyncDispose]();
				store.close();
				store = new SqliteOrchestratorStore(join(root, "test.db"));
				runtime = createRuntime();
				orchestrator = new SessionOrchestrator(store, runtime);
			}
			await orchestrator.drainSession(id);
			expect(store.listOperations(id, 1)[0]!.status).toBe("completed");
			const editedRequest = JSON.stringify(requests.at(-1)!.messages);
			for (const text of [
				"ORIGINAL_RELEASE_TASK",
				"RAW_CONFIRMED_RESULT",
				"CONFIRMED_PROGRESS",
				"REVISED_TASK",
				"does not undo",
			])
				expect(editedRequest).toContain(text);
			for (const text of ["OBSOLETE_TASK", "OBSOLETE_ANSWER"]) expect(editedRequest).not.toContain(text);
			await send("CONTINUE");
			expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain("OBSOLETE_TASK");
			expect(writes).toBe(1);
			const fork = await orchestrator.forkSession({
				principalId: "test",
				idempotencyKey: "fork",
				sessionId: id,
				fromItemId: firstReply.id,
			});
			expect(fork.snapshot.session.id).not.toBe(id);
			await runtime[Symbol.asyncDispose]();
			runtime = createRuntime();
			orchestrator = new SessionOrchestrator(store, runtime);
			await send("FORK_CONTINUE", fork.snapshot.session.id);
			const forkRequest = JSON.stringify(requests.at(-1)!.messages);
			for (const text of ["ORIGINAL_RELEASE_TASK", "RAW_CONFIRMED_RESULT", "CONFIRMED_PROGRESS", "FORK_CONTINUE"])
				expect(forkRequest).toContain(text);
			for (const text of ["REVISED_TASK", "OBSOLETE_TASK", "OBSOLETE_ANSWER"]) expect(forkRequest).not.toContain(text);
			const forkState = store.loadSnapshot(fork.snapshot.session.id)!;
			await send("REWRITE_FIRST", forkState.session.id, {
				itemId: forkState.transcript[0]!.id,
				expectedRevision: forkState.revision,
			});
			const firstEdit = JSON.stringify(requests.at(-1)!.messages);
			expect(firstEdit).toContain("REWRITE_FIRST");
			for (const text of ["ORIGINAL_RELEASE_TASK", "RAW_CONFIRMED_RESULT", "FORK_CONTINUE"])
				expect(firstEdit).not.toContain(text);
			expect(store.loadSnapshot(forkState.session.id)!.session.id).toBe(forkState.session.id);
			expect(writes).toBe(1);
		} finally {
			await runtime?.[Symbol.asyncDispose]();
			store?.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	},
	30000
);

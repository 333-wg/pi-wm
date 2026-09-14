import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { createDefaultPiSessionFactory, PiAgentRuntime } from "@wuming/pi-adapter";
import { ApprovalBroker, createSandboxTools, WorkspaceFileExecutor } from "@wuming/sandbox";
import { expect, it } from "vitest";
import { ManagedSkillCatalog } from "../../apps/gateway/src/managed-skill-catalog.js";
import { createSkillTools, skillDiscoveryFragment } from "../../apps/gateway/src/skill-tools.js";

interface RequestBody {
	messages: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }>;
	tools: Array<{ function: { name: string; description?: string } }>;
}

// Scripted provider, real SDK/tool/store plumbing. This proves transport and
// persistence, not whether a remote model independently chooses the procedure.
it.each([false, true])(
	"carries skill and recovery evidence through the wire (provider fails after tools=%s)",
	async (failAfterTools) => {
		const root = await mkdtemp(join(tmpdir(), "wuming-skill-wire-"));
		const store = new SqliteOrchestratorStore(join(root, "test.db"));
		const requests: RequestBody[] = [];
		const errors: unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
				requests.push(body);
				const step = requests.length;
				expect(step).toBeLessThanOrEqual(6);
				const system = body.messages.find((message) => message.role === "system")?.content ?? "";
				const loadDescription = body.tools.find((tool) => tool.function.name === "skill_load")?.function.description;
				expect(loadDescription).toContain('"id":"debug"');
				expect(loadDescription).not.toContain("# Evidence-led debugging");
				expect(loadDescription).not.toContain('"id":"manual-wire"');
				expect(system).toContain("skills:discovery");
				expect(system).toContain("even if you could solve it directly");
				expect(system).not.toContain("# Evidence-led debugging");
				if (step === 5) expect(system).toContain("MANUAL_WIRE_INSTRUCTIONS");
				else expect(system).not.toContain("MANUAL_WIRE_INSTRUCTIONS");
				const lastContent = body.messages.at(-1)?.content ?? "";
				const previous =
					typeof lastContent === "string" ? lastContent : lastContent.map((part) => part.text ?? "").join("\n");
				if (step === 2) expect(previous).toContain("Wuming recovery (configuration, attempt 1)");
				if (step === 3) {
					expect(previous).toContain("# Evidence-led debugging");
					expect(previous).toMatch(/sha256:[a-f0-9]{64}/);
				}
				if (step === 4) expect(previous).toContain("changed_attempt_succeeded");
				if (step === 4 && failAfterTools) {
					response.writeHead(429, { "Content-Type": "application/json" }).end(
						JSON.stringify({
							error: { message: "Rate limited after tools", type: "rate_limit_error" },
						})
					);
					return;
				}
				const call =
					step === 1
						? { name: "read_file", arguments: JSON.stringify({ path: "config.txt" }) }
						: step === 2
							? { name: "skill_load", arguments: JSON.stringify({ skillId: "debug" }) }
							: step === 3
								? { name: "read_file", arguments: JSON.stringify({ path: "config.local.txt" }) }
								: undefined;
				// The final answer gets its proof solely from the actual tool response.
				const answer =
					step === 5
						? "MANUAL_WIRE_OK"
						: step === 6
							? "GREETING_OK"
							: previous.match(/proof=(SKILL_WIRE_[a-f0-9-]+)/)?.[1];
				if (!call) expect(answer).toBeTruthy();
				const delta = call
					? {
							role: "assistant",
							tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: call }],
						}
					: { role: "assistant", content: answer };
				const frames = [
					{ choices: [{ index: 0, delta, finish_reason: null }] },
					{
						choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					},
				].map((frame) => ({
					id: `completion_${step}`,
					object: "chat.completion.chunk",
					created: 1,
					model: "wire-model",
					...frame,
				}));
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
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
			const manual = join(workspace, ".wuming", "skills", "manual-wire");
			await mkdir(manual, { recursive: true });
			await writeFile(
				join(manual, "SKILL.md"),
				"---\nname: manual-wire\ndescription: Manual test\ndisable-model-invocation: true\n---\nMANUAL_WIRE_INSTRUCTIONS: Reply MANUAL_WIRE_OK."
			);
			const proof = `SKILL_WIRE_${randomUUID()}`;
			await writeFile(join(workspace, "config.local.txt"), `proof=${proof}\n`);
			const files = await WorkspaceFileExecutor.create(workspace, {
				maxReadBytes: 4096,
				maxWriteBytes: 4096,
			});
			const approvals = new ApprovalBroker({ store });
			const catalog = new ManagedSkillCatalog();
			runtime = new PiAgentRuntime({
				resolveContextFragments: async () => [skillDiscoveryFragment(await catalog.list("test", workspace))],
				resolveSkills: async (_snapshot, ids) =>
					Promise.all(
						ids.map(async (id) => {
							const skill = await catalog.get("test", workspace, id);
							return { id, name: skill.name, content: skill.content, truncated: skill.truncated };
						})
					),
				createSession: createDefaultPiSessionFactory({
					agentDir: join(root, "agent"),
					sessionDataDir: join(root, "sessions"),
					resolveWorkspace: () => workspace,
					autoRetry: false,
					autoCompaction: false,
					registerProviders: () => [
						{
							provider: "wire-test",
							config: {
								baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
					createCustomTools: async (snapshot) => [
						...createSandboxTools({
							snapshot,
							executor: { files },
							approvals,
							protectSkillSources: true,
						}).filter((tool) => tool.name === "read_file"),
						...createSkillTools(catalog.manager(workspace), "test", await catalog.list("test", workspace)),
					],
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
				sandboxMode: "read_only",
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
						text: "Read config.txt and report proof. Inspect available alternatives if missing.",
					},
				],
			});
			await orchestrator.drainSession(sessionId);
			expect(errors).toEqual([]);
			expect(store.listOperations(sessionId)[0]).toMatchObject({
				status: failAfterTools ? "failed" : "completed",
			});
			expect(requests).toHaveLength(4);
			const snapshot = store.loadSnapshot(sessionId)!;
			const tools = snapshot.transcript.filter((item) => item.type === "tool");
			expect(tools.map((tool) => [tool.toolName, tool.isError])).toEqual([
				["read_file", true],
				["skill_load", false],
				["read_file", false],
			]);
			expect(tools[1]?.input).toEqual({ skillId: "debug" });
			expect(snapshot.usageByTurn?.at(-1)?.skills).toEqual(["debug"]);
			if (failAfterTools) {
				expect(snapshot.transcript.findLast((item) => item.type === "assistant")).toMatchObject({
					status: "error",
				});
				expect(JSON.stringify(tools[2]?.content)).toContain(proof);
				return;
			}
			expect(snapshot.transcript.findLast((item) => item.type === "assistant")).toMatchObject({
				status: "complete",
				content: [{ type: "text", text: proof }],
			});
			await orchestrator.acceptTurn({
				principalId: "test",
				idempotencyKey: "manual",
				sessionId,
				mode: "prompt",
				skills: ["manual-wire"],
				content: [{ type: "text", text: "Use my selected skill." }],
			});
			await orchestrator.drainSession(sessionId);
			await orchestrator.acceptTurn({
				principalId: "test",
				idempotencyKey: "greeting",
				sessionId,
				mode: "prompt",
				content: [{ type: "text", text: "Just say hello." }],
			});
			await orchestrator.drainSession(sessionId);
			expect(errors).toEqual([]);
			expect(requests).toHaveLength(6);
			expect(store.listOperations(sessionId).every((operation) => operation.status === "completed")).toBe(true);
			expect(store.loadSnapshot(sessionId)?.usageByTurn?.map((turn) => turn.skills)).toEqual([
				["debug"],
				["manual-wire"],
				[],
			]);
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

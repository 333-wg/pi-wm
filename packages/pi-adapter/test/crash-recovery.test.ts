import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { expect, it } from "vitest";
import { crashRuntime, recoverySse, type CrashStage, type RecoveryApi } from "./crash-recovery-fixtures.js";

const scenarios = (["openai-completions", "openai-responses", "anthropic-messages"] as RecoveryApi[]).flatMap((api) =>
	(["first-response", "tool-side-effect", "tool-result"] as CrashStage[]).map((stage) => ({ api, stage }))
);

it.each(scenarios)(
	"recovers a killed process: $api / $stage",
	async ({ api, stage }) => {
		const root = await mkdtemp(join(tmpdir(), "wuming-killed-recovery-"));
		let recovering = false;
		let blockedProvider = false;
		let initialRequests = 0;
		const resumedRequests: Record<string, unknown>[] = [];
		const errors: unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				if (!recovering) {
					initialRequests++;
					if (stage === "first-response" || initialRequests > 1) {
						response.flushHeaders();
						blockedProvider = true;
						return;
					}
					response.end(recoverySse(api, "write"));
					return;
				}
				resumedRequests.push(body);
				const history = JSON.stringify(body.input ?? body.messages);
				expect(history).toContain("Build a library management system");
				expect(history).toContain("runtime_restart");
				expect(history).toContain("Continue");
				if (stage === "tool-result") expect(history).toContain("RAW_TOOL_RESULT");
				if (stage === "tool-side-effect") {
					expect(history).toContain("No result provided");
					expect(history).not.toContain("RAW_TOOL_RESULT");
				}
				// Unknown side effects must be inspectable from the next model turn.
				response.end(
					recoverySse(api, stage === "tool-side-effect" && resumedRequests.length === 1 ? "inspect" : undefined)
				);
			} catch (error) {
				errors.push(error);
				response.end(recoverySse(api, undefined, "Fixture assertion failed"));
			}
		});
		let worker: ChildProcess | undefined;
		let workerExit: Promise<void> | undefined;
		let runtime: ReturnType<typeof crashRuntime> | undefined;
		let store: SqliteOrchestratorStore | undefined;
		let output = "";
		let stderr = "";
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("No test port");
			const baseUrl = `http://127.0.0.1:${address.port}/v1`;
			worker = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					fileURLToPath(new URL("./fixtures/crash-worker.ts", import.meta.url)),
					root,
					baseUrl,
					api,
					stage,
				],
				{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
			);
			worker.stdout!.on("data", (chunk) => {
				output += chunk.toString();
			});
			worker.stderr!.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			workerExit = new Promise<void>((resolve) => {
				worker!.once("exit", () => resolve());
				worker!.once("error", () => resolve());
			});
			await expect
				.poll(
					() => {
						if (worker!.exitCode !== null) throw new Error(`Worker exited early: ${output}\n${stderr}`);
						return stage === "tool-side-effect" ? output.includes("SIDE_EFFECT_READY") : blockedProvider;
					},
					{ timeout: 15000 }
				)
				.toBe(true);
			const sessionId = /SESSION:([^\r\n]+)/.exec(output)?.[1];
			expect(sessionId).toBeTruthy();
			worker.kill("SIGKILL");
			await workerExit;
			server.closeAllConnections();
			recovering = true;
			store = new SqliteOrchestratorStore(join(root, "session.db"));
			store.clearWriterLeases();
			runtime = crashRuntime(root, baseUrl, api, store);
			const orchestrator = new SessionOrchestrator(store, runtime, { maxRetries: 0, turnTimeoutMs: 10000 });
			expect(orchestrator.recoverInterruptedOperations()).toBe(1);
			const recoveredOperations = store.listRecoveryOperations(sessionId!);
			expect(recoveredOperations).toHaveLength(1);
			expect(recoveredOperations[0]).toMatchObject({ status: "interrupted", failureKind: "runtime_restart" });
			await orchestrator.acceptTurn({
				principalId: "test",
				idempotencyKey: "continue",
				sessionId: sessionId!,
				mode: "prompt",
				content: [{ type: "text", text: "Continue" }],
			});
			await orchestrator.drainSession(sessionId!);
			expect(errors).toEqual([]);
			expect(store.listOperations(sessionId!)[0]).toMatchObject({ status: "completed" });
			expect(resumedRequests).toHaveLength(stage === "tool-side-effect" ? 2 : 1);
			if (stage !== "first-response")
				expect(await readFile(join(root, "writes.txt"), "utf8")).toBe("library-manager\n");
			else await expect(readFile(join(root, "writes.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			if (worker?.exitCode === null) worker.kill("SIGKILL");
			await workerExit;
			await runtime?.[Symbol.asyncDispose]();
			store?.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	},
	30000
);

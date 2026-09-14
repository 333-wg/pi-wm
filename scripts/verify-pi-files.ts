import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { createDefaultPiSessionFactory, PiAgentRuntime } from "@wuming/pi-adapter";
import { ApprovalBroker, createSandboxTools, WorkspaceFileExecutor } from "@wuming/sandbox";
import { loadSavedModelSource, smokeRegistrations } from "./lib/saved-model-source.js";
import { verifyFileRoundTrip } from "./lib/file-acceptance.js";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(name + " is required");
	return value;
}

async function main(): Promise<void> {
	const agentDir = resolve(required("WUMING_AGENT_DIR"));
	const provider = required("WUMING_MODEL_PROVIDER");
	const modelId = required("WUMING_MODEL_ID");
	const source = await loadSavedModelSource(
		required("WUMING_PI_MODEL_SOURCE_DIR"),
		process.env.WUMING_MODEL_CONFIG_KEY
	);
	const registrations = smokeRegistrations(source.registrations, provider, modelId);
	const temporary = await mkdtemp(join(tmpdir(), "wuming-real-files-"));
	let store: SqliteOrchestratorStore | undefined;
	let runtime: PiAgentRuntime | undefined;
	try {
		const workspace = join(temporary, "workspace");
		await mkdir(workspace);
		const proof = "WUMING_FILE_PROOF_" + randomUUID() + "\n";
		const executionEvidence: {
			toolName: string;
			inputMatchesProof?: boolean;
			resultMatchesProof?: boolean;
			resultBytes?: number;
		}[] = [];
		await writeFile(join(workspace, "input.txt"), proof, "utf8");
		store = new SqliteOrchestratorStore(join(temporary, "verification.db"));
		const approvals = new ApprovalBroker({ store });
		const files = await WorkspaceFileExecutor.create(workspace, {
			maxReadBytes: 4096,
			maxWriteBytes: 4096,
		});
		runtime = new PiAgentRuntime({
			createSession: createDefaultPiSessionFactory({
				agentDir,
				sessionDataDir: join(temporary, "sessions"),
				resolveWorkspace: () => workspace,
				autoRetry: false,
				autoCompaction: false,
				initialToolChoice: "required",
				registerProviders: () => registrations,
				createCustomTools: (snapshot) =>
					createSandboxTools({ snapshot, executor: { files }, approvals })
						.filter((tool) => tool.name === "read_file" || tool.name === "write_file")
						.map((tool) => ({
							...tool,
							execute: async (...args: Parameters<typeof tool.execute>) => {
								const result = await tool.execute(...args);
								const text = result.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("");
								const params = args[1] as { content?: unknown };
								executionEvidence.push(
									tool.name === "write_file"
										? { toolName: tool.name, inputMatchesProof: params.content === proof }
										: {
												toolName: tool.name,
												resultMatchesProof: text === proof,
												resultBytes: Buffer.byteLength(text),
											}
								);
								return result;
							},
						})),
			}),
		});
		const orchestrator = new SessionOrchestrator(store, runtime, {
			turnTimeoutMs: 30_000,
			maxRetries: 0,
		});
		const principalId = "real-file-verifier";
		const created = await orchestrator.createSession({
			principalId,
			idempotencyKey: randomUUID(),
			workspaceId: "verification",
			model: { provider, id: modelId },
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "never",
			tokenBudget: 8000,
		});
		const sessionId = created.snapshot.session.id;
		await orchestrator.acceptTurn({
			principalId,
			idempotencyKey: randomUUID(),
			sessionId,
			mode: "prompt",
			content: [
				{
					type: "text",
					text: "Use read_file to read input.txt, then use write_file to write its exact contents to output.txt, then use read_file to verify output.txt. Preserve the final newline in input.txt: the output must contain the same single line followed by one newline character. Do not copy any tool display wrappers or line-number prefixes. Make exactly these three tool calls in order. Do not create other files. Finish with exactly WUMING_FILE_OK.",
				},
			],
		});
		await orchestrator.drainSession(sessionId);
		const operations = store.listOperations(sessionId);
		if (operations.length !== 1 || operations[0]?.status !== "completed") {
			let detail = operations[0]?.error ?? "no operation error available";
			for (const registration of source.registrations) {
				const secret = registration.config.apiKey;
				if (typeof secret === "string" && secret) detail = detail.replaceAll(secret, "[redacted]");
			}
			console.error(
				JSON.stringify({
					status: operations[0]?.status,
					failureKind: operations[0]?.failureKind,
					error: detail.slice(0, 1000),
					executionEvidence,
				})
			);
			throw new Error("File verification operation did not complete");
		}
		const snapshot = store.loadSnapshot(sessionId);
		if (!snapshot || snapshot.session.phase !== "idle") throw new Error("File verification did not settle");
		const tools = snapshot.transcript.filter((item) => item.type === "tool");
		const output = await readFile(join(workspace, "output.txt"), "utf8");
		console.log(
			JSON.stringify({
				kind: "file-verification-evidence",
				expectedBytes: Buffer.byteLength(proof),
				actualBytes: Buffer.byteLength(output),
				missingTrailingNewline: output === proof.trimEnd(),
				executionEvidence,
				tools: tools.map((tool) => ({
					name: tool.toolName,
					status: tool.status,
					isError: tool.isError ?? false,
				})),
				usage: snapshot.usage,
			})
		);
		verifyFileRoundTrip(proof, output, tools, workspace);
		const assistant = [...snapshot.transcript].reverse().find((item) => item.type === "assistant");
		if (
			!assistant ||
			assistant.type !== "assistant" ||
			assistant.status !== "complete" ||
			assistant.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("")
				.trim() !== "WUMING_FILE_OK"
		)
			throw new Error("File verification final answer did not match");
		console.log(
			JSON.stringify(
				{
					ok: true,
					kind: "real-file-round-trip",
					provider,
					modelId,
					checks: [
						"durable-operation-completed",
						"exact-input-copy",
						"ordered-read-write-read",
						"successful-tool-results",
						"exact-final-answer",
					],
					usage: snapshot.usage,
				},
				null,
				2
			)
		);
	} finally {
		try {
			await runtime?.[Symbol.asyncDispose]();
		} finally {
			store?.close();
			await rm(temporary, { recursive: true, force: true });
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

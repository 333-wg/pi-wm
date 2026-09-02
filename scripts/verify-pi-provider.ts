import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createDefaultPiSessionFactory, PiAgentRuntime } from "../packages/pi-adapter/src/index.js";
import type { DurableOperation } from "../packages/orchestrator/src/index.js";
import type { SessionSnapshot } from "../packages/protocol/src/index.js";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };

async function main(): Promise<void> {
	const agentDir = resolve(required("WUMING_AGENT_DIR"));
	const provider = required("WUMING_MODEL_PROVIDER");
	const modelId = required("WUMING_MODEL_ID");
	const workspace = resolve(process.env.WUMING_WORKSPACE?.trim() || process.cwd());
	const prompt = process.env.WUMING_PI_SMOKE_PROMPT?.trim() || "Reply with exactly: WUMING_PI_OK";
	const temporary = await mkdtemp(join(tmpdir(), "wuming-pi-smoke-"));
	const sessionId = `pi-smoke-${randomUUID()}`;
	const snapshot: SessionSnapshot = {
		session: { id: sessionId, workspaceId: "smoke-workspace", phase: "turn", createdAt: Date.now(), updatedAt: Date.now() },
		revision: 1,
		model: { provider, id: modelId },
		thinkingLevel: "off",
		sandboxMode: "read_only",
		approvalPolicy: "never",
		transcript: [],
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		pendingApprovals: [],
		usage: zeroUsage,
	};
	const operation: DurableOperation = {
		id: randomUUID(),
		sessionId,
		type: "turn",
		status: "running",
		payload: { type: "turn", mode: "prompt", userItemId: randomUUID(), content: [{ type: "text", text: prompt }] },
		attempt: 1,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		abortRequested: false,
	};
	const runtime = new PiAgentRuntime({
		createSession: createDefaultPiSessionFactory({ agentDir, sessionDataDir: temporary, resolveWorkspace: () => workspace, autoRetry: false }),
	});
	try {
		const result = await runtime.executeTurn({ operation: operation as DurableOperation & { payload: typeof operation.payload }, snapshot, signal: new AbortController().signal, onProgress: () => {} });
		if (result.failure) throw new Error(`${result.failure.message} (retryable=${result.failure.retryable === true})`);
		const assistant = [...result.items].reverse().find((item) => item.type === "assistant");
		if (!assistant || assistant.type !== "assistant" || assistant.status !== "complete") throw new Error("Pi provider returned no completed assistant message");
		const text = assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
		if (!text) throw new Error("Pi provider returned an empty assistant message");
		console.log(JSON.stringify({ ok: true, provider, modelId, response: text, usage: result.usage ?? zeroUsage }, null, 2));
	} finally {
		await runtime[Symbol.asyncDispose]();
		await rm(temporary, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { crashRuntime, type CrashStage, type RecoveryApi } from "../crash-recovery-fixtures.js";

const [root, baseUrl, api, stage] = process.argv.slice(2) as [string, string, RecoveryApi, CrashStage];
const store = new SqliteOrchestratorStore(join(root, "session.db"));
const runtime = crashRuntime(root, baseUrl, api, store, stage);
const orchestrator = new SessionOrchestrator(store, runtime, { maxRetries: 0, turnTimeoutMs: 60000 });
const created = await orchestrator.createSession({
	principalId: "test",
	idempotencyKey: "create",
	workspaceId: "workspace",
	model: { provider: "recovery-test", id: "recovery-model" },
	thinkingLevel: "off",
	sandboxMode: "workspace_write",
	approvalPolicy: "never",
});
console.log(`SESSION:${created.snapshot.session.id}`);
await orchestrator.acceptTurn({
	principalId: "test",
	idempotencyKey: "original",
	sessionId: created.snapshot.session.id,
	mode: "prompt",
	content: [{ type: "text", text: "Build a library management system" }],
});
await orchestrator.drainSession(created.snapshot.session.id);
throw new Error("Crash fixture unexpectedly finished instead of waiting for termination");

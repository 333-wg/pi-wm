import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "@wuming/protocol";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createDefaultPiSessionFactory } from "../src/default-factory.js";
import type { PiSessionLike } from "../src/types.js";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("disables Pi host tools while keeping Wuming custom tools active", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-pi-factory-"));
	directories.push(root);
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	const sessionDataDir = join(root, "sessions");
	await mkdir(agentDir);
	await mkdir(workspace);
	await writeFile(join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"factory-test": {
				baseUrl: "https://example.invalid/v1",
				api: "openai-completions",
				apiKey: "test-only",
				models: [{ id: "test-model" }],
			},
		},
	}));
	const customWrite: ToolDefinition = {
		name: "write",
		label: "write",
		description: "Test-only Wuming write tool",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
	const snapshot: SessionSnapshot = {
		session: { id: "factory-session", workspaceId: "workspace", phase: "idle", createdAt: 1, updatedAt: 1 },
		revision: 1,
		model: { provider: "factory-test", id: "test-model" },
		thinkingLevel: "off",
		sandboxMode: "workspace_write",
		approvalPolicy: "on_risk",
		transcript: [],
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		pendingApprovals: [],
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
	};
	const session = await createDefaultPiSessionFactory({
		agentDir,
		sessionDataDir,
		resolveWorkspace: () => workspace,
		createCustomTools: () => [customWrite],
	})(snapshot);

	try {
		const activeTools = (session as PiSessionLike & { agent: { state: { tools: Array<{ name: string }> } } }).agent.state.tools;
		expect(activeTools.map((tool) => tool.name)).toEqual(["write"]);
	} finally {
		session.dispose();
	}
});

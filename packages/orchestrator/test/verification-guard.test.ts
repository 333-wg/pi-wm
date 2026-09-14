import type { TranscriptItem, Usage, UsageToolSummary } from "@wuming/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore } from "../src/index.js";
import type { AgentRuntime } from "../src/types.js";

const usage = (overrides: Partial<Usage> = {}): Usage => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
	...overrides,
});

const tool = (toolName: string): UsageToolSummary => ({
	toolName,
	callCount: 1,
	usage: usage(),
});

class FakeRuntime implements AgentRuntime {
	tools: UsageToolSummary[] = [];

	async compact() {
		return { summary: "test", usage: usage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }) };
	}

	async executeTurn() {
		return {
			items: this.tools.map((tool, index): TranscriptItem => ({
				id: `tool-${index}`,
				type: "tool",
				toolCallId: `call-${index}`,
				toolName: tool.toolName,
				createdAt: 1_700_000_000_000 + index,
				status: "complete",
				input: tool.toolName === "exec" ? { command: "npm test" } : {},
				content: [{ type: "text", text: "ok" }],
				isError: false,
			})),
			usage: usage({ inputTokens: 1, totalTokens: 1 }),
			tools: this.tools,
		};
	}
}

describe("Verification Guard", () => {
	let store: SqliteOrchestratorStore;
	let orchestrator: SessionOrchestrator;
	let runtime: FakeRuntime;
	let sequence: number;

	beforeEach(() => {
		sequence = 0;
		store = new SqliteOrchestratorStore(":memory:");
		runtime = new FakeRuntime();
		orchestrator = new SessionOrchestrator(store, runtime, {
			clock: () => 1_700_000_000_000,
			idFactory: () => `test-${++sequence}`,
		});
	});

	afterEach(() => {
		store.close();
	});

	async function runTurn(tools: UsageToolSummary[]) {
		const created = await orchestrator.createSession({
			principalId: "user-1",
			idempotencyKey: `session-${sequence}`,
			workspaceId: "test-workspace",
			model: { provider: "anthropic", id: "claude-opus-4-20250514" },
			thinkingLevel: "medium",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		});
		const sessionId = created.snapshot.session.id;
		runtime.tools = tools;
		await orchestrator.acceptTurn({
			principalId: "user-1",
			idempotencyKey: `turn-${sequence}`,
			sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "update the code" }],
		});
		const operationId = store.listOperations(sessionId)[0]!.id;
		await orchestrator.drainSession(sessionId, `worker-${sequence}`);
		return { operationId, snapshot: store.loadSnapshot(sessionId)! };
	}

	it("generates a warning when code changes lack verification", async () => {
		const { operationId, snapshot } = await runTurn([tool("write_file"), tool("read_file")]);

		expect(snapshot.verificationWarnings).toEqual([
			expect.objectContaining({ operationId, changedTools: ["write_file"] }),
		]);
	});

	it("does not warn when code changes include verification", async () => {
		const { snapshot } = await runTurn([tool("write_file"), tool("exec")]);

		expect(snapshot.verificationWarnings).toEqual([]);
	});

	it("does not warn for pure read operations", async () => {
		const { snapshot } = await runTurn([tool("read_file"), tool("grep")]);

		expect(snapshot.verificationWarnings).toEqual([]);
	});

	it("warns when verification only happened before the final edit", async () => {
		const { snapshot } = await runTurn([tool("exec"), tool("edit")]);
		expect(snapshot.verificationWarnings).toHaveLength(1);
	});

	it("does not treat starting a server or opening a page as verification", async () => {
		const { snapshot } = await runTurn([tool("edit"), tool("preview_start"), tool("browser_open")]);
		expect(snapshot.verificationWarnings).toHaveLength(1);
	});

	it("recognizes screenshot inspection evidence after an edit", async () => {
		const { snapshot } = await runTurn([tool("edit"), tool("browser_screenshot")]);
		expect(snapshot.verificationWarnings).toEqual([]);
	});

	it("recognizes edit as a code change tool", async () => {
		const { operationId, snapshot } = await runTurn([tool("edit")]);

		expect(snapshot.verificationWarnings).toEqual([expect.objectContaining({ operationId, changedTools: ["edit"] })]);
	});
});

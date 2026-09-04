import type { SessionSnapshot, SubagentSummary } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { createAgencyTools, type SubagentRunner } from "../src/agency.js";

const emptyUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };

function snapshot(overrides: Partial<SessionSnapshot["session"]> = {}): SessionSnapshot {
	return {
		session: { id: "session-1", workspaceId: "workspace-1", phase: "turn", createdAt: 1, updatedAt: 1, ...overrides },
		revision: 1,
		model: { provider: "demo", id: "demo" },
		thinkingLevel: "medium",
		sandboxMode: "read_only",
		approvalPolicy: "on_risk",
		transcript: [],
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		pendingApprovals: [],
		usage: { ...emptyUsage },
	};
}

function summary(overrides: Partial<SubagentSummary> = {}): SubagentSummary {
	return {
		id: "sub-1",
		parentSessionId: "session-1",
		sessionId: "sub-1",
		operationId: "op-1",
		name: "callers",
		task: "Find every caller of the approval broker",
		depth: 1,
		status: "completed",
		createdAt: 1,
		updatedAt: 2,
		model: { provider: "demo", id: "demo" },
		thinkingLevel: "medium",
		sandboxMode: "read_only",
		approvalPolicy: "on_risk",
		usage: { ...emptyUsage, inputTokens: 5, outputTokens: 7, totalTokens: 12, costUsd: 0.0125 },
		pendingApprovals: [],
		result: "Three callers, all in packages/orchestrator.",
		...overrides,
	};
}

interface FakeRunner extends SubagentRunner {
	created: Array<Parameters<SubagentRunner["createSubagent"]>[0]>;
	drained: string[];
	cancelled: string[];
}

function fakeRunner(options: { summary?: SubagentSummary; drain?: () => Promise<number>; depth?: number } = {}): FakeRunner {
	const runner: FakeRunner = {
		created: [],
		drained: [],
		cancelled: [],
		async createSubagent(input) {
			runner.created.push(input);
			return { subagent: summary({ status: "running", name: input.name ?? "Subagent", task: input.task, result: undefined }) };
		},
		async drainSession(sessionId) {
			runner.drained.push(sessionId);
			return options.drain ? await options.drain() : 1;
		},
		subagentDepth: () => options.depth ?? 0,
		subagentSummary: () => options.summary ?? summary(),
		async cancelSubagent(input) {
			runner.cancelled.push(input.subagentId);
			return undefined;
		},
	};
	return runner;
}

function tool(tools: ReturnType<typeof createAgencyTools>, name: string) {
	const found = tools.find((entry) => entry.name === name);
	if (!found) throw new Error(`tool ${name} was not registered`);
	return found;
}

const signal = () => new AbortController().signal;

describe("update_plan", () => {
	it("renders progress, marks the active step, and echoes the explanation", async () => {
		const plan = tool(createAgencyTools({ snapshot: snapshot() }), "update_plan");

		const result = await plan.execute("call-1", {
			explanation: "Split the search from the edit",
			plan: [
				{ step: "Read the reducer", status: "completed" },
				{ step: "Thread the new field", status: "in_progress" },
				{ step: "Cover it with a test", status: "pending" },
			],
		}, signal());

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Split the search from the edit\nPlan updated (1/3 done)\n- [x] Read the reducer\n- [>] Thread the new field\n- [ ] Cover it with a test",
		});
		expect(result.details).toMatchObject({ total: 3, completed: 1, inProgress: 1 });
	});

	it("nudges the model when work remains but nothing is in progress", async () => {
		const plan = tool(createAgencyTools({ snapshot: snapshot() }), "update_plan");

		const stalled = await plan.execute("call-2", { plan: [{ step: "Ship it", status: "pending" }] }, signal());
		expect(stalled.content[0]?.text).toContain("No step is in progress.");

		const done = await plan.execute("call-3", { plan: [{ step: "Ship it", status: "completed" }] }, signal());
		expect(done.content[0]?.text).not.toContain("No step is in progress.");
	});

	it("rejects a plan with two steps in progress", async () => {
		const plan = tool(createAgencyTools({ snapshot: snapshot() }), "update_plan");

		await expect(plan.execute("call-4", {
			plan: [{ step: "One", status: "in_progress" }, { step: "Two", status: "in_progress" }],
		}, signal())).rejects.toThrow("at most one in_progress step; received 2");
	});
});

describe("subagent", () => {
	it("is offered while the session remains below the nesting limit", () => {
		const runner = fakeRunner();
		expect(createAgencyTools({ snapshot: snapshot(), runner }).map((entry) => entry.name)).toEqual(["update_plan", "subagent"]);
		expect(createAgencyTools({ snapshot: snapshot() }).map((entry) => entry.name)).toEqual(["update_plan"]);
		expect(createAgencyTools({ snapshot: snapshot({ id: "sub-1", parentSessionId: "session-1" }), runner: fakeRunner({ depth: 1 }) }).map((entry) => entry.name)).toEqual(["update_plan", "subagent"]);
		expect(createAgencyTools({ snapshot: snapshot({ id: "sub-3", parentSessionId: "sub-2" }), runner: fakeRunner({ depth: 3 }) }).map((entry) => entry.name)).toEqual(["update_plan"]);
	});

	it("delegates inline, drains the child, and returns its report with usage", async () => {
		const runner = fakeRunner();
		const subagent = tool(createAgencyTools({ snapshot: snapshot(), runner }), "subagent");

		const result = await subagent.execute("call-1", { task: "Find every caller", name: "callers", cost_budget_usd: 0.5 }, signal());

		expect(runner.created).toMatchObject([{
			principalId: "agent:session-1",
			idempotencyKey: "subagent-tool:call-1",
			sessionId: "session-1",
			task: "Find every caller",
			name: "callers",
			costBudgetUsd: 0.5,
			deliverInline: true,
		}]);
		expect(runner.created[0]).not.toHaveProperty("tokenBudget");
		expect(runner.drained).toEqual(["sub-1"]);
		expect(result.content[0]?.text).toBe("Subagent callers completed using 12 token(s), $0.0125.\n\nThree callers, all in packages/orchestrator.");
		expect(result.details).toMatchObject({ subagentId: "sub-1", depth: 1, status: "completed", truncated: false, costUsd: 0.0125, totalTokens: 12 });
	});

	it("truncates an oversized report", async () => {
		const runner = fakeRunner({ summary: summary({ result: "x".repeat(50) }) });
		const subagent = tool(createAgencyTools({ snapshot: snapshot(), runner, maxResultChars: 10 }), "subagent");

		const result = await subagent.execute("call-1", { task: "Summarise the tree" }, signal());

		expect(result.content[0]?.text).toContain(`${"x".repeat(10)}\n[report truncated]`);
		expect(result.details).toMatchObject({ truncated: true });
	});

	it("keeps going when another worker already holds the child's lease", async () => {
		const conflict = Object.assign(new Error("another worker owns this session"), { code: "lease_conflict" });
		const runner = fakeRunner({ drain: () => Promise.reject(conflict) });
		const subagent = tool(createAgencyTools({ snapshot: snapshot(), runner }), "subagent");

		await expect(subagent.execute("call-1", { task: "Find every caller" }, signal())).resolves.toMatchObject({
			details: { status: "completed" },
		});
	});

	it("propagates a drain failure that is not a lease conflict", async () => {
		const runner = fakeRunner({ drain: () => Promise.reject(new Error("store is closed")) });
		const subagent = tool(createAgencyTools({ snapshot: snapshot(), runner }), "subagent");

		await expect(subagent.execute("call-1", { task: "Find every caller" }, signal())).rejects.toThrow("store is closed");
	});

	it("surfaces failure and cancellation as tool errors, and an unfinished child as a note", async () => {
		const rootSnapshot = snapshot();
		const failed = tool(createAgencyTools({ snapshot: rootSnapshot, runner: fakeRunner({ summary: summary({ status: "failed", result: undefined, error: "budget exhausted" }) }) }), "subagent");
		await expect(failed.execute("call-1", { task: "t" }, signal())).rejects.toThrow("Subagent callers failed after 12 token(s), $0.0125: budget exhausted");

		const cancelled = tool(createAgencyTools({ snapshot: rootSnapshot, runner: fakeRunner({ summary: summary({ status: "cancelled", result: undefined }) }) }), "subagent");
		await expect(cancelled.execute("call-2", { task: "t" }, signal())).rejects.toThrow("Subagent callers was cancelled after 12 token(s), $0.0125.");

		const waiting = tool(createAgencyTools({ snapshot: rootSnapshot, runner: fakeRunner({ summary: summary({ status: "awaiting_approval", result: undefined }) }) }), "subagent");
		const result = await waiting.execute("call-3", { task: "t" }, signal());
		expect(result.content[0]?.text).toContain("is still awaiting_approval");
		expect(result.details).toMatchObject({ status: "awaiting_approval" });
	});

	it("cancels the child when the parent turn is aborted", async () => {
		const runner = fakeRunner({ drain: () => new Promise<number>(() => {}) });
		const subagent = tool(createAgencyTools({ snapshot: snapshot(), runner }), "subagent");
		const controller = new AbortController();

		const pending = subagent.execute("call-1", { task: "Find every caller" }, controller.signal);
		await Promise.resolve();
		controller.abort(new Error("turn interrupted"));

		expect(runner.cancelled).toEqual(["sub-1"]);
		void pending.catch(() => {});
	});
});

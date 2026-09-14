import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot, SubagentSummary } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { createAgencyTools, type SubagentRunner } from "../src/agency.js";

type ToolExecute = ToolDefinition["execute"];

// Pi calls a tool with five positional arguments. These tools stream nothing and
// never touch the extension context, so the tests pass what Pi passes for a
// context-free call and keep the signature in a single place.
function invoke(
	entry: ToolDefinition,
	toolCallId: string,
	params: Parameters<ToolExecute>[1],
	signal?: AbortSignal
): ReturnType<ToolExecute> {
	return entry.execute(toolCallId, params, signal, undefined, undefined as unknown as Parameters<ToolExecute>[4]);
}

/** The text of a result's first block; Pi's content union also allows images. */
function text(result: Awaited<ReturnType<ToolExecute>>): string {
	const block = result.content[0];
	if (!block || block.type !== "text") throw new Error(`expected a text block, got ${block?.type ?? "nothing"}`);
	return block.text;
}

const emptyUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
};

function snapshot(overrides: Partial<SessionSnapshot["session"]> = {}): SessionSnapshot {
	return {
		session: {
			id: "session-1",
			workspaceId: "workspace-1",
			phase: "turn",
			createdAt: 1,
			updatedAt: 1,
			...overrides,
		},
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

/**
 * A child with no report yet: still running, or finished without one. An
 * optional field cannot be set to `undefined` under `exactOptionalPropertyTypes`,
 * so absence has to be expressed by leaving the key out.
 */
function unfinished(overrides: Partial<SubagentSummary> = {}): SubagentSummary {
	const { result: _result, ...withoutResult } = summary();
	return { ...withoutResult, ...overrides };
}

interface FakeRunner extends SubagentRunner {
	created: Array<Parameters<SubagentRunner["createSubagent"]>[0]>;
	drained: string[];
	cancelled: string[];
}

function fakeRunner(
	options: { summary?: SubagentSummary; drain?: () => Promise<number>; depth?: number } = {}
): FakeRunner {
	const runner: FakeRunner = {
		created: [],
		drained: [],
		cancelled: [],
		async createSubagent(input) {
			runner.created.push(input);
			return {
				subagent: unfinished({
					status: "running",
					name: input.name ?? "Subagent",
					task: input.task,
				}),
			};
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

		const result = await invoke(
			plan,
			"call-1",
			{
				explanation: "Split the search from the edit",
				plan: [
					{ step: "Read the reducer", status: "completed" },
					{ step: "Thread the new field", status: "in_progress" },
					{ step: "Cover it with a test", status: "pending" },
				],
			},
			signal()
		);

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Split the search from the edit\nPlan updated (1/3 done)\n- [x] Read the reducer\n- [>] Thread the new field\n- [ ] Cover it with a test",
		});
		expect(result.details).toMatchObject({ total: 3, completed: 1, inProgress: 1 });
	});

	it("nudges the model when work remains but nothing is in progress", async () => {
		const plan = tool(createAgencyTools({ snapshot: snapshot() }), "update_plan");

		const stalled = await invoke(plan, "call-2", { plan: [{ step: "Ship it", status: "pending" }] }, signal());
		expect(text(stalled)).toContain("No step is in progress.");

		const done = await invoke(plan, "call-3", { plan: [{ step: "Ship it", status: "completed" }] }, signal());
		expect(text(done)).not.toContain("No step is in progress.");
	});

	it("rejects a plan with two steps in progress", async () => {
		const plan = tool(createAgencyTools({ snapshot: snapshot() }), "update_plan");

		await expect(
			invoke(
				plan,
				"call-4",
				{
					plan: [
						{ step: "One", status: "in_progress" },
						{ step: "Two", status: "in_progress" },
					],
				},
				signal()
			)
		).rejects.toThrow("at most one in_progress step; received 2");
	});
});

describe("memory_search", () => {
	it("binds retrieval to the current session and returns source citations", async () => {
		const calls: Array<{ query: string; limit: number }> = [];
		const memorySearch = (query: string, limit: number) => {
			calls.push({ query, limit });
			return [
				{
					memory: {
						memory: {
							id: "memory-1",
							sessionId: "session-1",
							kind: "compaction" as const,
							reason: "threshold" as const,
							summary: "Use SQLite transactions for durable state.",
							digest: `sha256:${"a".repeat(64)}`,
							source: { revision: 12, fromItemId: "item-1", throughItemId: "item-8" },
							createdAt: 100,
						},
						status: "active" as const,
						retention: "retained" as const,
						updatedAt: 101,
					},
					score: 82,
					matchedTerms: ["sqlite"],
				},
			];
		};
		const memory = tool(createAgencyTools({ snapshot: snapshot(), memorySearch }), "memory_search");
		expect(Object.keys((memory.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
			"query",
			"limit",
		]);
		const result = await invoke(memory, "memory-call", { query: " SQLite ", limit: 3 }, signal());
		expect(calls).toEqual([{ query: "SQLite", limit: 3 }]);
		expect(text(result)).toContain("[memory memory-1]");
		expect(text(result)).toContain("revision 12; items item-1 -> item-8");
		expect(result.details).toMatchObject({
			query: "SQLite",
			matchCount: 1,
			memoryIds: ["memory-1"],
			truncated: false,
		});
	});
});

describe("subagent", () => {
	it("is offered while the session remains below the nesting limit", () => {
		const runner = fakeRunner();
		expect(createAgencyTools({ snapshot: snapshot(), runner }).map((entry) => entry.name)).toEqual([
			"update_plan",
			"subagent",
		]);
		expect(createAgencyTools({ snapshot: snapshot() }).map((entry) => entry.name)).toEqual(["update_plan"]);
		expect(
			createAgencyTools({
				snapshot: snapshot({ id: "sub-1", parentSessionId: "session-1" }),
				runner: fakeRunner({ depth: 1 }),
			}).map((entry) => entry.name)
		).toEqual(["update_plan", "subagent"]);
		expect(
			createAgencyTools({
				snapshot: snapshot({ id: "sub-3", parentSessionId: "sub-2" }),
				runner: fakeRunner({ depth: 3 }),
			}).map((entry) => entry.name)
		).toEqual(["update_plan"]);
	});

	it("delegates inline, drains the child, and returns its report with usage", async () => {
		const runner = fakeRunner();
		const subagent = tool(createAgencyTools({ snapshot: snapshot(), runner }), "subagent");

		const result = await invoke(
			subagent,
			"call-1",
			{ task: "Find every caller", name: "callers", cost_budget_usd: 0.5 },
			signal()
		);

		expect(runner.created).toMatchObject([
			{
				principalId: "agent:session-1",
				idempotencyKey: "subagent-tool:call-1",
				sessionId: "session-1",
				task: "Find every caller",
				name: "callers",
				costBudgetUsd: 0.5,
				deliverInline: true,
			},
		]);
		expect(runner.created[0]).not.toHaveProperty("tokenBudget");
		expect(runner.drained).toEqual(["sub-1"]);
		expect(text(result)).toBe(
			"Subagent callers completed using 12 token(s), $0.0125.\n\nThree callers, all in packages/orchestrator."
		);
		expect(result.details).toMatchObject({
			subagentId: "sub-1",
			depth: 1,
			status: "completed",
			truncated: false,
			costUsd: 0.0125,
			totalTokens: 12,
		});
	});

	it("truncates an oversized report", async () => {
		const runner = fakeRunner({ summary: summary({ result: "x".repeat(50) }) });
		const subagent = tool(createAgencyTools({ snapshot: snapshot(), runner, maxResultChars: 10 }), "subagent");

		const result = await invoke(subagent, "call-1", { task: "Summarise the tree" }, signal());

		expect(text(result)).toContain(`${"x".repeat(10)}\n[report truncated]`);
		expect(result.details).toMatchObject({ truncated: true });
	});

	it("keeps going when another worker already holds the child's lease", async () => {
		const conflict = Object.assign(new Error("another worker owns this session"), {
			code: "lease_conflict",
		});
		const runner = fakeRunner({ drain: () => Promise.reject(conflict) });
		const subagent = tool(createAgencyTools({ snapshot: snapshot(), runner }), "subagent");

		await expect(invoke(subagent, "call-1", { task: "Find every caller" }, signal())).resolves.toMatchObject({
			details: { status: "completed" },
		});
	});

	it("propagates a drain failure that is not a lease conflict", async () => {
		const runner = fakeRunner({ drain: () => Promise.reject(new Error("store is closed")) });
		const subagent = tool(createAgencyTools({ snapshot: snapshot(), runner }), "subagent");

		await expect(invoke(subagent, "call-1", { task: "Find every caller" }, signal())).rejects.toThrow(
			"store is closed"
		);
	});

	it("surfaces failure and cancellation as tool errors, and an unfinished child as a note", async () => {
		const rootSnapshot = snapshot();
		const failed = tool(
			createAgencyTools({
				snapshot: rootSnapshot,
				runner: fakeRunner({
					summary: unfinished({ status: "failed", error: "budget exhausted" }),
				}),
			}),
			"subagent"
		);
		await expect(invoke(failed, "call-1", { task: "t" }, signal())).rejects.toThrow(
			"Subagent callers failed after 12 token(s), $0.0125: budget exhausted"
		);

		const cancelled = tool(
			createAgencyTools({
				snapshot: rootSnapshot,
				runner: fakeRunner({ summary: unfinished({ status: "cancelled" }) }),
			}),
			"subagent"
		);
		await expect(invoke(cancelled, "call-2", { task: "t" }, signal())).rejects.toThrow(
			"Subagent callers was cancelled after 12 token(s), $0.0125."
		);

		const waiting = tool(
			createAgencyTools({
				snapshot: rootSnapshot,
				runner: fakeRunner({ summary: unfinished({ status: "awaiting_approval" }) }),
			}),
			"subagent"
		);
		const result = await invoke(waiting, "call-3", { task: "t" }, signal());
		expect(text(result)).toContain("is still awaiting_approval");
		expect(result.details).toMatchObject({ status: "awaiting_approval" });
	});

	it("cancels the child when the parent turn is aborted", async () => {
		const runner = fakeRunner({ drain: () => new Promise<number>(() => {}) });
		const subagent = tool(createAgencyTools({ snapshot: snapshot(), runner }), "subagent");
		const controller = new AbortController();

		const pending = invoke(subagent, "call-1", { task: "Find every caller" }, controller.signal);
		await Promise.resolve();
		controller.abort(new Error("turn interrupted"));

		expect(runner.cancelled).toEqual(["sub-1"]);
		void pending.catch(() => {});
	});
});

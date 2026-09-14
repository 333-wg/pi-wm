import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MAX_SUBAGENT_DEPTH } from "@wuming/orchestrator";
import type { MemorySearchMatch, SessionSnapshot, SubagentSummary } from "@wuming/protocol";
import { Type } from "typebox";

/**
 * Tools that let the model organise its own work rather than act on the workspace.
 *
 * They deliberately live outside `@wuming/sandbox`: that package is the isolation
 * boundary for filesystem, process and network capabilities, and these two touch
 * none of them. `update_plan` is pure bookkeeping, and `subagent` reaches back into
 * the durable orchestrator that is already running the parent turn.
 */

/** The slice of the orchestrator the `subagent` tool needs. */
export interface SubagentRunner {
	createSubagent(input: {
		principalId: string;
		idempotencyKey: string;
		sessionId: string;
		task: string;
		name?: string;
		costBudgetUsd?: number;
		tokenBudget?: number;
		deliverInline?: boolean;
	}): Promise<{ subagent: SubagentSummary }>;
	drainSession(sessionId: string): Promise<number>;
	subagentDepth(sessionId: string): number;
	subagentSummary(parentSessionId: string, subagentId: string): SubagentSummary;
	cancelSubagent(input: {
		principalId: string;
		idempotencyKey: string;
		sessionId: string;
		subagentId: string;
	}): Promise<unknown>;
}

export interface AgencyToolOptions {
	snapshot: SessionSnapshot;
	/** Absent in demo mode and while the orchestrator is still being constructed. */
	runner?: SubagentRunner | undefined;
	memorySearch?: ((query: string, limit: number) => MemorySearchMatch[]) | undefined;
	maxResultChars?: number;
}

type PlanStatus = "pending" | "in_progress" | "completed";

const statusMark: Record<PlanStatus, string> = { pending: " ", in_progress: ">", completed: "x" };

function textResult(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

function renderPlan(plan: Array<{ step: string; status: PlanStatus }>): string {
	const done = plan.filter((entry) => entry.status === "completed").length;
	const lines = plan.map((entry) => `- [${statusMark[entry.status]}] ${entry.step}`);
	const active = plan.some((entry) => entry.status === "in_progress");
	const remaining = plan.some((entry) => entry.status !== "completed");
	const hint = !active && remaining ? "\nNo step is in progress. Mark the one you are working on next." : "";
	return `Plan updated (${done}/${plan.length} done)\n${lines.join("\n")}${hint}`;
}

export function createAgencyTools(options: AgencyToolOptions): ToolDefinition[] {
	const maxResultChars = options.maxResultChars ?? 60_000;
	const sessionId = options.snapshot.session.id;
	const tools: ToolDefinition[] = [
		defineTool({
			name: "update_plan",
			label: "update_plan",
			description: [
				"Record the plan for a multi-step task and keep it current as you work.",
				"Send the whole plan every time — it replaces the previous one. Each step needs a status: pending, in_progress or completed.",
				"Keep exactly one step in_progress, and update the plan as soon as a step is finished or the approach changes.",
				"Skip it for single-step work; a plan that is never updated is worse than none.",
			].join(" "),
			promptSnippet: "Record and update a step-by-step plan for the current task",
			promptGuidelines: [
				"Use update_plan for work with several distinct steps, and update it as each step completes — the user follows your progress through it.",
				'A plan step is an outcome, not a tool call: "make the reducer handle the new event", not "call edit".',
			],
			parameters: Type.Object({
				plan: Type.Array(
					Type.Object({
						step: Type.String({ minLength: 1, maxLength: 500 }),
						status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
					}),
					{
						minItems: 1,
						maxItems: 40,
						description: "The complete plan, in order. Replaces any previous plan.",
					}
				),
				explanation: Type.Optional(
					Type.String({
						maxLength: 2000,
						description: "Why the plan changed, when it is not obvious",
					})
				),
			}),
			async execute(_toolCallId, params) {
				const plan = params.plan as Array<{ step: string; status: PlanStatus }>;
				const inProgress = plan.filter((entry) => entry.status === "in_progress").length;
				if (inProgress > 1) throw new Error(`A plan can have at most one in_progress step; received ${inProgress}`);
				const explanation = params.explanation?.trim();
				return textResult(`${explanation ? `${explanation}\n` : ""}${renderPlan(plan)}`, {
					total: plan.length,
					completed: plan.filter((entry) => entry.status === "completed").length,
					inProgress,
				});
			},
		}),
	];
	if (options.memorySearch) {
		tools.push(
			defineTool({
				name: "memory_search",
				label: "memory_search",
				description: [
					"Search durable compaction memories from this session only.",
					"Use it when older decisions, constraints, findings, or user preferences may no longer be present in the visible transcript.",
					"Results include source revision and transcript item IDs so claims can cite their origin.",
					"It cannot read another session and never returns forgotten or superseded memories.",
				].join(" "),
				promptSnippet: "Search active durable memories from the current session",
				promptGuidelines: [
					"Use memory_search selectively when the current request depends on earlier context that is not visible; do not call it on every turn.",
					"Treat retrieved summaries as compressed evidence and cite the memory ID or source item IDs when the distinction matters.",
				],
				parameters: Type.Object({
					query: Type.String({
						minLength: 1,
						maxLength: 500,
						description: "Words or phrase describing the earlier decision, constraint, finding, or preference",
					}),
					limit: Type.Optional(
						Type.Integer({
							minimum: 1,
							maximum: 10,
							description: "Maximum matches to return (default 5)",
						})
					),
				}),
				async execute(_toolCallId, params) {
					const query = params.query.trim();
					if (!query) throw new Error("Memory search query cannot be empty");
					const matches = options.memorySearch!(query, params.limit ?? 5);
					const body = matches
						.map(({ memory: record, score, matchedTerms }) => {
							const memory = record.memory;
							const source = `${memory.source.fromItemId ?? "?"} -> ${memory.source.throughItemId ?? "?"}`;
							return [
								`[memory ${memory.id}] score=${score.toFixed(2)} retention=${record.retention}`,
								`source: revision ${memory.source.revision}; items ${source}; digest ${memory.digest}`,
								`matched: ${matchedTerms.join(", ")}`,
								memory.summary.slice(0, 8_000),
							].join("\n");
						})
						.join("\n\n");
					const text = body || `No active memory matched: ${query}`;
					const truncated = text.length > maxResultChars;
					return textResult(truncated ? `${text.slice(0, maxResultChars)}\n[results truncated]` : text, {
						query,
						matchCount: matches.length,
						memoryIds: matches.map((match) => match.memory.memory.id),
						truncated,
					});
				},
			})
		);
	}

	const runner = options.runner;
	if (!runner || runner.subagentDepth(sessionId) >= MAX_SUBAGENT_DEPTH) return tools;

	tools.push(
		defineTool({
			name: "subagent",
			label: "subagent",
			description: [
				"Delegate a self-contained investigation to a fresh agent and wait for its answer.",
				"The subagent starts with an empty context, inherits this session's workspace, sandbox mode and approval policy, and returns one final report.",
				`Delegation is bounded to ${MAX_SUBAGENT_DEPTH} agent levels; a child can delegate again while it remains below that limit.`,
				"Use it to keep a large search out of your own context — for example locating every caller of an API across an unfamiliar tree.",
				"It cannot ask you questions, so state the goal, the paths worth looking at, and exactly what to report back.",
				"Its cost counts against this session's budget.",
			].join(" "),
			promptSnippet: "Delegate a self-contained investigation to a subagent and wait for its report",
			promptGuidelines: [
				"Delegate to subagent when a question needs a lot of reading to answer but only a short answer matters, and when the work does not depend on what you learn along the way.",
				"Do the work yourself when it is a few files, when you need to see the raw contents, or when you are making the change — a subagent's report is a summary, not the code.",
			],
			parameters: Type.Object({
				task: Type.String({
					minLength: 1,
					maxLength: 20_000,
					description: "The complete instruction, including what to report back",
				}),
				name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Short label shown in the UI" })),
				cost_budget_usd: Type.Optional(
					Type.Number({
						exclusiveMinimum: 0,
						maximum: 1000,
						description: "Cap on this subagent's spend; defaults to the session's remaining budget",
					})
				),
				token_budget: Type.Optional(
					Type.Integer({
						minimum: 1000,
						maximum: 100_000_000,
						description: "Cap on this subagent's tokens; defaults to the session's remaining budget",
					})
				),
			}),
			async execute(toolCallId, params, signal) {
				const principalId = `agent:${sessionId}`;
				const created = await runner.createSubagent({
					principalId,
					idempotencyKey: `subagent-tool:${toolCallId}`,
					sessionId,
					task: params.task,
					...(params.name === undefined ? {} : { name: params.name }),
					...(params.cost_budget_usd === undefined ? {} : { costBudgetUsd: params.cost_budget_usd }),
					...(params.token_budget === undefined ? {} : { tokenBudget: params.token_budget }),
					deliverInline: true,
				});
				const subagentId = created.subagent.id;
				// An abandoned child would keep spending the parent's budget after the turn
				// that asked for it is gone, so hand the abort down instead of detaching.
				const cancel = () => {
					void runner
						.cancelSubagent({
							principalId,
							idempotencyKey: `subagent-tool-cancel:${toolCallId}`,
							sessionId,
							subagentId,
						})
						.catch(() => {});
				};
				if (signal?.aborted) cancel();
				else signal?.addEventListener("abort", cancel, { once: true });
				try {
					await runner.drainSession(subagentId);
				} catch (error) {
					// Another worker holds the child's lease and is draining it; read the
					// outcome below rather than failing a subagent that is running fine.
					if (!isLeaseConflict(error)) throw error;
				} finally {
					signal?.removeEventListener("abort", cancel);
				}
				const summary = runner.subagentSummary(sessionId, subagentId);
				const usage = `${summary.usage.totalTokens} token(s), $${summary.usage.costUsd.toFixed(4)}`;
				if (summary.status === "failed")
					throw new Error(`Subagent ${summary.name} failed after ${usage}: ${summary.error ?? "no error reported"}`);
				if (summary.status === "cancelled") throw new Error(`Subagent ${summary.name} was cancelled after ${usage}.`);
				if (summary.status !== "completed") {
					return textResult(
						`Subagent ${summary.name} is still ${summary.status} (id ${subagentId}). Its report is not available yet; continue without it or ask the user to check the Agents tab.`,
						{ subagentId, status: summary.status }
					);
				}
				const report = summary.result ?? "(the subagent produced no final message)";
				const truncated = report.length > maxResultChars;
				return textResult(
					`Subagent ${summary.name} completed using ${usage}.\n\n${truncated ? `${report.slice(0, maxResultChars)}\n[report truncated]` : report}`,
					{
						subagentId,
						depth: summary.depth,
						status: summary.status,
						truncated,
						costUsd: summary.usage.costUsd,
						totalTokens: summary.usage.totalTokens,
					}
				);
			},
		})
	);

	return tools;
}

function isLeaseConflict(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "lease_conflict";
}

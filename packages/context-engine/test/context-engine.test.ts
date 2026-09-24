import { describe, expect, it } from "vitest";
import { ContextEngine, verifyContextPlan, type ContextAssemblyInput, type ContextFragment } from "../src/index.js";

const engine = new ContextEngine({ estimateTokens: (text) => Math.ceil(text.length / 4) });

function fragment(id: string, content: string, overrides: Partial<ContextFragment> = {}): ContextFragment {
	return {
		id,
		version: "1",
		kind: "workspace",
		source: `workspace:${id}`,
		content,
		...overrides,
	};
}

function input(fragments: ContextFragment[], overrides: Partial<ContextAssemblyInput> = {}): ContextAssemblyInput {
	return {
		workspaceId: "workspace-1",
		sessionId: "session-1",
		operationId: "operation-1",
		model: { provider: "openai", id: "gpt" },
		query: "fix authentication token refresh",
		baseSystemPrompt: "Base system instructions.",
		fragments,
		budget: {
			contextWindowTokens: 1000,
			observedContextTokens: 100,
			userInputTokens: 20,
			reservedOutputTokens: 100,
			maxSystemTokens: 500,
		},
		...overrides,
	};
}

describe("ContextEngine", () => {
	it("appends fresh reference snapshots without changing policy or skill precedence", () => {
		const reference = fragment("workspace:readme", "old readme", { delivery: "user" });
		const policy = fragment("policy:agents", "active policy", { kind: "policy", required: true });
		const skill = fragment("skill:selected", "active skill", { kind: "skill", required: true });
		const assemble = (references: ContextFragment[]) =>
			engine.assemble(input([policy, skill, ...references], { appendReferenceContext: true }));
		const first = assemble([reference]);
		const updated = assemble([{ ...reference, version: "2", content: "new readme" }]);
		const removed = assemble([]);
		for (const result of [first, updated, removed]) {
			expect(result.systemPrompt).toBe(first.systemPrompt);
			expect(result.systemPrompt).toContain("active policy");
			expect(result.systemPrompt).toContain("active skill");
			expect(result.systemPrompt).not.toContain("readme");
			expect(result.referencePrompt).not.toContain("active policy");
			expect(verifyContextPlan(result.plan)).toBe(true);
		}
		expect(updated.referencePrompt).toContain("new readme");
		expect(updated.referencePrompt).not.toContain("old readme");
		expect(removed.referencePrompt).toContain("\n[]\n");
		expect(first.plan.fragments.at(-1)?.delivery).toBe("user");
		expect(updated.plan.digest).not.toBe(first.plan.digest);
		expect(engine.assemble(input([reference])).systemPrompt).toContain("old readme");
	});

	it("budgets appended references together with system instructions, including empty snapshot overhead", () => {
		const reference = fragment("workspace:large", "x".repeat(5000), {
			delivery: "user",
			truncation: "head_tail",
			required: true,
		});
		const result = engine.assemble(input([reference], { appendReferenceContext: true }));
		expect(result.plan.fragments.at(-1)?.truncated).toBe(true);
		expect(result.plan.estimatedSystemTokens + result.plan.estimatedReferenceTokens!).toBeLessThanOrEqual(
			result.plan.budget.availableSystemTokens
		);
		expect(result.plan.estimatedReferenceTokens).toBe(engine.estimateTokens(result.referencePrompt));
		for (const kind of ["policy", "skill"] as const)
			expect(() => engine.assemble(input([{ ...reference, kind }], { appendReferenceContext: true }))).toThrow(
				"only workspace or memory"
			);
	});

	it("builds deterministic verifiable plans without persisting fragment bodies", () => {
		const fragments = [
			fragment("workspace:auth", "Authentication token refresh implementation.", {
				cacheScope: "session",
				priority: 5,
			}),
			fragment("skill:review", "Review changes carefully.", {
				kind: "skill",
				source: "skill:review",
				required: true,
				cacheScope: "turn",
			}),
		];
		const first = engine.assemble(input(fragments));
		const second = engine.assemble(input(fragments));
		expect(first).toEqual(second);
		expect(verifyContextPlan(first.plan)).toBe(true);
		expect(first.plan.fragments.map((entry) => entry.id)).toEqual(["system:base", "workspace:auth", "skill:review"]);
		expect(first.systemPrompt).toContain("Authentication token refresh implementation.");
		expect(JSON.stringify(first.plan)).not.toContain("Authentication token refresh implementation.");
		expect(Object.isFrozen(first.plan.fragments)).toBe(true);
	});

	it("ranks optional workspace context by query relevance under pressure", () => {
		const relevant = fragment("workspace:auth", "authentication token refresh ".repeat(15), {
			priority: 0,
		});
		const unrelated = fragment("workspace:colors", "button typography colors ".repeat(15), {
			priority: 0,
		});
		const full = engine.assemble(input([relevant, unrelated]));
		const constrainedBudget =
			full.plan.fragments.find((entry) => entry.id === "workspace:auth")!.renderedTokens +
			full.plan.fragments[0]!.renderedTokens +
			105;
		const constrained = engine.assemble(
			input([unrelated, relevant], {
				budget: {
					contextWindowTokens: 1000,
					observedContextTokens: 0,
					userInputTokens: 10,
					reservedOutputTokens: 100,
					maxSystemTokens: constrainedBudget,
				},
			})
		);
		expect(constrained.plan.fragments.map((entry) => entry.id)).toContain("workspace:auth");
		expect(constrained.plan.omitted.map((entry) => entry.id)).toContain("workspace:colors");
	});

	it("truncates only when the fragment explicitly allows it", () => {
		const content = "begin\n" + "x".repeat(1200) + "\nend";
		const truncatable = fragment("workspace:large", content, {
			truncation: "head_tail",
			required: true,
		});
		const assembly = engine.assemble(
			input([truncatable], {
				budget: {
					contextWindowTokens: 1000,
					observedContextTokens: 0,
					userInputTokens: 10,
					reservedOutputTokens: 100,
					maxSystemTokens: 180,
				},
			})
		);
		const planned = assembly.plan.fragments.find((entry) => entry.id === truncatable.id)!;
		expect(planned.truncated).toBe(true);
		expect(planned.renderedTokens).toBeLessThan(planned.originalTokens);
		expect(assembly.systemPrompt).toContain("...[context truncated]...");

		expect(() =>
			engine.assemble(
				input([{ ...truncatable, id: "workspace:required", truncation: "none" }], {
					budget: {
						contextWindowTokens: 1000,
						observedContextTokens: 0,
						userInputTokens: 10,
						reservedOutputTokens: 100,
						maxSystemTokens: 180,
					},
				})
			)
		).toThrow("Required context fragment workspace:required does not fit");
	});

	it("separates stable cache prefix identity from turn-local context", () => {
		const stable = fragment("policy:base", "Stable policy", {
			kind: "policy",
			source: "deployment:policy",
			cacheScope: "stable",
			required: true,
		});
		const turn = fragment("workspace:file", "First turn data", { cacheScope: "turn" });
		const first = engine.assemble(input([stable, turn]));
		const turnChanged = engine.assemble(input([stable, { ...turn, content: "Changed turn data", version: "2" }]));
		const stableChanged = engine.assemble(input([{ ...stable, content: "Changed stable policy", version: "2" }, turn]));
		expect(turnChanged.plan.digest).not.toBe(first.plan.digest);
		expect(turnChanged.plan.cachePrefixDigest).toBe(first.plan.cachePrefixDigest);
		expect(stableChanged.plan.cachePrefixDigest).not.toBe(first.plan.cachePrefixDigest);
	});

	it.each(["stable", "session", "turn"] as const)(
		"keeps unchanged %s fragments in the same wire order when query relevance changes",
		(scope) => {
			const fragments = [
				fragment("policy:auth", "authentication refresh", { kind: "policy", cacheScope: scope }),
				fragment("policy:colors", "button typography", { kind: "policy", cacheScope: scope }),
			];
			const first = engine.assemble(input(fragments, { query: "authentication refresh" }));
			const second = engine.assemble(input([...fragments].reverse(), { query: "button typography" }));
			expect(second.systemPrompt).toBe(first.systemPrompt);
			expect(second.injectedPromptSuffix).toBe(first.injectedPromptSuffix);
			expect(second.plan.cachePrefixDigest).toBe(first.plan.cachePrefixDigest);
		}
	);

	it("accounts for observed context while replacing the prior system prompt", () => {
		const available = engine.assemble(
			input([], {
				budget: {
					contextWindowTokens: 1000,
					observedContextTokens: 900,
					userInputTokens: 20,
					reservedOutputTokens: 50,
					maxSystemTokens: 500,
				},
			})
		);
		expect(available.plan.budget.availableSystemTokens).toBe(37);
		expect(available.plan.estimatedSystemTokens).toBeLessThanOrEqual(37);
		expect(() =>
			engine.assemble(
				input([], {
					budget: {
						contextWindowTokens: 1000,
						observedContextTokens: 970,
						userInputTokens: 20,
						reservedOutputTokens: 50,
						maxSystemTokens: 500,
					},
				})
			)
		).toThrow("compact the session");
	});

	it("rejects duplicate identifiers and detects plan tampering", () => {
		expect(() => engine.assemble(input([fragment("workspace:a", "one"), fragment("workspace:a", "two")]))).toThrow(
			"more than once"
		);
		const assembly = engine.assemble(input([fragment("workspace:a", "one")]));
		expect(
			verifyContextPlan({
				...assembly.plan,
				estimatedSystemTokens: assembly.plan.estimatedSystemTokens + 1,
			})
		).toBe(false);
	});
});

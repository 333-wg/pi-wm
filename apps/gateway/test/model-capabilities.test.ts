import { describe, expect, it } from "vitest";
import { parseModelThinkingDeclaration, resolveCustomModelCapabilities as resolve } from "../src/model-capabilities.js";

describe("custom model capabilities", () => {
	it("uses the installed catalog for GPT levels, including unavailable levels", () => {
		expect(resolve("gpt-5.5", "openai-responses")).toMatchObject({
			reasoning: true,
			thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
			thinking: { mode: "effort", source: "catalog" },
		});
	});

	it("recognizes namespaced and dotted Claude IDs as budget-based on Messages", () => {
		expect(resolve("anthropic/claude-opus-4.5", "anthropic-messages")).toMatchObject({
			reasoning: true,
			thinkingLevels: ["off", "minimal", "low", "medium", "high"],
			thinking: { mode: "budget", source: "catalog" },
		});
		expect(resolve("claude-opus-4-5", "openai-completions")).toMatchObject({
			reasoning: true,
			thinking: { mode: "effort", source: "catalog" },
		});
		expect(resolve("claude-opus-4-5", "openai-completions").compat).toBeUndefined();
	});

	it("does not offer off when the Gemini catalog disallows it", () => {
		expect(resolve("gemini-3.5-flash", "openai-completions")).toMatchObject({
			reasoning: true,
			thinkingLevels: ["minimal", "low", "medium", "high"],
		});
	});

	it("collapses Kimi native reasoning to off/on and retains its wire format", () => {
		expect(resolve("kimi-k2.6", "openai-completions")).toMatchObject({
			reasoning: true,
			thinkingLevels: ["off", "high"],
			compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
			thinking: { mode: "toggle", source: "catalog" },
		});
	});

	it("distinguishes DeepSeek variants instead of guessing an ambiguous alias", () => {
		expect(resolve("deepseek-v4-flash", "openai-completions").thinkingLevels).toEqual(["off", "low", "high", "max"]);
		expect(resolve("deepseek-v4-pro", "openai-completions").thinkingLevels).toEqual(["off", "high", "max"]);
		expect(resolve("deepseek-v4", "openai-completions").thinking.mode).toBe("unknown");
	});

	it.each(["gpt-5.5-non-reasoning", "my-thinking-model", "future-codex"])("does not guess capabilities of %s", (id) => {
		expect(resolve(id, "openai-completions")).toEqual({
			input: ["text", "image"],
			reasoning: false,
			thinkingLevels: ["off"],
			thinking: { mode: "unknown", source: "unknown" },
		});
	});

	it("distinguishes catalog non-reasoning models from unknown ones", () => {
		expect(resolve("gpt-4o", "openai-completions").thinking).toEqual({ mode: "none", source: "catalog" });
	});

	it("prefers explicit endpoint declarations, including disabling a catalog model", () => {
		expect(resolve("gpt-5.5", "openai-completions", { reasoning: false })).toMatchObject({
			reasoning: false,
			thinking: { mode: "none", source: "endpoint" },
		});
		const declared = parseModelThinkingDeclaration({
			supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
		});
		expect(resolve("kimi-k2.6", "openai-completions", declared)).toMatchObject({
			thinkingLevels: ["low", "high"],
			compat: { supportsReasoningEffort: true },
			thinking: { mode: "effort", source: "endpoint" },
		});
	});

	it("parses only explicit bounded metadata and tolerates malformed catalogs", () => {
		expect(parseModelThinkingDeclaration({ name: "GPT-5.5", capabilities: "reasoning" })).toBeUndefined();
		expect(parseModelThinkingDeclaration({ supported_reasoning_levels: [null, {}, 4, "ultra"] })).toBeUndefined();
		expect(parseModelThinkingDeclaration({ reasoning: true, thinkingLevelMap: { off: null } })).toEqual({
			reasoning: true,
			thinkingLevelMap: { off: null },
		});
		expect(
			parseModelThinkingDeclaration({ supported_reasoning_levels: ["none", "high", "high"] })?.thinkingLevelMap
		).toEqual({ off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
	});
});

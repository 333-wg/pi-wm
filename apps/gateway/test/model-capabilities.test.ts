import { describe, expect, it } from "vitest";
import { parseModelThinkingDeclaration, resolveCustomModelCapabilities as resolve } from "../src/model-capabilities.js";

describe("custom model capabilities", () => {
	it.each([
		["relay/gpt-7.2-preview", "gpt-6-astra"],
		["gpt-5.7-luna", "gpt-5.6-luna"],
		["gpt-7-pro", "gpt-5.5-pro"],
		["gpt-7-mini", "gpt-5.4-mini"],
		["gpt-7-codex", "gpt-5.3-codex"],
		["gpt-6-chat-latest", "gpt-5.2-chat-latest"],
		["o9-mini", "o4-mini"],
	])("inherits the full %s family profile from %s", (id, parent) => {
		expect(resolve(id, "openai-completions")).toMatchObject({
			reasoning: true,
			thinkingLevels: resolve(parent, "openai-completions").thinkingLevels,
			thinking: { mode: "effort", source: "family" },
		});
	});

	it("uses the documented Astra levels without offering unsupported off or minimal", () => {
		expect(resolve("gpt-6-astra", "openai-responses").thinkingLevels).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it.each([
		["claude-opus-6", "claude-opus-5"],
		["anthropic/claude-sonnet-6.1", "claude-sonnet-5"],
		["claude-haiku-6", "claude-haiku-4-5"],
		["claude-opus-4-5-relay", "claude-opus-4-5"],
	])("inherits Claude levels and thinking mode for %s", (id, parent) => {
		const expected = resolve(parent, "anthropic-messages");
		expect(resolve(id, "anthropic-messages")).toMatchObject({
			reasoning: true,
			thinkingLevels: expected.thinkingLevels,
			thinking: { mode: expected.thinking.mode, source: "family" },
		});
		expect(resolve(id, "openai-completions")).toMatchObject({
			thinkingLevels: expected.thinkingLevels,
			thinking: { mode: "effort" },
		});
		expect(resolve(id, "openai-completions").compat).toBeUndefined();
		expect(resolve(id, "anthropic-messages").compat ?? {}).not.toHaveProperty("allowedFallbackModels");
	});

	it.each(["gpt-6-audio", "gpt-6-non-reasoning", "gpt-6-image", "gpt-4-new"])(
		"does not infer reasoning for %s",
		(id) => {
			expect(resolve(id, "openai-completions").thinking.mode).toBe("unknown");
		}
	);

	it("lets declarations and manual overrides supersede family defaults", () => {
		expect(resolve("gpt-6-astra", "openai-responses", { reasoning: false }).reasoning).toBe(false);
		expect(
			resolve(
				"gpt-6-astra",
				"openai-responses",
				parseModelThinkingDeclaration({ supported_reasoning_levels: ["high", "xhigh", "max"] })
			)
		).toMatchObject({
			thinkingLevels: ["high", "xhigh", "max"],
			thinking: { source: "endpoint" },
		});
		expect(
			resolve("relay-alias", "openai-completions", { reasoning: false }, undefined, { levels: ["low", "xhigh", "max"] })
		).toMatchObject({
			reasoning: true,
			thinkingLevels: ["low", "xhigh", "max"],
			thinking: { source: "manual" },
		});
		expect(resolve("gpt-6-astra", "openai-responses", undefined, undefined, "disabled")).toMatchObject({
			reasoning: false,
			thinking: { mode: "none", source: "manual" },
		});
		expect(resolve("gpt-6-astra", "openai-responses", undefined, undefined, "auto").thinking.source).toBe("catalog");
	});

	it("accepts nested capability declarations and explicit effort parameter support", () => {
		expect(parseModelThinkingDeclaration({ capabilities: { reasoning: false } })).toEqual({ reasoning: false });
		expect(parseModelThinkingDeclaration({ supported_parameters: ["reasoning_effort"] })).toEqual({ reasoning: true });
		expect(
			resolve(
				"alias",
				"openai-completions",
				parseModelThinkingDeclaration({ capabilities: { supported_reasoning_levels: ["high", "max"] } })
			).thinkingLevels
		).toEqual(["high", "max"]);
	});
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
		expect(resolve("deepseek-v4-pro", "openai-completions").thinkingLevels).toEqual(["off", "low", "high", "max"]);
		expect(resolve("deepseek-flash", "openai-completions").thinkingLevels).toEqual(["off", "low", "high", "max"]);
		expect(resolve("deepseek-v4", "openai-completions").thinking.mode).toBe("unknown");
	});

	it("retains researched domestic-model differences instead of applying GPT levels", () => {
		expect(resolve("kimi-k3", "openai-completions").thinkingLevels).toEqual(["low", "high", "max"]);
		expect(resolve("glm-5.3", "openai-completions").thinkingLevels).toEqual(["low", "high", "max"]);
		expect(resolve("glm-4.7", "openai-completions").thinkingLevels).toEqual(["off", "high"]);
		expect(resolve("qwen3.7-plus", "openai-completions")).toMatchObject({
			thinkingLevels: ["off", "high"],
			compat: { thinkingFormat: "qwen", supportsReasoningEffort: false },
		});
		expect(resolve("qwen3.8-max", "openai-completions")).toMatchObject({
			thinkingLevels: ["off", "low", "medium", "xhigh"],
			compat: { thinkingFormat: "qwen", supportsReasoningEffort: true },
		});
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

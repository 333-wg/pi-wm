import { describe, expect, it } from "vitest";
import type { ModelMetadata } from "@wuming/protocol";
import { modelThinkingDescription, thinkingLabel, thinkingOptions } from "../src/components/ThinkingPicker.js";
import { THINKING_LEVELS } from "../src/lib/thinking-preference.js";

describe("thinking picker options", () => {
	const model: ModelMetadata = {
		model: { provider: "relay", id: "model" },
		name: "Model",
		reasoning: true,
		input: ["text"],
		contextWindow: 10000,
		maxOutputTokens: 1000,
		authenticated: true,
	};

	it("distinguishes unknown, unsupported, budget, and toggle capabilities", () => {
		expect(
			modelThinkingDescription({ ...model, reasoning: false, thinking: { mode: "unknown", source: "unknown" } })
		).toBe("思考能力未识别");
		expect(
			modelThinkingDescription({ ...model, reasoning: false, thinking: { mode: "none", source: "endpoint" } })
		).toBe("该模型不支持思考强度");
		expect(modelThinkingDescription({ ...model, thinking: { mode: "budget", source: "catalog" } })).toBe(
			"支持思考预算 · 接口待确认"
		);
		expect(modelThinkingDescription({ ...model, thinking: { mode: "toggle", source: "catalog" } })).toBe(
			"支持推理，不分强度档位 · 接口待确认"
		);
	});
	it("offers every protocol level, so a new one cannot go missing from the menu", () => {
		expect(thinkingOptions().map((option) => option.id)).toEqual([...THINKING_LEVELS]);
	});

	it("labels every level in Chinese rather than falling through to the raw id", () => {
		for (const level of THINKING_LEVELS) {
			const label = thinkingLabel(level);
			expect(label).not.toBe(level);
			expect(label).toMatch(/^[一-鿿]+$/);
		}
	});

	it("reads as one rising scale, from no thinking to the model's ceiling", () => {
		const strengths = thinkingOptions().map((option) => option.strength);
		expect(strengths[0]).toBe(0);
		for (const [index, strength] of strengths.entries()) {
			if (index > 0) expect(strength).toBeGreaterThan(strengths[index - 1]!);
		}
	});
});

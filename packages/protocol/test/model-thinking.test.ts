import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { CustomModelThinkingOverrideSchema, ModelMetadataSchema } from "../src/index.js";

describe("model thinking configuration", () => {
	const override = Compile(CustomModelThinkingOverrideSchema);
	it.each(["auto", "disabled", { levels: ["low", "high", "xhigh", "max"] }])(
		"accepts explicit configuration %j",
		(value) => {
			expect(override.Check(value)).toBe(true);
		}
	);
	it.each([
		{ levels: [] },
		{ levels: ["high", "high"] },
		{ levels: ["unsupported"] },
		{ levels: ["high"], extra: true },
		true,
	])("rejects invalid configuration %j", (value) => {
		expect(override.Check(value)).toBe(false);
	});
	it.each(["family", "manual"])("accepts the capability source %s", (source) => {
		expect(
			Compile(ModelMetadataSchema).Check({
				model: { provider: "relay", id: "gpt-6-astra" },
				name: "GPT-6 Astra",
				reasoning: true,
				thinkingLevels: ["low", "medium", "high"],
				thinking: { mode: "effort", source },
				input: ["text"],
				contextWindow: 32000,
				maxOutputTokens: 4096,
				authenticated: true,
			})
		).toBe(true);
	});
});

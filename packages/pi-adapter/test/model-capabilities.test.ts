import { describe, expect, it, vi } from "vitest";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as messages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import type { CustomModelApi, ThinkingLevel } from "@wuming/protocol";
import { resolveCustomModelCapabilities } from "../src/model-capabilities.js";

async function capture(id: string, api: CustomModelApi, reasoning: ThinkingLevel) {
	const capabilities = resolveCustomModelCapabilities(id, api);
	const model = {
		id,
		name: id,
		api,
		provider: "custom-test",
		baseUrl: "https://relay.invalid/v1",
		reasoning: capabilities.reasoning,
		...(capabilities.thinkingLevelMap ? { thinkingLevelMap: capabilities.thinkingLevelMap } : {}),
		...(capabilities.compat ? { compat: capabilities.compat } : {}),
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 32000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<CustomModelApi>;
	let payload: unknown;
	const fetch = vi.fn(async () => {
		throw new Error("Network must not be used");
	});
	const options: SimpleStreamOptions = {
		apiKey: "test-key",
		...(reasoning === "off" ? {} : { reasoning }),
		fetch,
		onPayload(value) {
			payload = value;
			throw new Error("Captured before network");
		},
	};
	const context = { messages: [{ role: "user" as const, content: "test", timestamp: 0 }] };
	const stream =
		api === "anthropic-messages"
			? messages(model as Model<"anthropic-messages">, context, options)
			: api === "openai-responses"
				? responses(model as Model<"openai-responses">, context, options)
				: completions(model as Model<"openai-completions">, context, options);
	await stream.result();
	expect(fetch).not.toHaveBeenCalled();
	expect(payload).toBeDefined();
	return payload;
}

describe("custom reasoning wire format", () => {
	it("sends a thinking token budget for Claude 4.5 Messages", async () => {
		const payload = await capture("claude-opus-4-5", "anthropic-messages", "high");
		expect(payload).toMatchObject({ thinking: { type: "enabled", budget_tokens: expect.any(Number) } });
		expect(payload).not.toHaveProperty("reasoning_effort");
	});

	it("uses the Responses effort envelope for GPT", async () => {
		expect(await capture("gpt-5.5", "openai-responses", "xhigh")).toMatchObject({ reasoning: { effort: "xhigh" } });
	});

	it.each(["claude-opus-4-5", "gemini-3.5-flash"])("translates %s through the completions interface", async (id) => {
		const payload = await capture(id, "openai-completions", "high");
		expect(payload).toMatchObject({ reasoning_effort: "high" });
		expect(payload).not.toHaveProperty("output_config");
	});

	it("sends only the supported binary thinking control for Kimi", async () => {
		const enabled = await capture("kimi-k2.6", "openai-completions", "high");
		expect(enabled).toMatchObject({ thinking: { type: "enabled" } });
		expect(enabled).not.toHaveProperty("reasoning_effort");
		expect(await capture("kimi-k2.6", "openai-completions", "off")).toMatchObject({ thinking: { type: "disabled" } });
	});

	it("preserves DeepSeek thinking format and sparse effort levels", async () => {
		expect(await capture("deepseek-v4-pro", "openai-completions", "max")).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "max",
		});
	});
});

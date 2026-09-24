import { expect, it } from "vitest";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";
import { CacheUsageObserver } from "../src/cache-usage-evidence.js";

it.each([
	["openai-completions", { usage: { prompt_tokens_details: { cached_tokens: 0 } } }],
	["openai-completions", { usage: { prompt_cache_hit_tokens: 0 } }],
	["openai-responses", { response: { usage: { input_tokens_details: { cached_tokens: 0 } } } }],
	["anthropic-messages", { message: { usage: { cache_read_input_tokens: 0 } } }],
])("distinguishes reported zero from missing usage for %s", (api, frame) => {
	const observer = new CacheUsageObserver();
	observer.observe({}, api as string);
	expect(observer.evidence.read).toBe("unknown");
	observer.observe(frame, api as string);
	expect(observer.evidence).toEqual({ source: "provider_response", read: "reported", write: "unknown" });
});

it("does not infer zero from missing, null, negative or malformed counts", () => {
	const observer = new CacheUsageObserver();
	for (const cached_tokens of [undefined, null, -1, "10", Infinity, 0.5]) {
		observer.observe({ usage: { prompt_tokens_details: { cached_tokens } } }, "openai-completions");
		expect(observer.evidence.read).toBe("unknown");
	}
});

it("retains Anthropic start usage when later deltas omit it, without retaining content", () => {
	const observer = new CacheUsageObserver();
	observer.observe(
		{ message: { usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
		"anthropic-messages"
	);
	observer.observe({ usage: { output_tokens: 1 }, content: "private text" }, "anthropic-messages");
	expect(observer.evidence).toEqual({ source: "provider_response", read: "reported", write: "reported" });
});

it.each(["openai-completions", "openai-responses", "openai-codex-responses"])(
	"replaces read and write evidence with each %s usage object",
	(api) => {
		const observer = new CacheUsageObserver();
		const frame = (details?: object) =>
			api.endsWith("responses")
				? { response: { usage: { input_tokens: 1000, input_tokens_details: details } } }
				: { usage: { prompt_tokens: 1000, prompt_tokens_details: details } };
		observer.observe(frame({ cached_tokens: 900, cache_write_tokens: 100 }), api);
		expect(observer.evidence).toMatchObject({ read: "reported", write: "reported" });
		observer.observe({}, api);
		expect(observer.evidence.read).toBe("reported");
		observer.observe(frame(), api);
		expect(observer.evidence).toEqual({ source: "provider_response", read: "unknown", write: "unknown" });
	}
);

it("preserves omitted Anthropic delta fields but invalidates explicitly malformed replacements", () => {
	const observer = new CacheUsageObserver();
	observer.observe(
		{ message: { usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
		"anthropic-messages"
	);
	observer.observe({ usage: { cache_read_input_tokens: null } }, "anthropic-messages");
	expect(observer.evidence).toMatchObject({ read: "reported", write: "reported" });
	observer.observe({ usage: { cache_read_input_tokens: "invalid" } }, "anthropic-messages");
	expect(observer.evidence).toMatchObject({ read: "unknown", write: "reported" });
});

const model: Model<"openai-completions"> = {
	id: "cache-review",
	name: "cache-review",
	api: "openai-completions",
	provider: "review-local",
	baseUrl: "https://unused.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 256,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const wireUsage = { prompt_tokens: 1000, completion_tokens: 1, total_tokens: 1001 };
const choice = { index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" };

it.each([
	{
		name: "nested explicit zero",
		frames: [
			{
				choices: [
					{ ...choice, usage: { ...wireUsage, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } },
				],
			},
		],
		read: "reported",
		write: "reported",
		tokens: 0,
	},
	{
		name: "nested positive",
		frames: [{ choices: [{ ...choice, usage: { ...wireUsage, prompt_tokens_details: { cached_tokens: 1000 } } }] }],
		read: "reported",
		write: "unknown",
		tokens: 1000,
	},
	{
		name: "nested missing",
		frames: [{ choices: [{ ...choice, usage: wireUsage }] }],
		read: "unknown",
		write: "unknown",
		tokens: 0,
	},
	{
		name: "top-level precedence",
		frames: [
			{
				usage: wireUsage,
				choices: [{ ...choice, usage: { ...wireUsage, prompt_tokens_details: { cached_tokens: 1000 } } }],
			},
		],
		read: "unknown",
		write: "unknown",
		tokens: 0,
	},
	{
		name: "last usage replaces earlier evidence",
		frames: [
			{
				usage: { ...wireUsage, prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 } },
				choices: [{ ...choice, finish_reason: null }],
			},
			{ usage: wireUsage, choices: [choice] },
		],
		read: "unknown",
		write: "unknown",
		tokens: 0,
	},
])("matches real SDK usage for $name", async ({ frames, read, write, tokens }) => {
	const observer = new CacheUsageObserver();
	const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
	const fetcher = observer.wrapFetch(
		async () => new Response(text, { headers: { "content-type": "text/event-stream" } }),
		model.api
	);
	const result = await stream(
		model,
		{ messages: [{ role: "user", content: "local fixture", timestamp: 1 }] },
		{ apiKey: "local-fixture-only", fetch: fetcher }
	).result();
	expect(result.stopReason).toBe("stop");
	expect(result.usage.cacheRead).toBe(tokens);
	expect(result.usage.input + result.usage.cacheRead + result.usage.cacheWrite).toBe(1000);
	expect(observer.evidence).toEqual({ source: "provider_response", read, write });
});

it("passes fragmented SSE bytes unchanged, observes usage and resets on retries", async () => {
	const observer = new CacheUsageObserver();
	const text = 'data: {"usage":{"prompt_tokens_details":{"cached_tokens":0}}}\r\n\r\ndata: [DONE]\n\n';
	const bytes = new TextEncoder().encode(text);
	let calls = 0;
	const fetcher = (async () => {
		calls++;
		return new Response(
			new ReadableStream({
				start(controller) {
					for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
					controller.close();
				},
			}),
			{ headers: { "content-type": "text/event-stream", "x-request-id": "not-retained" } }
		);
	}) as typeof fetch;
	const wrapped = observer.wrapFetch(fetcher, "openai-completions");
	const result = await wrapped("https://unused.invalid");
	expect(await result.text()).toBe(text);
	expect(calls).toBe(1);
	expect(observer.evidence.read).toBe("reported");
	await wrapped("https://unused.invalid");
	expect(observer.evidence.read).toBe("unknown");
});

it("skips oversized frames and recovers for a subsequent usage frame", async () => {
	const observer = new CacheUsageObserver();
	const text = `data: ${"x".repeat(1024 * 1024 + 1)}\n\ndata: {"usage":{"cached_tokens":12}}\n\n`;
	const wrapped = observer.wrapFetch(
		(async () => new Response(text, { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
		"openai-completions"
	);
	expect(await (await wrapped("https://unused.invalid")).text()).toBe(text);
	expect(observer.evidence.read).toBe("reported");
});

it("does not accept completion-only aliases on Responses", () => {
	const observer = new CacheUsageObserver();
	observer.observe({ response: { usage: { cached_tokens: 100, prompt_cache_hit_tokens: 100 } } }, "openai-responses");
	expect(observer.evidence.read).toBe("unknown");
});

it("does not consume non-SSE or failed responses", async () => {
	const observer = new CacheUsageObserver();
	const response = new Response("unmodified", { status: 400 });
	const wrapped = observer.wrapFetch((async () => response) as typeof fetch, "openai-completions");
	expect(await wrapped("https://unused.invalid")).toBe(response);
	expect(response.bodyUsed).toBe(false);
	expect(observer.evidence.source).toBe("unavailable");
});

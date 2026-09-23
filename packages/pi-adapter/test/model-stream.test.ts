import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { guardedModelStream } from "../src/model-stream.js";

const model: Model<"openai-completions"> = {
	id: "test",
	name: "test",
	api: "openai-completions",
	provider: "local",
	baseUrl: "http://127.0.0.1",
	reasoning: false,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 256,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const message: AssistantMessage = {
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	content: [{ type: "text", text: "partial output" }],
	stopReason: "stop",
	timestamp: 1,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

afterEach(() => vi.useRealTimers());

it("bounds silence before the provider creates its stream and ignores late responses", async () => {
	vi.useFakeTimers();
	let resolve!: (stream: ReturnType<typeof createAssistantMessageEventStream>) => void;
	let signal!: AbortSignal;
	const stream = guardedModelStream(
		model,
		(input) => {
			signal = input;
			return new Promise((done) => {
				resolve = done;
			});
		},
		undefined,
		1000
	);
	await vi.advanceTimersByTimeAsync(1000);
	expect(await stream.result()).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("idle timeout"),
	});
	expect(signal.aborted).toBe(true);
	const late = createAssistantMessageEventStream();
	late.push({ type: "done", reason: "stop", message });
	resolve(late);
	await vi.advanceTimersByTimeAsync(0);
	expect(await stream.result()).toMatchObject({ stopReason: "error" });
	expect(vi.getTimerCount()).toBe(0);
});

it("preserves partial output on a stalled stream without completing partial tool calls", async () => {
	vi.useFakeTimers();
	const source = createAssistantMessageEventStream();
	let signal!: AbortSignal;
	const stream = guardedModelStream(
		model,
		(input) => {
			signal = input;
			return source;
		},
		undefined,
		1000
	);
	source.push({ type: "text_delta", contentIndex: 0, delta: "partial output", partial: message });
	await vi.advanceTimersByTimeAsync(1000);
	expect(await stream.result()).toMatchObject({ content: message.content, stopReason: "error" });
	expect(signal.aborted).toBe(true);
	source.end();
	expect(vi.getTimerCount()).toBe(0);
});

it("allows a healthy stream to exceed the idle deadline many times and leaves no tool-time timer", async () => {
	vi.useFakeTimers();
	const source = createAssistantMessageEventStream();
	const stream = guardedModelStream(model, () => source, undefined, 1000);
	for (let index = 0; index < 10; index++) {
		await vi.advanceTimersByTimeAsync(800);
		source.push({ type: "thinking_delta", contentIndex: 0, delta: "progress", partial: message });
		await vi.advanceTimersByTimeAsync(0);
	}
	source.push({ type: "done", reason: "stop", message });
	expect(await stream.result()).toEqual(message);
	expect(vi.getTimerCount()).toBe(0);
	await vi.advanceTimersByTimeAsync(60 * 60_000);
	expect(await stream.result()).toEqual(message);
});

it.each([false, true])(
	"settles caller cancellation without waiting for the provider (already aborted=%s)",
	async (already) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const source = createAssistantMessageEventStream();
		const start = vi.fn(() => source);
		if (already) controller.abort();
		const stream = guardedModelStream(model, start, controller.signal, 1000);
		controller.abort();
		expect(await stream.result()).toMatchObject({ stopReason: "aborted" });
		expect(start).toHaveBeenCalledTimes(already ? 0 : 1);
		source.end();
		expect(vi.getTimerCount()).toBe(0);
	}
);

it("treats a stream ending without a terminal event as a recoverable failure", async () => {
	const source = createAssistantMessageEventStream();
	const stream = guardedModelStream(model, () => source);
	source.end();
	expect(await stream.result()).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("stream ended"),
	});
});

it("passes provider errors through and supports explicitly disabling the idle limit", async () => {
	vi.useFakeTimers();
	const source = createAssistantMessageEventStream();
	const stream = guardedModelStream(model, () => source, undefined, 0);
	await vi.advanceTimersByTimeAsync(60 * 60_000);
	expect(vi.getTimerCount()).toBe(0);
	const error = { ...message, stopReason: "error" as const, errorMessage: "401 Unauthorized" };
	source.push({ type: "error", reason: "error", error });
	expect(await stream.result()).toEqual(error);
});

it("retains thrown HTTP status and nested connection codes for retry classification", async () => {
	const stream = guardedModelStream(model, () => {
		throw Object.assign(new Error("Request failed"), { status: 503, cause: { code: "ECONNRESET" } });
	});
	expect(await stream.result()).toMatchObject({
		stopReason: "error",
		errorMessage: "Request failed [HTTP 503; ECONNRESET]",
	});
});

it("closes a non-cooperative source and prevents late frames changing the settled result", async () => {
	vi.useFakeTimers();
	const source = createAssistantMessageEventStream();
	const partial = structuredClone(message);
	const stream = guardedModelStream(model, () => source, undefined, 1000);
	source.push({ type: "start", partial });
	await vi.advanceTimersByTimeAsync(1000);
	const failure = await stream.result();
	expect(await source.result()).toEqual(failure);
	partial.content.push({ type: "text", text: "late mutation" });
	source.push({ type: "done", reason: "stop", message });
	const events = [];
	for await (const event of stream) events.push(event.type);
	expect(events).toEqual(["start", "error"]);
	expect(failure.content).toEqual(message.content);
	expect(vi.getTimerCount()).toBe(0);
});

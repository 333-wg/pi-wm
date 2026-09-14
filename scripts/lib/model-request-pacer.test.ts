import { afterEach, expect, it, vi } from "vitest";
import { createModelRequestPacer, type PacingAgent } from "./model-request-pacer.js";

afterEach(() => vi.useRealTimers());

it("paces across sessions without altering transformed messages", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	const pacer = createModelRequestPacer(20);
	const messages: Parameters<NonNullable<PacingAgent["transformContext"]>>[0] = [];
	const transformed = [...messages];
	const original = vi.fn(async () => transformed);
	const first: PacingAgent = { transformContext: original };
	const second: PacingAgent = {};
	const clock = vi.spyOn(Date, "now");
	pacer.attach(first);
	pacer.attach(second);
	expect(await first.transformContext!(messages)).toBe(transformed);
	expect(original).toHaveBeenCalledWith(messages, undefined);
	const finished = vi.fn();
	const pending = second.transformContext!(messages).then(finished);
	await vi.advanceTimersByTimeAsync(19);
	expect(finished).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	await pending;
	expect(finished).toHaveBeenCalledWith(messages);
	expect(pacer.stats()).toEqual({ intervalMs: 20, contextPreparations: 2, requestedDelayMs: 20 });
	clock.mockRestore();
});

it("cancels a queued preparation and preserves upstream errors", async () => {
	const pacer = createModelRequestPacer(30000);
	const agent: PacingAgent = {};
	pacer.attach(agent);
	await agent.transformContext!([]);
	const controller = new AbortController();
	const queued = agent.transformContext!([], controller.signal);
	const assertion = expect(queued).rejects.toMatchObject({ name: "AbortError" });
	controller.abort();
	await assertion;
	const failure = new Error("original transform failed");
	const broken: PacingAgent = {
		transformContext: async () => {
			throw failure;
		},
	};
	pacer.attach(broken);
	await expect(broken.transformContext!([])).rejects.toBe(failure);
});

it("is opt-in and rejects invalid bounds", () => {
	const original = async () => [];
	const agent: PacingAgent = { transformContext: original };
	createModelRequestPacer(0).attach(agent);
	expect(agent.transformContext).toBe(original);
	for (const value of [-1, 0.5, 30001, NaN])
		expect(() => createModelRequestPacer(value)).toThrow("Invalid model request interval");
});

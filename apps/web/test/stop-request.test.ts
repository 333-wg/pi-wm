import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForStopConnection } from "../src/lib/stop-request.js";

afterEach(() => vi.useRealTimers());

describe("stop during reconnect", () => {
	it("waits for an authenticated connection and does not send early", async () => {
		vi.useFakeTimers();
		const request = vi.fn();
		let connected = false;
		const stopping = waitForStopConnection(
			() => (connected ? request : undefined),
			() => true
		).then((send) => send());
		await vi.advanceTimersByTimeAsync(400);
		expect(request).not.toHaveBeenCalled();
		connected = true;
		await vi.advanceTimersByTimeAsync(100);
		await stopping;
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("expires without sending a late stop on reconnect", async () => {
		vi.useFakeTimers();
		const request = vi.fn();
		let connected = false;
		const stopping = waitForStopConnection(
			() => (connected ? request : undefined),
			() => true,
			300
		).then((send) => send());
		const rejected = expect(stopping).rejects.toThrow("停止请求尚未送达");
		await vi.advanceTimersByTimeAsync(300);
		await rejected;
		connected = true;
		await vi.advanceTimersByTimeAsync(1000);
		expect(request).not.toHaveBeenCalled();
	});

	it("cancels pending delivery when the session or identity changes", async () => {
		vi.useFakeTimers();
		let current = true;
		const stopping = waitForStopConnection(
			() => undefined,
			() => current
		);
		const rejected = expect(stopping).rejects.toThrow("会话或登录状态已变化");
		current = false;
		await vi.advanceTimersByTimeAsync(100);
		await rejected;
	});
});

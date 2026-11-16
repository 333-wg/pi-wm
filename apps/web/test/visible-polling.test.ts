import { afterEach, expect, it, vi } from "vitest";
import { RefreshRequests, startVisiblePolling } from "../src/lib/visible-polling.js";

class Visibility extends EventTarget {
	hidden = false;
	set(hidden: boolean) {
		this.hidden = hidden;
		this.dispatchEvent(new Event("visibilitychange"));
	}
}
afterEach(() => vi.useRealTimers());

it("pauses when hidden, refreshes on return and removes its listener on disposal", async () => {
	vi.useFakeTimers();
	const visibility = new Visibility();
	const task = vi.fn(async () => undefined);
	const stop = startVisiblePolling(task, 30_000, visibility);
	await vi.advanceTimersByTimeAsync(29_999);
	expect(task).toHaveBeenCalledTimes(1);
	visibility.set(true);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(task).toHaveBeenCalledTimes(1);
	visibility.set(false);
	await vi.advanceTimersByTimeAsync(0);
	expect(task).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(30_000);
	expect(task).toHaveBeenCalledTimes(3);
	stop();
	visibility.set(true);
	visibility.set(false);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(task).toHaveBeenCalledTimes(3);
});

it("never overlaps slow requests, including visibility changes, and retries failures", async () => {
	vi.useFakeTimers();
	const visibility = new Visibility();
	let resolve!: () => void;
	const task = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise<void>((done) => {
					resolve = done;
				})
		)
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue(undefined);
	const stop = startVisiblePolling(task, 1500, visibility);
	await vi.advanceTimersByTimeAsync(10_000);
	visibility.set(true);
	visibility.set(false);
	expect(task).toHaveBeenCalledTimes(1);
	resolve();
	await vi.advanceTimersByTimeAsync(1500);
	expect(task).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(1500);
	expect(task).toHaveBeenCalledTimes(3);
	stop();
});

it("does not start hidden or schedule more work after a pending poll is disposed", async () => {
	vi.useFakeTimers();
	const visibility = new Visibility();
	visibility.hidden = true;
	let resolve!: () => void;
	const task = vi.fn(
		() =>
			new Promise<void>((done) => {
				resolve = done;
			})
	);
	const stop = startVisiblePolling(task, 1500, visibility);
	expect(task).not.toHaveBeenCalled();
	visibility.set(false);
	stop();
	resolve();
	await vi.advanceTimersByTimeAsync(60_000);
	expect(task).toHaveBeenCalledTimes(1);
});

it("coalesces the same resource and generation without mixing different requests", async () => {
	const requests = new RefreshRequests();
	let resolve!: (value: number) => void;
	const task = vi.fn(
		() =>
			new Promise<number>((done) => {
				resolve = done;
			})
	);
	const first = requests.run("session-a:1", task);
	expect(requests.run("session-a:1", task)).toBe(first);
	expect(await requests.run("session-a:2", async () => 2)).toBe(2);
	expect(await requests.run("session-b:1", async () => 3)).toBe(3);
	resolve(1);
	expect(await first).toBe(1);
	expect(task).toHaveBeenCalledOnce();
	await expect(
		requests.run("session-a:1", async () => {
			throw new Error("offline");
		})
	).rejects.toThrow("offline");
	expect(await requests.run("session-a:1", async () => 4)).toBe(4);
});

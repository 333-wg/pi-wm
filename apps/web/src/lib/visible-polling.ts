/** Sequential polling: hidden pages do no work; returning to the page refreshes immediately. */
export function startVisiblePolling(
	task: () => Promise<unknown>,
	intervalMs: number,
	visibility: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document
): () => void {
	let stopped = false;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const poll = async () => {
		clearTimeout(timer);
		if (stopped || running || visibility.hidden) return;
		running = true;
		try {
			await task();
		} catch {
			/* The next visible poll retries a transient failure. */
		} finally {
			running = false;
			if (!stopped && !visibility.hidden) timer = setTimeout(() => void poll(), intervalMs);
		}
	};
	const changed = () => {
		clearTimeout(timer);
		if (!visibility.hidden) void poll();
	};
	visibility.addEventListener("visibilitychange", changed);
	void poll();
	return () => {
		stopped = true;
		clearTimeout(timer);
		visibility.removeEventListener("visibilitychange", changed);
	};
}

/** Coalesce automatic and manual refreshes, scoped by resource and navigation generation. */
export class RefreshRequests {
	readonly #pending = new Map<string, Promise<unknown>>();
	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const pending = this.#pending.get(key);
		if (pending) return pending as Promise<T>;
		const request = Promise.resolve()
			.then(task)
			.finally(() => {
				if (this.#pending.get(key) === request) this.#pending.delete(key);
			});
		this.#pending.set(key, request);
		return request;
	}
}

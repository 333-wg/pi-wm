import type { TranscriptItem } from "@wuming/protocol";

export function isUnfinishedItem(item: TranscriptItem): boolean {
	return item.type === "assistant"
		? item.status === "streaming"
		: item.type === "tool" && ["pending", "running", "awaiting_approval"].includes(item.status);
}

// Persist boundaries immediately, but coalesce token updates to bound SQLite writes.
export class TranscriptCheckpoint {
	readonly #pending = new Map<string, TranscriptItem>();
	readonly #seen = new Set<string>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;

	constructor(
		private readonly persist: (items: TranscriptItem[]) => void,
		private readonly onError: (error: unknown) => void,
		private readonly intervalMs = 250
	) {}

	put(item: TranscriptItem): void {
		if (this.#closed) return;
		this.#pending.set(item.id, structuredClone(item));
		const first = !this.#seen.has(item.id);
		this.#seen.add(item.id);
		if (first || !isUnfinishedItem(item)) {
			this.#tryFlush();
		} else if (!this.#timer) {
			this.#timer = setTimeout(() => this.#tryFlush(), this.intervalMs);
		}
	}

	#tryFlush(): void {
		try {
			this.flush();
		} catch (error) {
			this.close();
			this.onError(error);
		}
	}

	flush(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#closed || this.#pending.size === 0) return;
		this.persist([...this.#pending.values()]);
		this.#pending.clear();
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#pending.clear();
	}
}

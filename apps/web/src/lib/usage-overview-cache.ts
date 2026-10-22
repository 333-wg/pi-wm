import type { UsageOverview } from "@wuming/protocol";

export const USAGE_FRESH_MS = 30_000;

interface UsageState {
	data?: UsageOverview | undefined;
	loading: boolean;
	error?: string;
}

interface Entry {
	state: UsageState;
	fetchedAt: number;
	revision: number;
	stale: boolean;
	pending?: Promise<UsageOverview | undefined> | undefined;
}

const EMPTY_STATE: UsageState = { loading: false };
const keyFor = (workspaceId: string | undefined, days: number) => JSON.stringify([workspaceId ?? null, days]);

/** Owned by one authenticated client, so closing a settings panel does not discard its data. */
export class UsageOverviewCache {
	readonly #entries = new Map<string, Entry>();
	readonly #listeners = new Set<() => void>();
	#version = 0;
	invalidationRevision = 0;

	constructor(
		private readonly fetchOverview: (workspaceId: string | undefined, days: number) => Promise<UsageOverview>,
		private readonly clock: () => number = Date.now
	) {}

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	getVersion = () => this.#version;

	#notify() {
		this.#version++;
		for (const listener of this.#listeners) listener();
	}

	getState(workspaceId?: string, days = 7): UsageState {
		return this.#entries.get(keyFor(workspaceId, days))?.state ?? EMPTY_STATE;
	}

	invalidate() {
		for (const entry of this.#entries.values()) {
			entry.stale = true;
			entry.revision++;
		}
		this.invalidationRevision++;
		this.#notify();
	}

	clear() {
		this.#entries.clear();
		this.invalidationRevision++;
		this.#notify();
	}

	load(workspaceId?: string, days = 7, force = false): Promise<UsageOverview | undefined> {
		const key = keyFor(workspaceId, days);
		let entry = this.#entries.get(key);
		if (!entry) {
			entry = { state: EMPTY_STATE, fetchedAt: 0, revision: 0, stale: true };
			this.#entries.set(key, entry);
		}
		if (entry.pending) return entry.pending;
		const now = this.clock();
		if (
			!force &&
			!entry.stale &&
			entry.state.data &&
			now >= entry.fetchedAt &&
			now - entry.fetchedAt < USAGE_FRESH_MS &&
			new Date(now).toDateString() === new Date(entry.fetchedAt).toDateString()
		) {
			return Promise.resolve(entry.state.data);
		}
		const current = entry;
		current.state = { data: current.state.data, loading: true };
		// Defer the fetch until pending is installed, including when the loader throws synchronously.
		current.pending = Promise.resolve().then(async () => {
			try {
				while (this.#entries.get(key) === current) {
					const revision = current.revision;
					const data = await this.fetchOverview(workspaceId, days);
					if (this.#entries.get(key) !== current) return undefined;
					// A usage event arrived during this request; do not mark an older response fresh.
					if (revision !== current.revision) continue;
					current.state = { data, loading: false };
					current.fetchedAt = this.clock();
					current.stale = false;
					return data;
				}
				return undefined;
			} catch (error) {
				current.stale = true;
				current.state = {
					data: current.state.data,
					loading: false,
					error: error instanceof Error ? error.message : String(error),
				};
				throw error;
			} finally {
				current.pending = undefined;
				if (this.#entries.get(key) === current) this.#notify();
			}
		});
		for (const [oldKey, oldEntry] of this.#entries) {
			if (this.#entries.size <= 64) break;
			if (oldKey !== key && !oldEntry.pending) this.#entries.delete(oldKey);
		}
		this.#notify();
		return current.pending;
	}
}

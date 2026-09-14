import { setTimeout as pause } from "node:timers/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type PacingAgent = Pick<AgentSession["agent"], "transformContext">;

/** Evaluation-only pacing at model context preparation, shared across sessions. */
export function createModelRequestPacer(intervalMs: number) {
	if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 30_000)
		throw new Error("Invalid model request interval");
	let nextSlot = 0;
	let contextPreparations = 0;
	let requestedDelayMs = 0;
	return {
		attach(agent: PacingAgent): void {
			if (intervalMs === 0) return;
			const previous = agent.transformContext?.bind(agent);
			agent.transformContext = async (messages, signal) => {
				signal?.throwIfAborted();
				const transformed = previous ? await previous(messages, signal) : messages;
				signal?.throwIfAborted();
				const now = Date.now();
				const slot = Math.max(now, nextSlot);
				nextSlot = slot + intervalMs;
				const delay = slot - now;
				contextPreparations++;
				requestedDelayMs += delay;
				if (delay > 0) await pause(delay, undefined, signal ? { signal } : undefined);
				signal?.throwIfAborted();
				return transformed;
			};
		},
		stats: () => ({ intervalMs, contextPreparations, requestedDelayMs }),
	};
}

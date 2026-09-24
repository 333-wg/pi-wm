import type { RunSummary, TranscriptItem } from "@wuming/protocol";
import { messageText } from "./transcript.js";

export interface CompletedTurnProcess {
	key: string;
	itemIds: Set<string>;
	durationMs?: number;
}

/** Fold only turns with a terminal answer; interrupted/unfinished work stays visible. */
export function completedTurnProcesses(
	transcript: TranscriptItem[],
	active: boolean,
	runs: RunSummary[] = []
): CompletedTurnProcess[] {
	const result: CompletedTurnProcess[] = [];
	for (let start = 0; start < transcript.length; start++) {
		const user = transcript[start]!;
		if (user.type !== "user") continue;
		let end = start + 1;
		while (end < transcript.length && transcript[end]!.type !== "user") end++;
		if (end === transcript.length && active) continue;
		const items = transcript.slice(start + 1, end);
		const answer = items.at(-1);
		if (
			!answer ||
			answer.type !== "assistant" ||
			answer.status !== "complete" ||
			answer.error ||
			!messageText(answer.content) ||
			answer.content.some((part) => part.type === "tool_call")
		)
			continue;
		if (items.some((item) => item.type === "tool" && ["pending", "running", "awaiting_approval"].includes(item.status)))
			continue;
		// Rich outputs remain accessible next to the answer, rather than disappearing into history.
		const process = items.slice(0, -1).filter((item) => !item.content.some((part) => part.type === "artifact"));
		if (process.length === 0) continue;
		const run = runs.find(
			(candidate) =>
				candidate.status === "completed" &&
				candidate.startedAt !== undefined &&
				candidate.startedAt >= user.createdAt - 1000 &&
				candidate.startedAt <= answer.createdAt &&
				candidate.finishedAt !== undefined &&
				// Runtime items can use millisecond offsets to preserve ordering.
				candidate.finishedAt >= answer.createdAt - 1000 &&
				(end === transcript.length || candidate.finishedAt <= transcript[end]!.createdAt)
		);
		result.push({
			key: user.id,
			itemIds: new Set(process.map((item) => item.id)),
			...(run?.startedAt !== undefined && run.finishedAt !== undefined
				? { durationMs: Math.max(0, run.finishedAt - run.startedAt) }
				: {}),
		});
	}
	return result;
}

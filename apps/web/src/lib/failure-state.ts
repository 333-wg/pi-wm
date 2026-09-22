import type { RunSummary, SessionSnapshot, TranscriptItem } from "@wuming/protocol";
import type { LiveRetry } from "../use-wuming-client.js";

export function connectionFailure(error: string): boolean {
	return /connection error|network error|fetch failed|econnreset|econnrefused|enotfound|socket hang up|http\/?2.*(?:stream|reset|goaway|response)|stream (?:failed|ended|closed)|premature close|terminated/i.test(
		error
	);
}

export function activeRecovery(
	snapshot: SessionSnapshot | undefined,
	runs: RunSummary[],
	liveRetry: LiveRetry | undefined
): (LiveRetry & { waiting: boolean }) | undefined {
	if (!snapshot || !["turn", "retry", "compaction"].includes(snapshot.session.phase)) return undefined;
	const run = runs.find((item) => item.sessionId === snapshot.session.id && item.status === "running");
	const last = run?.retryHistory?.at(-1);
	const retry =
		liveRetry ??
		(run && last
			? {
					operationId: run.id,
					attempt: last.attempt,
					nextAttempt: last.attempt + 1,
					maxAttempts: last.maxAttempts + 1,
					delayMs: last.delayMs,
					failureKind: run.failureKind ?? "provider",
					error: last.error,
				}
			: undefined);
	if (!retry || snapshot.transcript.some((item) => item.id === `${retry.operationId}:error`)) return undefined;
	return { ...retry, waiting: snapshot.session.phase === "retry" };
}

export function activeTurnFailure(transcript: TranscriptItem[], itemId: string, active: boolean): boolean {
	if (!active) return false;
	const index = transcript.findIndex((item) => item.id === itemId);
	return index >= 0 && !transcript.slice(index + 1).some((item) => item.type === "user");
}

export function retrySummary(run: RunSummary | undefined): string | undefined {
	const scheduled = run?.retryHistory?.length ?? 0;
	if (!scheduled) return undefined;
	// Retry history records scheduling, not proof that a subsequent attempt started.
	return `已安排自动重试 ${scheduled} 次；任务实际启动 ${run?.attempt ?? 1} 次`;
}

export function supersededFailure(transcript: TranscriptItem[], itemId: string): boolean {
	const index = transcript.findIndex((item) => item.id === itemId);
	if (index < 0) return false;
	for (const item of transcript.slice(index + 1)) {
		if (item.type === "user") break;
		if (item.type === "assistant" && (item.error || item.id.endsWith(":error"))) return true;
		if (item.type === "assistant" && !item.error && item.status === "complete" && item.content.length > 0) return true;
	}
	return false;
}

export function desktopContinuation(transcript: TranscriptItem[], itemId: string): boolean {
	const index = transcript.findIndex((item) => item.id === itemId);
	if (index < 0) return false;
	for (let cursor = index - 1; cursor >= 0; cursor--) {
		const item = transcript[cursor]!;
		if (item.type === "user") break;
		if (item.type === "tool" && item.toolName.startsWith("computer_") && item.status !== "pending") return true;
	}
	return false;
}

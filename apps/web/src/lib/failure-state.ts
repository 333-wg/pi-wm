import type { RunSummary, TranscriptItem } from "@wuming/protocol";

export function connectionFailure(error: string): boolean {
	return /connection error|network error|fetch failed|econnreset|econnrefused|enotfound|socket hang up/i.test(error);
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
		if (item.type === "assistant" && item.error && item.id.endsWith(":error")) return true;
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

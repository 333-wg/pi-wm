import { sessionUsageRequests, type RunSummary, type SessionSnapshot } from "@wuming/protocol";
import { createTranslator, type Translate } from "./locale.js";

export function diagnoseRun(snapshot: SessionSnapshot, runs: RunSummary[], t: Translate = createTranslator("zh")) {
	const phase = snapshot.session.phase;
	const run = runs.find((entry) => entry.status === "running") ?? runs[0];
	const lastUser = snapshot.transcript.findLastIndex((item) => item.type === "user");
	const items = snapshot.transcript.slice(Math.max(0, lastUser));
	if (phase === "awaiting_approval" || snapshot.pendingApprovals.length > 0)
		return { phase: "approval", label: t("statusApproval"), attention: true };
	if (phase === "compaction") return { phase: "compaction", label: t("diagnosisCompaction"), attention: false };
	if (phase === "retry") return { phase: "retry", label: t("diagnosisRetry"), attention: true };
	if (phase === "turn") {
		if (run?.status === "running" && run.abortRequested)
			return { phase: "stopping", label: t("diagnosisStopping"), attention: false };
		const tool = items.findLast(
			(item) => item.type === "tool" && (item.status === "running" || item.status === "pending")
		);
		if (tool?.type === "tool")
			return {
				phase: "tool",
				label: t("diagnosisTool"),
				toolName: tool.toolName,
				attention: false,
				toolStartedAt: tool.createdAt,
				lastProgressAt: tool.lastProgressAt,
				command:
					tool.input && typeof tool.input === "object" && !Array.isArray(tool.input)
						? typeof tool.input.command === "string"
							? tool.input.command
							: typeof tool.input.cmd === "string"
								? tool.input.cmd
								: undefined
						: undefined,
			};
		const assistant = items.findLast((item) => item.type === "assistant");
		if (assistant?.type === "assistant" && assistant.status === "streaming" && assistant.content.length > 0)
			return { phase: "streaming", label: t("diagnosisStreaming"), attention: false };
		return { phase: "waiting", label: t("diagnosisWaiting"), attention: false };
	}
	if (phase === "error" || run?.status === "failed")
		return { phase: "failed", label: t("diagnosisFailed"), attention: true };
	if (run?.status === "interrupted") return { phase: "interrupted", label: t("diagnosisInterrupted"), attention: true };
	if (run?.status === "queued") return { phase: "queued", label: t("diagnosisQueued"), attention: false };
	return { phase: "idle", label: t("diagnosisIdle"), attention: false };
}

/** Export allowlisted metadata only, never transcript, names, paths, or error text. */
export function diagnosticReport(snapshot: SessionSnapshot, runs: RunSummary[]) {
	return {
		version: 1,
		phase: diagnoseRun(snapshot, runs).phase,
		revision: snapshot.revision,
		pendingApprovalCount: snapshot.pendingApprovals.length,
		runs: runs.slice(0, 20).map((run) => ({
			status: run.status,
			attempt: run.attempt,
			createdAt: run.createdAt,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			failureKind: run.failureKind,
			retryCount: run.retryHistory?.length ?? 0,
		})),
		requests: sessionUsageRequests(snapshot)
			.slice(-50)
			.map((request) => ({
				status: request.status,
				startedAt: request.startedAt,
				firstContentAt: request.firstContentAt,
				finishedAt: request.finishedAt,
				inputTokens: request.usage.inputTokens,
				outputTokens: request.usage.outputTokens,
			})),
	};
}

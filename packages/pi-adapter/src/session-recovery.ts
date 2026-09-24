import { createHash } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { PiSessionRecovery } from "./types.js";

const RECEIPT_TYPE = "wuming-recovery-receipt";

export function requestDigest(content: UserMessage["content"]): string {
	return createHash("sha256")
		.update(JSON.stringify(typeof content === "string" ? [{ type: "text", text: content }] : content))
		.digest("hex");
}

/** Reconcile durable requests without turning UI previews into provider messages. */
export async function recoverDurableSession(manager: SessionManager, input: PiSessionRecovery): Promise<boolean> {
	if (input.snapshot.pendingApprovals.length > 0) return false;
	const branch = manager.getBranch();
	const receipts = new Set<string>();
	for (const entry of branch) {
		const data = (
			entry.type === "custom" && entry.customType === RECEIPT_TYPE
				? entry.data
				: entry.type === "custom_message" && entry.customType === "wuming-interrupted-turn"
					? entry.details
					: undefined
		) as { operationId?: unknown } | undefined;
		if (typeof data?.operationId === "string") receipts.add(data.operationId);
	}
	let changed = false;
	for (const operation of input.operations) {
		if (input.signal.aborted) throw input.signal.reason;
		if (operation.sessionId !== input.snapshot.session.id) throw new Error("Cross-session recovery is not allowed");
		if (!["interrupted", "failed", "completed"].includes(operation.status) || receipts.has(operation.id)) continue;
		// Deleted follow-ups were never submitted to the runtime. This also covers
		// legacy deletions persisted as interrupted operations without a marker.
		if (operation.status === "interrupted" && operation.attempt === 0 && operation.payload.mode === "follow_up") continue;
		const start = operation.startedAt ?? operation.createdAt;
		const end = operation.finishedAt ?? operation.updatedAt;
		// Inspect the full active branch, not just the compacted model context. A
		// request represented by a compaction summary must not be resurrected.
		const anchors = branch.flatMap((entry, index) => {
			if (entry.type !== "custom" || entry.customType !== "wuming-turn-input") return [];
			const data = entry.data as { operationId?: unknown; digest?: unknown } | undefined;
			return data?.operationId === operation.id && typeof data.digest === "string"
				? [{ index, digest: data.digest }]
				: [];
		});
		const original = operation.payload.runtimeContent ?? operation.payload.content;
		const originalText = original
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n\n");
		const hasRequest = branch.some((entry, index) => {
			if (entry.type !== "message" || entry.message.role !== "user") return false;
			if (entry.message.timestamp < start || entry.message.timestamp > end) return false;
			const digest = requestDigest(entry.message.content);
			if (anchors.length > 0) return anchors.some((anchor) => index > anchor.index && digest === anchor.digest);
			// Legacy logs lack operation IDs. Match the original input as well as its
			// execution window so an unrelated prompt cannot hide a missing request.
			const text =
				typeof entry.message.content === "string"
					? entry.message.content
					: entry.message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n\n");
			if (original.every((part) => part.type === "text")) return text === originalText;
			return original.every((part) =>
				part.type === "text" ? text.includes(part.text) : text.includes(JSON.stringify(part.artifact.id))
			);
		});
		const userIndex = input.snapshot.transcript.findIndex((item) => item.id === operation.payload.userItemId);
		const following = userIndex < 0 ? [] : input.snapshot.transcript.slice(userIndex + 1);
		const nextUser = following.findIndex((item) => item.type === "user");
		const tools = (nextUser < 0 ? following : following.slice(0, nextUser))
			.filter((item) => item.type === "tool")
			.map((item) => ({
				toolCallId: item.toolCallId,
				toolName: item.toolName,
				outcome:
					item.status === "complete" && !item.isError
						? "completed"
						: item.status === "error"
							? "failed_or_partial"
							: "unknown",
			}));
		// Load attachments before mutating the log. Failed extraction must not mark
		// the request as recovered or silently drop its original attachments.
		const prompt = hasRequest ? undefined : await input.loadPrompt(operation);
		if (input.signal.aborted) throw input.signal.reason;
		if (operation.status !== "completed" || !hasRequest) {
			const status =
				"Historical execution status, not a new request or permission to resume. Follow the latest user message. " +
				"If it asks to continue, use the retained request and confirmed results; if it changes tasks, follow the new task. " +
				"Do not automatically replay tools. A failed or missing result does not prove an operation had no side effects. " +
				"Inspect the current state before repeating any operation with an unknown outcome. " +
				(!hasRequest
					? "History was partially recovered: original user input is available, but missing assistant replies and full tool outputs were not reconstructed from display previews. Do not invent missing results. "
					: "") +
				JSON.stringify({
					operationId: operation.id,
					status: operation.status,
					reason: operation.failureKind ?? operation.status,
					tools,
				});
			// One append holds both recovery data and its receipt, including if the
			// process dies immediately afterward. Never persist a receipt first.
			manager.appendCustomMessageEntry(
				"wuming-interrupted-turn",
				[
					{ type: "text", text: status },
					...(prompt
						? [
								{
									type: "text" as const,
									text: "Recovered historical user request from durable storage (not a new request):\n" + prompt.text,
								},
								...prompt.images,
							]
						: []),
				],
				false,
				{ operationId: operation.id, userItemId: operation.payload.userItemId }
			);
			changed = true;
		} else manager.appendCustomEntry(RECEIPT_TYPE, { operationId: operation.id });
		receipts.add(operation.id);
	}
	return changed;
}

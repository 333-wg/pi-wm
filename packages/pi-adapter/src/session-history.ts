import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, DurableOperation } from "@wuming/orchestrator";
import type { TranscriptItem } from "@wuming/protocol";

export type HistoryBranchInput = Parameters<NonNullable<AgentRuntime["branchSession"]>>[0];

export function sessionHistoryDirectory(root: string, sessionId: string, historyId?: string): string {
	const hash = (value: string) => createHash("sha256").update(value).digest("hex");
	const directory = join(root, hash(sessionId));
	return historyId === undefined ? directory : join(directory, "branches", hash(historyId));
}

function itemEntryIndex(branch: SessionEntry[], item: TranscriptItem, operations: DurableOperation[]): number {
	if (item.type === "user") {
		const operation = operations.find((candidate) => candidate.payload.userItemId === item.id);
		const anchor = branch.findIndex((entry) => {
			if (entry.type !== "custom" || entry.customType !== "wuming-turn-input") return false;
			const data = entry.data as { userItemId?: string; operationId?: string } | undefined;
			return data?.userItemId === item.id || (operation !== undefined && data?.operationId === operation.id);
		});
		if (anchor >= 0) {
			for (let index = anchor + 1; index < branch.length; index++) {
				const entry = branch[index]!;
				if (entry.type === "custom" && entry.customType === "wuming-turn-input") break;
				if (entry.type === "message" && entry.message.role === "user") return index;
			}
		}
		const recovered = branch.findIndex(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "wuming-interrupted-turn" &&
				(entry.details as { userItemId?: string } | undefined)?.userItemId === item.id
		);
		if (recovered >= 0) return recovered;
		// Legacy logs have no UI IDs. Match the original request and execution window,
		// never rebuild a provider message from a rendered transcript preview.
		const text = item.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n\n");
		const matches = branch.flatMap((entry, index) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const message = entry.message;
			const original =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n\n");
			return original === text &&
				message.timestamp >= (operation?.startedAt ?? item.createdAt) &&
				(operation?.finishedAt === undefined || message.timestamp <= operation.finishedAt)
				? [index]
				: [];
		});
		return matches.length === 1 ? matches[0]! : -1;
	}
	const matches = branch.flatMap((entry, index) => {
		if (entry.type !== "message") return [];
		if (item.type === "tool")
			return entry.message.role === "toolResult" && entry.message.toolCallId === item.toolCallId ? [index] : [];
		return item.type === "assistant" && entry.message.role === "assistant" && entry.message.timestamp === item.createdAt
			? [index]
			: [];
	});
	return matches.length === 1 ? matches[0]! : -1;
}

/** Select real SDK entries; display text is never promoted to model history. */
export function selectHistoryBranch(
	manager: SessionManager,
	input: HistoryBranchInput,
	operations: DurableOperation[]
): SessionEntry[] {
	const branch = manager.getBranch();
	const itemId = input.beforeItemId ?? input.fromItemId;
	const itemIndex = input.snapshot.transcript.findIndex((item) => item.id === itemId);
	if (itemId !== undefined && itemIndex < 0) throw new Error("History anchor no longer exists");
	const retained = input.snapshot.transcript.slice(
		0,
		itemId === undefined ? undefined : itemIndex + (input.beforeItemId ? 0 : 1)
	);
	// Detect legacy display-only forks and missing logs instead of silently starting empty.
	for (const item of retained) {
		if (item.type === "user" && itemEntryIndex(branch, item, operations) < 0)
			throw new Error("Original model history is missing; reopen the source conversation before editing or forking");
	}
	if (input.beforeItemId && retained.length === 0) return [];
	if (itemId === undefined) return branch;
	let end = itemEntryIndex(branch, input.snapshot.transcript[itemIndex]!, operations);
	if (end < 0) throw new Error("Cannot locate the message in model history; the conversation was not changed");
	if (input.beforeItemId) {
		const previous = branch[end - 1];
		if (previous?.type === "custom" && previous.customType === "wuming-turn-input") end -= 1;
	} else end += 1;
	return branch.slice(0, end);
}

export async function persistHistoryBranch(
	root: string,
	cwd: string,
	manager: SessionManager,
	input: HistoryBranchInput,
	operations: DurableOperation[]
): Promise<void> {
	const entries = selectHistoryBranch(manager, input, operations).map((entry) => {
		if (entry.type !== "custom" || entry.customType !== "wuming-turn-input") return entry;
		const data = entry.data as { operationId?: string; userItemId?: string } | undefined;
		const operation = operations.find((candidate) => candidate.id === data?.operationId);
		// Preserve stable user anchors when a legacy session is forked. Its source
		// operations intentionally do not become executable operations in the fork.
		return operation ? { ...entry, data: { ...data, userItemId: operation.payload.userItemId } } : entry;
	});
	const directory = sessionHistoryDirectory(root, input.targetSessionId, input.historyId);
	await mkdir(directory, { recursive: true });
	const target = SessionManager.create(cwd, directory);
	const file = target.getSessionFile()!;
	const notice: SessionEntry = {
		type: "custom_message",
		id: randomUUID(),
		parentId: entries.at(-1)?.id ?? null,
		timestamp: new Date().toISOString(),
		customType: "wuming-history-branch",
		display: false,
		content:
			"Conversation history was branched at the selected message. Later messages are not part of this context. " +
			"This does not undo file edits, commands, submissions, or other external effects. Inspect the current state " +
			"before repeating any operation whose outcome is unknown. Follow the latest user request; do not automatically replay tools.",
	};
	// Publish a complete file before committing its pointer in SQLite. A failed or
	// abandoned command can leave an unused branch, but cannot alter the live one.
	const temporary = file + ".tmp";
	const handle = await open(temporary, "wx");
	try {
		await handle.writeFile(
			[target.getHeader(), ...entries, notice].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			"utf8"
		);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, file);
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { persistHistoryBranch, selectHistoryBranch, sessionHistoryDirectory } from "../src/session-history.js";
import { recoverDurableSession } from "../src/session-recovery.js";
import { recoveryAssistant, recoveryOperation, recoverySnapshot } from "./recovery-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function setup() {
	const first = recoveryOperation("first", { status: "completed" });
	const second = recoveryOperation("second", { createdAt: 40, startedAt: 40, finishedAt: 60, updatedAt: 60 });
	second.payload = { ...second.payload, content: [{ type: "text", text: "OBSOLETE_REQUEST" }] };
	const snapshot = recoverySnapshot([first, second]);
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("wuming-turn-input", { operationId: first.id });
	const firstUser = manager.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: "EXPANDED_ATTACHMENT" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		],
		timestamp: 11,
	});
	manager.appendMessage(recoveryAssistant([{ type: "toolCall", id: "write", name: "write", arguments: {} }]));
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "write",
		toolName: "write",
		content: [{ type: "text", text: "FULL_RAW_RESULT" }],
		isError: false,
		timestamp: 21,
	});
	manager.appendCompaction("RETAINED_SUMMARY", firstUser, 1000);
	manager.appendCustomEntry("wuming-turn-input", { operationId: second.id });
	manager.appendMessage({ role: "user", content: "OBSOLETE_REQUEST", timestamp: 41 });
	manager.appendMessage({ ...recoveryAssistant([{ type: "text", text: "OBSOLETE_ANSWER" }]), timestamp: 50 });
	manager.appendCompaction("OBSOLETE_SUMMARY", firstUser, 2000);
	return { manager, first, second, snapshot, operations: [first, second] };
}

it("retains raw attachments, confirmed results and earlier compaction but excludes the edited suffix", async () => {
	const { manager, snapshot, operations, second } = setup();
	const original = manager.getEntries();
	const root = await mkdtemp(join(tmpdir(), "wuming-history-unit-"));
	roots.push(root);
	const input = { snapshot, targetSessionId: "fork", historyId: "branch", beforeItemId: second.payload.userItemId };
	await persistHistoryBranch(root, root, manager, input, operations);
	const fork = SessionManager.continueRecent(root, sessionHistoryDirectory(root, "fork", "branch"));
	const raw = JSON.stringify(fork.getBranch());
	for (const text of ["EXPANDED_ATTACHMENT", "aW1hZ2U=", "FULL_RAW_RESULT", "RETAINED_SUMMARY"])
		expect(raw).toContain(text);
	for (const text of ["OBSOLETE_REQUEST", "OBSOLETE_ANSWER", "OBSOLETE_SUMMARY"]) expect(raw).not.toContain(text);
	expect(manager.getEntries()).toEqual(original);
	const forkSnapshot = {
		...snapshot,
		runtimeHistoryId: "branch",
		transcript: snapshot.transcript.slice(0, 1),
		session: { ...snapshot.session, id: "fork" },
	};
	// A repeated edit in a fork still finds legacy user entries without source operations.
	expect(
		selectHistoryBranch(
			fork,
			{
				snapshot: forkSnapshot,
				targetSessionId: "nested",
				historyId: "nested",
				fromItemId: operations[0]!.payload.userItemId,
			},
			[]
		)
	).toHaveLength(2);
});

it("does not recover abandoned requests after an edit, including after compaction", async () => {
	const { manager, snapshot, operations, second } = setup();
	const retained = SessionManager.inMemory();
	const content = selectHistoryBranch(
		manager,
		{ snapshot, targetSessionId: snapshot.session.id, historyId: "edit", beforeItemId: second.payload.userItemId },
		operations
	);
	// Use the same recovery path as the runtime with a fresh active branch.
	retained.appendMessage({ role: "user", content: "CURRENT_REQUEST", timestamp: 70 });
	const edited = { ...snapshot, runtimeHistoryId: "edit", transcript: [] };
	let loaded = false;
	await recoverDurableSession(retained, {
		snapshot: edited,
		operations,
		signal: new AbortController().signal,
		loadPrompt: async () => {
			loaded = true;
			return { text: "SHOULD_NOT_LOAD", images: [] };
		},
	});
	expect(loaded).toBe(false);
	expect(JSON.stringify(retained.buildSessionContext().messages)).not.toContain("OBSOLETE_REQUEST");
	expect(JSON.stringify(content)).not.toContain("OBSOLETE_SUMMARY");
});

it("refuses display-only forks and never mistakes the next request for a missing earlier input", () => {
	const { snapshot, operations } = setup();
	const missing = SessionManager.inMemory();
	missing.appendCustomEntry("wuming-turn-input", { operationId: operations[0]!.id });
	missing.appendCustomEntry("wuming-turn-input", { operationId: operations[1]!.id });
	missing.appendMessage({ role: "user", content: "OBSOLETE_REQUEST", timestamp: 41 });
	expect(() =>
		selectHistoryBranch(missing, { snapshot, targetSessionId: "fork", historyId: "fork" }, operations)
	).toThrow("Original model history is missing");
});

it("persists a branch even when no assistant response has ever existed", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-history-empty-"));
	roots.push(root);
	const snapshot = recoverySnapshot([]);
	const manager = SessionManager.inMemory(root);
	await persistHistoryBranch(root, root, manager, { snapshot, targetSessionId: "new", historyId: "empty" }, []);
	const directory = sessionHistoryDirectory(root, "new", "empty");
	expect(await SessionManager.list(root, directory)).toHaveLength(1);
	expect(SessionManager.continueRecent(root, directory).getBranch()).toHaveLength(1);
});

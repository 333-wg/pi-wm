import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { recoverDurableSession, requestDigest } from "../src/session-recovery.js";
import type { PiSessionRecovery } from "../src/types.js";
import { recoveryAssistant, recoveryOperation, recoverySnapshot } from "./recovery-fixtures.js";

const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

function input(operations = [recoveryOperation()]): PiSessionRecovery {
	return {
		operations,
		snapshot: recoverySnapshot(operations),
		signal: new AbortController().signal,
		loadPrompt: vi.fn<PiSessionRecovery["loadPrompt"]>(async (operation) => ({
			text: (operation.payload.runtimeContent ?? operation.payload.content)
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n\n"),
			images: [],
		})),
	};
}

it("recovers a first request absent from the Pi log, including repeated crashes before any assistant response", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-recovery-first-"));
	directories.push(root);
	const first = SessionManager.create(root, root);
	first.appendMessage({ role: "user", content: "Build a library management system", timestamp: 11 });
	expect(existsSync(first.getSessionFile()!)).toBe(false);
	const resumed = SessionManager.continueRecent(root, root);
	expect(resumed.buildSessionContext().messages).toEqual([]);
	expect(await recoverDurableSession(resumed, input())).toBe(true);
	expect(JSON.stringify(resumed.buildSessionContext().messages)).toContain("Build a library management system");
	const next = recoveryOperation("next", {
		createdAt: 40,
		startedAt: 40,
		finishedAt: 50,
		updatedAt: 50,
		payload: { type: "turn", mode: "prompt", userItemId: "user-next", content: [{ type: "text", text: "Continue" }] },
	});
	const resumedAgain = SessionManager.continueRecent(root, root);
	await recoverDurableSession(resumedAgain, input([recoveryOperation(), next]));
	const context = JSON.stringify(resumedAgain.buildSessionContext().messages);
	expect(context).toContain("Build a library management system");
	expect(context).toContain("Continue");
	expect(context).toContain("runtime_restart");
});

it("uses durable interruption state when a tool has no result and the Pi tail has no error text", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Build a library management system", timestamp: 11 });
	manager.appendMessage(
		recoveryAssistant([{ type: "toolCall", id: "write", name: "write", arguments: { path: "app.ts" } }])
	);
	const recovery = input();
	recovery.snapshot.transcript.push({
		id: "tool-write",
		type: "tool",
		toolCallId: "write",
		toolName: "write",
		status: "aborted",
		input: { path: "app.ts" },
		content: [{ type: "text", text: "TRUNCATED_UI_PREVIEW" }],
		isError: true,
		createdAt: 20,
	});
	expect(await recoverDurableSession(manager, recovery)).toBe(true);
	expect(recovery.loadPrompt).not.toHaveBeenCalled();
	const context = JSON.stringify(manager.buildSessionContext().messages);
	expect(context).toContain('\\"outcome\\":\\"unknown\\"');
	expect(context).toContain("runtime_restart");
	expect(context).not.toContain("TRUNCATED_UI_PREVIEW");
	expect(manager.buildSessionContext().messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
});

it("retains completed raw tool evidence while recording a later runtime restart", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Build a library management system", timestamp: 11 });
	manager.appendMessage(recoveryAssistant([{ type: "toolCall", id: "write", name: "write", arguments: {} }]));
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "write",
		toolName: "write",
		isError: false,
		content: [{ type: "text", text: "FULL_RAW_RESULT" }],
		timestamp: 21,
	});
	const before = manager.buildSessionContext().messages;
	await recoverDurableSession(manager, input());
	expect(manager.buildSessionContext().messages.slice(0, before.length)).toEqual(before);
	expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("FULL_RAW_RESULT");
});

it("does not reintroduce an original request already covered by compaction", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Build a library management system", timestamp: 11 });
	manager.appendMessage(recoveryAssistant());
	const retained = manager.appendMessage({ role: "user", content: "Recent context", timestamp: 32 });
	manager.appendCompaction("Library work summary", retained, 2000);
	const recovery = input();
	await recoverDurableSession(manager, recovery);
	expect(recovery.loadPrompt).not.toHaveBeenCalled();
	expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("Build a library management system");
	expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("Library work summary");
	const leaf = manager.getLeafId();
	expect(await recoverDurableSession(manager, recovery)).toBe(false);
	expect(manager.getLeafId()).toBe(leaf);
});

it("keeps recovery receipts across restart and compaction", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-recovery-receipts-"));
	directories.push(root);
	const manager = SessionManager.create(root, root);
	manager.appendMessage({ role: "user", content: "Build a library management system", timestamp: 11 });
	manager.appendMessage(recoveryAssistant());
	await recoverDurableSession(manager, input());
	const retained = manager.appendMessage({ role: "user", content: "Continue", timestamp: 40 });
	manager.appendCompaction("Previous task interrupted", retained, 2000);
	const reopened = SessionManager.continueRecent(root, root);
	const before = reopened.getEntries();
	expect(await recoverDurableSession(reopened, input())).toBe(false);
	expect(reopened.getEntries()).toEqual(before);
});

it("matches original input, not an unrelated user message in the same time window", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Different task", timestamp: 11 });
	await recoverDurableSession(manager, input());
	expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("Build a library management system");
});

it("checks operation-specific input receipts without reloading attachments", async () => {
	const manager = SessionManager.inMemory();
	const content = [{ type: "text" as const, text: "Provider-facing attachment contents" }];
	manager.appendCustomEntry("wuming-turn-input", { operationId: "original", digest: requestDigest(content) });
	manager.appendMessage({ role: "user", content, timestamp: 11 });
	const recovery = input();
	await recoverDurableSession(manager, recovery);
	expect(recovery.loadPrompt).not.toHaveBeenCalled();
});

it("restores original images and internal runtime content instead of display text", async () => {
	const manager = SessionManager.inMemory();
	const operation = recoveryOperation();
	operation.payload.runtimeContent = [{ type: "text", text: "INTERNAL_ORIGINAL_REQUEST" }];
	const recovery = input([operation]);
	recovery.loadPrompt = vi.fn<PiSessionRecovery["loadPrompt"]>(async () => ({
		text: "INTERNAL_ORIGINAL_REQUEST",
		images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
	}));
	await recoverDurableSession(manager, recovery);
	const context = JSON.stringify(manager.buildSessionContext().messages);
	expect(context).toContain("INTERNAL_ORIGINAL_REQUEST");
	expect(context).toContain("aW1hZ2U=");
	expect(context).not.toContain("Build a library management system");
});

it("does not commit recovery if original attachment loading fails", async () => {
	const manager = SessionManager.inMemory();
	const recovery = input();
	recovery.loadPrompt = async () => {
		throw new Error("Missing attachment");
	};
	await expect(recoverDurableSession(manager, recovery)).rejects.toThrow("Missing attachment");
	expect(manager.getEntries()).toEqual([]);
});

it("does not modify a session with an active approval", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(recoveryAssistant([{ type: "toolCall", id: "pending", name: "write", arguments: {} }]));
	const recovery = input();
	recovery.snapshot = {
		...recovery.snapshot,
		pendingApprovals: [{ id: "pending" } as (typeof recovery.snapshot.pendingApprovals)[number]],
	};
	const leaf = manager.getLeafId();
	expect(await recoverDurableSession(manager, recovery)).toBe(false);
	expect(manager.getLeafId()).toBe(leaf);
});

it("rejects cross-session records and aborted recovery", async () => {
	const manager = SessionManager.inMemory();
	await expect(
		recoverDurableSession(manager, input([recoveryOperation("other", { sessionId: "other" })]))
	).rejects.toThrow("Cross-session");
	const recovery = input();
	recovery.signal = AbortSignal.abort(new Error("Stopped"));
	await expect(recoverDurableSession(manager, recovery)).rejects.toThrow("Stopped");
	expect(manager.getEntries()).toEqual([]);
});

it("leaves completed context unchanged and never restores queued or running requests", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Build a library management system", timestamp: 11 });
	manager.appendMessage(recoveryAssistant());
	const messages = manager.buildSessionContext().messages;
	expect(
		await recoverDurableSession(
			manager,
			input([
				recoveryOperation("complete", { status: "completed" }),
				recoveryOperation("queued", { status: "queued" }),
				recoveryOperation("running", { status: "running" }),
			])
		)
	).toBe(false);
	expect(manager.buildSessionContext().messages).toEqual(messages);
});

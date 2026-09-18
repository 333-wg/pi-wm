import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionSnapshot } from "@wuming/protocol";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createDefaultPiSessionFactory, recoverInterruptedSession } from "../src/default-factory.js";
import type { PiSessionLike } from "../src/types.js";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function assistant(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: 1,
	};
}

it("retains user requests across consecutive interrupted turns", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "stable", timestamp: 1 });
	manager.appendMessage(assistant("stop"));
	manager.appendMessage({ role: "user", content: "old weather request", timestamp: 2 });
	manager.appendMessage(assistant("error", "This operation was aborted"));
	manager.appendMessage({ role: "user", content: "new document request", timestamp: 3 });
	manager.appendMessage(assistant("aborted"));

	expect(recoverInterruptedSession(manager)).toBe(true);
	expect(
		manager
			.buildSessionContext()
			.messages.filter((message) => message.role === "user")
			.map((message) => message.content)
	).toEqual(["stable", "old weather request", "new document request"]);
	const notice = manager.buildSessionContext().messages.at(-1);
	expect(notice).toMatchObject({ role: "custom", customType: "wuming-interrupted-turn", display: false });
	expect(notice && "content" in notice && notice.content).toContain("if it changes tasks, follow the new task");
	const leaf = manager.getLeafId();
	expect(recoverInterruptedSession(manager)).toBe(false);
	expect(manager.getLeafId()).toBe(leaf);
});

it("retains the first request and completed work when the first turn is cancelled", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Build a library management system", timestamp: 1 });
	manager.appendMessage({
		...assistant("toolUse"),
		content: [
			{ type: "text", text: "I will implement book search and borrowing." },
			{ type: "toolCall", id: "write-package", name: "write", arguments: { path: "package.json" } },
		],
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "write-package",
		toolName: "write",
		content: [{ type: "text", text: "Created package.json" }],
		isError: false,
		timestamp: 2,
	});
	manager.appendMessage(assistant("aborted"));
	const before = manager.buildSessionContext().messages;
	expect(recoverInterruptedSession(manager)).toBe(true);
	expect(manager.buildSessionContext().messages.slice(0, -1)).toEqual(before);
	manager.appendMessage({ role: "user", content: "Continue", timestamp: 3 });
	expect(recoverInterruptedSession(manager)).toBe(false);
	expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({ role: "user", content: "Continue" });
});

it("preserves a cancelled tool result and marks uncertain side effects without replaying tools", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Write the app", timestamp: 1 });
	manager.appendMessage({
		...assistant("toolUse"),
		content: [{ type: "toolCall", id: "write-app", name: "write", arguments: { path: "app.ts" } }],
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "write-app",
		toolName: "write",
		content: [{ type: "text", text: "Operation cancelled" }],
		isError: true,
		timestamp: 2,
	});
	expect(recoverInterruptedSession(manager)).toBe(true);
	const messages = manager.buildSessionContext().messages;
	expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	const notice = messages.at(-1);
	expect(notice && "content" in notice && notice.content).toContain("Inspect the current state before repeating it");
	expect(recoverInterruptedSession(manager)).toBe(false);
});

it("does not change pending tool approvals or unrelated errors", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Write the app", timestamp: 1 });
	manager.appendMessage({
		...assistant("toolUse"),
		content: [{ type: "toolCall", id: "pending", name: "write", arguments: {} }],
	});
	const pendingLeaf = manager.getLeafId();
	expect(recoverInterruptedSession(manager)).toBe(false);
	expect(manager.getLeafId()).toBe(pendingLeaf);
	manager.appendMessage(assistant("error", "Rate limit exceeded"));
	const errorLeaf = manager.getLeafId();
	expect(recoverInterruptedSession(manager)).toBe(false);
	expect(manager.getLeafId()).toBe(errorLeaf);
});

it("persists recovery across restart without adding duplicate notices", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-interrupted-context-"));
	directories.push(root);
	const manager = SessionManager.create(root, root);
	manager.appendMessage({ role: "user", content: "Build a library management system", timestamp: 1 });
	manager.appendMessage(assistant("aborted"));
	expect(recoverInterruptedSession(manager)).toBe(true);
	const resumed = SessionManager.continueRecent(root, root);
	expect(resumed.buildSessionContext().messages).toEqual(manager.buildSessionContext().messages);
	expect(recoverInterruptedSession(resumed)).toBe(false);
	resumed.appendMessage({ role: "user", content: "Continue", timestamp: 2 });
	resumed.appendMessage(assistant("error", "This operation was aborted"));
	expect(recoverInterruptedSession(resumed)).toBe(true);
	expect(resumed.buildSessionContext().messages.filter((message) => message.role === "custom")).toHaveLength(2);
});

it("keeps a completed turn as the active context", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "current request", timestamp: 1 });
	manager.appendMessage(assistant("stop"));
	const leaf = manager.getLeafId();
	expect(recoverInterruptedSession(manager)).toBe(false);
	expect(manager.getLeafId()).toBe(leaf);
});

it.each([undefined, "parent-session"])(
	"keeps independent compactable sessions with Wuming tools (parent=%s)",
	async (parentSessionId) => {
		const root = await mkdtemp(join(tmpdir(), "wuming-pi-factory-"));
		directories.push(root);
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		const sessionDataDir = join(root, "sessions");
		await mkdir(agentDir);
		await mkdir(workspace);
		await writeFile(join(workspace, "AGENTS.md"), "This must be assembled by Wuming, not loaded implicitly by Pi.\n");
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"factory-test": {
						baseUrl: "https://example.invalid/v1",
						api: "openai-completions",
						apiKey: "test-only",
						models: [{ id: "test-model", input: ["text"], contextWindow: 258000 }],
					},
				},
			})
		);
		const customWrite: ToolDefinition = {
			name: "write",
			label: "write",
			description: "Test-only Wuming write tool",
			promptSnippet: "Test-only Wuming write tool",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const snapshot: SessionSnapshot = {
			session: {
				id: "factory-session",
				...(parentSessionId ? { parentSessionId } : {}),
				workspaceId: "workspace",
				phase: "idle",
				createdAt: 1,
				updatedAt: 1,
			},
			revision: 1,
			model: { provider: "factory-test", id: "test-model" },
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
			transcript: [],
			queuedSteerCount: 0,
			queuedFollowUpCount: 0,
			pendingApprovals: [],
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				costUsd: 0,
			},
		};
		const factory = createDefaultPiSessionFactory({
			agentDir,
			sessionDataDir,
			resolveWorkspace: () => workspace,
			createCustomTools: () => [customWrite],
		});
		const session = await factory(snapshot);

		try {
			const contextUsage = session.getContextUsage?.();
			expect(contextUsage?.contextWindow).toBe(258000);
			expect(contextUsage?.tokens).toBeTypeOf("number");
			expect(session.getContextUsage?.()).toEqual(contextUsage);
			await expect(
				session.prompt("Inspect this image", {
					images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
				})
			).rejects.toThrow("当前模型不支持图片理解");
			expect((session as PiSessionLike & { autoCompactionEnabled: boolean }).autoCompactionEnabled).toBe(true);
			const activeTools = (session as PiSessionLike & { agent: { state: { tools: Array<{ name: string }> } } }).agent
				.state.tools;
			expect(activeTools.map((tool) => tool.name)).toEqual(["write"]);
			// Pi would otherwise introduce itself and describe its own tool names. The
			// prompt is rendered from the live tool set, so the custom tool appears in it.
			const prompt = session.getSystemPrompt?.() ?? "";
			expect(prompt.startsWith("You are Pi-Wm, a coding agent.")).toBe(true);
			expect(prompt).toContain("- write: Test-only Wuming write tool");
			expect(prompt).toContain("Sandbox mode: workspace_write");
			expect(prompt).not.toContain("This must be assembled by Wuming");
			const manifests = session.getCapabilityManifests?.() ?? [];
			expect(manifests).toHaveLength(1);
			expect(manifests[0]).toMatchObject({
				id: "tool:write",
				kind: "tool",
				provider: "wuming",
				tool: { name: "write", executionMode: "parallel", exposure: "direct" },
			});
			expect(manifests[0]?.tool?.inputSchema).toMatchObject({ type: "object" });
		} finally {
			session.dispose();
		}

		// A project that ships its own prompt still owns it: ours is the default only.
		await mkdir(join(workspace, ".pi"));
		await writeFile(join(workspace, ".pi", "SYSTEM.md"), "Project prompt wins.\n");
		const overridden = await factory({
			...snapshot,
			session: { ...snapshot.session, id: "override-session" },
		});
		try {
			expect(overridden.getSystemPrompt?.()).toContain("Project prompt wins.");
			expect(overridden.getSystemPrompt?.()).not.toContain("You are Wuming");
		} finally {
			overridden.dispose();
		}
	}
);

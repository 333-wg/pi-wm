import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "@wuming/protocol";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createSandboxTools } from "../src/tools.js";
import type { SandboxToolOptions } from "../src/tools.js";
import type { ApprovalBroker } from "../src/approval.js";
import type { BrowserAutomation } from "../src/types.js";

const noContext = undefined as unknown as Parameters<ToolDefinition["execute"]>[4];

function harness() {
	const page = {
		tabId: "t1",
		tabCount: 1,
		url: "http://127.0.0.1:5173/",
		title: "App",
		text: "Saved",
		interactiveCount: 1,
		truncated: false,
	};
	const diagnostics = { url: page.url, console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
	const run = vi.fn<NonNullable<BrowserAutomation["run"]>>(async () => ({
		completedSteps: 1,
		steps: [],
		snapshot: page,
		diagnostics,
		durationMs: 0,
		actionDurationMs: 0,
	}));
	const screenshot = vi.fn<BrowserAutomation["screenshot"]>(async () => ({
		image: Buffer.from("png"),
		url: page.url,
		title: page.title,
	}));
	const browser: BrowserAutomation = {
		open: async () => page,
		snapshot: async () => page,
		act: async () => page,
		run,
		screenshot,
		diagnostics: async () => diagnostics,
		tabs: async () => [],
		close: async () => {},
	};
	const artifactWriter = vi.fn<NonNullable<SandboxToolOptions["artifactWriter"]>>(async () => ({
		id: "image",
		name: "image.png",
		mimeType: "image/png",
		size: 3,
	}));
	let leases = 0;
	const acquire = vi.fn(() => {
		leases++;
		return () => {
			leases--;
		};
	});
	const snapshot: SessionSnapshot = {
		session: { id: "borrower", workspaceId: "workspace", phase: "turn", createdAt: 1, updatedAt: 1 },
		revision: 1,
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		sandboxMode: "workspace_write",
		approvalPolicy: "never",
		transcript: [],
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		pendingApprovals: [],
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
	};
	const options: SandboxToolOptions = {
		snapshot,
		approvals: { authorize: async () => {} } as unknown as ApprovalBroker,
		artifactWriter,
		executor: {
			files: {
				root: process.cwd(),
				readText: async () => ({ content: "", bytesRead: 0, totalBytes: 0, truncated: false }),
				writeText: async () => ({ bytesWritten: 0 }),
				editText: async () => ({ bytesWritten: 0, replacements: 0 }),
			},
			browser,
			preview: {
				start: async () => ({ state: "running", log: "", truncated: false }),
				status: async () => ({ state: "stopped", log: "", truncated: false }),
				stop: async () => ({ state: "stopped", log: "", truncated: false }),
				acquire,
			},
		},
	};
	const action = createSandboxTools(options).find((tool) => tool.name === "browser_action")!;
	const execute = (signal?: AbortSignal) =>
		action.execute(
			"verify",
			{ action: "batch", steps: [{ action: "wait", text: "Saved" }], screenshot: true, evidence_timeout_ms: 100 },
			signal,
			undefined,
			noContext
		);
	return { execute, run, screenshot, artifactWriter, acquire, leases: () => leases, page, diagnostics };
}

describe("browser verification finalization", () => {
	it("bounds a stuck screenshot, preserves completed steps and releases the preview lease", async () => {
		const h = harness();
		let cancelled = false;
		h.screenshot.mockImplementation(async (options) => {
			expect(h.leases()).toBe(1);
			options?.signal?.addEventListener(
				"abort",
				() => {
					cancelled = true;
				},
				{ once: true }
			);
			return new Promise(() => {});
		});
		const started = Date.now();
		await expect(h.execute()).rejects.toMatchObject({
			details: { completedSteps: 1, evidenceError: expect.stringContaining("time budget") },
		});
		expect(Date.now() - started).toBeLessThan(1000);
		expect(cancelled).toBe(true);
		expect(h.run).toHaveBeenCalledTimes(1);
		expect(h.artifactWriter).not.toHaveBeenCalled();
		expect(h.acquire).toHaveBeenCalledWith(h.page.url);
		expect(h.leases()).toBe(0);
	});

	it("shares the remaining evidence budget with artifact storage", async () => {
		const h = harness();
		h.run.mockImplementation(async () => {
			const evidenceDeadlineMs = Date.now() + 100;
			await delay(65);
			return {
				completedSteps: 1,
				steps: [],
				snapshot: h.page,
				diagnostics: h.diagnostics,
				durationMs: 65,
				actionDurationMs: 0,
				evidenceDeadlineMs,
			};
		});
		let storageSignal: AbortSignal | undefined;
		h.artifactWriter.mockImplementation(async ({ signal }) => {
			storageSignal = signal;
			return new Promise(() => {});
		});
		const started = Date.now();
		await expect(h.execute()).rejects.toMatchObject({
			details: { completedSteps: 1, evidenceError: expect.stringContaining("time budget") },
		});
		expect(Date.now() - started).toBeLessThan(500);
		expect(storageSignal?.aborted).toBe(true);
		expect(h.leases()).toBe(0);
	});

	it("does not start a screenshot after the final snapshot exhausts the budget", async () => {
		const h = harness();
		h.run.mockResolvedValue({
			completedSteps: 1,
			steps: [],
			diagnostics: h.diagnostics,
			durationMs: 100,
			evidenceDeadlineMs: Date.now() - 1,
		});
		await expect(h.execute()).rejects.toMatchObject({ details: { completedSteps: 1 } });
		expect(h.screenshot).not.toHaveBeenCalled();
	});

	it("reports complete elapsed time including artifact storage", async () => {
		const h = harness();
		h.artifactWriter.mockImplementation(async () => {
			expect(h.leases()).toBe(1);
			await delay(30);
			return { id: "stored", name: "image.png", mimeType: "image/png", size: 3 };
		});
		const result = await h.execute();
		const details = result.details as { durationMs: number; evidenceDurationMs: number };
		expect(details.durationMs).toBeGreaterThanOrEqual(25);
		expect(details.evidenceDurationMs).toBe(details.durationMs);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining(`"durationMs":${details.durationMs}`),
		});
		expect(h.leases()).toBe(0);
	});

	it("propagates user cancellation during evidence collection without replay", async () => {
		const h = harness();
		const controller = new AbortController();
		h.screenshot.mockImplementation(async () => {
			controller.abort(new Error("Stopped by user"));
			return new Promise(() => {});
		});
		await expect(h.execute(controller.signal)).rejects.toThrow("Stopped by user");
		expect(h.run).toHaveBeenCalledTimes(1);
		expect(h.leases()).toBe(0);
	});
});

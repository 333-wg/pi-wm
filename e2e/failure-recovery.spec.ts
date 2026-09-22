import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore, type CommitMutationOptions } from "@wuming/orchestrator";
import type { TranscriptItem } from "@wuming/protocol";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
const sessions: Record<string, string> = {};

class LegacyFailureStore extends SqliteOrchestratorStore {
	override commitMutation(options: CommitMutationOptions) {
		// Seed the pre-fix failure into an isolated fixture database, not the user's data.
		if (options.retryOperation) throw new Error("Mutation contains an invalid event");
		return super.commitMutation(options);
	}
}

test.beforeAll(async () => {
	webUrl = await startWebApp({}, async (workspace) => {
		using store = new LegacyFailureStore(join(workspace, "..", "data", "wuming.db"));
		for (const mode of ["network", "legacy"]) {
			const orchestrator = new SessionOrchestrator(
				store,
				{
					async executeTurn(input) {
						const tool: TranscriptItem = {
							id: `${mode}:tool`,
							type: "tool",
							createdAt: Date.now(),
							toolCallId: `${mode}:launch`,
							toolName: "computer_open",
							input: { app_ref: "fixture" },
							content: [{ type: "text", text: '{"performed":true,"outcome":"launch_requested"}' }],
							status: "complete",
							isError: false,
						};
						const error: TranscriptItem = {
							id: `${mode}:provider`,
							type: "assistant",
							createdAt: Date.now(),
							content: [{ type: "text", text: "正在检查测试应用。" }],
							status: "error",
							error: "Connection error.",
							model: input.snapshot.model,
						};
						input.onTranscriptItem?.(tool);
						input.onTranscriptItem?.(error);
						return {
							items: [tool, error],
							failure: {
								code: "runtime_error",
								kind: "provider_network",
								message: "Connection error.",
								retryable: true,
							},
						};
					},
				},
				{ maxRetries: mode === "legacy" ? 1 : 0, retryBaseDelayMs: 0 }
			);
			const created = await orchestrator.createSession({
				principalId: "test",
				idempotencyKey: `create-${mode}`,
				workspaceId: "local-workspace",
				name: mode,
				model: { provider: "demo", id: "wuming-demo" },
				thinkingLevel: "off",
				sandboxMode: "unrestricted",
				approvalPolicy: "never",
			});
			const sessionId = created.snapshot.session.id;
			sessions[mode] = sessionId;
			await orchestrator.acceptTurn({
				principalId: "test",
				idempotencyKey: `turn-${mode}`,
				sessionId,
				mode: "prompt",
				content: [{ type: "text", text: "打开测试应用" }],
			});
			await orchestrator.drainSession(sessionId);
		}
	});
});
test.afterAll(stopWebApp);

for (const width of [1365, 390]) {
	for (const mode of ["network", "legacy"]) {
		test(`shows one actionable ${mode} failure at ${width}px`, async ({ page }, testInfo) => {
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.setViewportSize({ width, height: 900 });
			await page.addInitScript((id) => {
				localStorage.setItem("wuming.workspaceId", "local-workspace");
				localStorage.setItem("wuming.sessionId.local-workspace", id);
			}, sessions[mode]!);
			await openApp(page, webUrl);
			await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeEnabled();
			await expect(page.locator(".session-entry.selected")).toHaveCount(1);
			if (width <= 720) await page.getByRole("button", { name: "打开导航", exact: true }).click();
			await page
				.locator(".session-open")
				.filter({ hasText: new RegExp(`^${mode}$`) })
				.click();
			await expect(page.locator(".session-entry.selected .session-open")).toHaveText(mode);
			const notice = page.locator(".failure-notice");
			await expect(notice).toHaveCount(1);
			await expect(notice).toContainText(mode === "network" ? "连接暂时中断" : "任务状态保存失败");
			if (mode === "legacy") await expect(notice).toContainText("已安排自动重试 1 次；任务实际启动 1 次");
			await notice.getByText("技术详情", { exact: true }).click();
			await expect(notice.locator("pre")).toContainText("Connection error.");
			await page.screenshot({ path: testInfo.outputPath("failure.png") });
			expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
			expect(errors).toEqual([]);
			if (mode === "network" && width === 390) {
				await notice.getByRole("button", { name: "继续任务", exact: true }).click();
				await expect(page.locator(".message-row.user").last()).toContainText(
					"继续上一条未完成的桌面任务，不要从头重做"
				);
			}
		});
	}
}

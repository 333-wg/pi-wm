import { expect, test, type Page } from "@playwright/test";
import { reduceSessionEvent, type SessionEvent } from "@wuming/domain";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openApp, restartGateway, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_DEPLOYMENT_MODE: "local_device" }, async (workspace) => {
		const data = join(dirname(workspace), "data");
		const projects = ["project-visible", "project-hidden"].map((id) => ({
			id,
			name: id,
			path: join(workspace, id),
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...(id === "project-hidden" ? { hiddenAt: Date.now() } : {}),
		}));
		await mkdir(join(data, "projects"));
		for (const project of projects) await mkdir(project.path);
		await writeFile(join(data, "projects", "projects.json"), JSON.stringify({ version: 1, projects }));
		const store = new SqliteOrchestratorStore(join(data, "wuming.db"));
		try {
			const orchestrator = new SessionOrchestrator(store, {
				async executeTurn() {
					return { items: [] };
				},
			});
			for (const [workspaceId, totalTokens] of [
				["local-workspace", 1000],
				["project-visible", 2000],
				["project-hidden", 3000],
			] as const) {
				const { snapshot } = await orchestrator.createSession({
					principalId: "local-user",
					idempotencyKey: workspaceId,
					workspaceId,
					model: { provider: "demo", id: "wuming-demo" },
					thinkingLevel: "medium",
					sandboxMode: "workspace_write",
					approvalPolicy: "on_risk",
				});
				const usage = {
					inputTokens: totalTokens,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens,
					costUsd: 0,
				};
				const event: SessionEvent = {
					type: "session.usage.recorded",
					eventId: `usage-${workspaceId}`,
					sessionId: snapshot.session.id,
					revision: snapshot.revision + 1,
					timestamp: Date.now(),
					turnId: `turn-${workspaceId}`,
					mode: "prompt",
					model: snapshot.model,
					attempt: 1,
					usage,
					tools: [],
					requests: [{ requestId: `request-${workspaceId}`, model: snapshot.model, usage }],
				};
				store.commitMutation({
					sessionId: snapshot.session.id,
					expectedRevision: snapshot.revision,
					events: [event],
					snapshot: reduceSessionEvent(snapshot, event),
				});
				await orchestrator.archiveSession({
					principalId: "local-user",
					idempotencyKey: `archive-${workspaceId}`,
					sessionId: snapshot.session.id,
					archived: true,
				});
			}
		} finally {
			store.close();
		}
	});
});
test.afterAll(stopWebApp);

async function openUsage(page: Page) {
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page
		.getByRole("navigation", { name: "设置分类" })
		.getByRole("button", { name: /^用量统计/ })
		.click();
	return page.locator("#settings-panel-usage");
}

test("defaults to all historical usage and preserves totals after hiding projects and restarting", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await openApp(page, webUrl);
	const panel = await openUsage(page);
	const scope = panel.getByRole("combobox", { name: "统计范围" });
	const total = panel.locator(".usage-metric-card").last();
	await expect(scope).toHaveValue("");
	await expect(total).toContainText("6.0k");
	await expect(total).toContainText("3 次请求");
	await expect(scope.locator('option[value="project-hidden"]')).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath("all-workspaces-desktop.png") });
	await scope.selectOption("local-workspace");
	await expect(total).toContainText("工作区累计");
	await expect(total).toContainText("1.0k");
	await scope.selectOption("project-visible");
	await expect(total).toContainText("2.0k");
	await scope.selectOption("");
	await expect(total).toContainText("6.0k");
	await panel.getByRole("button", { name: "近 14 天", exact: true }).click();
	await expect(panel.locator(".usage-settings-day")).toHaveCount(14);
	await panel.getByRole("button", { name: "近 30 天", exact: true }).click();
	await expect(panel.locator(".usage-settings-day")).toHaveCount(30);
	await panel.getByRole("button", { name: "刷新用量统计" }).click();
	await expect(total).toContainText("6.0k");
	await page.setViewportSize({ width: 390, height: 844 });
	const dialog = page.getByRole("dialog", { name: "设置", exact: true });
	expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("all-workspaces-mobile.png") });
	await page.evaluate(() => localStorage.setItem("wuming.workspaceId", "project-visible"));
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await openUsage(page);
	await expect(scope).toHaveValue("");
	await expect(total).toContainText("6.0k");
	const removed = await page.request.delete(new URL("/api/projects/project-visible", webUrl).href, {
		headers: { authorization: `Bearer ${token}` },
	});
	expect(removed.status()).toBe(204);
	await restartGateway();
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await openUsage(page);
	await expect(scope).toHaveValue("");
	await expect(scope.locator('option[value="project-visible"]')).toHaveCount(0);
	await expect(total).toContainText("6.0k");
	await expect(total).toContainText("3 次请求");
});

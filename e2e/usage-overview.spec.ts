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
					tools:
						workspaceId === "local-workspace"
							? [
									{
										toolName: "read_file",
										callCount: 2,
										durationMs: 1200,
										usage: { ...usage, inputTokens: 0, totalTokens: 0 },
									},
								]
							: [],
					requests: [{ requestId: `request-${workspaceId}`, model: snapshot.model, usage }],
				};
				store.commitMutation({
					sessionId: snapshot.session.id,
					expectedRevision: snapshot.revision,
					events: [event],
					snapshot: reduceSessionEvent(snapshot, event),
				});
				if (workspaceId !== "local-workspace") {
					await orchestrator.archiveSession({
						principalId: "local-user",
						idempotencyKey: `archive-${workspaceId}`,
						sessionId: snapshot.session.id,
						archived: true,
					});
				}
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

test("reopens cached usage immediately and preserves data during slow or failed refreshes", async ({
	page,
}, testInfo) => {
	let hold = false;
	let requests = 0;
	const held: Array<{ release: () => void; fail: () => void }> = [];
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const parsed = JSON.parse(String(message));
			if (parsed.command?.type === "usage.overview" && !parsed.command.workspaceId) {
				requests++;
				if (hold) {
					held.push({
						release: () => server.send(message),
						fail: () =>
							socket.send(
								JSON.stringify({
									type: "response",
									requestId: parsed.requestId,
									ok: false,
									error: { code: "internal", message: "Usage temporarily unavailable" },
								})
							),
					});
					return;
				}
			}
			server.send(message);
		});
	});
	await page.setViewportSize({ width: 1440, height: 1000 });
	await openApp(page, webUrl);
	const panel = await openUsage(page);
	const total = panel.locator(".usage-metric-card").last();
	const refresh = panel.getByRole("button", { name: "刷新用量统计" });
	await expect(total).toContainText("6.0k");
	await expect(refresh).toBeEnabled();
	const initialRequests = requests;
	hold = true;
	await page
		.getByRole("dialog", { name: "设置", exact: true })
		.getByRole("button", { name: "关闭", exact: true })
		.click();
	await openUsage(page);
	await expect(total).toContainText("6.0k");
	await expect(panel.getByText("正在统计", { exact: true })).toHaveCount(0);
	await expect(refresh).toBeEnabled();
	expect(requests).toBe(initialRequests);
	await refresh.click();
	await expect.poll(() => held.length).toBe(1);
	await expect(refresh).toBeDisabled();
	await expect(total).toContainText("6.0k");
	await expect(panel.locator(".usage-trend-line")).toHaveCount(1);
	await page.screenshot({ path: testInfo.outputPath("usage-background-refresh.png") });
	await page
		.getByRole("dialog", { name: "设置", exact: true })
		.getByRole("button", { name: "关闭", exact: true })
		.click();
	await openUsage(page);
	await expect(total).toContainText("6.0k");
	await expect(refresh).toBeDisabled();
	expect(held).toHaveLength(1);
	held.shift()!.fail();
	await expect(panel.locator(".usage-settings-error")).toContainText("Usage temporarily unavailable");
	await expect(total).toContainText("6.0k");
	await expect(refresh).toBeEnabled();
	await refresh.click();
	await expect.poll(() => held.length).toBe(1);
	held.shift()!.release();
	await expect(refresh).toBeEnabled();
	await expect(panel.locator(".usage-settings-error")).toHaveCount(0);
	await panel.getByRole("button", { name: "近 14 天", exact: true }).click();
	await expect.poll(() => held.length).toBe(1);
	await panel.getByRole("button", { name: "近 7 天", exact: true }).click();
	await expect(total).toContainText("6.0k");
	await expect(panel.locator(".usage-settings-day")).toHaveCount(7);
	held.shift()!.release();
	await panel.getByRole("button", { name: "近 14 天", exact: true }).click();
	await expect(panel.locator(".usage-settings-day")).toHaveCount(14);
	await expect(refresh).toBeEnabled();
	await page.setViewportSize({ width: 390, height: 844 });
	await refresh.click();
	await expect.poll(() => held.length).toBe(1);
	await expect(total).toContainText("6.0k");
	expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("usage-background-refresh-mobile.png") });
	held.shift()!.release();
	await expect(refresh).toBeEnabled();
});

test("defaults to all historical usage and preserves totals after hiding projects and restarting", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await openApp(page, webUrl);
	await page.locator(".recent-conversations .session-open").first().click();
	await expect(page.getByRole("button", { name: "显示或隐藏运行面板", exact: true })).toBeVisible();
	if (!(await page.locator(".right-rail").isVisible()))
		await page.getByRole("button", { name: "显示或隐藏运行面板", exact: true }).click();
	const sparkline = page.getByRole("group", { name: "最近 7 天 Token 用量", exact: true });
	await expect(sparkline.locator(".usage-sparkline-line")).toHaveAttribute("d", / C /);
	await expect(sparkline.getByRole("button")).toHaveCount(7);
	await expect(sparkline.locator(".usage-sparkline-dates span").last()).toHaveText("今天");
	const firstPoint = sparkline.getByRole("button").first();
	await firstPoint.hover();
	await expect(firstPoint).toHaveAttribute("title", /0 Token/);
	await firstPoint.focus();
	await expect(firstPoint).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath("usage-sparkline-desktop.png") });
	const panel = await openUsage(page);
	const scope = panel.getByRole("combobox", { name: "统计范围" });
	const total = panel.locator(".usage-metric-card").last();
	await expect(scope).toHaveText("全部工作区");
	await expect(total).toContainText("6.0k");
	await expect(total).toContainText("3 次请求");
	await expect(panel.locator(".usage-metric-card > strong small")).toHaveText(["Token", "Token", "Token", "Token"]);
	await expect(panel.locator(".usage-composition-value small")).toHaveText(["100.0%", "0.0%", "0.0%", "0.0%"]);
	await expect(panel.locator(".usage-tool-header")).toContainText("总耗时");
	await expect(panel.locator(".usage-tool-row").last()).toContainText("2 次调用");
	await scope.click();
	await expect(panel.getByRole("option", { name: "project-hidden", exact: true })).toHaveCount(0);
	await expect(panel.getByRole("option", { name: "全部工作区", exact: true })).toHaveAttribute("aria-selected", "true");
	await page.screenshot({ path: testInfo.outputPath("usage-scope-open.png") });
	await scope.press("Escape");
	await expect(scope).toBeFocused();
	await expect(panel).toBeVisible();
	await expect(panel.getByRole("listbox")).toHaveCount(0);
	const chart = panel.getByRole("group", { name: "最近 7 天 Token 用量趋势" });
	await expect(chart.locator(".usage-trend-line")).toHaveAttribute("d", / C /);
	await expect(chart.locator(".usage-trend-point")).toHaveCount(7);
	await expect(chart.getByRole("status")).toContainText("6,000");
	await chart.locator(".usage-trend-point").first().hover();
	await expect(chart.locator(".usage-trend-point").first()).toHaveAttribute("aria-pressed", "true");
	await expect(chart.getByRole("status")).toContainText("0 Token");
	await chart.locator(".usage-trend-point").last().focus();
	await expect(chart.getByRole("status")).toContainText("6,000");
	await page.screenshot({ path: testInfo.outputPath("all-workspaces-desktop.png") });
	await scope.press("ArrowDown");
	await scope.press("ArrowDown");
	await scope.press("Enter");
	await expect(scope).toHaveText("本地工作区");
	await expect(panel.getByRole("listbox")).toHaveCount(0);
	await expect(total).toContainText("工作区累计");
	await expect(total).toContainText("1.0k");
	await scope.click();
	await panel.getByRole("option", { name: "project-visible", exact: true }).click();
	await expect(total).toContainText("2.0k");
	await expect(panel.getByText("当前会话还没有模型用量。", { exact: true })).toBeVisible();
	await expect(panel.getByText("当前会话还没有工具调用。", { exact: true })).toBeVisible();
	await scope.click();
	await panel.getByRole("option", { name: "全部工作区", exact: true }).click();
	await scope.click();
	await panel.locator(".usage-settings-section-heading").first().click();
	await expect(scope).toHaveAttribute("aria-expanded", "false");
	await scope.click();
	await scope.press("End");
	await scope.press("Home");
	await scope.press("Tab");
	await expect(scope).toHaveAttribute("aria-expanded", "false");
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
	await panel.locator(".usage-tools-section").scrollIntoViewIfNeeded();
	expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("usage-details-mobile.png") });
	await page.evaluate(() => localStorage.setItem("wuming.workspaceId", "project-visible"));
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await openUsage(page);
	await expect(scope).toHaveText("全部工作区");
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
	await expect(scope).toHaveText("全部工作区");
	await scope.click();
	await expect(panel.getByRole("option", { name: "project-visible", exact: true })).toHaveCount(0);
	await scope.press("Escape");
	await expect(total).toContainText("6.0k");
	await expect(total).toContainText("3 次请求");
});

import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
const sessions: Record<string, string> = {};

test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_RETRY_BASE_DELAY_MS: "300" }, async (workspace) => {
		using store = new SqliteOrchestratorStore(join(workspace, "..", "data", "wuming.db"));
		const orchestrator = new SessionOrchestrator(store, {
			async executeTurn() {
				return { items: [] };
			},
		});
		for (const width of [1365, 390]) {
			for (const mode of ["exhaust", "recover", "stop"]) {
				const name = `${mode}-${width}`;
				const created = await orchestrator.createSession({
					principalId: "test",
					idempotencyKey: name,
					name,
					workspaceId: "local-workspace",
					model: { provider: "demo", id: "wuming-demo" },
					thinkingLevel: "off",
					sandboxMode: "unrestricted",
					approvalPolicy: "never",
				});
				sessions[name] = created.snapshot.session.id;
			}
		}
	});
});
test.afterAll(stopWebApp);

async function openSession(page: Page, name: string, width: number) {
	await page.setViewportSize({ width, height: 900 });
	await page.addInitScript((id) => {
		localStorage.setItem("wuming.workspaceId", "local-workspace");
		localStorage.setItem("wuming.sessionId.local-workspace", id);
	}, sessions[name]!);
	await openApp(page, webUrl);
	if (width <= 720) await page.getByRole("button", { name: "打开导航", exact: true }).click();
	await page
		.locator(".session-open")
		.filter({ hasText: new RegExp(`^${name}$`) })
		.click();
	await expect(page.locator(".session-entry.selected .session-open")).toHaveText(name);
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
}

async function send(page: Page, text: string) {
	await page.getByRole("textbox", { name: "消息" }).fill(text);
	await page.getByRole("button", { name: "发送", exact: true }).click();
}

for (const width of [1365, 390]) {
	test(`updates one neutral card across five retries and reload at ${width}px`, async ({ page }, testInfo) => {
		await openSession(page, `exhaust-${width}`, width);
		await send(page, "/retry-exhaust");
		const recovery = page.getByRole("status", { name: "正在自动重试" });
		await expect(recovery).toHaveCount(1);
		await recovery.evaluate((element) => element.setAttribute("data-test-stable", "yes"));
		await recovery.getByText("技术详情", { exact: true }).click();
		await expect(recovery).toContainText("重试 3/5");
		await expect(recovery).toHaveAttribute("data-test-stable", "yes");
		await expect(recovery.locator("details")).toHaveAttribute("open", "");
		await expect(page.locator(".transcript .failure-notice")).toHaveCount(1);
		await expect(page.locator(".transcript .message-error")).toHaveCount(0);
		await expect(page.locator(".transcript [role=alert]")).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath("retry.png") });
		await expect(recovery).toContainText("重试 5/5");
		await page.reload();
		await expect(recovery).toBeVisible();
		await expect(recovery).toContainText("重试 5/5");
		await expect(recovery.locator("details")).not.toHaveAttribute("open", "");
		const notice = page.locator(".transcript .failure-notice");
		await expect(notice).toContainText("连接暂时中断", { timeout: 15_000 });
		await expect(notice).toHaveCount(1);
		await expect(notice).toContainText("已安排自动重试 5 次；任务实际启动 6 次");
		await expect(notice).toHaveAttribute("role", "status");
		await expect(page.locator(".transcript [role=alert]")).toHaveCount(0);
		await expect(page.locator(".transcript .tool-card")).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath("exhausted.png") });
		expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
	});

	test(`removes the recovery card after success at ${width}px`, async ({ page }) => {
		await openSession(page, `recover-${width}`, width);
		await send(page, "/retry-once");
		await expect(page.getByRole("status", { name: "正在自动重试" })).toBeVisible();
		await expect(page.getByText("Demo provider recovered after retry.", { exact: true })).toBeVisible();
		await expect(page.locator(".transcript .failure-notice")).toHaveCount(0);
		await expect(page.locator(".transcript .message-error")).toHaveCount(0);
	});

	test(`can stop the retry backoff at ${width}px`, async ({ page }) => {
		await openSession(page, `stop-${width}`, width);
		await send(page, "/retry-exhaust");
		await expect(page.getByRole("status", { name: "正在自动重试" })).toBeVisible();
		await page.getByRole("button", { name: "停止任务", exact: true }).click();
		await expect(page.getByRole("status", { name: "正在自动重试" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "停止任务", exact: true })).toHaveCount(0);
		await expect(page.locator(".transcript [role=alert]")).toHaveCount(0);
		await expect(page.locator(".transcript .failure-notice")).toHaveCount(0);
	});
}

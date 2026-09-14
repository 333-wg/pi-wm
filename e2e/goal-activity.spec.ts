import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;

test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_CONTEXT_WINDOW: "5000" });
});

test.afterAll(stopWebApp);

test("runs a goal inline with timer, pause, resume, and delete controls", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, webUrl);
	const composer = page.getByRole("textbox", { name: "消息", exact: true });
	await composer.fill("/goal /long");
	await expect(page.locator(".composer-goal-target")).toContainText("目标");
	await page.getByRole("button", { name: "发送", exact: true }).click();

	const card = page.locator(".goal-activity-card");
	await expect(card).toBeVisible();
	await expect(card).toContainText("进行中的目标");
	await expect(card).toContainText("/long");
	await expect(card).toContainText("当前对话中执行");
	await expect(card.getByText("查看执行会话")).toHaveCount(0);
	await expect(page.locator(".message-row.user").last()).toContainText("/long");
	await expect(page.locator(".message-row.assistant.streaming-row").last()).toContainText("demo-step-");
	const elapsed = card.locator(".goal-activity-elapsed").last();
	await expect(elapsed).toHaveText(/\d+s/);
	const first = await elapsed.textContent();
	await page.waitForTimeout(1200);
	await expect.poll(() => elapsed.textContent()).not.toBe(first);
	await page.screenshot({ path: testInfo.outputPath("goal-running-desktop.png") });

	await page.getByRole("button", { name: "暂停目标" }).click();
	await expect(card).toContainText("已暂停的目标");
	await page.screenshot({ path: testInfo.outputPath("goal-paused-desktop.png") });
	const paused = await elapsed.textContent();
	await page.waitForTimeout(1200);
	await expect(elapsed).toHaveText(paused ?? "0s");

	await page.getByRole("button", { name: "继续目标" }).click();
	await expect(card).toContainText("进行中的目标");
	await page.setViewportSize({ width: 390, height: 844 });
	const closeRail = page.locator(".right-rail .rail-mobile-close");
	if (await closeRail.isVisible()) await closeRail.click();
	await page.screenshot({ path: testInfo.outputPath("goal-running-mobile.png") });
	await page.getByRole("button", { name: "删除目标" }).click();
	await expect(card).toBeHidden();
});

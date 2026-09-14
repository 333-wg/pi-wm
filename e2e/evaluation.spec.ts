import { expect, test, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;

test.beforeAll(async () => {
	webUrl = await startWebApp();
});

test.afterAll(async () => {
	await stopWebApp();
});

async function completeRun(page: Page): Promise<void> {
	const sessions = page.getByRole("navigation", { name: "会话" }).locator(".session-entry");
	const previousCount = await sessions.count();
	await page.getByRole("button", { name: "新对话" }).click();
	await expect(sessions).toHaveCount(previousCount + 1);
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
	await page.getByRole("textbox", { name: "消息" }).fill("Evaluate this completed run");
	await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText(/Demo runtime received: Evaluate this completed run/)).toBeVisible();
	await expect(page.locator(".right-rail .phase-idle")).toHaveText("空闲");
}

test("creates reusable graders, evaluates a run, and exports a signed attestation", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1365, height: 900 });
	await openApp(page, webUrl);
	await completeRun(page);

	await page.getByRole("button", { name: "打开运行评测与诊断" }).first().click();
	const dialog = page.getByRole("dialog", { name: "运行评测" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("暂无评测记录", { exact: true })).toBeVisible();

	await dialog.getByRole("tab", { name: "回归数据集" }).click();
	await dialog.getByLabel("名称", { exact: true }).fill("Release regression");
	await expect(dialog.getByLabel("检查类型", { exact: true })).toHaveValue("trajectory");
	await dialog.getByLabel("要添加的检查类型").selectOption("artifact");
	await dialog.getByRole("button", { name: "添加检查" }).click();
	await expect(dialog.getByLabel("检查类型", { exact: true })).toHaveCount(2);
	await dialog.getByRole("button", { name: "移除检查" }).last().click();
	await dialog.getByRole("button", { name: "保存数据集" }).click();

	await expect(dialog.getByRole("tab", { name: "执行与结果" })).toHaveAttribute("aria-selected", "true");
	await expect(dialog.locator(".evaluation-run-controls select")).toHaveValue(/.+/);
	await dialog.getByRole("button", { name: "运行评测" }).click();
	await expect(dialog.locator(".evaluation-result.result-pass")).toBeVisible();
	await expect(dialog.locator(".evaluation-check.check-pass")).toContainText("轨迹检查 1");
	await expect(dialog.locator(".evaluation-check")).toContainText("Trajectory integrity=true");

	const download = page.waitForEvent("download");
	await dialog.getByRole("button", { name: "生成签名并导出 JSON" }).click();
	expect((await download).suggestedFilename()).toMatch(/^wuming-evaluation-.*\.json$/);
	await expect(dialog.getByText(/最近导出签名密钥/)).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("evaluation-desktop.png") });

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(dialog).toBeVisible();
	const box = await dialog.boundingBox();
	expect(box?.x).toBeGreaterThanOrEqual(0);
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("evaluation-mobile.png") });

	await dialog.getByRole("button", { name: "关闭" }).click();
	await expect(dialog).toBeHidden();
});

import { test, expect } from "@playwright/test";
import { openApp, startWebApp, stopWebApp, restartGateway } from "./harness.js";

let url: string;
test.beforeAll(async () => {
	url = await startWebApp({ WUMING_RUNTIME: "pi" });
});
test.afterAll(async () => {
	await stopWebApp();
});

test("saves Grok relay protocol per image model and restores it after restart", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await openApp(page, url);
	const settings = page.getByRole("region", { name: "图片与视频生成模型" });
	async function openSettings() {
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.locator(".settings-navigation button").filter({ hasText: "模型" }).click();
	}
	await openSettings();
	const imageEntry = settings.locator("summary").filter({ hasText: "手动添加生图服务" });
	const videoEntry = settings.locator("summary").filter({ hasText: "手动添加视频服务" });
	await videoEntry.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("media-add-buttons-desktop.png") });
	await videoEntry.focus();
	await videoEntry.press("Enter");
	await expect(settings.locator("form").filter({ hasText: "添加视频服务" })).toBeVisible();
	await videoEntry.press("Enter");
	await expect(settings.locator("form").filter({ hasText: "添加视频服务" })).toHaveCount(0);
	await imageEntry.click();
	const form = settings.locator("form").filter({ hasText: "添加生图服务" });
	await expect(form.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	await form.getByLabel("接口协议").selectOption("grok");
	await form.getByLabel("Base URL").fill("https://relay.invalid/api/v1");
	await form.getByLabel("模型 ID").fill("grok-imagine-image");
	await form.getByLabel("API Key").fill("fixture-only-key");
	await form.getByRole("button", { name: "保存", exact: true }).click();
	const protocol = settings.getByLabel("生图协议：grok-imagine-image", { exact: true });
	await expect(protocol).toHaveValue("grok");
	await settings.locator("summary").filter({ hasText: "手动添加生图服务" }).click();
	await form.getByLabel("Base URL").fill("https://relay.invalid/api/v1");
	await form.getByLabel("模型 ID").fill("gpt-image-1");
	await form.getByLabel("接口协议").selectOption("openai");
	await form.getByRole("button", { name: "保存", exact: true }).click();
	await expect(settings.getByLabel("生图协议：gpt-image-1", { exact: true })).toHaveValue("openai");
	await protocol.selectOption("openai");
	await expect(protocol).toBeEnabled();
	await expect(protocol).toHaveValue("openai");
	await protocol.selectOption("grok");
	await expect(protocol).toBeEnabled();
	await restartGateway();
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await openSettings();
	await expect(protocol).toHaveValue("grok");
	await expect(settings.getByLabel("生图协议：gpt-image-1", { exact: true })).toHaveValue("openai");
	await expect(settings.getByRole("button", { name: "启用默认模型：grok-imagine-image", exact: true })).toBeDisabled();
	await expect(settings).not.toContainText("fixture-only-key");
	await protocol.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("image-protocol-desktop.png") });
	await settings.locator("summary").filter({ hasText: "手动添加生图服务" }).click();
	await expect(form.getByLabel("API Key")).toHaveValue("");
	await expect(form.getByLabel("接口协议")).toHaveValue("auto");
	await form.getByLabel("接口协议").selectOption("grok");
	await form.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("image-protocol-form-desktop.png") });
	expect(errors).toEqual([]);
});

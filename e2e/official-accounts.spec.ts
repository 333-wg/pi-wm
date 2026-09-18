import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({
		WUMING_RUNTIME: "pi",
		WUMING_DEPLOYMENT_MODE: "local_device",
		WUMING_PROCESS_MODE: "disabled",
		WUMING_COMPUTER_PYTHON: "missing-test-python",
	});
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const width of [1440, 390]) {
	test(`official account authorization and cancellation at ${width}`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		// Exercise the real local callback flow without navigating to or signing into external accounts.
		await page.addInitScript(() => {
			window.open = () => null;
		});
		await openApp(page, webUrl);
		if (width === 390) await page.locator(".mobile-menu").click();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.locator('.settings-navigation button[aria-controls="settings-panel-models"]').click();
		await expect(page.locator("#settings-panel-models .official-accounts")).toHaveCount(0);
		await expect(page.locator("#settings-panel-models .custom-model-settings")).toBeVisible();
		await page.locator('.settings-navigation button[aria-controls="settings-panel-official"]').click();
		await expect(page.locator("#settings-panel-official .custom-model-settings")).toHaveCount(0);
		const accounts = page.getByRole("region", { name: "官方账号" });
		await expect(accounts.locator(".official-account")).toHaveCount(3);
		await expect(accounts.getByRole("button", { name: "登录", exact: true })).toHaveCount(3);
		await accounts.getByRole("combobox", { name: "ChatGPT 登录方式" }).selectOption("device_code");
		await expect(accounts.getByRole("combobox", { name: "ChatGPT 登录方式" })).toHaveValue("device_code");
		const claude = accounts.locator('[data-provider="official-claude"]');
		await claude.getByRole("button", { name: "登录", exact: true }).click();
		await expect(claude.getByRole("link", { name: "打开授权页面" })).toHaveAttribute(
			"href",
			/^https:\/\/claude\.ai\/oauth\/authorize\?/
		);
		await expect(claude).toContainText("等待授权");
		await claude.locator("summary").click();
		await claude.getByLabel("完整回调地址").fill("http://localhost:53692/callback?code=test&state=wrong");
		await claude.getByRole("button", { name: "提交", exact: true }).click();
		await expect(accounts.getByRole("alert")).toContainText("state");
		expect(await accounts.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath(`official-${width}.png`), fullPage: true });
		await claude.getByRole("button", { name: "取消", exact: true }).click();
		await expect(claude.getByRole("button", { name: "登录", exact: true })).toBeVisible();
		await expect(claude.getByRole("link")).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath(`official-${width}.png`), fullPage: true });
		await page.reload();
		if (width === 390) await page.locator(".mobile-menu").click();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.locator('.settings-navigation button[aria-controls="settings-panel-official"]').click();
		await expect(
			page.getByRole("region", { name: "官方账号" }).getByRole("button", { name: "登录", exact: true })
		).toHaveCount(3);
	});
}

test("new clients can reach official accounts without configuring an API service", async ({ page }) => {
	await page.addInitScript((value) => localStorage.setItem("wuming.token", value), token);
	await page.goto(webUrl);
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await expect(page.getByRole("dialog", { name: "首次设置" })).toHaveCount(0);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.locator('.settings-navigation button[aria-controls="settings-panel-official"]').click();
	await expect(page.locator(".custom-model-settings")).toBeHidden();
	await expect(page.getByRole("region", { name: "官方账号" }).locator(".official-account")).toHaveCount(3);
});

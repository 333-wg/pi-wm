import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";
let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_DEPLOYMENT_MODE: "local_device", WUMING_TERMINAL_MODE: "host" });
});
test.afterAll(stopWebApp);
test("wallpaper terminal retains real output through theme changes", async ({ page }, info) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	if (process.platform === "win32")
		await page.addInitScript(() => localStorage.setItem("wuming.terminal.shell", "cmd"));
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "暮色流光", exact: true }).click();
	await page.getByRole("button", { name: "浅色", exact: true }).click();
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await page.getByRole("tab", { name: "终端", exact: true }).click();
	const panel = page.locator(".terminal-workbench:not([hidden])");
	await expect(panel.getByRole("status")).toHaveText("就绪");
	await panel.locator(".xterm-helper-textarea").focus();
	await page.keyboard.insertText(`node -e "console.log('WALLPAPER'+'-READABLE');console.log('const answer = 42;')"`);
	await page.keyboard.press("Enter");
	await expect(panel.locator(".xterm-rows")).toContainText("WALLPAPER-READABLE");
	for (const mode of ["light", "dark"]) {
		if (mode === "dark") await page.getByRole("button", { name: "切换深浅主题" }).click();
		const colour = await page.locator("body").evaluate((e) => getComputedStyle(e).color);
		await expect(panel.locator(".xterm-rows")).toHaveCSS("color", colour);
		await expect(panel.locator(".xterm-viewport")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(panel.locator(".xterm-rows")).toContainText("WALLPAPER-READABLE");
		await page.screenshot({ path: info.outputPath(`terminal-${mode}.png`) });
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(panel.locator(".xterm-rows")).toContainText("WALLPAPER-READABLE");
	await page.screenshot({ path: info.outputPath("terminal-mobile.png") });
	page.once("dialog", (d) => d.accept());
	await panel.getByRole("button", { name: "关闭终端", exact: true }).click();
	await expect(panel.getByRole("status")).toHaveText("已关闭");
});

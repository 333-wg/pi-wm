import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";
import type { ComputerUseStatus } from "@wuming/protocol";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_DEPLOYMENT_MODE: "local_device" });
});
test.afterAll(stopWebApp);

for (const width of [1440, 390]) {
	test(`desktop control settings and emergency stop at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		let state: ComputerUseStatus = {
			supported: true,
			enabled: false,
			ready: false,
			installing: false,
			platform: "win32",
			python: "C:\\Users\\Administrator\\AppData\\Roaming\\Pi-Wm\\data\\computer-use\\venv\\Scripts\\python.exe",
			authorization: "settings",
		};
		let requests = 0;
		let stopRequests = 0;
		await page.route("**/api/computer-use**", async (route) => {
			const url = new URL(route.request().url());
			if (url.pathname.endsWith("/enable")) {
				requests++;
				state = { ...state, requestedEnabled: true, installing: true, setupStage: "installing_packages" };
			}
			if (url.pathname.endsWith("/stop")) {
				stopRequests++;
				state = { ...state, enabled: false, requestedEnabled: false };
			}
			await route.fulfill({ json: state });
		});
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await openApp(page, webUrl);
		if (width < 600) await page.getByTitle("打开导航").click();
		await page.locator(".sidebar-footer").getByRole("button", { name: "设置", exact: true }).click();
		await page
			.locator(".settings-navigation")
			.getByRole("button", { name: /Computer Use/ })
			.click();
		const panel = page.locator("#settings-panel-computer");
		await expect(panel).toBeVisible();
		await expect(panel.getByText("完全访问直接执行", { exact: true })).toBeVisible();
		await expect(panel.getByRole("switch")).toBeEnabled();
		await panel.getByRole("switch").click();
		const consent = page.getByRole("dialog", { name: "允许 Agent 控制电脑？" });
		await expect(consent).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath(`computer-consent-${width}.png`), fullPage: true });
		await consent.getByRole("button", { name: "取消", exact: true }).click();
		await expect(panel.getByRole("switch")).not.toBeChecked();
		expect(requests).toBe(0);
		await panel.getByRole("switch").click();
		await consent.getByRole("button", { name: "同意并开启" }).click();
		await expect(panel.getByRole("list", { name: "安装进度" })).toBeVisible();
		await expect(panel.getByRole("switch")).toBeChecked();
		await expect(page.locator(".computer-use-notice")).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath(`computer-installing-${width}.png`), fullPage: true });
		await panel.getByRole("button", { name: "紧急停止" }).click();
		await expect(panel.getByRole("switch")).not.toBeChecked();
		state = { ...state, installing: false, ready: true };
		await expect(panel.getByRole("switch")).toBeEnabled();
		await panel.getByRole("switch").click();
		await consent.getByRole("button", { name: "同意并开启" }).click();
		await expect(panel.getByRole("list", { name: "安装进度" })).toBeVisible();
		state = { ...state, enabled: true, installing: false, ready: true };
		await expect(panel.getByRole("list", { name: "安装进度" })).toHaveCount(0);
		await expect(panel.getByRole("switch")).toBeChecked();
		await panel.getByText("运行环境", { exact: true }).click();
		await page.screenshot({ path: testInfo.outputPath(`computer-settings-light-${width}.png`), fullPage: true });
		await page.evaluate(() => {
			document.documentElement.dataset.theme = "dark";
		});
		await page.screenshot({ path: testInfo.outputPath(`computer-settings-dark-${width}.png`), fullPage: true });
		const overflow = await panel.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
		expect(overflow).toBe(false);
		await page.locator(".settings-shell-header").getByRole("button", { name: "关闭" }).click();
		await expect(page.locator(".computer-use-notice")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "立即停止", exact: true })).toHaveCount(0);
		expect(state.enabled).toBe(true);
		expect(stopRequests).toBe(1);
		await page.screenshot({ path: testInfo.outputPath("computer-workspace-" + width + ".png"), fullPage: true });
		if (width < 600) await page.getByTitle("打开导航").click();
		await page.locator(".sidebar-footer").getByRole("button", { name: "设置", exact: true }).click();
		await page
			.locator(".settings-navigation")
			.getByRole("button", { name: /Computer Use/ })
			.click();
		await expect(panel.getByRole("switch")).toBeChecked();
		await panel.getByRole("switch").click();
		await expect(panel.getByRole("switch")).not.toBeChecked();
		expect(stopRequests).toBe(2);
		expect(errors).toEqual([]);
	});
}

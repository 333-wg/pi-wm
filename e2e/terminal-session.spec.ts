import { expect, test, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_DEPLOYMENT_MODE: "local_device", WUMING_TERMINAL_MODE: "host" });
});
test.afterAll(async () => {
	await stopWebApp();
});

async function command(page: Page, value: string) {
	await page.locator(".terminal-workbench:not([hidden]) .xterm-helper-textarea").focus();
	await page.keyboard.insertText(value);
	await page.keyboard.press("Enter");
}

test("keeps the real shell across navigation and disconnection, closes explicitly, and fits narrow panels", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.addInitScript(() => {
		const Native = window.WebSocket;
		Object.assign(window, { terminalTestSockets: [] });
		window.WebSocket = class extends Native {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				this.addEventListener("message", (event) => {
					if (JSON.parse(String(event.data)).type === "terminal.ready") {
						(window as unknown as { terminalTestSockets: WebSocket[] }).terminalTestSockets.push(this);
					}
				});
			}
		};
	});
	if (process.platform === "win32")
		await page.addInitScript(() => localStorage.setItem("wuming.terminal.shell", "cmd"));
	await openApp(page, webUrl);
	await page.getByRole("tab", { name: "终端", exact: true }).click();
	const panel = page.locator(".terminal-workbench:not([hidden])");
	await expect(panel.getByRole("status")).toHaveText("就绪");
	await command(page, process.platform === "win32" ? "set TERMINAL_KEEP=retained" : "export TERMINAL_KEEP=retained");
	await command(page, `node -e "console.log('BEFORE'+'-SWITCH')"`);
	await expect(panel.locator(".xterm-rows")).toContainText("BEFORE-SWITCH");
	await page.getByRole("tab", { name: "文件", exact: true }).click();
	await expect(page.locator(".terminal-workbench")).toBeHidden();
	await page.getByRole("tab", { name: "终端", exact: true }).click();
	await command(page, `node -e "console.log('STATE'+'-'+process.env.TERMINAL_KEEP)"`);
	await expect(panel.locator(".xterm-rows")).toContainText("STATE-retained");
	await page.evaluate(() =>
		(window as unknown as { terminalTestSockets: WebSocket[] }).terminalTestSockets.at(-1)!.close()
	);
	await expect(panel.getByRole("status")).toHaveText("重新连接中");
	await expect(panel.getByRole("status")).toHaveText("就绪");
	await command(page, `node -e "console.log('RECONNECT'+'-'+process.env.TERMINAL_KEEP)"`);
	await expect(panel.locator(".xterm-rows")).toContainText("RECONNECT-retained");
	await page.screenshot({ path: "test-results/terminal-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(panel).toBeVisible();
	for (const button of await panel.locator(".terminal-actions button").all()) {
		const bounds = await button.boundingBox();
		expect(bounds).not.toBeNull();
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
	}
	await page.screenshot({ path: "test-results/terminal-mobile.png" });
	page.once("dialog", (dialog) => dialog.accept());
	await panel.getByRole("button", { name: "关闭终端", exact: true }).click();
	await expect(panel.getByRole("status")).toHaveText("已关闭");
	await panel.getByRole("button", { name: "新建终端", exact: true }).click();
	await expect(panel.getByRole("status")).toHaveText("就绪");
	await command(page, `node -e "console.log('NEW'+'-'+String(process.env.TERMINAL_KEEP))"`);
	await expect(panel.locator(".xterm-rows")).toContainText("NEW-undefined");
});

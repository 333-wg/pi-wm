import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";
let url: string;
test.beforeAll(async () => {
	url = await startWebApp({
		WUMING_RUNTIME: "pi",
		WUMING_DEPLOYMENT_MODE: "local_device",
		WUMING_PROCESS_MODE: "disabled",
		WUMING_COMPUTER_PYTHON: "missing-test-python",
	});
});
test.afterAll(stopWebApp);
test("DeepSeek account confirmation, pending, cancellation and signed-in model refresh", async ({ page }, info) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	let starts = 0;
	let state: Record<string, unknown> = {
		provider: "official-deepseek",
		name: "DeepSeek",
		loggedIn: false,
		modelCount: 0,
	};
	await page.routeWebSocket(/\/api\/ws/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const request = JSON.parse(String(message));
			const command = request.command;
			if (command?.type?.startsWith("model.official.")) {
				if (command.type === "model.official.start") {
					starts++;
					state = {
						...state,
						login: {
							id: "test-login",
							status: "pending",
							expiresAt: Date.now() + 600000,
							authorizeUrl: "https://platform.deepseek.com/dsh/authorize?test=1",
						},
					};
				}
				if (command.type === "model.official.cancel")
					state = { provider: "official-deepseek", name: "DeepSeek", loggedIn: false, modelCount: 0 };
				if (command.type === "model.official.logout")
					state = { provider: "official-deepseek", name: "DeepSeek", loggedIn: false, modelCount: 0 };
				socket.send(
					JSON.stringify({
						type: "response",
						requestId: request.requestId,
						ok: true,
						result: { type: "model.official.accounts", accounts: [state] },
					})
				);
			} else server.send(message);
		});
	});
	await page.addInitScript(() => {
		window.open = () => null;
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await openApp(page, url);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.locator('.settings-navigation button[aria-controls="settings-panel-official"]').click();
	const row = page.locator('[data-provider="official-deepseek"]');
	await expect(row).toContainText("调用消耗平台账号余额");
	await row.getByRole("button", { name: "登录", exact: true }).click();
	const dialog = page.getByRole("alertdialog", { name: "DeepSeek 登录风险确认" });
	await expect(dialog).toContainText("不是免费网页版聊天");
	await dialog.getByRole("button", { name: "取消", exact: true }).click();
	expect(starts).toBe(0);
	await row.getByRole("button", { name: "登录", exact: true }).click();
	await dialog.getByRole("button", { name: "我已了解风险，继续登录" }).click();
	await expect(row.getByRole("link", { name: "打开授权页面" })).toHaveAttribute(
		"href",
		/^https:\/\/platform.deepseek.com\/dsh\/authorize/
	);
	await page.screenshot({ path: info.outputPath("deepseek-pending.png"), fullPage: true });
	await row.getByRole("button", { name: "取消", exact: true }).click();
	await expect(row.getByRole("button", { name: "登录", exact: true })).toBeVisible();
	state = { provider: "official-deepseek", name: "DeepSeek", loggedIn: true, modelCount: 2 };
	await expect(row).toContainText("已登录 · 2 个模型");
	await row.getByRole("button", { name: "退出登录", exact: true }).click();
	await expect(row.getByRole("button", { name: "登录", exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

// Scope this feature's assertions to the three subscription providers it covers.
const riskAccountsSelector =
	'[data-provider="official-claude"], [data-provider="official-chatgpt"], [data-provider="official-grok"]';
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
		await expect(accounts.locator(riskAccountsSelector)).toHaveCount(3);
		await expect(accounts.locator(riskAccountsSelector).getByRole("button", { name: "登录", exact: true })).toHaveCount(
			3
		);
		await accounts.getByRole("combobox", { name: "ChatGPT 登录方式" }).selectOption("device_code");
		await expect(accounts.getByRole("combobox", { name: "ChatGPT 登录方式" })).toHaveValue("device_code");
		const claude = accounts.locator('[data-provider="official-claude"]');
		await claude.getByRole("button", { name: "登录", exact: true }).click();
		await page
			.getByRole("alertdialog", { name: "Claude 登录风险确认" })
			.getByRole("button", { name: "我已了解风险，继续登录" })
			.click();
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
			page
				.getByRole("region", { name: "官方账号" })
				.locator(riskAccountsSelector)
				.getByRole("button", { name: "登录", exact: true })
		).toHaveCount(3);
	});
}

for (const locale of ["zh", "en"] as const) {
	test(`requires a fresh provider-specific risk confirmation before every login (${locale})`, async ({
		page,
	}, testInfo) => {
		const starts: Array<{ provider: string; method: string }> = [];
		const accounts = [
			{ provider: "official-claude", name: "Claude", loggedIn: false, modelCount: 0 },
			{ provider: "official-chatgpt", name: "ChatGPT", loggedIn: false, modelCount: 0 },
			{ provider: "official-grok", name: "Grok", loggedIn: false, modelCount: 0 },
		];
		// Intercept only login starts: no external OAuth traffic, real app and list/poll wiring.
		await page.routeWebSocket(/\/api\/ws/, (socket) => {
			const server = socket.connectToServer();
			socket.onMessage((message) => {
				const parsed = JSON.parse(String(message));
				if (parsed.command?.type === "model.official.start") {
					starts.push(parsed.command);
					socket.send(
						JSON.stringify({
							type: "response",
							requestId: parsed.requestId,
							ok: true,
							result: { type: "model.official.accounts", accounts },
						})
					);
					return;
				}
				server.send(message);
			});
		});
		await page.addInitScript((value) => {
			localStorage.setItem("wuming.locale", value);
			window.open = () => {
				throw new Error("Authorization must not open before confirmation");
			};
		}, locale);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width: 1440, height: 900 });
		await openApp(page, webUrl);
		await page.getByRole("button", { name: locale === "en" ? "Settings" : "设置", exact: true }).click();
		await page.locator('.settings-navigation button[aria-controls="settings-panel-official"]').click();
		const login = locale === "en" ? "Sign in" : "登录";
		const cancel = locale === "en" ? "Cancel" : "取消";
		const confirm = locale === "en" ? "I understand the risks, continue" : "我已了解风险，继续登录";
		for (const [provider, risk, method] of [
			["official-claude", locale === "en" ? "Higher risk" : "较高风险", "browser"],
			["official-chatgpt", locale === "en" ? "Relatively lower risk" : "相对较低风险", "browser"],
			["official-chatgpt", locale === "en" ? "Relatively lower risk" : "相对较低风险", "device_code"],
			["official-grok", locale === "en" ? "Moderate risk" : "中等风险", "browser"],
		]) {
			const row = page.locator(`.official-account[data-provider="${provider}"]`);
			if (provider === "official-chatgpt") await row.getByRole("combobox").selectOption(method!);
			const button = row.getByRole("button", { name: login, exact: true });
			const before = starts.length;
			await button.click();
			const dialog = page.getByRole("alertdialog");
			await expect(dialog).toContainText(risk!);
			await expect(dialog).toContainText("cc-haha #1526");
			await expect(dialog.getByRole("button", { name: cancel, exact: true })).toBeFocused();
			expect(starts).toHaveLength(before);
			await page.screenshot({ path: testInfo.outputPath(`risk-${locale}-${provider}-${method}.png`) });
			await dialog.getByRole("button", { name: cancel, exact: true }).click();
			await expect(dialog).toHaveCount(0);
			await expect(button).toBeFocused();
			expect(starts).toHaveLength(before);
			await button.click();
			await page.keyboard.press("Shift+Tab");
			await expect(dialog.getByRole("button", { name: confirm })).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			await expect(button).toBeFocused();
			expect(starts).toHaveLength(before);
			await button.click();
			await dialog.getByRole("button", { name: confirm }).click();
			await expect.poll(() => starts.length).toBe(before + 1);
			expect(starts.at(-1)).toMatchObject({ provider, method });
			await expect(dialog).toHaveCount(0);
			await expect(button).toBeEnabled();
			await button.click();
			await expect(dialog).toBeVisible();
			await dialog.getByRole("button", { name: cancel, exact: true }).click();
			expect(starts).toHaveLength(before + 1);
		}
		expect(errors).toEqual([]);
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
	await expect(page.getByRole("region", { name: "官方账号" }).locator(riskAccountsSelector)).toHaveCount(3);
});

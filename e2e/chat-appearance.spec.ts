import { expect, test, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeEach(async () => {
	webUrl = await startWebApp();
});
test.afterEach(async () => {
	await stopWebApp();
});
async function settings(page: Page) {
	if ((page.viewportSize()?.width ?? 1440) < 720) await page.locator(".mobile-menu").click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const region = page.getByRole("region", { name: "聊天外观", exact: true });
	await region.scrollIntoViewIfNeeded();
	return region;
}

for (const width of [1440, 390])
	test(`chat appearance applies and persists at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		await openApp(page, webUrl);
		const input = page.getByRole("textbox", { name: "消息", exact: true });
		await input.fill(
			"### 阅读测试\n中文与 English，**大字号**和 `inline code`。\n\n```js\nconst hello = 1;\n```\n\n| 项目 | 内容 |\n| --- | --- |\n| 字体 | 检查 | "
		);
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.locator(".message-row.assistant")).toContainText("Demo runtime received:");
		const bodySize = await page.locator("body").evaluate((el) => getComputedStyle(el).fontSize);
		const region = await settings(page);
		await region.getByRole("combobox", { name: "聊天字体" }).selectOption("serif");
		await region.getByRole("slider").fill("24");
		await region.getByRole("button", { name: "铺满", exact: true }).click();
		await expect(region.locator(".prose").first()).toHaveCSS("font-size", "24px");
		await expect(region.locator(".prose").first()).toHaveCSS("font-family", /Georgia/);
		await expect(input).toHaveCSS("font-size", "24px");
		await expect(page.locator(".message-row.user .prose")).toHaveCSS("font-size", "24px");
		await expect(page.locator(".message-row.assistant .prose").first()).toHaveCSS("font-family", /Georgia/);
		await expect(page.locator(".message-row.user .md-code")).toHaveCSS("font-family", /monospace/);
		await expect(page.locator(".message-row.user .code-block code")).toHaveCSS("font-size", "21.6px");
		await expect(page.locator("body")).toHaveCSS("font-size", bodySize);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("settings.png") });
		await page.keyboard.press("Escape");
		await page.screenshot({ path: testInfo.outputPath("chat.png") });
		await page.reload();
		await expect(input).toHaveCSS("font-size", "24px");
		const reopened = await settings(page);
		await expect(reopened.getByRole("combobox")).toHaveValue("serif");
		await expect(reopened.getByRole("button", { name: "铺满", exact: true })).toHaveAttribute("aria-pressed", "true");
		await reopened.getByRole("button", { name: "恢复默认" }).click();
		await expect(input).toHaveCSS("font-size", "14px");
		await expect(reopened.getByRole("combobox")).toHaveValue("system");
	});

test("width changes real layout and local tabs sync without affecting another device", async ({
	page,
	context,
	browser,
}) => {
	await page.setViewportSize({ width: 1800, height: 1000 });
	await openApp(page, webUrl);
	const region = await settings(page);
	const padding = () => page.locator(".transcript").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
	const standard = await padding();
	await region.getByRole("button", { name: "宽", exact: true }).click();
	const wide = await padding();
	await region.getByRole("button", { name: "铺满", exact: true }).click();
	expect(standard).toBeGreaterThan(wide);
	expect(wide).toBeGreaterThan(await padding());
	await expect(page.locator(".composer-wrap")).toHaveCSS("padding-left", "24px");
	const second = await context.newPage();
	await openApp(second, webUrl);
	const otherSettings = await settings(second);
	await otherSettings.getByRole("combobox").selectOption("mono");
	await otherSettings.getByRole("slider").fill("12");
	await expect(region.getByRole("combobox")).toHaveValue("mono");
	await expect(region.getByRole("slider")).toHaveValue("12");
	await second.close();
	const device = await browser.newContext();
	try {
		const fresh = await device.newPage();
		await openApp(fresh, webUrl);
		const defaults = await settings(fresh);
		await expect(defaults.getByRole("slider")).toHaveValue("14");
		await expect(defaults.getByRole("combobox")).toHaveValue("system");
	} finally {
		await device.close();
	}
});

test("corrupt preferences recover; blocked saving is visible and non-fatal", async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem("wuming.chatAppearance", "broken JSON");
		const set = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key === "wuming.chatAppearance") throw new Error("quota exceeded");
			set.call(this, key, value);
		};
	});
	await openApp(page, webUrl);
	const region = await settings(page);
	await expect(region.getByRole("slider")).toHaveValue("14");
	await region.getByRole("slider").fill("20");
	await expect(region.getByRole("alert")).toContainText("本地保存失败");
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveCSS("font-size", "20px");
});

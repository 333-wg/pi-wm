import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeEach(async () => {
	webUrl = await startWebApp();
});
test.afterEach(stopWebApp);

async function openReply(page: Page) {
	await openApp(page, webUrl);
	if ((page.viewportSize()?.width ?? 1440) < 720) await page.locator(".mobile-menu").click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "深色", exact: true }).click();
	await page.getByRole("button", { name: "暮色流光", exact: true }).click();
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("请简要说明这个项目的工作方式。");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const reply = page.locator(".message-row.assistant:not(.streaming-row)").first();
	await expect(reply).toBeVisible();
	return reply;
}

async function expectQuiet(reply: Locator) {
	await expect(reply).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(reply).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
	await expect(reply).toHaveCSS("box-shadow", "none");
}

async function expectRevealed(reply: Locator) {
	await expect(reply).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(reply).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
	await expect(reply).not.toHaveCSS("box-shadow", "none");
}

test("dark wallpaper replies reveal only the approached or focused row without layout shifts", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const reply = await openReply(page);
	await page.mouse.move(0, 0);
	await expectQuiet(reply);
	const bounds = await reply.boundingBox();
	const user = page.locator(".user-message-bubble").first();
	const userBackground = await user.evaluate((element) => getComputedStyle(element).backgroundColor);
	await page.screenshot({ path: info.outputPath("desktop-quiet.png") });
	// Approach within the row padding, not the text or a control.
	await reply.hover({ position: { x: 4, y: 4 } });
	await expectRevealed(reply);
	expect(await reply.boundingBox()).toEqual(bounds);
	await expect(user).toHaveCSS("background-color", userBackground);
	await page.screenshot({ path: info.outputPath("desktop-hover.png") });
	await page.mouse.move(0, 0);
	await expectQuiet(reply);
	await reply.locator(".message-actions button").first().focus();
	await expectRevealed(reply);
	await page.getByRole("textbox", { name: "消息", exact: true }).focus();
	await expectQuiet(reply);
	await page.emulateMedia({ reducedMotion: "reduce" });
	// The global accessibility rule forces a 0.01ms duration with !important;
	// transition-property:none proves this row has no animated properties.
	await expect(reply).toHaveCSS("transition-property", "none");
	// All dark classic palettes resolve to the same dark wallpaper behaviour.
	for (const palette of ["ink-night", "ink-blue", "dark"]) {
		await page.evaluate((value) => {
			localStorage.setItem("wuming.theme.palettes", JSON.stringify({ light: "light", dark: value }));
		}, palette);
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("data-theme", palette);
		await expectQuiet(reply);
	}
	await page.getByRole("button", { name: "切换深浅主题" }).click();
	await expect(reply).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(reply).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
	await page.getByRole("button", { name: "切换深浅主题" }).click();
	await expectQuiet(reply);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "无背景", exact: true }).click();
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(reply).toHaveCSS("border-bottom-width", "1px");
	await expect(reply).not.toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
	await reply.hover();
	await expect(reply).toHaveCSS("box-shadow", "none");
	expect(errors).toEqual([]);
});

test.describe("touch wallpaper replies", () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	test("retain a quiet reading tint without permanent borders or shadows", async ({ page }, info) => {
		const reply = await openReply(page);
		await expect(reply).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(reply).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
		await expect(reply).toHaveCSS("box-shadow", "none");
		await expect(reply.locator(".message-actions")).toHaveCSS("opacity", "1");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: info.outputPath("mobile-quiet.png") });
	});
});

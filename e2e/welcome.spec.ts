import { expect, test } from "@playwright/test";
import type {} from "../apps/web/src/lib/desktop.js";
import { startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_TOKEN: "wuming" });
});
test.afterAll(stopWebApp);

test("password hint supports hover, keyboard focus and Escape without changing the form", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(webUrl);
	const trigger = page.getByRole("button", { name: "查看初始密码" });
	const hint = page.getByRole("tooltip");
	await expect(hint).toBeHidden();
	await trigger.hover();
	await expect(hint).toContainText("wuming");
	await expect(hint).toBeVisible();
	await page.screenshot({ path: "test-results/welcome-hint-desktop.png" });
	await hint.hover();
	await expect(hint).toBeVisible();
	await page.getByRole("heading", { name: "欢迎来到 Pi-Wm" }).hover();
	await expect(hint).toBeHidden();
	await trigger.focus();
	await expect(hint).toBeVisible();
	await trigger.press("Escape");
	await expect(hint).toBeHidden();
	await trigger.click();
	await expect(hint).toBeVisible();
	await page.getByLabel("访问密码", { exact: true }).focus();
	await expect(hint).toBeHidden();
	await expect(page.getByLabel("访问密码", { exact: true })).toHaveValue("");
	await expect(page.getByRole("button", { name: "开启工作空间" })).toBeDisabled();
});

test("password hint opens on touch and fits a narrow mobile screen", async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
	try {
		const page = await context.newPage();
		await page.goto(webUrl);
		await page.getByRole("button", { name: "查看初始密码" }).tap();
		const hint = page.getByRole("tooltip");
		await expect(hint).toBeVisible();
		await expect(hint).toContainText("wuming");
		const bounds = await hint.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
		await page.screenshot({ path: "test-results/welcome-hint-mobile.png" });
		await page.getByLabel("访问密码", { exact: true }).tap();
		await expect(hint).toBeHidden();
	} finally {
		await context.close();
	}
});

test("first visit validates the password and enters the workbench directly", async ({ page }) => {
	await page.goto(webUrl);
	await expect(page.getByRole("heading", { name: "欢迎来到 Pi-Wm" })).toBeVisible();
	await expect(page.locator(".app-shell")).toHaveCount(0);
	const submit = page.getByRole("button", { name: "开启工作空间" });
	await expect(submit).toBeDisabled();
	const password = page.getByLabel("访问密码", { exact: true });
	await password.fill("wrong-password");
	await page.getByRole("button", { name: "显示密码", exact: true }).click();
	await expect(password).toHaveAttribute("type", "text");
	await page.getByRole("button", { name: "隐藏密码", exact: true }).click();
	await expect(password).toHaveAttribute("type", "password");
	await password.press("Enter");
	await expect(page.getByRole("alert")).toContainText("密码不正确");
	await expect(page.locator(".app-shell")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => localStorage.getItem("wuming.token"))).toBeNull();
	await password.fill("wuming");
	await password.press("Enter");
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await expect(page.locator(".welcome-screen")).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "首次设置" })).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
	await expect.poll(() => page.evaluate(() => localStorage.getItem("wuming.token"))).toBe("wuming");
	await page.reload();
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
	await expect(page.locator(".welcome-screen")).toHaveCount(0);
});

test("desktop auto-connection still requires first-use password and remembers it", async ({ page }) => {
	await page.addInitScript(() => {
		window.wumingDesktop = {
			connect: async () => ({ token: "wuming", websocketUrl: location.origin.replace("http", "ws") + "/api/ws" }),
		};
	});
	await page.goto(webUrl);
	await expect(page.locator(".welcome-screen")).toBeVisible();
	const password = page.getByLabel("访问密码", { exact: true });
	await password.fill("wrong");
	await password.press("Enter");
	await expect(page.getByRole("alert")).toContainText("密码不正确");
	await expect(page.locator(".app-shell")).toHaveCount(0);
	await password.fill("wuming");
	await password.press("Enter");
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
	await expect.poll(() => page.evaluate(() => localStorage.getItem("wuming.desktop.welcome.complete"))).toBe("true");
	await expect.poll(() => page.evaluate(() => localStorage.getItem("wuming.token"))).toBeNull();
	await page.reload();
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
	await expect(page.locator(".welcome-screen")).toHaveCount(0);
});

test("welcome stays readable and scrollable at desktop and mobile sizes", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("wuming.theme", "dark"));
	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 390, height: 844 },
		{ width: 320, height: 640 },
	]) {
		await page.setViewportSize(viewport);
		await page.goto(webUrl);
		await expect(page.getByRole("heading", { name: "欢迎来到 Pi-Wm" })).toBeVisible();
		await expect(page.locator(".welcome-screen")).toHaveCSS("color-scheme", "light");
		expect(
			await page.locator(".welcome-screen").evaluate((element) => element.scrollWidth <= element.clientWidth)
		).toBe(true);
		expect(
			await page
				.locator(".welcome-screen img")
				.evaluateAll((images) =>
					images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)
				)
		).toBe(true);
		await page.screenshot({ path: "test-results/welcome-" + viewport.width + ".png", fullPage: true });
		await page.getByLabel("访问密码", { exact: true }).fill("wuming");
		await page.getByRole("button", { name: "开启工作空间" }).scrollIntoViewIfNeeded();
		await expect(page.getByRole("button", { name: "开启工作空间" })).toBeInViewport();
	}
});

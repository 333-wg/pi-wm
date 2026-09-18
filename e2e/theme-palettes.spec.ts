import { expect, test } from "@playwright/test";
import { PALETTES } from "../apps/web/src/lib/theme.js";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const width of [1440, 390]) {
	test("all palettes render and persist at " + width, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		if (width === 390) await page.locator(".mobile-menu").click();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		const settings = page.locator(".theme-settings");
		await settings.getByRole("button", { name: "浅色", exact: true }).click();
		for (const palette of PALETTES) {
			await settings.getByRole("button", { name: palette.zh, exact: true }).click();
			await expect(page.locator("html")).toHaveAttribute("data-theme", palette.id);
			await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", palette.background);
			expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(palette.mode);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			for (const card of await settings.locator(".theme-palette").all()) {
				expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
			}
			await settings.screenshot({ path: testInfo.outputPath(palette.id + ".png") });
		}
		await page.screenshot({ path: testInfo.outputPath("full-page.png") });
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "ink-blue");
		await page.getByRole("button", { name: "切换深浅主题" }).click();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "celadon");
	});
}

test("system mode tracks the selected pair live, persists and synchronizes tabs", async ({ page, context }) => {
	await page.emulateMedia({ colorScheme: "light" });
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const settings = page.locator(".theme-settings");
	await settings.getByRole("button", { name: "纸墨", exact: true }).click();
	await settings.getByRole("button", { name: "墨夜蓝", exact: true }).click();
	await expect(settings.getByRole("button", { name: "跟随系统" })).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "ink-blue");
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "ink-blue");
	await page.emulateMedia({ colorScheme: "light" });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
	const second = await context.newPage();
	await second.emulateMedia({ colorScheme: "light" });
	await openApp(second, webUrl);
	await second.getByRole("button", { name: "设置", exact: true }).click();
	await second.locator(".theme-settings").getByRole("button", { name: "青瓷", exact: true }).click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "celadon");
	await second.close();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await settings.getByRole("button", { name: "浅色", exact: true }).click();
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "celadon");
});

test("new palettes paint without React and follow terminal token changes", async ({ page }) => {
	await openApp(page, webUrl);
	await page.evaluate(() => {
		localStorage.setItem("wuming.theme", "dark");
		localStorage.setItem("wuming.theme.palettes", JSON.stringify({ light: "white", dark: "ink-blue" }));
	});
	await page.route("**/src/main.tsx", (route) => route.abort());
	await page.reload();
	await expect(page.locator("#root")).toBeEmpty();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "ink-blue");
	await page.unroute("**/src/main.tsx");
	await page.reload();
	await page.getByRole("tab", { name: "终端", exact: true }).click();
	await expect(page.locator(".xterm-scrollable-element")).toHaveCSS("background-color", "rgb(21, 24, 30)");
	await page.getByRole("button", { name: "切换深浅主题" }).click();
	await expect(page.locator(".xterm-scrollable-element")).toHaveCSS("background-color", "rgb(248, 248, 248)");
});

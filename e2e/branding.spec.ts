import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;

test.beforeAll(async () => {
	webUrl = await startWebApp();
});

test.afterAll(async () => {
	await stopWebApp();
});

for (const profile of [
	{ name: "light", theme: "light", width: 1440, height: 900 },
	{ name: "dark", theme: "dark", width: 1440, height: 900 },
	{ name: "mobile", theme: "light", width: 390, height: 844 },
]) {
	test(`clover branding renders in ${profile.name}`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: profile.width, height: profile.height });
		await page.addInitScript((theme) => localStorage.setItem("wuming.theme", theme), profile.theme);
		await openApp(page, webUrl);
		if (profile.name === "mobile") await page.locator(".mobile-menu").click();
		const mark = page.locator(".brand-mark");
		await expect(mark).toBeVisible();
		await expect(mark).toHaveAttribute("src", /wuming-clover.*\.png/);
		await expect
			.poll(() => mark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0))
			.toBe(true);
		await expect(mark).toHaveCSS("width", "32px");
		await expect(mark).toHaveCSS("height", "32px");
		await expect(mark).toHaveCSS("background-image", "none");
		const favicon = page.locator('link[rel="icon"]');
		expect(await favicon.getAttribute("href")).toBe(await mark.getAttribute("src"));
		const response = await page.request.get(new URL((await favicon.getAttribute("href"))!, page.url()).href);
		expect(response.ok()).toBe(true);
		expect(response.headers()["content-type"]).toContain("image/png");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("branding.png") });
	});
}

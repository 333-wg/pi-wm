import { expect, test, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

// The terminal is the one surface the stylesheet cannot reach: xterm paints its
// own markup from colours handed to it in JavaScript. So these check the handover
// rather than the tokens — that what is on screen is what `--term-*` says, and
// that it stays that way after the token block is swapped.

let webUrl: string;

test.beforeAll(async () => {
	webUrl = await startWebApp();
});

test.afterAll(async () => {
	await stopWebApp();
});

test.beforeEach(async ({ page }) => {
	await openApp(page, webUrl);
});

/** What a token resolves to, spelled the way `getComputedStyle` reports colours. */
async function tokenColor(page: Page, name: string): Promise<string> {
	return await page.evaluate((token) => {
		const probe = document.createElement("span");
		probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(token);
		document.body.append(probe);
		const resolved = getComputedStyle(probe).color;
		probe.remove();
		return resolved;
	}, name);
}

async function openTerminal(page: Page): Promise<void> {
	await page.getByRole("tab", { name: "终端" }).click();
	// The gateway in this harness has the terminal switched off, which is enough:
	// the palette is handed over when xterm is constructed, before it connects.
	await expect(page.locator(".xterm-rows")).toBeVisible();
}

test("the terminal paints itself from the token block", async ({ page }) => {
	await openTerminal(page);
	// xterm puts the background on its scroll container and the foreground on the
	// row container, so those are the two places its palette becomes visible.
	await expect(page.locator(".xterm-scrollable-element")).toHaveCSS("background-color", await tokenColor(page, "--term-bg"));
	await expect(page.locator(".xterm-rows")).toHaveCSS("color", await tokenColor(page, "--term-text"));
});

test("the terminal re-reads the token block when the theme changes", async ({ page }) => {
	await openTerminal(page);
	const surface = page.locator(".xterm-scrollable-element");
	const before = await tokenColor(page, "--term-bg");

	// Stands in for a token block that gives the terminal a second variant: the
	// value behind `--term-bg` changes without the terminal being told.
	await page.evaluate(() => document.documentElement.style.setProperty("--term-bg", "#3d1f5c"));
	await expect(surface).toHaveCSS("background-color", before);

	await page.getByRole("button", { name: "切换深浅主题" }).click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	// Re-read in place: the terminal was never remounted, so its scrollback and
	// any running process survive the switch.
	await expect(surface).toHaveCSS("background-color", "rgb(61, 31, 92)");
});

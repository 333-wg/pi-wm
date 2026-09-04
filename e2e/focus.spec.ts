import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

// Keyboard containment for the two overlays that own their own markup. A dialog
// is only visually on top, so these check the parts the browser will not do by
// itself: focus enters the overlay, Tab cannot leave it, and closing hands focus
// back to whatever opened it.

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

/** The composer, focused, standing in for "wherever the user was". */
async function focusComposer(page: Page): Promise<Locator> {
	const composer = page.getByRole("textbox", { name: "消息" });
	await composer.click();
	await expect(composer).toBeFocused();
	return composer;
}

test("the command palette takes focus and gives it back", async ({ page }) => {
	const composer = await focusComposer(page);
	await page.keyboard.press("Control+k");

	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette).toBeVisible();
	await expect(palette.getByRole("combobox", { name: "命令面板" })).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(palette).toBeHidden();
	await expect(composer).toBeFocused();
});

test("tabbing cycles inside the command palette", async ({ page }) => {
	await focusComposer(page);
	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog", { name: "命令面板" });
	const query = palette.getByRole("combobox", { name: "命令面板" });
	// One matching row keeps the cycle short; the loop below does not depend on
	// how many the ranking actually returns.
	await query.fill("快捷键");
	const options = palette.getByRole("option");
	const count = await options.count();
	expect(count).toBeGreaterThan(0);

	for (let index = 0; index < count; index += 1) {
		await page.keyboard.press("Tab");
		await expect(options.nth(index)).toBeFocused();
	}
	// Past the last row Tab wraps to the input instead of reaching the page.
	await page.keyboard.press("Tab");
	await expect(query).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(options.nth(count - 1)).toBeFocused();
});

test("the shortcuts dialog takes focus and gives it back", async ({ page }) => {
	const composer = await focusComposer(page);
	await page.keyboard.press("Control+/");

	const dialog = page.getByRole("dialog", { name: "快捷键" });
	await expect(dialog).toBeVisible();
	const close = dialog.getByRole("button", { name: "关闭", exact: true });
	await expect(close).toBeFocused();
	// The dialog has one stop, so Tab has nowhere to go but stay.
	await page.keyboard.press("Tab");
	await expect(close).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(close).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(composer).toBeFocused();
});

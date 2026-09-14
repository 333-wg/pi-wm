import { expect, test, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

// The composer's 思考强度 picker, against a demo gateway told to advertise its
// model as a reasoning one. The default demo model is not, and `wuming.spec.ts`
// covers that disabled path; everything here needs the control to be live.

let webUrl: string;

test.afterEach(async () => {
	await stopWebApp();
});

test.beforeEach(async ({ page }) => {
	webUrl = await startWebApp({ WUMING_MODEL_REASONING: "true" });
	await openApp(page, webUrl);
});

async function createSession(page: Page): Promise<void> {
	await page.locator(".new-chat-button:visible").first().click();
	await expect(page.locator(".session-entry.selected")).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
}

function trigger(page: Page) {
	return page.locator(".thinking-trigger");
}

async function openEffort(page: Page) {
	if ((await trigger(page).getAttribute("aria-expanded")) !== "true") await trigger(page).click();
	await page.locator(".thinking-menu-item").click();
}

function menu(page: Page) {
	return page.getByRole("menu", { name: "思考强度" });
}

/** Anchored on the row's own label so a reworded description cannot mis-target. */
function option(page: Page, label: string) {
	return menu(page)
		.getByRole("menuitemradio")
		.filter({ has: page.locator("strong", { hasText: new RegExp(`^${label}$`) }) });
}

test("offers every level and records the choice on the session", async ({ page }) => {
	await createSession(page);
	// A reasoning model opens at the default rather than at 关闭.
	await expect(trigger(page).locator(".thinking-trigger-effort")).toHaveText("中");

	await openEffort(page);
	await expect(menu(page).getByRole("menuitemradio")).toHaveCount(7);
	await expect(menu(page).locator(".thinking-option strong")).toHaveText([
		"关闭",
		"极简",
		"低",
		"中",
		"高",
		"极高",
		"最大",
	]);
	await expect(option(page, "中")).toHaveAttribute("aria-checked", "true");

	await option(page, "极高").click();
	await expect(menu(page)).toBeHidden();
	await expect(trigger(page).locator(".thinking-trigger-effort")).toHaveText("极高");
	await expect(page.locator(".thinking-error")).toHaveCount(0);

	// The gateway, not the browser, is the record: drop the local preference, then
	// reload and reopen the session. The level has to come back from its snapshot.
	await page.getByRole("textbox", { name: "消息" }).fill("hello");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".session-entry.selected")).toBeVisible();
	await expect(trigger(page)).toBeEnabled();
	const sessionName = await page.locator(".session-entry.selected .session-open span").innerText();
	await page.evaluate(() => localStorage.removeItem("wuming.thinking"));
	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await page.getByRole("navigation", { name: "会话" }).getByRole("button", { name: sessionName }).click();
	await expect(trigger(page).locator(".thinking-trigger-effort")).toHaveText("极高");
});

test("carries the level into the next session", async ({ page }) => {
	await createSession(page);
	await openEffort(page);
	await option(page, "低").click();
	await expect(trigger(page).locator(".thinking-trigger-effort")).toHaveText("低");

	await createSession(page);
	await expect(trigger(page).locator(".thinking-trigger-effort")).toHaveText("低");
});

test("re-picking the current level closes the menu instead of reporting a conflict", async ({ page }) => {
	await createSession(page);
	await openEffort(page);
	await option(page, "中").click();
	await expect(menu(page)).toBeHidden();
	// The orchestrator answers a no-op change with a conflict, which would surface here.
	await expect(page.locator(".thinking-error")).toHaveCount(0);
	await expect(trigger(page).locator(".thinking-trigger-effort")).toHaveText("中");
});

test("closes on Escape and on a click outside", async ({ page }) => {
	await createSession(page);

	await openEffort(page);
	await expect(menu(page)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(menu(page)).toBeHidden();

	await openEffort(page);
	await expect(menu(page)).toBeVisible();
	// The open menu covers the composer, so the click has to land above it.
	await page.getByText("已连接", { exact: true }).click();
	await expect(menu(page)).toBeHidden();
});

test("locks the control while a turn is running", async ({ page }) => {
	await createSession(page);
	await page.getByRole("textbox", { name: "消息" }).fill("/long");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(trigger(page)).toBeDisabled();
	await page.getByRole("button", { name: "停止任务" }).click();
	await expect(trigger(page)).toBeEnabled();
});

test("keeps the menu inside a mobile viewport", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await page.getByRole("button", { name: "打开导航" }).click();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await createSession(page);
	const closeNavigation = page.getByRole("button", { name: "关闭导航" }).first();
	if (await closeNavigation.isVisible()) await closeNavigation.click();

	// The label is the whole point of the control, so only the chevron folds away.
	await expect(trigger(page).locator(".thinking-trigger-effort")).toHaveText("中");
	await openEffort(page);
	await expect(menu(page)).toBeVisible();
	const box = await menu(page).boundingBox();
	expect(box?.x).toBeGreaterThanOrEqual(0);
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

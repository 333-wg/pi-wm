import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let url: string;
test.beforeAll(async () => {
	url = await startWebApp();
});
test.afterAll(stopWebApp);

for (const width of [1365, 390, 320]) {
	test("aligns sidebar actions at " + width + "px", async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, url);
		if (width <= 720) await page.getByRole("button", { name: "打开导航", exact: true }).click();
		const sidebar = page.locator(".sidebar");
		const newChat = sidebar.locator(".sidebar-new-chat");
		const scheduled = sidebar.locator(".sidebar-scheduled");
		await expect(newChat).toBeVisible();
		await expect(scheduled).toBeVisible();
		const metrics = await sidebar.evaluate((element) => {
			const measure = (selector: string) => {
				const button = element.querySelector<HTMLElement>(selector)!;
				const bounds = button.getBoundingClientRect();
				return {
					x: bounds.x,
					width: bounds.width,
					height: bounds.height,
					iconX: button.querySelector("svg")!.getBoundingClientRect().x,
					labelX: button.querySelector("span")!.getBoundingClientRect().x,
					fontSize: getComputedStyle(button).fontSize,
				};
			};
			return [measure(".sidebar-new-chat"), measure(".sidebar-scheduled")];
		});
		expect(metrics[0]).toEqual(metrics[1]);
		expect(metrics[0]!.height).toBe(40);
		await sidebar.screenshot({ path: testInfo.outputPath("sidebar-actions.png") });
		await scheduled.focus();
		await expect(scheduled).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toBeVisible();
		await expect(scheduled).toHaveClass(/selected/);
		if (width <= 720) await page.getByRole("button", { name: "打开导航", exact: true }).click();
		await sidebar.screenshot({ path: testInfo.outputPath("sidebar-actions-selected.png") });
		await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
		await sidebar.screenshot({ path: testInfo.outputPath("sidebar-actions-dark.png") });
		await newChat.click();
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
		expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
	});
}

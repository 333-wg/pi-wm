import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const width of [1365, 390]) {
	test(`offers only agent and full permissions at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		await page.getByRole("button", { name: "权限模式：帮我批准", exact: true }).click();
		const menu = page.getByRole("menu", { name: "工具权限模式" });
		await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
		const agent = menu.getByRole("menuitemradio", { name: /^帮我批准/ });
		const full = menu.getByRole("menuitemradio", { name: /^完全访问权限/ });
		await expect(agent).toHaveAttribute("aria-checked", "true");
		await expect(full).toBeVisible();
		await expect(menu.getByRole("menuitemradio", { name: /^请求批准/ })).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath("permission-menu.png") });
		await full.click();
		await expect(menu).toBeHidden();
		await page.getByRole("button", { name: "权限模式：完全访问权限", exact: true }).click();
		await expect(full).toHaveAttribute("aria-checked", "true");
		await agent.click();
		await expect(menu).toBeHidden();
		await expect(page.getByRole("button", { name: "权限模式：帮我批准", exact: true })).toBeEnabled();
	});
}

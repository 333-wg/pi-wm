import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";
let url: string;
test.beforeAll(async () => {
	url = await startWebApp();
});
test.afterAll(stopWebApp);
test("reviews changes in both layouts and scopes", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/git/status", (route) =>
		route.fulfill({
			json: {
				isRepository: true,
				branch: "main",
				truncated: false,
				entries: [
					{ path: "src/main.ts", indexStatus: "M", worktreeStatus: "M" },
					{ path: "new.txt", indexStatus: "?", worktreeStatus: "?" },
				],
			},
		})
	);
	await page.route("**/git/diff?**", (route) =>
		route.fulfill({ json: { staged: false, content: "@@ -1 +1 @@\n-old value\n+new value", truncated: false } })
	);
	await openApp(page, url);
	await page.getByRole("tab", { name: "更改", exact: true }).click();
	const panel = page.getByRole("region", { name: "Git 更改" });
	await expect(panel.getByText("new value", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "并排视图", exact: true }).click();
	await expect(panel.locator(".diff-split")).toBeVisible();
	await panel.getByRole("checkbox", { name: "已查看" }).check();
	await expect(panel.getByRole("checkbox")).toBeChecked();
	await panel.getByRole("button", { name: "已暂存 1" }).click();
	await expect(panel.getByRole("checkbox")).not.toBeChecked();
	await expect(panel.locator(".changes-list > button")).toHaveCount(1);
	await page.screenshot({ path: "test-results/changes-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(panel.getByRole("button", { name: "并排视图", exact: true })).toBeVisible();
	await page.screenshot({ path: "test-results/changes-mobile.png" });
	await panel.getByRole("textbox", { name: "筛选更改文件" }).fill("missing");
	await expect(panel.getByText("没有匹配的文件")).toBeVisible();
	await page.reload();
	await page.getByRole("tab", { name: "更改", exact: true }).click();
	await expect(panel.getByText("new value", { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

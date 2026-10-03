import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { openApp, startWebApp, stopWebApp } from "./harness.js";
import { seedAgentTeam } from "./fixtures/agent-team-fixture.js";

test.afterEach(stopWebApp);

test("team reading surfaces and objective disclosure work with and without wallpaper", async ({ page }, info) => {
	const url = await startWebApp({}, async (workspace) => {
		await seedAgentTeam(join(workspace, "..", "data"));
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, url);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "青绿极光", exact: true }).click();
	await page.getByRole("slider", { name: "背景强度", exact: true }).fill("100");
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	const team = page.locator(".persistent-teams");
	const details = team.locator(".persistent-team-objective-copy");
	await expect(details).not.toHaveAttribute("open", "");
	await details.locator("summary").focus();
	await page.keyboard.press("Enter");
	await expect(details).toHaveAttribute("open", "");
	await expect(details.locator("p")).toContainText("隔离测试：后端定义接口契约");
	await page.keyboard.press("Enter");
	await expect(details).not.toHaveAttribute("open", "");
	for (const mode of ["light", "dark"]) {
		if (mode === "dark") await page.getByRole("button", { name: "切换深浅主题", exact: true }).click();
		await expect(team.locator(".teams-canvas-scroll")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		for (const selector of [
			".persistent-team-board",
			".persistent-team-mailbox",
			".persistent-team-members",
			".teams-heading",
		]) {
			await expect(team.locator(selector)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			await expect(team.locator(selector)).toHaveCSS("backdrop-filter", "none");
		}
		for (const selector of [".persistent-team-member", ".persistent-team-messages article", ".teams-task-enhanced"]) {
			const alpha = await team
				.locator(selector)
				.first()
				.evaluate((element) => {
					const ctx = document.createElement("canvas").getContext("2d")!;
					ctx.fillStyle = getComputedStyle(element).backgroundColor;
					ctx.fillRect(0, 0, 1, 1);
					return ctx.getImageData(0, 0, 1, 1).data[3]! / 255;
				});
			expect(alpha, selector).toBeGreaterThan(0);
			expect(alpha, selector).toBeLessThan(0.8);
			expect(alpha, selector).toBeLessThan(1);
		}
		await expect(team.locator(".teams-task-enhanced").first()).toHaveCSS(
			"transition-property",
			"box-shadow, transform"
		);
		await page.screenshot({ path: info.outputPath(`team-${mode}.png`), animations: "disabled" });
		await page.getByRole("tab", { name: "子任务", exact: true }).click();
		const subtasks = page.getByRole("region", { name: "对话子任务", exact: true });
		await expect(subtasks).toBeVisible();
		for (const selector of [".teams-main", ".teams-formation", ".teams-heading", ".teams-timeline"]) {
			await expect(subtasks.locator(selector)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			await expect(subtasks.locator(selector)).toHaveCSS("backdrop-filter", "none");
		}
		await page.screenshot({ path: info.outputPath(`subtasks-${mode}.png`), animations: "disabled" });
		await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	}
	await team.getByRole("textbox", { name: "搜索任务", exact: true }).fill("集成验证");
	await expect(team.locator(".teams-task-enhanced")).toHaveCount(1);
	await team.locator(".teams-task-enhanced").click();
	await expect(team.locator(".persistent-team-detail").first()).toContainText("写入范围");
	await page.keyboard.press("Escape");
	await team.getByRole("textbox", { name: "搜索任务", exact: true }).clear();
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: info.outputPath("team-mobile.png"), animations: "disabled" });
	await team.getByRole("button", { name: "任务列表", exact: true }).click();
	await expect(team.locator(".persistent-team-task-list button")).toHaveCount(3);
	await page.getByRole("button", { name: "打开导航", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "无背景", exact: true }).click();
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await team.getByRole("button", { name: "依赖泳道", exact: true }).click();
	await expect(team.locator(".teams-canvas-scroll")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { openApp, startWebApp, stopWebApp } from "./harness.js";
import { seedAgentTeam } from "./fixtures/agent-team-fixture.js";

test.afterEach(stopWebApp);

test("keeps wallpaper continuous with readable local surfaces across themes", async ({ page }, info) => {
	let sessionId = "";
	const url = await startWebApp({}, async (workspace) => {
		sessionId = await seedAgentTeam(join(workspace, "..", "data"));
	});
	await page.addInitScript((id) => localStorage.setItem("wuming.sessionId.local-workspace", id), sessionId);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, url);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "青绿极光", exact: true }).click();
	await page.getByRole("slider", { name: "背景强度", exact: true }).fill("100");
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	const team = page.locator(".team-studio");
	const objective = team.locator(".persistent-team-objective-copy");
	await expect(objective).not.toHaveAttribute("open", "");
	await objective.locator("summary").focus();
	await page.keyboard.press("Enter");
	await expect(objective.locator("p")).toContainText("隔离测试：后端定义接口契约");
	await page.keyboard.press("Enter");
	await expect(objective).not.toHaveAttribute("open", "");
	for (const palette of ["light", "dark", "ink-night", "ink-blue"]) {
		await page.evaluate((palette) => {
			localStorage.setItem("wuming.theme", palette === "light" ? "light" : "dark");
			localStorage.setItem(
				"wuming.theme.palettes",
				JSON.stringify({ light: "light", dark: palette === "light" ? "dark" : palette })
			);
		}, palette);
		await page.reload();
		await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
		await expect(page.locator("html")).toHaveAttribute("data-theme", palette);
		for (const selector of [
			".persistent-team-board",
			".studio-canvas-scroll",
			".persistent-team-mailbox",
			".persistent-team-members",
			".teams-heading",
			".studio-title",
			".persistent-team-toolbar",
			".team-stage-strip",
			".studio-canvas-controls",
		])
			await expect(team.locator(selector)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		for (const selector of [".studio-task", ".persistent-team-mailbox form"]) {
			await expect(team.locator(selector).first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		}
		// A transparent root is insufficient if its pseudo-element paints a veil.
		expect(
			await team.evaluate((node) => {
				const before = getComputedStyle(node, "::before");
				return { content: before.content, background: before.backgroundColor, blur: before.backdropFilter };
			})
		).toEqual({ content: "none", background: "rgba(0, 0, 0, 0)", blur: "none" });

		const card = team.locator(".studio-task").first();
		const before = await card.boundingBox();
		await card.hover();
		await card.focus();
		await expect(card).toHaveCSS("box-shadow", "none");
		const after = await card.boundingBox();
		expect(after!.width).toBeCloseTo(before!.width, 2);
		expect(after!.height).toBeCloseTo(before!.height, 2);
		if (palette === "light" || palette === "dark")
			await page.screenshot({ path: info.outputPath(`team-${palette}.png`) });
		await page.locator(".session-entry").filter({ hasText: "团队协作隔离验收" }).first().click();
		await page.getByRole("tab", { name: "子任务", exact: true }).click();
		const subtasks = page.getByRole("region", { name: "对话子任务", exact: true });
		for (const selector of [".teams-main", ".teams-formation", ".teams-heading", ".teams-timeline"])
			await expect(subtasks.locator(selector)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await team.getByRole("button", { name: "任务列表", exact: true }).click();
	await expect(team.locator(".persistent-team-task-list button")).toHaveCount(3);
	await team.locator(".persistent-team-task-list button").first().click();
	await expect(team.getByRole("region", { name: "任务详情", exact: true })).toContainText("写入范围");
	await expect(team.locator(".persistent-team-mailbox")).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.keyboard.press("Escape");
	await team.getByRole("button", { name: "任务流程", exact: true }).click();
	await page.getByRole("button", { name: "打开导航", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "无背景", exact: true }).click();
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await team.getByRole("button", { name: "依赖泳道", exact: true }).click();
	await expect(team.locator(".studio-canvas-scroll")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	expect(errors).toEqual([]);
});

test.describe("touch team wallpaper", () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	test("keeps the wallpaper visible on touch devices", async ({ page }, info) => {
		const url = await startWebApp({}, async (workspace) => {
			await seedAgentTeam(join(workspace, "..", "data"));
		});
		await page.addInitScript(() => {
			localStorage.setItem("wuming.theme", "dark");
			localStorage.setItem("wuming.appearance.background.v1", JSON.stringify({ version: 1, kind: "aurora", shade: 0 }));
		});
		await openApp(page, url);
		await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
		const card = page.locator(".studio-task").first();
		await expect(card).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(card).toHaveCSS("box-shadow", "none");
		await card.click();
		await expect(page.getByRole("region", { name: "任务详情", exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		await page.screenshot({ path: info.outputPath("team-touch.png") });
	});
});

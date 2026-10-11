import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { openApp, startWebApp, stopWebApp } from "./harness.js";
import { seedTeamStages } from "./fixtures/team-stage-fixture.js";

test.afterEach(stopWebApp);

test("keeps later stages through search, navigation, zoom and replay with accessible execution links", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const url = await startWebApp({}, async (workspace) => {
		await seedTeamStages(join(workspace, "..", "data"));
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, url);
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	const team = page.locator(".persistent-teams");
	const nav = team.getByRole("navigation", { name: "阶段导航" });
	await expect(nav.getByRole("button")).toHaveCount(4);
	await expect(team.locator('[data-link-kind="continuation"]')).toHaveCount(1);
	await expect(team.locator(".teams-link-pulse")).toHaveCount(1);
	const review = team.locator('[data-task-id="stage-review"]');
	await expect(review).toHaveAttribute("data-stage", "3");
	await nav.getByRole("button", { name: /阶段 3/ }).click();
	await expect(review).toBeFocused();
	await expect.poll(() => team.locator(".teams-canvas-scroll").evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
	await review.click();
	await expect(team.locator(".teams-flow-link.highlighted")).toHaveCount(2);
	await page.keyboard.press("Escape");
	await nav.getByRole("button", { name: /阶段 1/ }).click();
	await team.getByRole("textbox", { name: "搜索任务", exact: true }).fill("复核后续修复成果");
	await expect(team.locator(".teams-task-enhanced")).toHaveCount(1);
	await expect(review).toHaveAttribute("data-stage", "3");
	await expect(review).toBeInViewport();
	await expect(team.getByRole("textbox", { name: "搜索任务", exact: true })).toBeFocused();
	await expect(nav.getByRole("button", { name: /阶段 1/ })).toBeDisabled();
	await team.getByRole("textbox", { name: "搜索任务", exact: true }).clear();
	await team.getByRole("button", { name: "缩小", exact: true }).click();
	await team.getByRole("button", { name: "定位执行中", exact: true }).click();
	await expect(review).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath("team-stages-desktop.png") });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(team.locator(".teams-link-pulse")).toHaveCSS("animation-name", "none");
	await team.getByRole("slider", { name: "历史版本" }).fill("5");
	await expect(nav.getByRole("button")).toHaveCount(1);
	await team.getByRole("button", { name: "回到实时", exact: true }).click();
	await expect(nav.getByRole("button")).toHaveCount(4);
	await page.setViewportSize({ width: 390, height: 844 });
	await nav.getByRole("button", { name: /阶段 4/ }).click();
	await expect(team.locator('[data-task-id="stage-release"]')).toBeFocused();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("team-stages-mobile.png") });
	await team.getByRole("textbox", { name: "搜索任务", exact: true }).fill("不存在的任务");
	await expect(team.getByText("暂无任务", { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

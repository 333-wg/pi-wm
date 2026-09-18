import { expect, test } from "@playwright/test";
import { openApp, restartGateway, startWebApp, stopWebApp } from "./harness.js";

test.afterEach(stopWebApp);

test("selected team skill creates a real team without a solo model turn and survives reload", async ({
	page,
}, testInfo) => {
	const url = await startWebApp();
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, url);
	await page.getByRole("tab", { name: "技能", exact: true }).click();
	await page
		.locator(".skill-entry")
		.filter({ has: page.locator("strong", { hasText: /^team$/ }) })
		.click();
	await page.getByRole("tab", { name: "对话", exact: true }).click();
	await expect(page.locator(".composer-selected-skill")).toContainText("已选技能：team");
	const task = "帮我做一个图书管理系统";
	await page.getByRole("textbox", { name: "消息", exact: true }).fill(task);
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const receipt = page.locator(".team-launch-notice");
	await expect(receipt).toContainText("团队已创建");
	const teamId = await receipt.locator("code").innerText();
	expect(teamId).toMatch(/^[a-f0-9-]{36}$/);
	await expect(page.locator(".composer-selected-skill")).toHaveCount(0);
	await expect(page.locator(".transcript")).not.toContainText("Demo runtime received:");
	await page.screenshot({ path: testInfo.outputPath("team-launch-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator(".right-rail").getByRole("button", { name: "关闭运行面板", exact: true }).click();
	await expect(receipt.getByRole("button", { name: "打开团队", exact: true })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("team-launch-mobile.png") });
	await page.getByRole("button", { name: "打开团队", exact: true }).click();
	await expect(page.locator(".persistent-teams .persistent-team-member")).toHaveCount(1);
	await expect(page.locator(".persistent-teams")).toContainText(task);
	await expect(page.locator(".persistent-team-messages article").first()).toContainText("已投递");
	await page.getByRole("tab", { name: "对话", exact: true }).click();
	await restartGateway();
	await page.reload();
	await expect(receipt.locator("code")).toHaveText(teamId);
	await page.getByRole("button", { name: "打开团队", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "项目团队" }).locator("option")).toHaveCount(1);
});

test("team command validates the goal and does not turn subsequent ordinary chat into a team", async ({ page }) => {
	const url = await startWebApp();
	await openApp(page, url);
	const input = page.getByRole("textbox", { name: "消息", exact: true });
	const send = page.getByRole("button", { name: "发送", exact: true });
	await input.fill("/team");
	await send.click();
	await expect(page.locator(".composer")).toContainText("请提供团队任务目标");
	await expect(page.locator(".team-launch-notice")).toHaveCount(0);
	await input.fill("/team Build a library manager");
	await send.click();
	await expect(page.locator(".team-launch-notice")).toContainText("团队已创建");
	await input.fill("Explain what a team is");
	await send.click();
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: Explain what a team is");
	await expect(page.locator(".composer .stop-button")).toHaveCount(0);
	await input.fill("/team Add book search");
	await send.click();
	await expect(page.locator(".transcript .tool-row").filter({ hasText: "创建团队" })).toHaveCount(2);
	await expect(page.locator(".team-launch-notice")).toContainText("团队已创建");
	await page.getByRole("button", { name: "打开团队", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "项目团队" }).locator("option")).toHaveCount(2);
});

test("unstaffed Demo launch exposes a durable startup error and an explicit bounded retry", async ({
	page,
}, testInfo) => {
	const url = await startWebApp();
	await openApp(page, url);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/team Build library search");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".team-launch-notice")).toContainText("团队已创建");
	await page.getByRole("button", { name: "打开团队", exact: true }).click();
	const team = page.locator(".persistent-teams");
	const failed = team.locator(".persistent-team-member.member-error");
	await expect(failed).toContainText("startup incomplete");
	await expect(team.locator(".persistent-team-messages article")).toHaveCount(2);
	await failed.getByRole("button", { name: "重试", exact: true }).click();
	await expect(team.locator(".persistent-team-messages article")).toHaveCount(4);
	await expect(failed).toContainText("startup incomplete");
	await failed.getByRole("button", { name: "查看成员 Lead", exact: true }).click();
	await expect(team.getByRole("region", { name: "成员详情", exact: true })).toContainText("then retry the lead.");
	await page.screenshot({ path: testInfo.outputPath("team-startup-attention-desktop.png") });
	await restartGateway();
	await page.reload();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await expect(failed).toContainText("startup incomplete");
	await expect(team.locator(".persistent-team-messages article")).toHaveCount(4);
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("team-startup-attention-mobile.png") });
});

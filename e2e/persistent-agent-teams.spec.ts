import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { openApp, restartGateway, startWebApp, stopWebApp } from "./harness.js";
import { seedAgentTeam, seedRunningAgentTeam } from "./fixtures/agent-team-fixture.js";

test.afterEach(stopWebApp);

test("shows a tool-created project team from another conversation, replays history and stops after restart", async ({
	page,
}) => {
	const url = await startWebApp({}, async (workspace) => {
		await seedRunningAgentTeam(join(workspace, "..", "data"));
	});
	await openApp(page, url);
	await expect(page.locator(".session-entry.selected")).toContainText("Explicit team request");
	await expect(page.getByText(/Demo runtime received:.*team-delivery/s)).toHaveCount(0);
	await page.getByRole("button", { name: "新对话", exact: true }).click();
	await expect(page.locator(".session-entry.selected")).toHaveCount(0);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("Persistent team workspace");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText(/Demo runtime received: Persistent team workspace/)).toBeVisible();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	const team = page.locator(".persistent-teams");
	await expect(team.getByRole("button", { name: "启动团队", exact: true })).toHaveCount(0);
	await expect(team.locator(".persistent-team-member")).toHaveCount(1);
	await expect(team.locator(".persistent-team-messages article").first()).toContainText("已投递");
	// Demo cannot staff a team: one bounded reminder, then attention rather than silent idle.
	await expect(team.locator(".persistent-team-member.member-error")).toContainText("startup incomplete");
	await expect(team.locator(".persistent-team-messages article")).toHaveCount(2);
	await team.getByRole("textbox", { name: "团队消息", exact: true }).fill("Please verify the API contract first");
	await team.getByRole("button", { name: "发送消息", exact: true }).click();
	await expect(team.locator(".persistent-team-messages article")).toHaveCount(3);
	await expect(team.locator(".persistent-team-messages article").last()).toContainText("待投递");
	await team.getByRole("slider", { name: "历史版本" }).fill("1");
	await expect(team.getByRole("button", { name: "停止团队" })).toBeDisabled();
	await expect(team.locator(".persistent-team-messages article")).toHaveCount(1);
	await expect(team.locator(".persistent-team-messages article").first()).toContainText("待投递");
	await team.getByRole("button", { name: "回到实时" }).click();
	await restartGateway();
	await page.reload();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await expect(team.locator(".persistent-team-messages article")).toHaveCount(3);
	await team.getByRole("button", { name: "停止团队", exact: true }).click();
	await expect(team.locator(".teams-heading")).toContainText("已停止");
	await expect(team.getByRole("textbox", { name: "团队消息", exact: true })).toBeDisabled();
});

test("opening Teams without a conversation or after ordinary chat does not create a team", async ({
	page,
}, testInfo) => {
	const url = await startWebApp();
	await openApp(page, url);
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	const team = page.locator(".persistent-teams");
	await expect(team.getByText("此项目暂无团队", { exact: true })).toBeVisible();
	await expect(team.getByRole("button", { name: "启动团队", exact: true })).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath("project-teams-empty.png") });
	await team.getByRole("button", { name: "对话", exact: true }).click();
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("Ordinary project task");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText(/Demo runtime received: Ordinary project task/)).toBeVisible();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await expect(team.getByText("此项目暂无团队", { exact: true })).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(team.getByText("此项目暂无团队", { exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("project-teams-empty-mobile.png") });
});

test("switches between project teams independently of the selected conversation", async ({ page }) => {
	const url = await startWebApp({}, async (workspace) => {
		const data = join(workspace, "..", "data");
		const sourceSessionId = await seedRunningAgentTeam(data, "Team A");
		await seedRunningAgentTeam(data, "Team B", { sourceSessionId, archiveSource: true });
	});
	await openApp(page, url);
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	const team = page.locator(".persistent-teams");
	const picker = team.getByRole("combobox", { name: "项目团队" });
	await expect(picker.locator("option")).toHaveCount(2);
	await picker.selectOption({ label: "Team A · 运行中" });
	await page.reload();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await expect(picker.locator("option:checked")).toHaveText("Team A · 运行中");
	await expect(team.locator(".persistent-team-member")).toHaveCount(1);
	await team.getByRole("button", { name: "停止团队", exact: true }).click();
	await expect(team.locator(".teams-heading")).toContainText("已停止");
	await picker.selectOption({ label: "Team B · 运行中" });
	await expect(team.getByRole("button", { name: "停止团队", exact: true })).toBeEnabled();
	await expect(team.getByRole("textbox", { name: "团队消息", exact: true })).toBeEnabled();
});

test("renders actual scripted team records, dependencies and persistent replay across desktop and mobile", async ({
	page,
}, testInfo) => {
	let lead = "";
	const url = await startWebApp({}, async (workspace) => {
		lead = await seedAgentTeam(join(workspace, "..", "data"));
	});
	await page.addInitScript((id) => localStorage.setItem("wuming.sessionId.local-workspace", id), lead);
	await page.setViewportSize({ width: 1440, height: 960 });
	await openApp(page, url);
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	const team = page.locator(".persistent-teams");
	await expect(team.locator(".persistent-team-member")).toHaveCount(3);
	await expect(team.locator(".teams-task.state-completed")).toHaveCount(3);
	await expect(team.locator("[data-dependency]")).toHaveCount(2);
	await expect(team.locator(".persistent-team-messages")).toContainText("接口契约已就绪");
	await expect(team.locator(".persistent-team-detail")).toContainText("负责人验收");
	await team.getByRole("button", { name: "查看成员 后端工程师", exact: true }).click();
	await expect(team.getByRole("region", { name: "成员详情", exact: true })).toContainText("接口契约与服务实现");
	await expect(team.getByRole("region", { name: "成员详情", exact: true })).toContainText("Tokens");
	await team.getByRole("button", { name: "关闭成员详情", exact: true }).click();
	expect(
		await team
			.locator(".persistent-team-member img")
			.evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))
	).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("persistent-teams-desktop.png") });
	await team.getByRole("combobox", { name: "回放速度", exact: true }).selectOption("4");
	await team.getByRole("button", { name: "播放回放", exact: true }).click();
	await expect(team.getByRole("button", { name: "暂停回放", exact: true })).toBeVisible();
	await expect
		.poll(async () => Number(await team.getByRole("slider", { name: "历史版本" }).inputValue()))
		.toBeGreaterThan(1);
	await team.getByRole("button", { name: "暂停回放", exact: true }).click();
	await team.getByRole("button", { name: "回到实时", exact: true }).click();
	await team.getByRole("textbox", { name: "搜索任务", exact: true }).fill("集成验证");
	await expect(team.locator(".teams-task")).toHaveCount(1);
	await team.getByRole("textbox", { name: "搜索任务", exact: true }).clear();
	await team.getByRole("slider", { name: "历史版本" }).fill("5");
	await expect(team.locator(".teams-task")).toHaveCount(2);
	await expect(team.locator(".teams-task.state-completed")).toHaveCount(0);
	await page.reload();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await team.getByRole("slider", { name: "历史版本" }).fill("5");
	await expect(team.locator(".teams-task")).toHaveCount(2);
	await team.getByRole("button", { name: "回到实时" }).click();
	await page.getByRole("button", { name: "切换深浅主题", exact: true }).click();
	await page.screenshot({ path: testInfo.outputPath("persistent-teams-dark.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(team.getByRole("region", { name: "依赖泳道" })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("persistent-teams-mobile.png") });
	await team.getByRole("button", { name: "任务列表", exact: true }).click();
	await team.locator(".persistent-team-task-list button").first().click();
	await expect(team.locator(".persistent-team-detail").first()).toContainText("写入范围");
});

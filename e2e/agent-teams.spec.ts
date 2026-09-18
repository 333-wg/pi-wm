import { expect, test } from "@playwright/test";
import { openApp, restartGateway, startWebApp, stopWebApp } from "./harness.js";

let url: string;
test.beforeEach(async () => {
	url = await startWebApp();
});
test.afterEach(stopWebApp);

test("creates a member, inspects real communication, filters tasks and opens its conversation", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 960 });
	await openApp(page, url);
	await page.getByRole("button", { name: "新对话", exact: true }).click();
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("Team member workspace");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText(/Demo runtime received: Team member workspace/)).toBeVisible();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await page.getByRole("tab", { name: "子任务", exact: true }).click();
	const team = page.getByRole("region", { name: "对话子任务", exact: true });
	await expect(team.getByText("尚无团队任务")).toBeVisible();
	await team.getByRole("button", { name: "新建成员", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "新建成员", exact: true });
	await dialog.getByRole("textbox", { name: "成员名称" }).fill("代码审查员");
	await dialog.getByRole("textbox", { name: "任务目标" }).fill("Inspect the shared workspace");
	await dialog.getByRole("button", { name: "创建并运行" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(team.locator(".teams-task.state-completed")).toHaveCount(1);
	await expect(team.locator(".teams-member")).toHaveCount(2);
	await team.getByRole("button", { name: /通信流/ }).click();
	await expect(team.locator(".teams-feed")).toContainText("Demo runtime received: Inspect the shared workspace");
	await team.getByRole("combobox", { name: "全部类型" }).selectOption("dispatch");
	await expect(team.locator(".teams-feed li")).toHaveCount(1);
	await team.getByRole("button", { name: "关闭", exact: true }).click();
	await team.getByRole("searchbox").fill("not-a-task");
	await expect(team.getByText("没有匹配的任务")).toBeVisible();
	await team.getByRole("searchbox").clear();
	await page.screenshot({ path: testInfo.outputPath("teams-desktop.png") });
	await team.locator(".teams-task").click();
	await expect(team.locator(".teams-result")).toContainText("Demo runtime received:");
	await team.getByRole("button", { name: "打开成员对话" }).click();
	await expect(page.getByRole("button", { name: "返回上级对话" })).toBeVisible();
	await expect(page.getByText(/Demo runtime received: Inspect the shared workspace/)).toBeVisible();
});

test("runs a dependency plan through approval and gateway restart, with mobile-safe lanes", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 960 });
	await openApp(page, url);
	await page.getByRole("button", { name: "新对话", exact: true }).click();
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("Team plan workspace");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText(/Demo runtime received: Team plan workspace/)).toBeVisible();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await page.getByRole("tab", { name: "子任务", exact: true }).click();
	const team = page.getByRole("region", { name: "对话子任务", exact: true });
	await team.getByRole("button", { name: "新建团队计划", exact: true }).first().click();
	const dialog = page.getByRole("dialog", { name: "新建团队计划" });
	await dialog.getByRole("textbox", { name: "计划名称" }).fill("发布协作");
	await dialog.getByRole("textbox", { name: "任务目标", exact: true }).fill("Review and release changes");
	await dialog.getByRole("textbox", { name: "步骤名称", exact: true }).fill("安全审查");
	await dialog.getByRole("textbox", { name: "步骤任务", exact: true }).fill("/approval");
	await dialog.getByRole("button", { name: "添加步骤" }).click();
	await dialog.getByRole("textbox", { name: "步骤名称", exact: true }).nth(1).fill("发布验证");
	await dialog.getByRole("textbox", { name: "步骤任务", exact: true }).nth(1).fill("Verify release after approval");
	await dialog.getByRole("checkbox", { name: "安全审查", exact: true }).check();
	await dialog.getByRole("button", { name: "创建计划", exact: true }).click();
	await expect(team.locator(".teams-task")).toHaveCount(2);
	await expect(team.locator("[data-dependency]")).toHaveCount(1);
	await team.getByRole("button", { name: "启动计划", exact: true }).click();
	await expect(team.locator(".teams-task").filter({ hasText: "等待批准" })).toHaveCount(1);
	await expect(team.locator(".teams-task").filter({ hasText: "等待依赖" })).toHaveCount(1);
	await expect(team.locator(".teams-member")).toHaveCount(2);
	await team.locator(".teams-task").filter({ hasText: "安全审查" }).click();
	const approval = team.getByRole("region", { name: "需要批准工具调用" });
	await expect(approval).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("teams-dependency-approval.png") });
	await restartGateway();
	await page.reload();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await page.getByRole("tab", { name: "子任务", exact: true }).click();
	await expect(team.locator(".teams-task")).toHaveCount(2);
	await team.locator(".teams-task").filter({ hasText: "安全审查" }).click();
	await expect(approval).toBeVisible();
	await approval.getByRole("button", { name: "允许", exact: true }).click();
	await expect(team.locator(".teams-task.state-completed")).toHaveCount(2);
	await team.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(team.locator(".teams-member")).toHaveCount(3);
	expect(
		await team
			.locator(".teams-member img")
			.evaluateAll((images) =>
				images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)
			)
	).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("teams-completed-desktop.png") });
	await page.getByRole("button", { name: "切换深浅主题", exact: true }).click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await page.screenshot({ path: testInfo.outputPath("teams-dark.png") });
	await page.getByRole("button", { name: "切换深浅主题", exact: true }).click();
	await team.getByRole("slider", { name: "本次观察记录" }).fill("0");
	await expect(team.getByText("历史快照 · 只读")).toBeVisible();
	await expect(team.getByRole("button", { name: "新建成员", exact: true })).toBeDisabled();
	await team.getByRole("button", { name: "实时", exact: true }).click();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(team.getByRole("region", { name: "依赖泳道" })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("teams-mobile.png") });
	await team.getByRole("button", { name: "任务列表", exact: true }).click();
	await team.locator(".teams-task-list button").first().click();
	await expect(team.getByRole("complementary", { name: "任务详情" })).toBeVisible();
	const box = await team.locator(".teams-inspector").boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("teams-mobile-inspector.png") });
});

test("stops a running member without reporting success", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 960 });
	await openApp(page, url);
	await page.getByRole("button", { name: "新对话", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("Team cancellation workspace");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText(/Demo runtime received: Team cancellation workspace/)).toBeVisible();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await page.getByRole("tab", { name: "子任务", exact: true }).click();
	const team = page.getByRole("region", { name: "对话子任务", exact: true });
	await team.getByRole("button", { name: "新建成员", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "新建成员", exact: true });
	await dialog.getByRole("textbox", { name: "成员名称" }).fill("Long running member");
	await dialog.getByRole("textbox", { name: "任务目标" }).fill("/long");
	await dialog.getByRole("button", { name: "创建并运行" }).click();
	await team.locator(".teams-task").click();
	await team.getByRole("button", { name: "停止任务", exact: true }).click();
	await expect(team.locator(".teams-task")).toContainText("已取消");
	await expect(team.locator(".teams-task.state-completed")).toHaveCount(0);
});

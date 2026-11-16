import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { openApp, restartGateway, startWebApp, stopWebApp } from "./harness.js";
import { seedModelAssignmentTeam } from "./fixtures/agent-team-fixture.js";

test.afterEach(stopWebApp);

test("team launch waits for the two-choice model dialog and keeps only the inherited Leader", async ({
	page,
}, info) => {
	const url = await startWebApp();
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, url);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/team 设计旅游体验网站");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await page.getByRole("button", { name: "打开团队", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "团队准备好了，模型怎么分配？" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("radio")).toHaveCount(2);
	await expect(dialog.getByRole("radio", { name: /使用对话默认模型/ })).toBeChecked();
	await expect(page.locator(".persistent-team-member")).toHaveCount(1);
	const initialModel = await dialog.getByRole("combobox", { name: "Leader 模型" }).inputValue();
	expect(initialModel).toBe(JSON.stringify(["demo", "wuming-demo"]));
	await page.screenshot({ path: info.outputPath("team-entry-light.png") });
	await dialog.getByRole("button", { name: "返回对话" }).click();
	await restartGateway();
	await page.reload();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await expect(dialog).toBeVisible();
	await expect(page.locator(".persistent-team-member")).toHaveCount(1);
	await dialog.getByRole("radio", { name: /自主选择/ }).check();
	await dialog.getByRole("button", { name: "进入团队", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.locator(".teams-heading")).toContainText("自主选择");
	await page.getByRole("button", { name: "自主选择", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "团队模型分配", exact: true });
	await expect(settings.getByRole("radio", { name: /自主选择/ })).toBeChecked();
	await settings.getByRole("radio", { name: /使用对话默认模型/ }).check();
	await settings.getByRole("button", { name: "保存分配", exact: true }).click();
	await expect(settings).toHaveCount(0);
	await expect(page.locator(".teams-heading")).toContainText("模型分配");
});

test("inline member assignment survives reload and integrates with changing wallpaper and narrow screens", async ({
	page,
}, info) => {
	const url = await startWebApp({}, (workspace) =>
		seedModelAssignmentTeam(join(workspace, "..", "data")).then(() => {})
	);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, url);
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	const team = page.locator(".team-studio");
	await expect(team.locator(".studio-assignment")).toHaveCount(2);
	await expect(team.locator(".member-awaiting_model")).toHaveCount(2);
	await expect(team.locator(".studio-task")).toHaveCount(4);
	const filter = team.getByRole("combobox", { name: "筛选成员", exact: true });
	await filter.selectOption({ label: "场景开发" });
	await expect(team.locator(".persistent-team-messages article")).toHaveCount(0);
	await expect(team.getByRole("region", { name: "成员详情", exact: true })).toHaveCount(0);
	await filter.selectOption("");
	await expect(team.locator(".persistent-team-messages article")).toHaveCount(3);
	await team.getByRole("button", { name: "查看任务与结果", exact: false }).first().click();
	await expect(team.getByRole("region", { name: "任务详情", exact: true })).toContainText("场景与界面可并行推进");
	await page.keyboard.press("Escape");
	const canvas = team.getByRole("region", { name: "任务流程画布" });
	const bounds = await canvas.boundingBox();
	for (const card of await team.locator(".studio-task").all()) {
		const box = await card.boundingBox();
		expect(box!.y).toBeGreaterThanOrEqual(bounds!.y - 1);
		expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
	}
	await page.screenshot({ path: info.outputPath("team-manual-light.png") });
	await restartGateway();
	await page.reload();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await expect(team.locator(".member-awaiting_model")).toHaveCount(2);
	for (const [theme, kind] of [
		["light", "aurora"],
		["dark", "dusk"],
	]) {
		await page.evaluate(
			({ theme, kind }) => {
				localStorage.setItem("wuming.theme", theme!);
				localStorage.setItem("wuming.appearance.background.v1", JSON.stringify({ version: 1, kind, shade: 0 }));
			},
			{ theme, kind }
		);
		await page.reload();
		await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
		await expect(page.locator(".app-shell")).toHaveAttribute("data-wallpaper", "true");
		await expect(team).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(canvas).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(team.locator(".persistent-team-board")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(team.locator(".studio-assignment").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await page.screenshot({ path: info.outputPath(`team-manual-${theme}-${kind}.png`) });
	}
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await team.getByRole("button", { name: "通信流", exact: true }).click();
	await expect(team.locator(".persistent-team-mailbox")).toBeVisible();
	await expect(team.locator(".persistent-team-board")).toBeHidden();
	await team.getByRole("button", { name: "任务流程", exact: true }).click();
	await team.getByRole("button", { name: "自主选择", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.screenshot({ path: info.outputPath("team-models-mobile-wallpaper.png") });
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await page.setViewportSize({ width: 1440, height: 900 });
	await team.getByRole("button", { name: "启动这 2 位成员", exact: true }).click();
	await expect(team.locator(".studio-assignment")).toHaveCount(0);
	await expect(team.locator(".member-awaiting_model")).toHaveCount(0);
	await expect(team.locator(".studio-task.state-in_progress")).toHaveCount(2);
	await team.getByRole("button", { name: "历史回放", exact: true }).click();
	await team.getByRole("button", { name: "上一帧", exact: true }).click();
	await expect(team.getByRole("button", { name: "自主选择", exact: true })).toBeDisabled();
	await expect(team.getByRole("textbox", { name: "团队消息", exact: true })).toBeDisabled();
	expect(errors).toEqual([]);
});

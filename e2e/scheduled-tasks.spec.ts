import { expect, test, type Page } from "@playwright/test";
import { openApp, restartGateway, startWebApp, stopWebApp } from "./harness.js";
let url: string;
test.beforeAll(async () => {
	url = await startWebApp({ WUMING_AUTOMATION_POLL_MS: "1000" });
});
test.afterAll(stopWebApp);

async function openScheduledTasks(page: Page): Promise<void> {
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await expect(page.getByRole("tab", { name: /定时任务|Scheduled tasks/ })).toHaveCount(0);
	const menu = page.getByRole("button", { name: "打开导航", exact: true });
	if (await menu.isVisible()) await menu.click();
	await page.locator(".sidebar").getByRole("button", { name: "定时任务", exact: true }).click();
	await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toBeVisible();
	await expect(page.locator(".sidebar-scheduled")).toHaveClass(/selected/);
	await expect(page.locator(".sidebar")).not.toHaveClass(/mobile-open/);
}

test("explains missing model configuration and never submits a task", async ({ page }) => {
	let submitted = 0;
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			if (JSON.parse(String(message)).command?.type === "scheduled.create") submitted++;
			server.send(message);
		});
		server.onMessage((message) => {
			const data = JSON.parse(String(message));
			if (data.result?.type === "model.list")
				socket.send(JSON.stringify({ ...data, result: { ...data.result, models: [] } }));
			else socket.send(message);
		});
	});
	await openApp(page, url);
	await openScheduledTasks(page);
	await page.getByRole("button", { name: "新建任务", exact: true }).click();
	const form = page.getByRole("dialog", { name: "新建定时任务", exact: true });
	await expect(form.getByRole("alert")).toHaveText("请先添加并验证模型");
	await expect(form.getByRole("button", { name: "创建任务", exact: true })).toBeDisabled();
	expect(submitted).toBe(0);
	await page.keyboard.press("Escape");
	await expect(form).toHaveCount(0);
});

test("keeps an existing chat unchanged while creating a task and prevents duplicate submission", async ({ page }) => {
	let release: (() => void) | undefined;
	let creates = 0;
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			if (JSON.parse(String(message)).command?.type === "scheduled.create") creates++;
			server.send(message);
		});
		server.onMessage((message) => {
			if (JSON.parse(String(message)).result?.type === "automation.created") release = () => socket.send(message);
			else socket.send(message);
		});
	});
	await openApp(page, url);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("Keep this ordinary chat");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".transcript")).toContainText("Demo runtime received");
	const selected = await page.evaluate(() =>
		localStorage.getItem("wuming.sessionId." + localStorage.getItem("wuming.workspaceId"))
	);
	await openScheduledTasks(page);
	await page.getByRole("button", { name: "新建任务", exact: true }).click();
	const form = page.getByRole("dialog", { name: "新建定时任务", exact: true });
	await form.getByRole("textbox", { name: "名称", exact: true }).fill("Independent chat task");
	await form.getByRole("textbox", { name: "描述", exact: true }).fill("Retain the selected chat");
	await form.getByRole("textbox", { name: "提示词", exact: true }).fill("Review the project");
	await form.getByRole("button", { name: "创建任务", exact: true }).click();
	await expect.poll(() => !!release).toBe(true);
	await expect(form.getByRole("button", { name: "正在保存...", exact: true })).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(form).toBeVisible();
	expect(creates).toBe(1);
	release!();
	await expect(form).toHaveCount(0);
	expect(
		await page.evaluate(() => localStorage.getItem("wuming.sessionId." + localStorage.getItem("wuming.workspaceId")))
	).toBe(selected);
	await page.getByRole("tab", { name: "对话", exact: true }).click();
	await expect(page.locator(".transcript")).toContainText("Keep this ordinary chat");
	await openScheduledTasks(page);
	await page
		.locator(".scheduled-task")
		.filter({ hasText: "Independent chat task" })
		.getByRole("button", { name: "删除", exact: true })
		.click();
	await page.getByRole("button", { name: "确认删除", exact: true }).click();
});

for (const width of [1440, 390, 320])
	test("standalone task lifecycle at " + width, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: width < 720 ? 844 : 1000 });
		const sent: string[] = [];
		page.on("websocket", (socket) =>
			socket.on("framesent", ({ payload }) => {
				const command = JSON.parse(String(payload)).command;
				if (command) sent.push(command.type);
			})
		);
		await openApp(page, url);
		await openScheduledTasks(page);
		await page.getByRole("button", { name: "新建任务", exact: true }).click();
		const form = page.getByRole("dialog", { name: "新建定时任务", exact: true });
		await form.getByRole("textbox", { name: "名称", exact: true }).fill("每日检查-" + width);
		await form.getByRole("textbox", { name: "描述", exact: true }).fill("检查当前项目的提交记录");
		await form
			.getByRole("textbox", { name: "提示词", exact: true })
			.fill("Summarize the project status in three lines");
		await expect(form.getByRole("combobox", { name: "模型", exact: true })).toBeEnabled();
		await expect(form.getByText("所有权限（固定）", { exact: false })).toBeVisible();
		await form.getByRole("combobox", { name: "频率", exact: true }).selectOption("weekly");
		await expect(form.getByRole("checkbox", { name: "周一", exact: true })).toBeChecked();
		await page.screenshot({ path: testInfo.outputPath("scheduled-form-" + width + ".png") });
		await form.getByRole("button", { name: "创建任务", exact: true }).click();
		await expect(form).toHaveCount(0);
		expect(sent).not.toContain("session.create");
		const card = page.locator(".scheduled-task").filter({ hasText: "每日检查-" + width });
		await expect(card).toBeVisible();
		await card.getByRole("button", { name: "禁用", exact: true }).click();
		await expect(card.getByText("已禁用", { exact: true }).first()).toBeVisible();
		await card.getByRole("button", { name: "编辑", exact: true }).click();
		const edit = page.getByRole("dialog", { name: "编辑定时任务", exact: true });
		await edit.getByRole("combobox", { name: "频率", exact: true }).selectOption("monthly");
		await edit.getByRole("spinbutton", { name: "每月日期", exact: true }).fill("31");
		await edit.getByRole("button", { name: "保存修改", exact: true }).click();
		await expect(edit).toHaveCount(0);
		await page.reload();
		await openScheduledTasks(page);
		await expect(card.getByText("已禁用", { exact: true }).first()).toBeVisible();
		await expect(card).toContainText("每月 31 日");
		await card.getByRole("button", { name: "立即执行", exact: true }).click();
		const logs = page.getByRole("dialog", { name: "每日检查-" + width + " · 执行日志", exact: true });
		await expect(logs.getByText("已完成", { exact: true })).toBeVisible();
		await logs.getByText("摘要", { exact: true }).click();
		await expect(logs).toContainText("Demo runtime received");
		await expect(logs.getByRole("button", { name: "查看完整对话" })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("scheduled-log-" + width + ".png") });
		await logs.getByRole("button", { name: "关闭", exact: true }).click();
		await card.getByRole("button", { name: "启用", exact: true }).click();
		await expect(card.getByText("活跃", { exact: true })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("scheduled-list-" + width + ".png") });
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
		await card.getByRole("button", { name: "删除", exact: true }).click();
		const confirmation = page.getByRole("dialog", { name: "删除定时任务", exact: true });
		await confirmation.getByRole("button", { name: "取消", exact: true }).click();
		await expect(card).toBeVisible();
		await card.getByRole("button", { name: "删除", exact: true }).click();
		await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
		await expect(card).toHaveCount(0);
	});

test("automatically fires at the real calendar boundary after restart", async ({ page }) => {
	test.setTimeout(105000);
	const due = new Date(Math.ceil((Date.now() + 12000) / 60000) * 60000);
	let triggers = 0;
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const data = JSON.parse(String(message));
			if (data.command?.type === "scheduled.trigger") triggers++;
			if (data.command?.type === "scheduled.create") {
				data.command.input.schedule = {
					kind: "calendar",
					frequency: "daily",
					timeZone: "UTC",
					hour: due.getUTCHours(),
					minute: due.getUTCMinutes(),
				};
				server.send(JSON.stringify(data));
			} else server.send(message);
		});
		server.onMessage((message) => socket.send(message));
	});
	await openApp(page, url);
	await openScheduledTasks(page);
	await page.getByRole("button", { name: "新建任务", exact: true }).click();
	const form = page.getByRole("dialog", { name: "新建定时任务" });
	await form.getByRole("textbox", { name: "名称", exact: true }).fill("真实到点执行");
	await form.getByRole("textbox", { name: "描述", exact: true }).fill("重启后执行一次");
	await form.getByRole("textbox", { name: "提示词", exact: true }).fill("Return the automatic verification result");
	await form.getByRole("button", { name: "创建任务", exact: true }).click();
	await expect(form).toHaveCount(0);
	await restartGateway();
	await page.reload();
	await openScheduledTasks(page);
	const card = page.locator(".scheduled-task").filter({ hasText: "真实到点执行" });
	await card.getByRole("button", { name: "日志", exact: true }).click();
	const logs = page.getByRole("dialog", { name: "真实到点执行 · 执行日志", exact: true });
	await expect(logs.getByText("已完成", { exact: true })).toBeVisible({ timeout: 80000 });
	await expect(logs.getByText("定时执行", { exact: true })).toHaveCount(1);
	expect(triggers).toBe(0);
	await logs.getByRole("button", { name: "关闭", exact: true }).click();
	await restartGateway();
	await page.reload();
	await openScheduledTasks(page);
	await card.getByRole("button", { name: "日志", exact: true }).click();
	await expect(logs.getByText("已完成", { exact: true })).toHaveCount(1);
});

import { expect, test } from "@playwright/test";
import { openLegacyAutomations, openApp, restartGateway, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;

test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_AUTOMATION_POLL_MS: "1000" });
});

test.afterAll(async () => {
	await stopWebApp();
});

for (const restart of [false, true])
	for (const decision of ["允许", "拒绝"] as const) {
		test(
			"resolves a plan approval after " + (restart ? "gateway restart" : "page reload") + ": " + decision,
			async ({ page }) => {
				await page.setViewportSize({ width: 1365, height: 900 });
				await openApp(page, webUrl);
				await page.getByRole("button", { name: "新对话", exact: true }).click();
				await openLegacyAutomations(page);
				const workbench = page.getByRole("region", { name: "自动化" });
				await workbench.getByRole("button", { name: "新建自动化" }).click();
				await workbench.getByRole("textbox", { name: "目标", exact: true }).fill("Approval dependency plan");
				await workbench.getByRole("checkbox", { name: "多步骤计划" }).check();
				await workbench.getByRole("textbox", { name: "步骤名称", exact: true }).fill("Gate");
				await workbench.getByRole("textbox", { name: "步骤任务", exact: true }).fill("/approval");
				await workbench.getByRole("button", { name: "添加步骤" }).click();
				await workbench.getByRole("textbox", { name: "步骤名称", exact: true }).nth(1).fill("Follow up");
				await workbench
					.getByRole("textbox", { name: "步骤任务", exact: true })
					.nth(1)
					.fill("Complete after permission");
				await workbench.getByRole("checkbox", { name: "Gate", exact: true }).check();
				await workbench.getByRole("button", { name: "创建自动化", exact: true }).click();
				await workbench.getByRole("button", { name: "立即运行", exact: true }).click();
				const history = workbench.locator(".automation-run-list");
				const plan = history.getByRole("region", { name: "步骤执行状态" });
				const approval = history.getByRole("region", { name: "需要批准工具调用" });
				await expect(approval).toBeVisible();
				await expect(plan.getByText("等待依赖", { exact: true })).toBeVisible();
				await expect(plan.getByText("已完成", { exact: true })).toHaveCount(0);
				if (restart) await restartGateway();
				await page.reload();
				await openLegacyAutomations(page);
				await expect(approval).toBeVisible();
				await expect(plan.getByText("等待依赖", { exact: true })).toBeVisible();
				await approval.getByRole("button", { name: decision, exact: true }).click();
				await expect(approval).toHaveCount(0);
				if (decision === "允许") await expect(plan.getByText("已完成", { exact: true })).toHaveCount(2);
				else {
					await expect(plan.getByText("失败", { exact: true })).toHaveCount(1);
					await expect(plan.getByText("已跳过", { exact: true })).toHaveCount(1);
				}
			}
		);
	}

test("approves an automation from its run history and continues execution", async ({ page }) => {
	await page.setViewportSize({ width: 1365, height: 900 });
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "新对话", exact: true }).click();
	await openLegacyAutomations(page);
	const workbench = page.getByRole("region", { name: "自动化" });
	await workbench.getByRole("button", { name: "新建自动化" }).click();
	await workbench.getByRole("textbox", { name: "目标", exact: true }).fill("/approval");
	await workbench.getByRole("textbox", { name: "名称", exact: true }).fill("Approval automation");
	await workbench.getByRole("button", { name: "创建自动化", exact: true }).click();
	await workbench.getByRole("button", { name: "立即运行", exact: true }).click();
	const history = workbench.locator(".automation-run-list");
	const approval = history.getByRole("region", { name: "需要批准工具调用" });
	await expect(approval).toBeVisible();
	await approval.getByRole("button", { name: "允许", exact: true }).click();
	await expect(approval).toHaveCount(0);
	await expect(history.getByText("已完成", { exact: true })).toBeVisible();
	await expect(
		history.getByText("Demo approval was granted. No filesystem or process action was executed.", {
			exact: true,
		})
	).toBeVisible();
});

test("runs and reloads an automation dependency plan", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1365, height: 900 });
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "新对话", exact: true }).click();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect
		.poll(async () => {
			const box = await page.locator(".sidebar").boundingBox();
			return box ? box.x + box.width : 0;
		})
		.toBeLessThanOrEqual(0);
	await openLegacyAutomations(page);
	const workbench = page.getByRole("region", { name: "自动化" });
	await workbench.getByRole("button", { name: "新建自动化" }).click();
	await workbench.getByRole("textbox", { name: "目标", exact: true }).fill("Run a dependency automation");
	await workbench.getByRole("textbox", { name: "名称", exact: true }).fill("Scheduled dependency plan");
	await workbench.getByRole("checkbox", { name: "多步骤计划" }).check();
	await workbench.getByRole("textbox", { name: "步骤名称", exact: true }).fill("Collect");
	await workbench.getByRole("textbox", { name: "步骤任务", exact: true }).fill("Collect evidence");
	await workbench.getByRole("button", { name: "添加步骤" }).click();
	await workbench.getByRole("textbox", { name: "步骤名称", exact: true }).nth(1).fill("Summarize");
	await workbench.getByRole("textbox", { name: "步骤任务", exact: true }).nth(1).fill("Summarize evidence");
	await workbench.getByRole("checkbox", { name: "Collect", exact: true }).check();
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
	await workbench.getByRole("button", { name: "创建自动化", exact: true }).click();
	await expect(workbench.getByText("Scheduled dependency plan", { exact: true }).first()).toBeVisible();
	await workbench.getByRole("button", { name: "立即运行", exact: true }).click();
	const history = workbench.locator(".automation-run-list");
	await expect(history.getByRole("region", { name: "步骤执行状态" }).getByText("已完成", { exact: true })).toHaveCount(
		2
	);
	await page.reload();
	await openLegacyAutomations(page);
	await expect(history.getByRole("region", { name: "步骤执行状态" }).getByText("已完成", { exact: true })).toHaveCount(
		2
	);
	await history.getByRole("region", { name: "步骤执行状态" }).scrollIntoViewIfNeeded();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("automation-plan-mobile.png") });
});

test("creates, controls, runs, and inspects a durable automation", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1365, height: 900 });
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "新对话", exact: true }).click();

	await openLegacyAutomations(page);
	const workbench = page.getByRole("region", { name: "自动化" });
	await expect(workbench).toBeVisible();
	await page.getByRole("button", { name: "新建自动化" }).click();
	await page.getByRole("textbox", { name: "目标" }).fill("Return a reviewed automation E2E result");
	await page.getByRole("textbox", { name: "名称" }).fill("E2E scheduled review");
	await page.getByRole("spinbutton", { name: "间隔（分钟）" }).fill("15");
	await page.getByRole("checkbox", { name: "启用评审循环" }).check();
	await page.getByRole("textbox", { name: "成功标准" }).fill("The result must contain the automation E2E result");
	await page.getByRole("combobox", { name: "最大轮次" }).selectOption("2");
	await page.getByRole("button", { name: "创建自动化" }).click();

	await expect(workbench.getByText("E2E scheduled review", { exact: true }).first()).toBeVisible();
	await expect(workbench.getByText("每 15 分钟", { exact: true })).toBeVisible();
	await expect(workbench.getByText("The result must contain the automation E2E result", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "暂停", exact: true }).click();
	await expect(workbench.getByText("已暂停", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "恢复", exact: true }).click();
	await expect(workbench.getByText("运行中", { exact: true }).first()).toBeVisible();

	await page.getByRole("button", { name: "立即运行", exact: true }).click();
	const history = workbench.locator(".automation-run-list");
	await expect(history.getByText("手动触发", { exact: true })).toBeVisible();
	await expect(history.getByText("已完成", { exact: true })).toBeVisible();
	await expect(history.getByText(/Demo runtime received: Return a reviewed automation E2E result/)).toBeVisible();
	await expect(history.getByRole("button", { name: "打开运行会话" })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("automation-desktop.png") });

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(workbench).toBeVisible();
	await expect
		.poll(async () => {
			const box = await page.locator(".sidebar").boundingBox();
			return box ? box.x + box.width : 0;
		})
		.toBeLessThanOrEqual(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
	expect(await workbench.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(390);
	await history.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("automation-mobile.png") });

	await history.getByRole("button", { name: "打开运行会话" }).click();
	await expect(page.getByRole("button", { name: "返回上级对话" })).toBeVisible();
});

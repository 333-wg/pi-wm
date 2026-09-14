import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(async () => {
	await stopWebApp();
});

test("creates and completes a dependency plan on desktop and mobile", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1365, height: 900 });
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "新对话" }).click();
	await page.getByRole("tab", { name: "目标", exact: true }).click();
	const workbench = page.getByRole("region", { name: "目标", exact: true });
	await workbench.getByRole("textbox", { name: "目标", exact: true }).fill("Combine two research results");
	await workbench.getByRole("textbox", { name: "名称", exact: true }).fill("Dependency plan E2E");
	await workbench.getByRole("checkbox", { name: "多步骤计划" }).check();
	for (let index = 0; index < 3; index += 1) {
		if (index > 0) await workbench.getByRole("button", { name: "添加步骤" }).click();
		await workbench
			.getByRole("textbox", { name: "步骤名称", exact: true })
			.nth(index)
			.fill(["Research A", "Research B", "Combine"][index]!);
		await workbench
			.getByRole("textbox", { name: "步骤任务", exact: true })
			.nth(index)
			.fill("Complete step " + index);
	}
	const finalStep = workbench.locator(".goal-plan-edit-step").nth(2);
	await finalStep.getByRole("checkbox", { name: "Research A" }).check();
	await finalStep.getByRole("checkbox", { name: "Research B" }).check();
	await finalStep
		.getByRole("textbox", { name: "步骤验收标准（可选）", exact: true })
		.fill("The combined result must include both sources");
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
	await page.screenshot({ path: testInfo.outputPath("plan-editor-desktop.png") });
	await workbench.getByRole("button", { name: "创建目标", exact: true }).click();
	const plan = workbench.getByRole("region", { name: "步骤执行状态" });
	await expect(plan.getByText("等待依赖", { exact: true })).toBeVisible();
	await workbench.getByRole("button", { name: "启动", exact: true }).click();
	await expect(plan.getByText("已完成", { exact: true })).toHaveCount(3);
	await plan.locator(".goal-plan-review summary").click();
	await expect(
		plan.getByRole("list", { name: "Combine 验收记录" }).getByText("第 1 轮 · 通过", { exact: true })
	).toBeVisible();
	await expect(plan.getByText("The demo candidate contains the requested goal result.", { exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("plan-review-desktop.png") });
	await plan.locator(".goal-plan-review summary").click();
	await expect(workbench.getByRole("navigation", { name: "目标列表" }).getByRole("button")).toHaveCount(1);
	await page.screenshot({ path: testInfo.outputPath("plan-result-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await expect
		.poll(async () => {
			const box = await page.locator(".sidebar").boundingBox();
			return box ? box.x + box.width : 0;
		})
		.toBeLessThanOrEqual(0);
	await plan.scrollIntoViewIfNeeded();
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	expect(await workbench.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("plan-result-mobile.png") });
	await plan.getByRole("button", { name: "打开步骤会话", exact: true }).last().click();
	await expect(page.getByRole("button", { name: "返回主会话" })).toBeVisible();
	await expect(page.getByRole("tab", { name: "对话", exact: true })).toHaveAttribute("aria-selected", "true");
	await page.getByRole("button", { name: "返回主会话" }).click();
	await page.getByRole("tab", { name: "目标", exact: true }).click();
	await expect(plan.getByText("已完成", { exact: true })).toHaveCount(3);
});

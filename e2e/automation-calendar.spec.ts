import { expect, test } from "@playwright/test";
import { openLegacyAutomations, openApp, startWebApp, stopWebApp } from "./harness.js";
let url: string;
test.beforeAll(async () => {
	url = await startWebApp({ WUMING_AUTOMATION_POLL_MS: "1000" });
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const width of [1440, 390])
	test(`calendar creation, validation, edit, run and delete at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		await openApp(page, url);
		await page.getByRole("button", { name: "新对话", exact: true }).click();
		await openLegacyAutomations(page);
		const view = page.getByRole("region", { name: "自动化", exact: true });
		await view.getByRole("button", { name: "新建自动化", exact: true }).click();
		await view.getByRole("textbox", { name: "名称", exact: true }).fill("日历验收任务");
		await view.getByRole("textbox", { name: "目标", exact: true }).fill("Summarize local changes in three lines");
		await view.getByRole("button", { name: "日历日程", exact: true }).click();
		await view.getByRole("textbox", { name: "时区", exact: true }).fill("Invalid/Zone");
		await view.getByRole("button", { name: "创建自动化", exact: true }).click();
		await expect(view.getByText("请填写有效时区、时刻及至少一个星期。")).toBeVisible();
		await view.getByRole("textbox", { name: "时区", exact: true }).fill("Asia/Shanghai");
		await view.getByRole("combobox", { name: "频率", exact: true }).selectOption("weekly");
		for (const name of ["周一", "周二", "周三", "周四", "周五"])
			await view.getByRole("checkbox", { name, exact: true }).uncheck();
		await view.getByRole("button", { name: "创建自动化", exact: true }).click();
		await expect(view.getByText("请填写有效时区、时刻及至少一个星期。")).toBeVisible();
		await view.getByRole("checkbox", { name: "周一", exact: true }).check();
		await view.getByRole("checkbox", { name: "周五", exact: true }).check();
		await view.getByRole("textbox", { name: "时区", exact: true }).scrollIntoViewIfNeeded();
		await page.screenshot({ path: testInfo.outputPath(`calendar-form-${width}.png`) });
		await view.getByRole("button", { name: "创建自动化", exact: true }).click();
		await expect(view.getByText("周一、周五 09:00 · Asia/Shanghai", { exact: true }).first()).toBeVisible();
		await view.getByRole("button", { name: "暂停", exact: true }).click();
		await view.getByRole("button", { name: "编辑", exact: true }).click();
		await view.getByRole("textbox", { name: "名称", exact: true }).fill("每月验收任务");
		await view.getByRole("combobox", { name: "频率", exact: true }).selectOption("monthly");
		await view.getByRole("spinbutton", { name: "每月日期", exact: true }).fill("31");
		await view.getByRole("button", { name: "保存修改", exact: true }).click();
		await expect(view.getByText("已暂停", { exact: true })).toBeVisible();
		await page.reload();
		await openLegacyAutomations(page);
		await expect(view.getByText("每月 31 日 09:00 · Asia/Shanghai", { exact: true }).first()).toBeVisible();
		await view.getByRole("button", { name: "立即运行", exact: true }).click();
		await expect(view.locator(".automation-run-list").getByText("已完成", { exact: true })).toBeVisible();
		await expect(view.getByRole("button", { name: "打开运行会话", exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
		await page.screenshot({ path: testInfo.outputPath(`calendar-result-${width}.png`) });
		await view.getByRole("button", { name: "删除", exact: true }).click();
		await view.getByRole("button", { name: "取消", exact: true }).click();
		await expect(view.getByText("每月验收任务", { exact: true }).first()).toBeVisible();
		await view.getByRole("button", { name: "删除", exact: true }).click();
		await view.getByRole("button", { name: "确认删除", exact: true }).click();
		await expect(view.getByText("暂无自动化", { exact: true })).toBeVisible();
		await page.reload();
		await openLegacyAutomations(page);
		await expect(view.getByText("暂无自动化", { exact: true })).toBeVisible();
	});

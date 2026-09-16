import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";
import { createTestSubagent } from "./subagent-fixture.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({
		WUMING_CONTEXT_WINDOW: "258000",
		WUMING_MODELS_JSON: JSON.stringify([
			{ provider: "demo", id: "wuming-demo", name: "Child Model", contextWindow: 258000, authenticated: true },
			{ provider: "demo", id: "alternate-demo", name: "Other Model", contextWindow: 128000, authenticated: true },
		]),
	});
});
test.afterAll(stopWebApp);

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
]) {
	test(`opens a child from its tool row and continues the independent conversation at ${viewport.width}px`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await openApp(page, webUrl);
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("Start the parent conversation");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.getByText(/Demo runtime received: Start the parent conversation/)).toBeVisible();
		await expect(page.getByRole("tab", { name: "智能体" })).toHaveCount(0);
		await createTestSubagent(page, "Inspect the child workspace", "Independent child");
		await page.locator(".thinking-trigger").click();
		await page.locator(".thinking-model-option").filter({ hasText: "Other Model" }).click();
		await expect(page.locator(".thinking-trigger")).toContainText("Other Model");
		await page.keyboard.press("Escape");
		await page.evaluate(() =>
			localStorage.setItem(
				"wuming.permission",
				JSON.stringify({ sandboxMode: "workspace_write", approvalPolicy: "always" })
			)
		);

		if (viewport.width < 600 && (await page.locator(".right-rail").count()))
			await page.getByRole("button", { name: "显示或隐藏运行面板" }).click();
		await page.setViewportSize(viewport);
		const row = page.getByRole("button", { name: /子代理.*Independent child/ });
		await expect(row).toHaveAttribute("title", "打开子代理对话");
		await row.click();
		await expect(page.locator(".thinking-trigger")).toContainText("Child Model");
		await expect(page.getByRole("button", { name: "权限模式：帮我批准", exact: true })).toBeVisible();
		if (viewport.width >= 600) await expect(page.getByRole("heading", { name: "Independent child" })).toBeVisible();
		await expect(page.getByRole("button", { name: "返回上级对话" })).toBeVisible();
		await expect(page.getByText(/Demo runtime received: Inspect the child workspace/)).toBeVisible();
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("Continue the child investigation");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.getByText(/Demo runtime received: Continue the child investigation/)).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath(`child-${viewport.width}.png`), fullPage: true });
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
		await page.getByRole("button", { name: "返回上级对话" }).click();
		await expect(row).toBeVisible();
		await page.getByRole("button", { name: "子对话", exact: true }).click();
		const childLink = page.locator(".child-conversation-open").filter({ hasText: "Independent child" });
		await expect(childLink).toBeVisible();
		await childLink.click();
		await expect(page.getByText(/Demo runtime received: Continue the child investigation/)).toBeVisible();
		await page.reload();
		await expect(page.getByText(/Demo runtime received: Continue the child investigation/)).toBeVisible();
		await page.getByRole("button", { name: "子对话", exact: true }).click();
		await expect(childLink).toHaveAttribute("aria-current", "page");
		const menuBox = await page.getByRole("dialog", { name: "子对话", exact: true }).boundingBox();
		expect(menuBox!.x).toBeGreaterThanOrEqual(0);
		expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width);
		await expect(page.getByRole("button", { name: "新建子对话", exact: true })).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath(`child-navigation-${viewport.width}.png`), fullPage: true });
	});
}

test("switches sibling conversations and stops a sibling from inside another child", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, webUrl);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("Parent for sibling navigation");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText(/Demo runtime received: Parent for sibling navigation/)).toBeVisible();
	await page.getByRole("button", { name: "子对话", exact: true }).click();
	await expect(page.getByText("暂无子对话", { exact: true })).toBeVisible();
	await page.getByRole("textbox", { name: "消息", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "子对话", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "子对话", exact: true }).click();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "子对话", exact: true })).toBeFocused();
	await createTestSubagent(page, "Inspect backend routes and report the architecture", "后端架构梳理");
	await createTestSubagent(page, "/approval", "前端架构梳理与组件依赖关系检查");
	await page.getByRole("button", { name: "子对话", exact: true }).click();
	const backend = page.locator(".child-conversation-open").filter({ hasText: "后端架构梳理" });
	const frontend = page.locator(".child-conversation-row").filter({ hasText: "前端架构梳理" });
	await expect(backend).toContainText("已完成");
	await expect(frontend).toContainText("等待批准");
	await page.screenshot({ path: testInfo.outputPath("switcher-desktop.png"), fullPage: true });
	await backend.click();
	await expect(page.getByRole("heading", { name: "后端架构梳理", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "子对话", exact: true }).click();
	await expect(page.getByText("同级子对话", { exact: true })).toBeVisible();
	await expect(backend).toHaveAttribute("aria-current", "page");
	await expect(frontend).toContainText("等待批准");
	await frontend.getByRole("button", { name: /停止子对话/ }).click();
	await expect(frontend).toContainText("已取消");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: testInfo.outputPath("switcher-mobile.png"), fullPage: true });
	const box = await page.getByRole("dialog", { name: "子对话", exact: true }).boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page
		.getByRole("dialog", { name: "子对话", exact: true })
		.getByRole("button", { name: "返回上级对话", exact: true })
		.click();
	await expect(page.getByText(/Demo runtime received: Parent for sibling navigation/)).toBeVisible();
	await expect(page.getByRole("dialog", { name: "子对话", exact: true })).toHaveCount(0);
});

test("returns through nested conversations after a reload", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("Parent for nested navigation");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText(/Demo runtime received: Parent for nested navigation/)).toBeVisible();
	for (const name of ["First child", "Second child", "Third child"]) {
		await createTestSubagent(page, "Inspect " + name, name);
		await page.getByRole("button", { name: "子对话", exact: true }).click();
		await page.locator(".child-conversation-open").filter({ hasText: name }).click();
		await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
		await expect(page.getByText("Demo runtime received: Inspect " + name, { exact: true })).toBeVisible();
	}
	await page.reload();
	await expect(page.getByRole("heading", { name: "Third child", exact: true })).toBeVisible();
	for (const name of ["Second child", "First child"]) {
		await page.getByRole("button", { name: "返回上级对话", exact: true }).click();
		await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
	}
	await page.getByRole("button", { name: "返回上级对话", exact: true }).click();
	await expect(page.getByText(/Demo runtime received: Parent for nested navigation/)).toBeVisible();
});

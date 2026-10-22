import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(stopWebApp);

test("keeps projectless chats visible and independent while working in a project", async ({ page }, testInfo) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1365, height: 900 });
	await openApp(page, webUrl);
	const project = await page.evaluate(async (authorization) => {
		const headers = { Authorization: `Bearer ${authorization}` };
		const response = await fetch("/api/projects", {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Recent isolation project" }),
		});
		const { project } = await response.json();
		await fetch(`/api/projects/${encodeURIComponent(project.id)}/files`, {
			method: "PUT",
			headers: { ...headers, "Content-Type": "text/plain", "X-Wuming-Project-Path": "readme.md" },
			body: "# Recent conversations test\n",
		});
		await fetch(`/api/projects/${encodeURIComponent(project.id)}/complete`, { method: "POST", headers });
		return project as { id: string; name: string };
	}, token);
	await page.reload();
	const recent = page.locator(".recent-conversations");
	const input = page.getByRole("textbox", { name: "消息", exact: true });
	await input.fill("Independent recent task");
	await input.press("Enter");
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: Independent recent task");
	const recentChat = recent.locator(".session-entry").filter({ hasText: "Independent recent task" });
	await expect(recentChat).toBeVisible();
	const projectRow = page.locator(".project-row").filter({ hasText: project.name });
	await projectRow.click();
	await expect(projectRow).toHaveClass(/selected/);
	await expect(recentChat).toBeVisible();
	await input.fill("Project-only task");
	await input.press("Enter");
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: Project-only task");
	const projectChats = page.locator(".project-conversations");
	await expect(projectChats.locator(".session-entry")).toHaveCount(1);
	await expect(projectChats).toContainText("Project-only task");
	await expect(recent).not.toContainText("Project-only task");
	await page.reload();
	await expect(projectRow).toHaveClass(/selected/);
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: Project-only task");
	await expect(recentChat).toBeVisible();
	await expect(projectChats).toContainText("Project-only task");

	// A background section can rename and browse archives without navigating the active project.
	await recentChat.hover();
	await recentChat.getByRole("button", { name: "重命名会话" }).click();
	await recent.getByRole("textbox", { name: "会话名称" }).fill("Renamed recent task");
	await recent.getByRole("button", { name: "保存名称" }).click();
	const renamed = recent.locator(".session-entry").filter({ hasText: "Renamed recent task" });
	await renamed.hover();
	await renamed.getByRole("button", { name: "归档聊天" }).click();
	await expect(renamed).toHaveCount(0);
	await recent.getByRole("button", { name: "最近对话选项" }).click();
	await recent.getByRole("button", { name: "查看归档聊天" }).click();
	await expect(renamed).toBeVisible();
	await expect(projectChats).toContainText("Project-only task");
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: Project-only task");
	await renamed.hover();
	await renamed.getByRole("button", { name: "恢复聊天" }).click();
	await recent.getByRole("button", { name: "返回聊天" }).click();
	await expect(renamed).toBeVisible();
	await recent.getByRole("button", { name: "最近对话选项" }).click();
	await page.screenshot({ path: testInfo.outputPath("recent-with-project-desktop.png") });

	await renamed.locator(".session-open").click();
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: Independent recent task");
	await expect(projectRow).not.toHaveClass(/selected/);
	await input.fill("/long");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(renamed.locator(".session-running")).toBeVisible();
	await projectRow.click();
	await expect(renamed.locator(".session-running")).toBeVisible();
	await renamed.locator(".session-open").click();
	await page.getByRole("button", { name: "停止任务", exact: true }).click();
	await expect(renamed.locator(".session-running")).toHaveCount(0);
	await projectRow.click();
	await recent.getByRole("button", { name: "最近对话选项" }).click();
	await recent.getByRole("button", { name: "查看归档聊天" }).click();
	await recent.getByRole("button", { name: "新建项目外对话" }).click();
	await expect(page.locator(".composer-project-context")).toHaveCount(0);
	await expect(recent.locator(".session-view-label")).toHaveCount(0);
	await recent.getByRole("button", { name: "最近对话选项" }).click();
	await input.fill("Created from recent heading");
	await input.press("Enter");
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: Created from recent heading");
	await expect(recent.locator(".session-entry")).toHaveCount(2);
	await projectRow.click();
	await expect(projectChats.locator(".session-entry")).toHaveCount(1);
	await expect(recent.locator(".session-entry")).toHaveCount(2);
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 740 });
		await page.getByRole("button", { name: "打开导航", exact: true }).click();
		await expect.poll(async () => (await page.locator(".sidebar").boundingBox())?.x).toBe(0);
		await expect(recent.getByRole("button", { name: "新建项目外对话" })).toBeInViewport();
		await expect(renamed).toBeInViewport();
		await page.screenshot({ path: testInfo.outputPath(`recent-mobile-${width}.png`) });
		expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
		await recent.getByRole("button", { name: "新建项目外对话" }).click();
		await expect(page.locator(".sidebar")).not.toHaveClass(/mobile-open/);
		await expect(input).toBeFocused();
	}
});

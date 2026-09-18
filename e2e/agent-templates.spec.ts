import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { openApp, restartGateway, startWebApp, stopWebApp } from "./harness.js";
import { seedAgentTeam } from "./fixtures/agent-team-fixture.js";

test.afterEach(stopWebApp);
async function openAgents(page: Page) {
	if (page.viewportSize()!.width < 700) await page.locator(".mobile-menu").click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.locator('.settings-navigation button[aria-controls="settings-panel-agents"]').click();
	return page.locator(".agent-template-settings");
}

for (const width of [1440, 390]) {
	test(`creates, edits, duplicates and deletes Agent templates at ${width}`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 960 });
		const url = await startWebApp();
		await openApp(page, url);
		const settings = await openAgents(page);
		await expect(settings.getByRole("button", { name: "内置 reviewer", exact: true })).toBeVisible();
		await settings.getByRole("button", { name: "创建 Agent", exact: true }).click();
		const form = settings.getByRole("form", { name: "Agent 配置" });
		await form.getByRole("textbox", { name: "Agent 名称", exact: true }).fill("api-reviewer");
		await form.getByLabel("描述", { exact: true }).fill("检查 API 契约与边界");
		await form.getByLabel("系统提示词", { exact: true }).fill("只读审查，返回文件路径与可验证的问题。");
		await form.getByLabel("配置范围", { exact: true }).selectOption("project");
		await form.getByLabel("思考强度", { exact: true }).selectOption("high");
		await form.getByRole("radio", { name: "自定义", exact: true }).check();
		await form.getByRole("checkbox", { name: "read_file", exact: true }).check();
		await form.getByRole("checkbox", { name: "grep", exact: true }).check();
		await form.getByRole("button", { name: "cyan", exact: true }).click();
		await form.getByRole("button", { name: "保存 Agent", exact: true }).click();
		await expect(form.getByRole("status")).toHaveText("已保存");
		await expect(settings.getByRole("button", { name: "项目 api-reviewer", exact: true })).toBeVisible();
		await settings.locator(".agent-template-heading").scrollIntoViewIfNeeded();
		await page.screenshot({ path: testInfo.outputPath(`agents-${width}.png`), fullPage: true });
		expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await restartGateway();
		await page.reload();
		await openAgents(page);
		await settings.getByRole("button", { name: "项目 api-reviewer", exact: true }).click();
		await expect(form.getByRole("checkbox", { name: "read_file", exact: true })).toBeChecked();
		await expect(form.getByLabel("思考强度", { exact: true })).toHaveValue("high");
		await expect(form.getByRole("button", { name: "cyan", exact: true })).toHaveAttribute("aria-pressed", "true");
		await form.getByLabel("描述", { exact: true }).fill("API 审查修订版");
		await form.getByRole("button", { name: "保存 Agent", exact: true }).click();
		await expect(settings.getByRole("button", { name: "项目 api-reviewer", exact: true })).toContainText(
			"API 审查修订版"
		);
		await form.getByRole("button", { name: "复制 Agent", exact: true }).click();
		await expect(form.getByRole("textbox", { name: "Agent 名称", exact: true })).toHaveValue("api-reviewer-copy");
		await form.getByRole("button", { name: "保存 Agent", exact: true }).click();
		await expect(settings.getByRole("button", { name: "用户 api-reviewer-copy", exact: true })).toBeVisible();
		page.once("dialog", (dialog) => dialog.accept());
		await form.getByRole("button", { name: "删除 Agent", exact: true }).click();
		await expect(settings.getByRole("button", { name: "用户 api-reviewer-copy", exact: true })).toHaveCount(0);
		await settings.getByRole("button", { name: "内置 reviewer", exact: true }).click();
		await expect(form.getByLabel("系统提示词", { exact: true })).toBeDisabled();
		await form.getByLabel("思考强度", { exact: true }).selectOption("low");
		await form.getByRole("button", { name: "保存覆盖", exact: true }).click();
		await expect(settings.getByRole("button", { name: "用户 reviewer", exact: true })).toBeVisible();
		await expect(settings.getByRole("button", { name: "内置 reviewer", exact: true })).toContainText("被覆盖：用户");
	});
}

test("existing team members keep template settings after the template is deleted and gateway restarts", async ({
	page,
}) => {
	const url = await startWebApp({}, async (workspace) => {
		await seedAgentTeam(join(workspace, "..", "data"), {
			name: "api-reviewer",
			description: "Frozen configuration",
			systemPrompt: "Read API contracts",
			model: { provider: "demo", id: "wuming-demo" },
			thinkingLevel: "off",
			tools: { mode: "custom", names: ["read_file", "grep"] },
			color: "cyan",
		});
	});
	await openApp(page, url);
	const settings = await openAgents(page);
	await settings.getByRole("button", { name: "项目 api-reviewer", exact: true }).click();
	page.once("dialog", (dialog) => dialog.accept());
	await settings.getByRole("button", { name: "删除 Agent", exact: true }).click();
	await expect(settings.getByRole("button", { name: "项目 api-reviewer", exact: true })).toHaveCount(0);
	await restartGateway();
	await page.reload();
	await page.getByRole("tab", { name: "Agent Teams", exact: true }).click();
	await page.getByRole("button", { name: "查看成员 后端工程师", exact: true }).click();
	const inspector = page.getByRole("region", { name: "成员详情", exact: true });
	await expect(inspector).toContainText("api-reviewer");
	await expect(inspector).toContainText("demo/wuming-demo");
	await expect(inspector).toContainText("read_file, grep");
});

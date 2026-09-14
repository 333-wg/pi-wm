import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({}, async (workspace) => {
		const source = join(workspace, ".wuming", "skills", "manual-review");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "SKILL.md"),
			"---\nname: 项目审查\ndescription: 检查项目约定与变更质量\ndisable-model-invocation: true\n---\nReview the requested code only."
		);
	});
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const width of [1365, 390]) {
	test(`selects skills from the composer without sending at ${width}px`, async ({ page }, testInfo) => {
		const turns: Array<{ skills?: string[] }> = [];
		page.on("websocket", (socket) =>
			socket.on("framesent", ({ payload }) => {
				const message = JSON.parse(String(payload));
				if (message.command?.type === "turn.prompt") turns.push(message.command);
			})
		);
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		const input = page.getByRole("textbox", { name: "消息", exact: true });
		await input.fill("/");
		const menu = page.getByRole("listbox", { name: "快捷命令" });
		await expect(menu.getByRole("option", { name: /debug/ })).toBeAttached();
		await expect(menu.locator(".suggest-group").filter({ hasText: /^技能$/ })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("slash-skills.png") });
		await input.fill("/排查");
		await expect(menu.getByRole("option", { name: /debug/ })).toBeVisible();
		await input.press("Escape");
		await expect(menu).toBeHidden();
		await expect(input).toHaveValue("/排查");
		await input.fill("请检查本次修改 $项目");
		const skills = page.getByRole("listbox", { name: "选择技能" });
		await expect(skills.getByRole("option", { name: /项目审查/ })).toContainText("工作区 · 手动");
		await page.screenshot({ path: testInfo.outputPath("skill-search.png") });
		await input.press("Tab");
		await expect(page.locator(".composer-selected-skill")).toContainText("项目审查");
		await expect(input).toHaveValue("请检查本次修改 ");
		expect(turns).toHaveLength(0);
		await expect(input).toBeFocused();
		await input.press("Enter");
		await expect.poll(() => turns.length).toBe(1);
		expect(turns[0]?.skills).toEqual(["manual-review"]);
		await page.getByRole("button", { name: "取消技能", exact: true }).click();
		await expect(page.locator(".composer-selected-skill")).toBeHidden();
	});
}

test("reports empty searches and scrolls the keyboard selection into view", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "新对话", exact: true }).click();
	await expect(page.getByRole("button", { name: "权限模式：帮我批准" })).toBeEnabled();
	const input = page.getByRole("textbox", { name: "消息", exact: true });
	await input.fill("$no-such-skill-xyz");
	await expect(page.getByRole("listbox")).toContainText("没有匹配的技能");
	await input.fill("$");
	await expect(page.getByRole("listbox", { name: "选择技能" }).getByRole("option")).not.toHaveCount(0);
	await input.press("ArrowUp");
	const selected = page.getByRole("listbox", { name: "选择技能" }).getByRole("option", { selected: true });
	await expect(selected).toBeInViewport();
	await input.press("Escape");
	await expect(input).toHaveValue("$");
});

test("removes disabled skills from the composer and keeps management available", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("tab", { name: "技能", exact: true }).click();
	await page.getByRole("button", { name: "管理技能", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "管理技能", exact: true });
	const row = dialog.locator('[data-skill-id="debug"]');
	await row.getByRole("checkbox").uncheck();
	await expect(row).toContainText("已禁用");
	await dialog.getByRole("button", { name: "关闭技能管理", exact: true }).click();
	await page.getByRole("tab", { name: "对话", exact: true }).click();
	const input = page.getByRole("textbox", { name: "消息", exact: true });
	await input.fill("$debug");
	await expect(page.getByRole("listbox", { name: "选择技能" })).toContainText("没有匹配的技能");
	await input.fill("/skills");
	await input.press("Enter");
	await expect(page.getByRole("region", { name: "技能", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "管理技能", exact: true }).click();
	await row.getByRole("checkbox").check();
	await expect(row).toContainText("已启用");
});

test("finds and selects a skill through the global keyboard palette", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "新对话", exact: true }).click();
	await expect(page.getByRole("button", { name: "权限模式：帮我批准" })).toBeEnabled();
	await page.keyboard.press("Control+k");
	const dialog = page.getByRole("dialog", { name: "命令面板" });
	await dialog.getByRole("combobox").fill("项目审查");
	await expect(dialog.getByRole("option", { name: /项目审查/ })).toBeVisible();
	await dialog.getByRole("combobox").press("Enter");
	await expect(dialog).toBeHidden();
	await expect(page.locator(".composer-selected-skill")).toContainText("项目审查");
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
});

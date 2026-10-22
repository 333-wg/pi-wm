import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openApp, restartGateway, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
let workspacePath: string;
test.beforeAll(async () => {
	webUrl = await startWebApp(
		{ WUMING_DEPLOYMENT_MODE: "local_device", WUMING_PROCESS_MODE: "disabled" },
		async (workspace) => {
			workspacePath = workspace;
			await mkdir(join(workspace, "packages", "demo"), { recursive: true });
			await writeFile(
				join(workspace, "packages", "demo", "SKILL.md"),
				"---\nname: My Demo\ndescription: Inspect demo fixtures\n---\nCheck the actual fixture before reporting completion."
			);
			await mkdir(join(workspace, "packages", "manual", "agents"), { recursive: true });
			await writeFile(
				join(workspace, "packages", "manual", "SKILL.md"),
				"---\nname: Manual Demo\ndescription: A manually selected workflow\n---\nInspect the user-selected fixture."
			);
			await writeFile(
				join(workspace, "packages", "manual", "agents", "openai.yaml"),
				"policy:\n  allow_implicit_invocation: false\n"
			);
		}
	);
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const width of [1365, 390]) {
	test(`install, disable, preview, enable and uninstall at ${width}px`, async ({ page }, testInfo) => {
		const failures: string[] = [];
		page.on("pageerror", (error) => failures.push(error.message));
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		await page.getByRole("tab", { name: "技能", exact: true }).click();
		const workbench = page.getByRole("region", { name: "技能", exact: true });
		await expect(workbench.locator(".skill-entry").filter({ hasText: "run-app" })).toBeVisible();
		await workbench.getByRole("button", { name: "管理技能", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "管理技能", exact: true });
		const builtin = dialog.locator('[data-skill-id="run-app"]');
		await expect(builtin).toContainText("系统内置");
		await expect(builtin.getByRole("button", { name: "卸载 run-app", exact: true })).toHaveCount(0);
		await builtin.getByRole("checkbox").uncheck();
		await expect(builtin).toContainText("已禁用");
		await builtin.getByRole("checkbox").check();
		await expect(builtin).toContainText("已启用");
		const id = `demo-${width}`;
		await dialog.getByLabel("工作区内的技能目录", { exact: true }).fill("packages/demo");
		await dialog.getByLabel("技能 ID（可选）", { exact: true }).fill(id);
		await dialog.getByRole("button", { name: "安装", exact: true }).click();
		const row = dialog.locator(`[data-skill-id="${id}"]`);
		await expect(row).toContainText("用户安装");
		await expect(row).toContainText("1.0.0");
		await dialog.getByRole("button", { name: "关闭技能管理", exact: true }).click();
		await workbench.locator(".skill-entry").filter({ hasText: "My Demo" }).click();
		await expect(workbench.locator(".editor-heading strong")).toHaveText("My Demo");
		await workbench.getByRole("button", { name: "管理技能", exact: true }).click();
		await row.getByRole("checkbox").uncheck();
		await expect(row).toContainText("已禁用");
		await expect(workbench.locator(".skill-entry").filter({ hasText: "My Demo" })).toHaveCount(0);
		await row.getByRole("button", { name: `查看 ${id}`, exact: true }).click();
		await expect(dialog.getByRole("region", { name: "技能预览" })).toContainText("actual fixture");
		await expect(dialog.getByRole("button", { name: "关闭技能管理", exact: true })).toBeEnabled();
		const overflow = await dialog.evaluate((element) => element.scrollWidth > element.clientWidth);
		expect(overflow).toBe(false);
		await page.screenshot({
			path: testInfo.outputPath(`skill-manager-${width}.png`),
			fullPage: true,
		});
		await row.getByRole("checkbox").check();
		await expect(row).toContainText("已启用");
		await row.getByRole("button", { name: `卸载 ${id}`, exact: true }).click();
		await row.getByRole("button", { name: "确认卸载", exact: true }).click();
		await expect(row).toHaveCount(0);
		await dialog.getByRole("button", { name: "关闭技能管理", exact: true }).click();
		await expect(workbench.getByText("选择一个技能", { exact: true })).toBeVisible();
		expect(failures).toEqual([]);
	});
}

test("shows imported manual-only policy without blocking explicit selection", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("tab", { name: "技能", exact: true }).click();
	const workbench = page.getByRole("region", { name: "技能", exact: true });
	await workbench.getByRole("button", { name: "管理技能", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "管理技能", exact: true });
	await dialog.getByLabel("工作区内的技能目录", { exact: true }).fill("packages/manual");
	await dialog.getByRole("button", { name: "安装", exact: true }).click();
	const row = dialog.locator('[data-skill-id="manual"]');
	await expect(row).toContainText("手动调用");
	await expect(row.getByRole("checkbox")).toBeChecked();
	await dialog.getByRole("button", { name: "关闭技能管理", exact: true }).click();
	await workbench.locator(".skill-entry").filter({ hasText: "Manual Demo" }).click();
	await expect(workbench.locator(".editor-heading strong")).toHaveText("Manual Demo");
	await expect(workbench).toContainText("Inspect the user-selected fixture");
	await workbench.getByRole("button", { name: "管理技能", exact: true }).click();
	await row.getByRole("button", { name: "卸载 manual", exact: true }).click();
	await row.getByRole("button", { name: "确认卸载", exact: true }).click();
	await expect(row).toHaveCount(0);
});

test("installs a global skill, persists across restart and preserves project overrides", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, webUrl);
	await page.getByRole("tab", { name: "技能", exact: true }).click();
	await page.getByRole("button", { name: "管理技能", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "管理技能", exact: true });
	const row = dialog.locator('[data-skill-id="shared-demo"]');
	await dialog.getByLabel("工作区内的技能目录", { exact: true }).fill("packages/demo");
	await dialog.getByLabel("技能 ID（可选）", { exact: true }).fill("shared-demo");
	await expect(dialog.getByLabel("安装范围", { exact: true })).toHaveValue("global");
	await expect(dialog).toContainText("安装到 ~/.wuming/skills");
	await dialog.getByRole("button", { name: "安装", exact: true }).click();
	await expect(row).toContainText("用户全局");
	const globalFile = join(dirname(workspacePath), "skill-home", ".wuming", "skills", "shared-demo", "SKILL.md");
	expect(await readFile(globalFile, "utf8")).toContain("actual fixture");
	await row.getByRole("checkbox").uncheck();
	await expect(row).toContainText("已禁用");
	await expect(row.getByRole("checkbox")).toBeEnabled();
	await expect
		.poll(
			async () =>
				JSON.parse(await readFile(join(dirname(workspacePath), "skill-home", ".wuming", "skills.json"), "utf8")).skills[
					"shared-demo"
				].enabled
		)
		.toBe(false);
	await restartGateway();
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.getByRole("tab", { name: "技能", exact: true }).click();
	await page.getByRole("button", { name: "管理技能", exact: true }).click();
	await expect(row).toContainText("用户全局");
	await expect(row.getByRole("checkbox")).not.toBeChecked();
	await row.getByRole("button", { name: "查看 shared-demo", exact: true }).click();
	await expect(dialog.getByRole("region", { name: "技能预览" })).toContainText("actual fixture");
	await row.getByRole("checkbox").check();
	await expect(row).toContainText("已启用");
	await page.screenshot({ path: testInfo.outputPath("global-skills-desktop.png"), fullPage: true });
	await dialog.getByLabel("工作区内的技能目录", { exact: true }).fill("packages/demo");
	await dialog.getByLabel("技能 ID（可选）", { exact: true }).fill("shared-demo");
	await dialog.getByLabel("安装范围", { exact: true }).selectOption("workspace");
	await dialog.getByRole("button", { name: "安装", exact: true }).click();
	await expect(row).toContainText("当前项目");
	await row.getByRole("button", { name: "卸载 shared-demo", exact: true }).click();
	await row.getByRole("button", { name: "确认卸载", exact: true }).click();
	await expect(row).toContainText("用户全局");
	await row.getByRole("button", { name: "卸载 shared-demo", exact: true }).click();
	await expect(row).toContainText("将从所有项目移除");
	await row.getByRole("button", { name: "确认卸载", exact: true }).click();
	await expect(row).toHaveCount(0);
	await expect(readFile(globalFile)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects out-of-workspace installation without publishing a skill", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("tab", { name: "技能", exact: true }).click();
	await page.getByRole("button", { name: "管理技能", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "管理技能", exact: true });
	await dialog.getByLabel("工作区内的技能目录", { exact: true }).fill("../outside");
	await dialog.getByLabel("技能 ID（可选）", { exact: true }).fill("outside");
	await dialog.getByRole("button", { name: "安装", exact: true }).click();
	await expect(dialog.getByRole("alert")).toContainText("authorized workspace");
	await expect(dialog.locator('[data-skill-id="outside"]')).toHaveCount(0);
});

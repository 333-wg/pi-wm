import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";
const exec = promisify(execFile);
let url: string;
let root: string;
test.beforeAll(async () => {
	url = await startWebApp(
		{ WUMING_DEPLOYMENT_MODE: "local_device", WUMING_BROWSER_ENABLED: "false" },
		async (workspace) => {
			root = workspace;
			for (const args of [
				["init", "--initial-branch=main"],
				["config", "user.name", "UI Test"],
				["config", "user.email", "ui@example.invalid"],
				["config", "commit.gpgsign", "false"],
				["add", "."],
				["commit", "-m", "Initial"],
				["branch", "feature/existing"],
			])
				await exec("git", args, { cwd: root });
		}
	);
});
test.afterAll(stopWebApp);

test("searches, switches, creates without sending a draft, and preserves dirty work", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, url);
	await page.getByRole("button", { name: "切换分支：main", exact: true }).click();
	const menu = page.getByRole("dialog", { name: "分支", exact: true });
	await expect(menu.getByRole("button", { name: "切换到 main", exact: true })).toHaveAttribute("aria-current", "true");
	await page.screenshot({ path: "test-results/branch-picker-desktop.png" });
	await menu.getByRole("textbox", { name: "搜索分支" }).fill("absent");
	await expect(menu).toContainText("没有匹配的分支");
	await menu.getByRole("textbox", { name: "搜索分支" }).fill("existing");
	await menu.getByRole("button", { name: "切换到 feature/existing", exact: true }).click();
	await expect(menu).not.toBeVisible();
	await expect(page.getByRole("button", { name: "切换分支：feature/existing", exact: true })).toBeEnabled();
	expect((await exec("git", ["branch", "--show-current"], { cwd: root })).stdout.trim()).toBe("feature/existing");
	const draft = page.getByRole("textbox", { name: "消息", exact: true });
	await draft.fill("This draft must not be sent by branch creation");
	await page.getByRole("button", { name: "切换分支：feature/existing", exact: true }).click();
	await menu.getByRole("button", { name: "创建并切换新分支…", exact: true }).click();
	await menu.getByRole("textbox", { name: "分支名称", exact: true }).fill("feature/created");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: "test-results/branch-picker-mobile-create.png" });
	await menu.getByRole("button", { name: "创建并切换", exact: true }).click();
	await expect(menu).not.toBeVisible();
	await expect(page.getByRole("button", { name: "切换分支：feature/created", exact: true })).toBeEnabled();
	await expect(draft).toHaveValue("This draft must not be sent by branch creation");
	expect((await exec("git", ["branch", "--show-current"], { cwd: root })).stdout.trim()).toBe("feature/created");
	await writeFile(join(root, "readme.md"), "unsaved change");
	await page.getByRole("button", { name: "切换分支：feature/created", exact: true }).click();
	await menu.getByRole("button", { name: "切换到 main", exact: true }).click();
	await expect(menu.getByRole("alert")).toContainText("未提交更改");
	await page.screenshot({ path: "test-results/branch-picker-mobile-error.png" });
	expect((await exec("git", ["branch", "--show-current"], { cwd: root })).stdout.trim()).toBe("feature/created");
	await menu.press("Escape");
	await expect(menu).not.toBeVisible();
	await expect(page.getByRole("button", { name: "切换分支：feature/created", exact: true })).toBeFocused();
	expect(errors).toEqual([]);
});

test("keeps the draft project and branch on one row across viewport sizes", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, url);
	const projectName = "Layout project with a deliberately long name for narrow screens";
	const project = await page.evaluate(async ({ authorization, name }) => {
		const headers = { Authorization: `Bearer ${authorization}` };
		const response = await fetch("/api/projects", {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		const { project } = await response.json();
		await fetch(`/api/projects/${project.id}/files`, {
			method: "PUT",
			headers: { ...headers, "Content-Type": "text/plain", "X-Wuming-Project-Path": "readme.md" },
			body: "# Layout fixture\n",
		});
		const completed = await fetch(`/api/projects/${project.id}/complete`, { method: "POST", headers });
		return (await completed.json()).project as { id: string };
	}, { authorization: token, name: projectName });
	const branch = "feature/a-deliberately-long-branch-name-for-layout";
	await page.route(`**/api/workspaces/${project.id}/git/details`, (route) => route.fulfill({
		json: { writable: true, isRepository: true, hasCommits: true, branch, branches: [branch], ahead: 0, behind: 0, conflicts: 0, remotes: [] },
	}));
	await page.route(`**/api/workspaces/${project.id}/git/status`, (route) => route.fulfill({
		json: { isRepository: true, branch, entries: [], truncated: false },
	}));
	await page.reload();
	await page.locator(".project-row").filter({ hasText: projectName }).click();
	await page.locator(".sidebar-new-chat").click();
	const context = page.locator(".composer-project-context");
	const trigger = context.getByRole("button", { name: `切换分支：${branch}`, exact: true });
	await expect(trigger).toBeEnabled();
	await expect(page.locator(".composer-branch-context")).toHaveCount(0);
	await expect(page.locator(".branch-picker-trigger")).toHaveCount(1);
	const draft = page.getByRole("textbox", { name: "消息", exact: true });
	await draft.fill("Keep this unsent draft");
	for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
		await page.setViewportSize(viewport);
		const nameBox = await context.locator(":scope > span").boundingBox();
		const branchBox = await trigger.boundingBox();
		const contextBox = await context.boundingBox();
		expect(nameBox).not.toBeNull();
		expect(branchBox).not.toBeNull();
		expect(contextBox).not.toBeNull();
		expect(branchBox!.x).toBeGreaterThanOrEqual(nameBox!.x + nameBox!.width);
		expect(Math.abs(branchBox!.y + branchBox!.height / 2 - nameBox!.y - nameBox!.height / 2)).toBeLessThan(2);
		expect(branchBox!.x + branchBox!.width).toBeLessThanOrEqual(contextBox!.x + contextBox!.width);
		await page.screenshot({ path: `test-results/branch-context-${viewport.width}.png` });
		await trigger.click();
		const menu = page.getByRole("dialog", { name: "分支", exact: true });
		await expect(menu.getByRole("button", { name: `切换到 ${branch}`, exact: true })).toBeVisible();
		await page.screenshot({ path: `test-results/branch-context-menu-${viewport.width}.png` });
		await menu.press("Escape");
		await expect(trigger).toBeFocused();
		await expect(draft).toHaveValue("Keep this unsent draft");
	}
	await context.getByRole("button", { name: "不在项目中工作", exact: true }).click();
	await expect(context).toHaveCount(0);
	await expect(page.locator(".composer-branch-context .branch-picker-trigger")).toBeVisible();
	await expect(draft).toHaveValue("Keep this unsent draft");
});

test("reports read-only restrictions and hides branches outside a repository", async ({ page }) => {
	await page.route("**/git/details", (route) =>
		route.fulfill({
			json: {
				writable: false,
				isRepository: true,
				hasCommits: true,
				branch: "main",
				branches: ["main", "other"],
				ahead: 0,
				behind: 0,
				conflicts: 0,
				remotes: [],
				blockedReason: "当前账号没有工作区写入权限。",
			},
		})
	);
	await openApp(page, url);
	await page.getByRole("button", { name: "切换分支：main", exact: true }).click();
	const menu = page.getByRole("dialog", { name: "分支", exact: true });
	await expect(menu).toContainText("没有工作区写入权限");
	await expect(menu.getByRole("button", { name: "切换到 other", exact: true })).toBeDisabled();
	await expect(menu.getByRole("button", { name: "创建并切换新分支…", exact: true })).toBeDisabled();
	await menu.press("Escape");
	await page.route("**/git/details", (route) =>
		route.fulfill({
			json: { writable: true, isRepository: false, hasCommits: false, ahead: 0, behind: 0, conflicts: 0, remotes: [] },
		})
	);
	await page.route("**/git/status", (route) =>
		route.fulfill({ json: { isRepository: false, entries: [], truncated: false } })
	);
	await page.reload();
	await expect(page.locator(".branch-picker-trigger")).toHaveCount(0);
});

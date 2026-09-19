import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

const exec = promisify(execFile);
let url: string;
test.beforeAll(async () => {
	url = await startWebApp({ WUMING_DEPLOYMENT_MODE: "local_device", WUMING_BROWSER_ENABLED: "false" }, async (root) => {
		await exec("git", ["init", "--initial-branch=main"], { cwd: root });
		await exec("git", ["config", "user.name", "UI Test"], { cwd: root });
		await exec("git", ["config", "user.email", "ui@example.invalid"], { cwd: root });
		await exec("git", ["config", "commit.gpgsign", "false"], { cwd: root });
	});
});
test.afterAll(stopWebApp);

test("requires explicit confirmation before trusting the displayed repository", async ({ page }) => {
	const path = "D:\\Projects\\existing-project";
	let trusted = false;
	let trustActions = 0;
	await page.route("**/git/status", (route) =>
		route.fulfill(
			trusted
				? { json: { isRepository: true, branch: "main", entries: [], truncated: false } }
				: { status: 409, json: { error: "Git 拒绝访问此仓库：目录所有者与当前系统账号不同。" } }
		)
	);
	await page.route("**/git/details", (route) =>
		route.fulfill({
			json: {
				writable: trusted,
				isRepository: true,
				workspaceRoot: path,
				hasCommits: true,
				branch: "main",
				ahead: 0,
				behind: 0,
				conflicts: 0,
				...(trusted ? {} : { trustRequired: { path } }),
				remotes: trusted
					? [
							{
								name: "origin",
								url: "https://gitlab.com/team/project.git",
								pushUrl: "https://gitlab.com/team/project.git",
							},
						]
					: [],
			},
		})
	);
	await page.route("**/git/action", async (route) => {
		expect(route.request().postDataJSON()).toEqual({ type: "trust", path });
		trustActions++;
		trusted = true;
		await route.fulfill({ json: { message: "已信任此仓库。" } });
	});
	await openApp(page, url);
	await page.getByRole("tab", { name: "更改", exact: true }).click();
	const panel = page.getByRole("region", { name: "Git 更改" });
	await panel.getByRole("button", { name: "信任此仓库", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "信任此仓库" });
	await expect(dialog.getByText(path, { exact: true })).toBeVisible();
	await expect(dialog).toContainText("Git hooks");
	expect(trustActions).toBe(0);
	await dialog.getByRole("button", { name: "取消", exact: true }).click();
	expect(trustActions).toBe(0);
	await panel.getByRole("button", { name: "信任此仓库", exact: true }).click();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: "test-results/git-trust-mobile.png" });
	await dialog.getByRole("button", { name: "确认信任此目录", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await expect(panel.getByRole("alert")).toHaveCount(0);
	await expect(panel.getByRole("combobox", { name: "远程仓库" })).toHaveValue("origin");
	await expect(panel.locator('[aria-label="当前远程地址"]')).toContainText("https://gitlab.com/team/project.git");
	expect(trustActions).toBe(1);
});

test("shows repository access errors and refreshes status plus remotes after recovery", async ({ page }) => {
	let blocked = true;
	const error = [
		"Git 拒绝访问此仓库：目录所有者与当前系统账号不同。确认信任后再配置 safe.directory。",
		"fatal: detected dubious ownership in repository at 'D:/example-project'",
		"To add an exception for this directory, call:",
		"git config --global --add safe.directory D:/example-project",
	].join("\n");
	await page.route("**/git/status", (route) =>
		route.fulfill(
			blocked
				? { status: 409, json: { error } }
				: { json: { isRepository: true, branch: "main", entries: [], truncated: false } }
		)
	);
	await page.route("**/git/details", (route) =>
		route.fulfill(
			blocked
				? { status: 409, json: { error } }
				: {
						json: {
							writable: true,
							isRepository: true,
							hasCommits: true,
							branch: "main",
							upstream: "origin/main",
							upstreamRemote: "origin",
							upstreamBranch: "main",
							ahead: 0,
							behind: 0,
							conflicts: 0,
							remotes: [
								{
									name: "origin",
									url: "https://github.com/example/example.git",
									pushUrl: "https://github.com/example/example.git",
								},
							],
						},
					}
		)
	);
	await page.setViewportSize({ width: 1440, height: 960 });
	await openApp(page, url);
	await page.getByRole("tab", { name: "更改", exact: true }).click();
	const panel = page.getByRole("region", { name: "Git 更改" });
	await expect(panel.getByRole("alert").first()).toContainText("目录所有者");
	await expect(panel.getByRole("alert")).toHaveCount(1);
	await expect(panel.getByText("当前工作区不是 Git 仓库")).toHaveCount(0);
	await expect(panel.getByText("工作区干净", { exact: true })).toHaveCount(0);
	await expect(panel.getByRole("button", { name: "初始化仓库" })).toHaveCount(0);
	await expect(panel.getByRole("button", { name: "推送", exact: true })).toBeDisabled();
	await page.screenshot({ path: "test-results/git-access-error-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: "test-results/git-access-error-mobile.png" });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.setViewportSize({ width: 1440, height: 960 });
	blocked = false;
	await panel.getByRole("button", { name: "刷新更改" }).click();
	await expect(panel.getByRole("alert")).toHaveCount(0);
	await expect(panel.getByRole("combobox", { name: "远程仓库" })).toHaveValue("origin");
	await expect(panel.getByRole("button", { name: "推送", exact: true })).toBeEnabled();
	blocked = true;
	await panel.getByRole("button", { name: "刷新更改" }).click();
	await expect(panel.getByRole("alert").first()).toContainText("目录所有者");
	await expect(panel.getByRole("button", { name: "推送", exact: true })).toBeDisabled();
	await expect(panel.getByText("工作区干净", { exact: true })).toHaveCount(0);
});

test("stages, commits, manages remotes and confirms a push without publishing test data", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 960 });
	await openApp(page, url);
	await page.getByRole("tab", { name: "更改", exact: true }).click();
	const panel = page.getByRole("region", { name: "Git 更改" });
	await expect(panel.getByRole("button", { name: "暂存全部更改", exact: true })).toBeEnabled();
	await panel.getByRole("button", { name: "暂存全部更改", exact: true }).click();
	await expect(panel.getByRole("button", { name: "已暂存 1", exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "已暂存 1", exact: true }).click();
	await panel.getByRole("button", { name: "取消暂存当前文件", exact: true }).click();
	await expect(panel.getByRole("button", { name: "未暂存 1", exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "未暂存 1", exact: true }).click();
	await panel.getByRole("button", { name: "暂存全部更改", exact: true }).click();
	await panel.getByRole("button", { name: "提交更改", exact: true }).click();
	const commit = page.getByRole("dialog", { name: "提交更改" });
	await commit.getByRole("textbox", { name: "提交说明" }).fill("Initial UI commit");
	await page.screenshot({ path: "test-results/git-commit-desktop.png" });
	await commit.getByRole("button", { name: "提交到本地", exact: true }).click();
	await expect(commit).not.toBeVisible();
	await expect(panel.getByText("已提交到本地仓库。", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "管理远程仓库", exact: true }).click();
	const remotes = page.getByRole("dialog", { name: "远程仓库", exact: true });
	await remotes.getByRole("textbox", { name: "仓库地址", exact: true }).fill("https://github.com/example/example.git");
	await remotes.getByRole("button", { name: "保存远程配置", exact: true }).click();
	await expect(remotes.locator(".git-remote-row")).toHaveCount(1);
	await remotes.getByRole("textbox", { name: "远程名称", exact: true }).fill("gitee");
	await remotes.getByRole("textbox", { name: "仓库地址", exact: true }).fill("git@gitee.com:example/example.git");
	await remotes.getByRole("button", { name: "保存远程配置", exact: true }).click();
	await expect(remotes.locator(".git-remote-row")).toHaveCount(2);
	await page.screenshot({ path: "test-results/git-remotes-desktop.png" });
	await remotes.getByRole("button", { name: "关闭", exact: true }).click();
	await panel.getByRole("combobox", { name: "远程仓库", exact: true }).selectOption("origin");
	let pushes = 0;
	await page.route("**/git/action", (route) => {
		const action = route.request().postDataJSON() as { type: string; remote?: string; branch?: string };
		if (action.type !== "push") return route.continue();
		pushes += 1;
		expect(action).toEqual({ type: "push", remote: "origin", branch: "main" });
		return route.fulfill({ status: 409, json: { error: "远程认证失败：请配置 SSH 密钥或 Git 凭据。" } });
	});
	await panel.getByRole("button", { name: "推送", exact: true }).click();
	const push = page.getByRole("dialog", { name: "推送提交" });
	await expect(push.getByText("https://github.com/example/example.git", { exact: true })).toBeVisible();
	expect(pushes).toBe(0);
	await push.getByRole("button", { name: "确认推送", exact: true }).click();
	await expect(push.getByRole("alert")).toContainText("远程认证失败");
	expect(pushes).toBe(1);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: "test-results/git-push-mobile.png" });
	await expect(push.getByRole("button", { name: "确认推送", exact: true })).toBeInViewport();
	await push.getByRole("button", { name: "取消", exact: true }).click();
	await page.screenshot({ path: "test-results/git-workflow-mobile.png" });
	await expect(panel.getByRole("button", { name: "推送", exact: true })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	expect(errors).toEqual([]);
});

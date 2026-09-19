import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd, windowsHide: true });
let url: string;
let created: string;
let cloned: string;
let remote: string;
async function initialize(root: string) {
	await git(root, "init", "--initial-branch=main");
	await git(root, "config", "user.name", "Discovery Test");
	await git(root, "config", "user.email", "discovery@example.invalid");
	await git(root, "config", "commit.gpgsign", "false");
	await git(root, "add", ".");
	await git(root, "commit", "-m", "Initial external commit");
}

test.beforeAll(async () => {
	const environment: Record<string, string> = {
		WUMING_DEPLOYMENT_MODE: "local_device",
		WUMING_BROWSER_ENABLED: "false",
	};
	url = await startWebApp(environment, async (root) => {
		created = root;
		const parent = dirname(root);
		remote = join(parent, "created-remote.git");
		const seed = join(parent, "seed");
		const cloneRemote = join(parent, "clone-remote.git");
		cloned = join(parent, "cloned");
		await mkdir(seed);
		await writeFile(join(seed, "note.txt"), "Cloned project\n");
		await initialize(seed);
		await git(parent, "init", "--bare", "--initial-branch=main", cloneRemote);
		await git(seed, "remote", "add", "origin", cloneRemote);
		await git(seed, "push", "-u", "origin", "main");
		await git(parent, "clone", cloneRemote, cloned);
		environment.WUMING_WORKSPACES_JSON = JSON.stringify([
			{ id: "created", name: "External project", path: created },
			{ id: "cloned", name: "Cloned project", path: cloned },
		]);
	});
});
test.afterAll(stopWebApp);

test("automatically follows external init, push, edits and remote changes without network actions", async ({
	page,
}) => {
	let actions = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/git/action")) actions++;
	});
	await openApp(page, url);
	await page.locator(".project-row").filter({ hasText: "External project" }).click();
	await page.getByRole("tab", { name: "更改", exact: true }).click();
	const panel = page.getByRole("region", { name: "Git 更改" });
	await expect(panel.getByRole("button", { name: "初始化仓库" })).toBeVisible();
	await initialize(created);
	await git(dirname(created), "init", "--bare", "--initial-branch=main", remote);
	await git(created, "remote", "add", "origin", remote);
	await git(created, "push", "-u", "origin", "main");
	await expect(panel.getByRole("button", { name: "初始化仓库" })).toHaveCount(0);
	await expect(panel.getByRole("combobox", { name: "远程仓库" })).toHaveValue("origin");
	await expect(panel.locator(".git-tracking")).toHaveAttribute("title", "origin/main（基于最近获取）");
	await expect(panel.getByRole("button", { name: "推送", exact: true })).toBeEnabled();
	await writeFile(join(created, "readme.md"), "First external edit\n");
	await expect(panel.getByText("First external edit", { exact: true })).toBeVisible();
	await writeFile(join(created, "readme.md"), "Second external edit\n");
	await expect(panel.getByText("Second external edit", { exact: true })).toBeVisible();
	await git(created, "add", "readme.md");
	await expect(panel.getByRole("button", { name: "已暂存 1", exact: true })).toBeVisible();
	await git(created, "remote", "set-url", "origin", "ssh://git@git.company.example:2222/team/subgroup/project.git");
	await expect(panel.locator('[aria-label="当前远程地址"]')).toContainText(
		"git.company.example:2222/team/subgroup/project.git"
	);
	await page.screenshot({ path: "test-results/git-discovery-desktop.png" });
	expect(actions).toBe(0);
});

test("opens a cloned repository with its existing origin and upstream", async ({ page }) => {
	await openApp(page, url);
	await page.locator(".project-row").filter({ hasText: "Cloned project" }).click();
	await page.getByRole("tab", { name: "更改", exact: true }).click();
	const panel = page.getByRole("region", { name: "Git 更改" });
	await expect(panel.getByRole("combobox", { name: "远程仓库" })).toHaveValue("origin");
	await expect(panel.locator(".git-tracking")).toHaveAttribute("title", "origin/main（基于最近获取）");
	await expect(panel.locator('[aria-label="仓库位置"]')).toContainText("cloned");
	await expect(panel.getByText("工作区干净", { exact: true })).toBeVisible();
	await writeFile(join(cloned, "note.txt"), "Edited cloned project\n");
	await expect(panel.getByText("Edited cloned project", { exact: true })).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: "test-results/git-discovery-mobile.png" });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

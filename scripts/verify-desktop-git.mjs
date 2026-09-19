import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "wuming desktop git-"));
const profile = join(temporary, "profile");
const workspace = join(profile, "workspace");
const remote = join(temporary, "remote.git");
const clone = join(temporary, "cloned project");
const globalConfig = join(temporary, "gitconfig");
await mkdir(workspace, { recursive: true });
await writeFile(globalConfig, "");
await writeFile(join(workspace, "note.txt"), "Desktop initial content\n");
const exec = promisify(execFile);
const git = (cwd, ...args) => exec("git", args, { cwd, windowsHide: true });
const env = {
	...process.env,
	WUMING_DESKTOP_NODE: process.execPath,
	WUMING_DESKTOP_TEST_RUNTIME: "demo",
	GIT_CONFIG_GLOBAL: globalConfig,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_COUNT: "0",
	GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
	desktop = await electron.launch({
		executablePath: createRequire(import.meta.url)("electron"),
		args: [join(root, "apps", "desktop"), `--user-data-dir=${profile}`],
		env,
		cwd: root,
		timeout: 60_000,
	});
	const page = await desktop.firstWindow({ timeout: 60_000 });
	await desktop.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) {
			window.webContents.setBackgroundThrottling(false);
			window.hide();
			window.on("show", () => window.hide());
		}
	});
	page.setDefaultTimeout(15_000);
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.getByLabel("访问密码", { exact: true }).fill("wuming");
	await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.evaluate(() => localStorage.setItem("wuming.onboarding.complete", "true"));
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.getByRole("tab", { name: "更改", exact: true }).click();
	const panel = page.getByRole("region", { name: "Git 更改" });
	await expect(panel.getByRole("button", { name: "初始化仓库" })).toBeVisible();
	await git(workspace, "init", "--initial-branch=main");
	await git(workspace, "config", "user.name", "Desktop Git Test");
	await git(workspace, "config", "user.email", "desktop-git@example.invalid");
	await git(workspace, "config", "commit.gpgsign", "false");
	await git(workspace, "add", "note.txt");
	await git(workspace, "commit", "-m", "External desktop commit");
	await git(temporary, "init", "--bare", "--initial-branch=main", remote);
	await git(workspace, "remote", "add", "origin", remote);
	await git(workspace, "push", "-u", "origin", "main");
	await panel.getByRole("button", { name: "信任此仓库", exact: true }).click();
	assert.equal(await readFile(globalConfig, "utf8"), "");
	const trust = page.getByRole("dialog", { name: "信任此仓库" });
	await expect(trust).toContainText(await realpath(workspace));
	await trust.getByRole("button", { name: "确认信任此目录", exact: true }).click();
	await expect(trust).not.toBeVisible();
	await expect(panel.getByRole("combobox", { name: "远程仓库" })).toHaveValue("origin");
	await expect(panel.locator(".git-tracking")).toHaveAttribute("title", "origin/main（基于最近获取）");
	await git(temporary, "clone", remote, clone);
	const config = await readFile(join(clone, ".git", "config"), "utf8");
	await desktop.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
	}, clone);
	const project = await page.evaluate(async () => {
		const response = await fetch("/api/projects/pick", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		if (!response.ok) throw new Error(await response.text());
		return (await response.json()).project;
	});
	await page.evaluate((id) => localStorage.setItem("wuming.workspaceId", id), project.id);
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.getByRole("tab", { name: "更改", exact: true }).click();
	await panel.getByRole("button", { name: "信任此仓库", exact: true }).click();
	await trust.getByRole("button", { name: "确认信任此目录", exact: true }).click();
	await expect(trust).not.toBeVisible();
	await expect(panel.getByRole("combobox", { name: "远程仓库" })).toHaveValue("origin");
	await expect(panel.locator(".git-tracking")).toHaveAttribute("title", "origin/main（基于最近获取）");
	await writeFile(join(clone, "note.txt"), "Desktop clone edit\n");
	await expect(panel.getByText("Desktop clone edit", { exact: true })).toBeVisible();
	assert.equal(await readFile(join(clone, ".git", "config"), "utf8"), config);
	const trustedPaths = await exec("git", ["config", "--file", globalConfig, "--get-all", "safe.directory"], {
		windowsHide: true,
	});
	assert.deepEqual(
		trustedPaths.stdout.trim().split(/\r?\n/),
		[await realpath(workspace), await realpath(clone)].map((path) => path.split(sep).join("/"))
	);
	assert.deepEqual(errors, []);
	console.log(
		"Desktop Git verification passed: external push detection, explicit scoped trust, native project import, cloned remote/upstream, live diff, unchanged repository configuration."
	);
} finally {
	if (desktop) await desktop.close();
	await rm(temporary, { recursive: true, force: true });
}

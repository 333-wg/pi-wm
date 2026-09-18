import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "wuming-terminal-desktop-"));
const output = join(root, "test-results", "desktop-terminal");
await mkdir(output, { recursive: true });
const env = { ...process.env, WUMING_DESKTOP_NODE: process.execPath, WUMING_DESKTOP_TEST_RUNTIME: "demo" };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
	app = await electron.launch({
		executablePath: createRequire(import.meta.url)("electron"),
		args: [join(root, "apps", "desktop"), `--user-data-dir=${profile}`],
		env,
		cwd: root,
		timeout: 60_000,
	});
	const page = await app.firstWindow({ timeout: 60_000 });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await expect(page.locator(".welcome-screen")).toBeVisible({ timeout: 30_000 });
	await page.evaluate(() => localStorage.setItem("wuming.onboarding.complete", "true"));
	await page.getByLabel("访问密码", { exact: true }).fill("wuming");
	await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	await expect(page.locator(".connection")).toHaveClass(/connected/, { timeout: 30_000 });
	assert.equal(new URL(page.url()).protocol, "wuming:");
	await page.getByRole("tab", { name: "终端", exact: true }).click();
	const panel = page.locator(".terminal-workbench:not([hidden])");
	await expect(panel.getByRole("status")).toHaveText("就绪", { timeout: 20_000 });
	if (process.platform === "win32") await expect(panel.locator(".terminal-location")).toContainText("PowerShell");
	async function command(text) {
		await panel.locator(".xterm-helper-textarea").focus();
		await page.keyboard.insertText(text);
		await page.keyboard.press("Enter");
	}
	await command(`node -e "console.log('DESKTOP'+'-TERMINAL-OK')"`);
	await expect(panel.locator(".xterm-rows")).toContainText("DESKTOP-TERMINAL-OK");
	await command(`node -e "setInterval(()=>{},1000)"`);
	await expect(panel.locator(".xterm-rows")).toContainText("setInterval");
	await panel.getByRole("button", { name: "中断当前命令", exact: true }).click();
	await command(`node -e "console.log('INTERRUPT'+'-OK')"`);
	await expect(panel.locator(".xterm-rows")).toContainText("INTERRUPT-OK");
	await page.getByRole("tab", { name: "文件", exact: true }).click();
	await expect(page.locator(".terminal-workbench")).toBeHidden();
	await page.getByRole("tab", { name: "终端", exact: true }).click();
	await expect(panel.locator(".xterm-rows")).toContainText("DESKTOP-TERMINAL-OK");
	if (process.platform === "win32") {
		await panel.getByLabel("新终端 Shell").selectOption("cmd");
		page.once("dialog", (dialog) => dialog.accept());
		await panel.getByRole("button", { name: "重启终端", exact: true }).click();
		await expect(panel.locator(".terminal-location")).toContainText("CMD");
		await expect(panel.getByRole("status")).toHaveText("就绪");
		await command(`node -e "console.log('CMD'+'-RESTART-OK')"`);
		await expect(panel.locator(".xterm-rows")).toContainText("CMD-RESTART-OK");
	}
	await page.screenshot({ path: join(output, "terminal.png") });
	page.once("dialog", (dialog) => dialog.accept());
	await panel.getByRole("button", { name: "关闭终端", exact: true }).click();
	await expect(panel.getByRole("status")).toHaveText("已关闭");
	assert.deepEqual(errors, []);
	console.log(
		"Desktop terminal passed: wuming:// bridge, real PTY execution, persistent panel, Shell selection/restart, explicit close."
	);
} finally {
	await app?.close();
	assert.ok(profile.startsWith(join(tmpdir(), "wuming-terminal-desktop-")));
	await rm(profile, { recursive: true, force: true });
}

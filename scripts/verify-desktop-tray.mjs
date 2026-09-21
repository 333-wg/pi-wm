import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Tray verification requires Windows");
const root = fileURLToPath(new URL("..", import.meta.url));
const parent = await realpath(tmpdir());
const profile = await mkdtemp(join(parent, "wuming-tray-"));
async function disposeProfile() {
	if (
		dirname(profile) !== parent ||
		!basename(profile).startsWith("wuming-tray-") ||
		(await realpath(profile)) !== profile
	)
		throw new Error("Unsafe test profile cleanup");
	await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const executablePath = createRequire(import.meta.url)("electron");
const args = [join(root, "apps/desktop/tests/fixtures/tray-app.mjs"), `--user-data-dir=${profile}`];
const env = { ...process.env, WUMING_DESKTOP_NODE: process.execPath, WUMING_DESKTOP_TEST_RUNTIME: "demo" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
	desktop = await electron.launch({ executablePath, args, env, cwd: root, timeout: 60_000 });
	const page = await desktop.firstWindow();
	await expect(page.locator(".welcome-screen")).toBeVisible();
	assert.equal(await desktop.evaluate(() => Boolean(globalThis.testTray && !globalThis.testTray.isDestroyed())), true);
	assert.deepEqual(await desktop.evaluate(() => globalThis.testTrayMenu.items.map((item) => item.label)), [
		"打开 Pi-Wm",
		"",
		"退出",
	]);
	const connection = await page.evaluate(() => window.wumingDesktop.connect());
	const health = connection.websocketUrl.replace("ws:", "http:").replace("/api/ws", "/health");
	const id = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
	await page.evaluate(() => {
		globalThis.trayStateMarker = "preserved";
	});
	const visible = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);
	async function hide() {
		await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
		await expect.poll(visible).toBe(false);
		assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id), id);
		assert.equal((await fetch(health)).ok, true);
	}
	await hide();
	await desktop.evaluate(() => globalThis.testTray.emit("click"));
	await expect.poll(visible).toBe(true);
	assert.equal(await page.evaluate(() => globalThis.trayStateMarker), "preserved");
	await hide();
	await desktop.evaluate(() => globalThis.testTrayMenu.items.find((item) => item.label === "打开 Pi-Wm").click());
	await expect.poll(visible).toBe(true);
	await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
	await expect
		.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
		.toBe(true);
	await desktop.evaluate(() => globalThis.testTray.emit("double-click"));
	await expect
		.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
		.toBe(false);
	await hide();
	const second = spawn(executablePath, args, { env, cwd: root, windowsHide: true, stdio: "ignore" });
	const [code] = await once(second, "exit", { signal: AbortSignal.timeout(15_000) });
	assert.equal(code, 0);
	await expect.poll(visible).toBe(true);
	assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
	await hide();
	const exited = once(desktop.process(), "exit", { signal: AbortSignal.timeout(20_000) });
	await desktop.evaluate(() => {
		setTimeout(() => globalThis.testTrayMenu.items.find((item) => item.label === "退出").click(), 50);
	});
	const [exitCode] = await exited;
	assert.equal(exitCode, 0);
	desktop = undefined;
	await assert.rejects(fetch(health, { signal: AbortSignal.timeout(2000) }));
	console.log("托盘验证通过：关闭隐藏、后台服务保留、单击/双击及菜单恢复、页面状态保留、重复启动恢复、退出停止服务。");
} finally {
	if (desktop) await desktop.close();
	await disposeProfile();
}

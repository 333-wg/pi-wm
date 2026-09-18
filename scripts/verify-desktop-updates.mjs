import { _electron as electron, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8")).version;
const parent = await realpath(tmpdir());
const profile = await mkdtemp(join(parent, "wuming-update-chrome-"));
const output = join(root, "test-results", "desktop-updates-native");
await mkdir(output, { recursive: true });
const env = { ...process.env, WUMING_DESKTOP_NODE: process.execPath, WUMING_DESKTOP_TEST_RUNTIME: "demo" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
	desktop = await electron.launch({
		executablePath: createRequire(import.meta.url)("electron"),
		args: [join(root, "apps/desktop"), "--user-data-dir=" + profile],
		env,
		cwd: root,
		timeout: 60_000,
	});
	const page = await desktop.firstWindow();
	await desktop.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) {
			window.webContents.setBackgroundThrottling(false);
			window.hide();
			window.on("show", () => window.hide());
		}
	});
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await expect(page.locator(".welcome-screen")).toBeVisible();
	await page.getByLabel("访问密码", { exact: true }).fill("wuming");
	await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	const state = await page.evaluate(() => window.wumingDesktop.updates.invoke("state"));
	assert.equal(state.status, "disabled");
	assert.equal(state.disabledReason, "development");
	assert.equal(state.currentVersion, version);
	assert.equal(state.repository, "333-wg/pi-wm");
	await desktop.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()
			.items[0].submenu.items.find((item) => item.label === "关于与更新")
			.click()
	);
	const panel = page.locator("#settings-panel-updates");
	await expect(panel).toBeVisible();
	await expect(panel.getByText("开发模式下不检查或安装更新。")).toBeVisible();
	await expect(panel.getByRole("button", { name: "检查更新", exact: true })).toBeDisabled();
	assert.equal(
		await page.evaluate(async () => {
			try {
				await window.wumingDesktop.updates.invoke("install-arbitrary-path", "C:/malicious.exe");
				return false;
			} catch {
				return true;
			}
		}),
		true
	);
	assert.equal(
		await page.evaluate(async () => {
			try {
				await window.wumingDesktop.updates.invoke("auto-check", "not-a-boolean");
				return false;
			} catch {
				return true;
			}
		}),
		true
	);
	await page.evaluate(() => window.wumingDesktop.updates.invoke("auto-check", false));
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	assert.equal((await page.evaluate(() => window.wumingDesktop.updates.invoke("state"))).autoCheck, false);
	// Reload briefly has real in-flight requests; wait for idle instead of weakening the installation gate.
	await expect
		.poll(async () => (await page.evaluate(() => window.wumingDesktop.updates.invoke("activity"))).busy)
		.toBe(false);
	await desktop.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()
			.items[0].submenu.items.find((item) => item.label === "关于与更新")
			.click()
	);
	await expect(panel).toBeVisible();
	assert.deepEqual(errors, []);
	// Visual snapshots are covered by the browser suite; hidden native captures can stall on Windows.
	await writeFile(
		join(output, "verification.json"),
		JSON.stringify({ version, repository: state.repository, mode: "development", passed: true, errors }, null, 2)
	);
	console.log(
		"Desktop updates: native menu, isolated IPC, invalid-action validation, version, activity and reload persistence passed."
	);
} finally {
	await desktop?.close();
	assert.equal(dirname(await realpath(profile)), parent);
	await rm(profile, { recursive: true, force: true });
}

import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { prepareDesktopRelease, releaseEnvironment } from "./lib/desktop-release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice(11);
assert.ok(baseline, "Pass --baseline=<older packaged Pi-Wm.exe>");
const metadata = load(await readFile(join(root, "release", "latest.yml"), "utf8"));
const parent = await realpath(tmpdir());
const temporary = await mkdtemp(join(parent, "pi-wm-published-update-"));
const profile = join(temporary, "profile");
const cache = join(temporary, "cache");
const output = join(root, "test-results", "desktop-published-update");
await mkdir(profile);
await writeFile(join(profile, "desktop-updates.json"), JSON.stringify({ autoCheck: false, deferredUntil: 0 }));
const report = {
	passed: false,
	expectedVersion: metadata.version,
	provider: "public GitHub (packaged configuration)",
	providerOverridden: false,
	installerExecuted: false,
};
let desktop, page, release;
try {
	release = await prepareDesktopRelease(resolve(baseline), root);
	const env = releaseEnvironment(process.env);
	delete env.WUMING_DESKTOP_NODE;
	delete env.WUMING_DESKTOP_TEST_RUNTIME;
	desktop = await electron.launch({
		executablePath: release.executable,
		args: [`--user-data-dir=${profile}`],
		cwd: release.directory,
		env,
		timeout: 90_000,
	});
	await desktop.evaluate(({ app, BrowserWindow, shell }, cachePath) => {
		const require = process.getBuiltinModule("module").createRequire(app.getAppPath() + "/package.json");
		const updater = require("electron-updater").autoUpdater;
		// Isolate only the cache. Keep the real packaged GitHub provider and Electron HTTPS executor.
		Object.defineProperty(updater.app, "baseCachePath", { get: () => cachePath });
		updater.spawnLog = async () => {
			throw new Error("Installation is prohibited in the published-download check");
		};
		globalThis.publishedUpdateExternal = [];
		shell.openExternal = async (url) => {
			globalThis.publishedUpdateExternal.push(url);
		};
		for (const window of BrowserWindow.getAllWindows()) {
			window.webContents.setBackgroundThrottling(false);
			window.hide();
			window.on("show", () => window.hide());
		}
	}, cache);
	page = await desktop.firstWindow();
	page.setDefaultTimeout(30_000);
	await page.evaluate(() => {
		localStorage.setItem("wuming.locale", "zh");
		localStorage.setItem("wuming.onboarding.complete", "true");
	});
	await page.reload();
	await page.getByLabel("访问密码", { exact: true }).fill("wuming");
	await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	const state = () => page.evaluate(() => window.wumingDesktop.updates.invoke("state"));
	report.baselineVersion = (await state()).currentVersion;
	assert.equal((await state()).repository, "333-wg/pi-wm");
	assert.equal((await state()).disabledReason, undefined);
	await desktop.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()
			.items[0].submenu.items.find((item) => item.label === "关于与更新")
			.click()
	);
	const panel = page.locator("#settings-panel-updates");
	await panel.getByRole("button", { name: "检查更新", exact: true }).click();
	await expect.poll(async () => (await state()).status, { timeout: 120_000 }).toBe("available");
	assert.equal((await state()).nextVersion, metadata.version);
	console.log("PASS: Older packaged app discovers the published GitHub release without a token");
	await panel.getByRole("button", { name: "下载更新", exact: true }).click();
	await expect.poll(async () => (await state()).status, { timeout: 300_000, intervals: [1000] }).toBe("ready");
	const installer = await desktop.evaluate(
		({ app }) =>
			process.getBuiltinModule("module").createRequire(app.getAppPath() + "/package.json")("electron-updater")
				.autoUpdater.installerPath
	);
	assert.ok(installer.startsWith(cache + "\\"));
	const bytes = await readFile(installer);
	assert.equal(createHash("sha512").update(bytes).digest("base64"), metadata.sha512);
	report.sha256 = createHash("sha256").update(bytes).digest("hex");
	report.size = bytes.length;
	assert.deepEqual(await desktop.evaluate(() => globalThis.publishedUpdateExternal), []);
	report.passed = true;
	console.log(
		"PASS: App downloads and validates the actual published installer without opening GitHub or installing locally"
	);
} catch (error) {
	report.error = error.stack;
	if (page && !page.isClosed())
		report.failureState = await page
			.evaluate(() => window.wumingDesktop.updates.invoke("state"))
			.catch(() => undefined);
	throw error;
} finally {
	await desktop?.close();
	await release?.dispose();
	await mkdir(output, { recursive: true });
	await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
	assert.equal(dirname(await realpath(temporary)), parent);
	await rm(temporary, { recursive: true, force: true });
}

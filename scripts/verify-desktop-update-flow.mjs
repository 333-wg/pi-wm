import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import WebSocket from "ws";
import { prepareDesktopRelease, releaseEnvironment } from "./lib/desktop-release.mjs";
import { openDesktopRpc } from "./lib/desktop-rpc.mjs";
import { verifyDesktopRelease } from "./lib/desktop-update-release.mjs";

// Real packaged renderer, IPC, Electron networking and NSIS download/handoff.
// Only the feed and OS installer launch are replaced. No installed app or registry is touched.
const root = fileURLToPath(new URL("..", import.meta.url));
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice(11);
assert.ok(baseline, "Pass --baseline=<previous release/win-unpacked/Pi-Wm.exe>");
const directory = resolve(process.argv.find((arg) => arg.startsWith("--release="))?.slice(10) ?? join(root, "release"));
const metadata = load(await readFile(join(directory, "latest.yml"), "utf8"));
await verifyDesktopRelease({ directory, version: metadata.version, repository: "333-wg/pi-wm" });
const installer = join(directory, metadata.path);
const installerHash = createHash("sha512")
	.update(await readFile(installer))
	.digest("base64");
const parent = await realpath(tmpdir());
const temporary = await mkdtemp(join(parent, "pi-wm-update-flow-"));
const profile = join(temporary, "profile");
const cache = join(temporary, "cache");
const config = join(temporary, "app-update.yml");
const output = join(root, "test-results", "desktop-update-flow");
await mkdir(profile);
await writeFile(join(profile, "desktop-updates.json"), JSON.stringify({ autoCheck: false, deferredUntil: 0 }));
await writeFile(config, JSON.stringify({ updaterCacheDirName: "isolated-update-cache" }));
const report = {
	passed: false,
	targetVersion: metadata.version,
	source: "loopback HTTP with real installer",
	installerExecuted: false,
	installationVerified: false,
	remotePublicationVerified: false,
	checks: [],
	requests: [],
};
let mode = "missing",
	downloads = 0,
	desktop,
	page,
	rpc,
	terminal,
	release;
const server = createServer((req, res) => {
	const path = new URL(req.url, "http://127.0.0.1").pathname;
	report.requests.push(path);
	if (path === "/latest.yml") {
		if (mode === "missing") return res.writeHead(404).end();
		res.setHeader("content-type", "text/yaml");
		return res.end(JSON.stringify(metadata));
	}
	if (path === "/" + metadata.path) {
		downloads++;
		res.writeHead(200, { "content-length": metadata.files[0].size, "content-type": "application/octet-stream" });
		if (mode === "slow") {
			res.write(Buffer.alloc(1024));
			return;
		}
		const stream = createReadStream(installer);
		let first = true;
		stream.on("data", (chunk) => {
			if (mode === "corrupt" && first) chunk[0] ^= 0xff;
			first = false;
		});
		stream.on("error", () => res.destroy());
		res.on("close", () => stream.destroy());
		return stream.pipe(res);
	}
	res.writeHead(404).end();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const feed = `http://127.0.0.1:${server.address().port}/`;
const env = releaseEnvironment(process.env);
delete env.WUMING_DESKTOP_TEST_RUNTIME;
delete env.WUMING_DESKTOP_NODE;
async function state() {
	return page.evaluate(() => window.wumingDesktop.updates.invoke("state"));
}
async function waitStatus(status) {
	await expect.poll(async () => (await state()).status, { timeout: 120_000 }).toBe(status);
}
function passed(name) {
	report.checks.push(name);
	console.log("PASS:", name);
}
async function close() {
	terminal?.terminate();
	terminal = undefined;
	await rpc?.close();
	rpc = undefined;
	await desktop?.close();
	desktop = undefined;
}
async function launch(executable) {
	release ??= await prepareDesktopRelease(executable, root);
	desktop = await electron.launch({
		executablePath: release.executable,
		args: [`--user-data-dir=${profile}`],
		env,
		cwd: release.directory,
		timeout: 60_000,
	});
	const actual = await desktop.evaluate(({ app }) => ({
		packaged: app.isPackaged,
		profile: app.getPath("userData"),
		version: app.getVersion(),
	}));
	assert.equal(actual.packaged, true);
	assert.equal(actual.profile, profile);
	// Change only the updater instance in this disposable process, never packaged source or config.
	await desktop.evaluate(
		async ({ app, shell, dialog, BrowserWindow }, options) => {
			const { createRequire } = process.getBuiltinModule("module");
			const require = createRequire(app.getAppPath() + "/package.json");
			const updater = require("electron-updater").autoUpdater;
			Object.defineProperty(updater.app, "baseCachePath", { get: () => options.cache });
			updater.updateConfigPath = options.config;
			updater.setFeedURL({ provider: "generic", url: options.feed });
			updater.logger = null;
			globalThis.updateProof = { external: [], launches: [], confirmations: [], accept: false, progress: 0 };
			updater.on("download-progress", () => globalThis.updateProof.progress++);
			// The actual quitAndInstall -> install -> doInstall chain runs, but cannot spawn NSIS.
			updater.spawnLog = async (command, args) => {
				globalThis.updateProof.launches.push({ command, args });
				return true;
			};
			updater.app.quit = () => {
				globalThis.updateProof.quitRequested = true;
			};
			shell.openExternal = async (url) => {
				globalThis.updateProof.external.push(url);
			};
			shell.openPath = async () => {
				throw new Error("Unexpected OS launch");
			};
			dialog.showMessageBox = async (...args) => {
				globalThis.updateProof.confirmations.push(args.at(-1).message);
				return { response: globalThis.updateProof.accept ? 1 : 0 };
			};
			for (const window of BrowserWindow.getAllWindows()) {
				window.webContents.setBackgroundThrottling(false);
				window.hide();
				window.on("show", () => window.hide());
			}
		},
		{ cache, config, feed }
	);
	page = await desktop.firstWindow();
	page.setDefaultTimeout(30_000);
	if ((await page.evaluate(() => localStorage.getItem("wuming.desktop.welcome.complete"))) !== "true") {
		await page.getByLabel("访问密码", { exact: true }).fill("wuming");
		await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	}
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.evaluate(() => localStorage.setItem("wuming.onboarding.complete", "true"));
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	rpc = await openDesktopRpc(await page.evaluate(() => window.wumingDesktop.connect()));
	await desktop.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()
			.items[0].submenu.items.find((item) => item.label === "关于与更新")
			.click()
	);
	await expect(page.locator("#settings-panel-updates")).toBeVisible();
	assert.equal((await state()).disabledReason, undefined);
	assert.equal((await state()).autoCheck, false);
	console.log("Packaged updater state:", JSON.stringify(await state()));
	return actual.version;
}
const button = (name) => page.locator("#settings-panel-updates").getByRole("button", { name, exact: true });
function exchange(message, type) {
	return new Promise((resolveMessage, reject) => {
		const timer = setTimeout(() => {
			terminal.off("message", receive);
			reject(new Error(`Timed out: ${type}`));
		}, 15_000);
		const receive = (raw) => {
			const result = JSON.parse(raw.toString());
			if (result.type !== type && result.type !== "terminal.error") return;
			clearTimeout(timer);
			terminal.off("message", receive);
			if (result.type === "terminal.error") reject(new Error(result.message));
			else resolveMessage(result);
		};
		terminal.on("message", receive);
		terminal.send(JSON.stringify(message));
	});
}
try {
	report.baselineVersion = await launch(resolve(baseline));
	assert.notEqual(report.baselineVersion, metadata.version);
	const { workspaces } = await rpc.request({ type: "workspace.list" });
	const session = (
		await rpc.request({
			type: "session.create",
			workspaceId: workspaces[0].id,
			name: "Update persistence proof",
			model: { provider: "fixture", id: "no-requests" },
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		})
	).snapshot.session;
	await page.evaluate(() => localStorage.setItem("update-flow-proof", "preserved"));
	await button("检查更新").click();
	await waitStatus("error");
	assert.equal((await state()).error, "metadata");
	passed("Missing metadata is shown as a recoverable error");
	mode = "slow";
	await button("重新检查更新").click();
	await waitStatus("available");
	assert.equal((await state()).nextVersion, metadata.version);
	assert.equal(downloads, 0);
	await button("下载更新").click();
	await waitStatus("downloading");
	await expect.poll(() => downloads).toBe(1);
	await button("取消下载").click();
	await waitStatus("available");
	passed("In-app discovery, explicit download and cancellation through real Electron HTTP");
	mode = "corrupt";
	await button("下载更新").click();
	await waitStatus("error");
	assert.equal((await state()).error, "integrity");
	assert.equal((await state()).retryAction, "download");
	await expect(button("重启并安装")).toHaveCount(0);
	passed("Corrupted real installer is rejected; installation is not offered");
	mode = "valid";
	await button("重新下载").click();
	await waitStatus("ready");
	assert.equal((await state()).progress, 100);
	const downloaded = await desktop.evaluate(async ({ app }) => {
		const { createRequire } = process.getBuiltinModule("module");
		return createRequire(app.getAppPath() + "/package.json")("electron-updater").autoUpdater.installerPath;
	});
	assert.ok(downloaded.startsWith(cache + "\\"));
	assert.equal(
		createHash("sha512")
			.update(await readFile(downloaded))
			.digest("base64"),
		installerHash
	);
	passed("App downloads the actual new installer into an isolated cache and verifies SHA-512");
	const connection = await page.evaluate(() => window.wumingDesktop.connect());
	terminal = new WebSocket(
		connection.websocketUrl,
		["wuming.v1", `wuming.bearer.${Buffer.from(connection.token).toString("base64url")}`],
		{ origin: "wuming://app" }
	);
	await once(terminal, "open");
	await exchange({ type: "hello", protocolVersion: 1, clientId: "update-flow", capabilities: [] }, "hello");
	await exchange(
		{
			type: "terminal.create",
			requestId: "open",
			terminalId: "update-flow-terminal",
			workspaceId: workspaces[0].id,
			cols: 80,
			rows: 24,
		},
		"terminal.ready"
	);
	assert.equal((await page.evaluate(() => window.wumingDesktop.updates.invoke("activity"))).busy, true);
	await expect(button("重启并安装")).toBeDisabled();
	assert.equal((await page.evaluate(() => window.wumingDesktop.updates.invoke("install"))).error, "busy");
	assert.equal(await desktop.evaluate(() => globalThis.updateProof.confirmations.length), 0);
	await exchange({ type: "terminal.close", requestId: "close", terminalId: "update-flow-terminal" }, "terminal.closed");
	terminal.close();
	await once(terminal, "close");
	terminal = undefined;
	passed("A real open terminal blocks both the UI install button and direct install IPC");
	await page.evaluate(() => window.wumingDesktop.updates.invoke("activity"));
	await expect(button("重启并安装")).toBeEnabled();
	await button("重启并安装").click();
	await waitStatus("ready");
	assert.equal(await desktop.evaluate(() => globalThis.updateProof.launches.length), 0);
	passed("Declining the native confirmation leaves the application running");
	assert.equal(await desktop.evaluate(() => globalThis.updateProof.external.length), 0);
	// Quit normally with a fully downloaded update. No install hook may be registered.
	assert.equal(
		await desktop.evaluate(async ({ app }) => {
			const { createRequire } = process.getBuiltinModule("module");
			return createRequire(app.getAppPath() + "/package.json")("electron-updater").autoUpdater.quitHandlerAdded;
		}),
		false
	);
	await close();
	passed("Ordinary quit after download does not install the update");
	await launch(resolve(baseline));
	const beforeCache = downloads;
	await button("检查更新").click();
	await waitStatus("available");
	await button("下载更新").click();
	await waitStatus("ready");
	assert.equal(downloads, beforeCache);
	passed("Restart reuses the previously verified installer without another download");
	await page.evaluate(() => window.wumingDesktop.updates.invoke("activity"));
	await expect(button("重启并安装")).toBeEnabled();
	await desktop.evaluate(() => {
		globalThis.updateProof.accept = true;
	});
	await rpc.close();
	rpc = undefined;
	await button("重启并安装").click();
	await expect.poll(() => desktop.evaluate(() => globalThis.updateProof.quitRequested)).toBe(true);
	const proof = await desktop.evaluate(() => globalThis.updateProof);
	assert.equal(proof.launches.length, 1);
	assert.equal(proof.launches[0].command, downloaded);
	assert.ok(proof.launches[0].args.includes("--updated"));
	assert.ok(proof.launches[0].args.includes("--force-run"));
	assert.deepEqual(proof.external, []);
	report.handoff = proof;
	passed("Confirmed in-app installation reaches real NSIS handoff with restart flags, without opening GitHub");
	await close();
	await release.dispose();
	release = undefined;
	// Launch target directly, NOT as evidence of NSIS replacement. Reuse the same isolated profile.
	assert.equal(await launch(join(directory, "win-unpacked", "Pi-Wm.exe")), metadata.version);
	assert.equal(
		(await rpc.request({ type: "session.snapshot.get", sessionId: session.id })).snapshot.session.name,
		session.name
	);
	assert.equal(await page.evaluate(() => localStorage.getItem("update-flow-proof")), "preserved");
	await button("检查更新").click();
	await waitStatus("latest");
	passed("New packaged version opens the old profile, preserves session/preferences and reports up to date");
	report.passed = true;
} catch (error) {
	report.error = error.stack;
	if (page && !page.isClosed()) {
		report.failureState = await state().catch(() => undefined);
		report.failurePanel = await page
			.locator("#settings-panel-updates")
			.innerText({ timeout: 2000 })
			.catch(() => "unavailable");
		console.error(
			"Update failure context:",
			JSON.stringify({ state: report.failureState, panel: report.failurePanel })
		);
	}
	throw error;
} finally {
	await close();
	await release?.dispose();
	server.closeAllConnections();
	await new Promise((done) => server.close(done));
	await mkdir(output, { recursive: true });
	await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
	assert.equal(dirname(await realpath(temporary)), parent);
	assert.ok(basename(temporary).startsWith("pi-wm-update-flow-"));
	await rm(temporary, { recursive: true, force: true });
}

import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile, copyFile, cp } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative, isAbsolute } from "node:path";
import { load } from "js-yaml";
import { extractFile, uncache } from "@electron/asar";
import { openDesktopRpc } from "./lib/desktop-rpc.mjs";
import { releaseEnvironment } from "./lib/desktop-release.mjs";
import { verifyRuntimeFiles } from "./lib/runtime-inventory.mjs";

// This test really installs/uninstalls software and changes the runner's registry.
// Never permit it on a developer machine or persistent/self-hosted runner.
assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Actual installation is restricted to GitHub Actions");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "A disposable GitHub-hosted runner is required");
const {
	UPDATE_BASELINE_VERSION: baselineVersion,
	UPDATE_TARGET_VERSION: targetVersion,
	UPDATE_FIXTURE_DIRECTORY: directory,
} = process.env;
for (const version of [baselineVersion, targetVersion]) assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
const temporary = await realpath(process.env.RUNNER_TEMP);
const pathScenario = process.env.UPDATE_PATH_SCENARIO ?? "standard";
assert.ok(["standard", "long-temp"].includes(pathScenario));
let updateTemporary = process.env.TEMP;
if (pathScenario === "long-temp") {
	updateTemporary = join(temporary, "long-user-temp", "Administrator-\u7528\u6237");
	while (updateTemporary.length < 100) updateTemporary = join(updateTemporary, "nested-temporary-directory");
	await mkdir(updateTemporary, { recursive: true });
}
const fixtures = await realpath(directory);
const rel = relative(temporary, fixtures);
assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), "Fixtures must be inside RUNNER_TEMP");
const installDirectory = join(temporary, "Pi-Wm-installed-update");
const executable = join(installDirectory, "Pi-Wm.exe");
const profile = join(process.env.APPDATA, "Wuming");
await assert.rejects(access(profile), { code: "ENOENT" });
await assert.rejects(access(installDirectory), { code: "ENOENT" });
const output = join(process.cwd(), "test-results", "desktop-installed-update");
const handoffPath = join(output, "handoff.json");
await mkdir(output, { recursive: true });
const metadata = load(await readFile(join(fixtures, "latest.yml"), "utf8"));
assert.equal(metadata.version, targetVersion);
assert.equal(metadata.path, `Pi-Wm-${targetVersion}-Setup-x64.exe`);
const installer = join(fixtures, metadata.path);
const targetBytes = await readFile(installer);
assert.equal(createHash("sha512").update(targetBytes).digest("base64"), metadata.sha512);
assert.equal(targetBytes.length, metadata.files[0].size);
const report = {
	passed: false,
	baselineVersion,
	targetVersion,
	installerExecuted: false,
	installationVerified: false,
	autoRestartObserved: false,
	feed: "loopback HTTP serving verified unpublished fixture",
	installerLaunchMocked: false,
	checks: [],
	pathScenario,
	updateTemporary,
};
const server = createServer((req, res) => {
	const path = new URL(req.url, "http://127.0.0.1").pathname;
	if (path === "/latest.yml") return res.end(JSON.stringify(metadata));
	const filename = path.slice(1);
	if (![metadata.path, metadata.path + ".blockmap"].includes(filename)) return res.writeHead(404).end();
	if (filename === metadata.path) res.setHeader("Content-Length", metadata.files[0].size);
	const stream = createReadStream(join(fixtures, filename));
	stream.on("error", () => res.destroy());
	res.on("close", () => stream.destroy());
	stream.pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const feed = `http://127.0.0.1:${server.address().port}/`;
const env = releaseEnvironment(
	Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !/TOKEN|SECRET|PASSWORD|WUMING_DESKTOP_NODE|WUMING_DESKTOP_TEST_RUNTIME/i.test(key)
		)
	)
);
let desktop, page, rpc;
env.TEMP = updateTemporary;
env.TMP = updateTemporary;
function passed(name) {
	report.checks.push(name);
	console.log("PASS:", name);
}
function powershell(script, extra = {}) {
	return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 90_000,
		env: { ...process.env, UPDATE_INSTALL_EXE: executable, ...extra },
	}).trim();
}
function applicationProcesses() {
	const value = powershell(
		`@(Get-CimInstance Win32_Process -Filter "Name = 'Pi-Wm.exe'" | Where-Object { $_.ExecutablePath -eq $env:UPDATE_INSTALL_EXE -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`
	);
	return value ? [JSON.parse(value)].flat() : [];
}
function installedVersion() {
	const archive = join(installDirectory, "resources", "app.asar");
	uncache(archive);
	return JSON.parse(extractFile(archive, "package.json").toString()).version;
}
function uninstallEntries() {
	const value = powershell(
		`@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Pi-Wm(\\s|$)' } | Select-Object DisplayName,DisplayVersion,InstallLocation) | ConvertTo-Json -Compress`
	);
	return value ? [JSON.parse(value)].flat() : [];
}
async function launch() {
	desktop = await electron.launch({
		executablePath: executable,
		args: [],
		env,
		cwd: installDirectory,
		timeout: 90_000,
	});
	assert.equal(await desktop.evaluate(({ app }) => app.getPath("userData")), profile);
	await desktop.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) {
			window.webContents.setBackgroundThrottling(false);
			window.hide();
			window.on("show", () => window.hide());
		}
	});
	page = await desktop.firstWindow({ timeout: 60_000 });
	page.setDefaultTimeout(30_000);
	await page.evaluate(() => {
		localStorage.setItem("wuming.locale", "zh");
		localStorage.setItem("wuming.onboarding.complete", "true");
	});
	await page.reload();
	if ((await page.evaluate(() => localStorage.getItem("wuming.desktop.welcome.complete"))) !== "true") {
		await page.getByLabel("访问密码", { exact: true }).fill("wuming");
		await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	}
	await expect(page.locator(".connection")).toHaveClass(/connected/, { timeout: 60_000 });
	rpc = await openDesktopRpc(await page.evaluate(() => window.wumingDesktop.connect()));
}
async function status() {
	return page.evaluate(() => window.wumingDesktop.updates.invoke("state"));
}
async function waitStatus(value) {
	await expect.poll(async () => (await status()).status, { timeout: 180_000 }).toBe(value);
}
const button = (name) => page.locator("#settings-panel-updates").getByRole("button", { name, exact: true });
async function stopObservedProcess(pid) {
	assert.ok(applicationProcesses().some((p) => p.ProcessId === pid));
	await expect
		.poll(
			() =>
				powershell(`(Get-Process -Id ([int]$env:UPDATE_RESTART_PID)).MainWindowHandle.ToInt64()`, {
					UPDATE_RESTART_PID: String(pid),
				}),
			{ timeout: 60_000, intervals: [1000] }
		)
		.not.toBe("0");
	powershell(
		`$p = Get-Process -Id ([int]$env:UPDATE_RESTART_PID); if (-not $p.CloseMainWindow()) { throw 'Cannot close verified restarted application' }; $p.WaitForExit(45000) | Out-Null; if (-not $p.HasExited) { throw 'Restarted application did not close' }`,
		{ UPDATE_RESTART_PID: String(pid) }
	);
}
try {
	assert.deepEqual(uninstallEntries(), [], "Runner must not have a prior Pi-Wm installation");
	await new Promise((done, reject) => {
		const started = Date.now();
		const child = spawn(
			join(fixtures, `Pi-Wm-${baselineVersion}-Setup-x64.exe`),
			["/S", "/currentuser", `/D=${installDirectory}`],
			{ windowsHide: true, stdio: "inherit", timeout: 600_000 }
		);
		const progress = setInterval(() => {
			try {
				const details = powershell(
					`$p = Get-Process -Id ([int]$env:UPDATE_INSTALLER_PID) -ErrorAction SilentlyContinue; $dir = [IO.Path]::GetDirectoryName($env:UPDATE_INSTALL_EXE); [pscustomobject]@{ cpu = $p.CPU; window = $p.MainWindowTitle; files = @(Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue).Count } | ConvertTo-Json -Compress`,
					{ UPDATE_INSTALLER_PID: String(child.pid) }
				);
				console.log(`Baseline installation after ${Math.round((Date.now() - started) / 1000)}s: ${details}`);
			} catch (error) {
				console.log("Installation progress unavailable:", error.message);
			}
		}, 30_000);
		child.once("error", (error) => {
			clearInterval(progress);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearInterval(progress);
			report.baselineInstallSeconds = Math.round((Date.now() - started) / 1000);
			if (code === 0) done();
			else reject(new Error(`Baseline installation exited ${code} (${signal ?? "no signal"})`));
		});
	});
	report.installerExecuted = true;
	assert.equal(installedVersion(), baselineVersion);
	report.baselineRegistration = uninstallEntries();
	console.log("Baseline registration:", JSON.stringify(report.baselineRegistration));
	assert.ok(report.baselineRegistration.some((entry) => entry.DisplayVersion === baselineVersion));
	passed("Candidate installed by the real NSIS installer and registered in Windows");
	await mkdir(profile, { recursive: true });
	await writeFile(join(profile, "desktop-updates.json"), JSON.stringify({ autoCheck: false, deferredUntil: 0 }));
	await launch();
	const { workspaces } = await rpc.request({ type: "workspace.list" });
	await writeFile(join(profile, "workspace", "upgrade-proof.txt"), "Workspace data survives the real installer.");
	const session = (
		await rpc.request({
			type: "session.create",
			workspaceId: workspaces[0].id,
			name: "Real installed upgrade persistence",
			model: { provider: "fixture", id: "no-paid-requests" },
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		})
	).snapshot.session;
	await page.evaluate(() => localStorage.setItem("installed-update-proof", "preserved-after-nsis"));
	await desktop.evaluate(
		({ app, dialog, shell }, options) => {
			const require = process.getBuiltinModule("module").createRequire(app.getAppPath() + "/package.json");
			const updater = require("electron-updater").autoUpdater;
			updater.setFeedURL({ provider: "generic", url: options.feed });
			const originalSpawn = updater.spawnLog.bind(updater);
			updater.spawnLog = async (command, args, ...rest) => {
				if (command !== updater.installerPath || !args.includes("/S") || !args.includes("--force-run"))
					throw new Error("Unexpected installation command");
				require("node:fs").writeFileSync(
					options.handoff,
					JSON.stringify({ command, args, installerLaunchMocked: false })
				);
				return originalSpawn(command, args, ...rest);
			};
			dialog.showMessageBox = async (_window, options) => {
				if (options.message !== "重启并安装更新？") throw new Error("Unexpected native dialog: " + options.message);
				return { response: 1 };
			};
			shell.openExternal = async () => {
				throw new Error("Update must not open an external browser");
			};
		},
		{ feed, handoff: handoffPath }
	);
	await desktop.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()
			.items[0].submenu.items.find((item) => item.label === "关于与更新")
			.click()
	);
	await button("检查更新").click();
	await waitStatus("available");
	assert.equal((await status()).nextVersion, targetVersion);
	await button("下载更新").click();
	await waitStatus("ready");
	passed("Installed app discovered and downloaded the higher version through its own UI");
	await page.evaluate(() => window.wumingDesktop.updates.invoke("activity"));
	await expect(button("重启并安装")).toBeEnabled();
	await rpc.close();
	rpc = undefined;
	const originalPid = desktop.process().pid;
	report.originalPid = originalPid;
	desktop.process().stdout.on("data", (data) => console.log("App stdout:", data.toString()));
	desktop.process().stderr.on("data", (data) => console.log("App stderr:", data.toString()));
	desktop.on("close", () => console.log("Playwright observed application close"));
	await button("重启并安装").click();
	// Verify the OS process, not an automation transport's close notification.
	await expect
		.poll(() => applicationProcesses().some((process) => process.ProcessId === originalPid), {
			timeout: 600_000,
			intervals: [3000],
		})
		.toBe(false);
	passed("Original installed application process exited after update confirmation");
	desktop = undefined;
	report.handoff = JSON.parse(await readFile(handoffPath, "utf8"));
	await expect
		.poll(
			() => {
				try {
					return installedVersion();
				} catch {
					return "replacing";
				}
			},
			{ timeout: 600_000, intervals: [1000] }
		)
		.toBe(targetVersion);
	console.log("Target app.asar is present; waiting for the installer to finish remaining runtime files");
	let lastInstallationProgress = 0;
	await expect
		.poll(
			() => {
				const entries = uninstallEntries();
				if (Date.now() - lastInstallationProgress >= 30_000) {
					lastInstallationProgress = Date.now();
					console.log("Upgrade registration:", JSON.stringify(entries));
					console.log(
						"Upgrade processes:",
						powershell(
							`@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*Setup-x64*' -or $_.Name -eq 'Pi-Wm.exe' } | Select-Object ProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`
						)
					);
				}
				return entries.some((entry) => entry.DisplayVersion === targetVersion);
			},
			{ timeout: 600_000, intervals: [3000] }
		)
		.toBe(true);
	report.installationVerified = true;
	report.installedRuntimeFiles = await verifyRuntimeFiles(join(installDirectory, "resources", "runtime"));
	report.targetRegistration = uninstallEntries();
	passed("Real updater launched NSIS, replaced the installed binary and updated Windows registration");
	await expect
		.poll(() => applicationProcesses().filter((p) => p.CommandLine.includes("--updated")).length, {
			timeout: 120_000,
			intervals: [1000],
		})
		.toBe(1);
	const restarted = applicationProcesses().find((p) => p.CommandLine.includes("--updated"));
	report.autoRestartObserved = true;
	report.restartedProcess = restarted;
	passed("The installer automatically restarted the installed application without a manual launch");
	await stopObservedProcess(restarted.ProcessId);
	await launch();
	assert.equal(await desktop.evaluate(({ app }) => app.getVersion()), targetVersion);
	assert.equal(
		(await rpc.request({ type: "session.snapshot.get", sessionId: session.id })).snapshot.session.name,
		session.name
	);
	assert.equal(await page.evaluate(() => localStorage.getItem("installed-update-proof")), "preserved-after-nsis");
	assert.equal((await status()).autoCheck, false);
	assert.equal((await rpc.request({ type: "workspace.list" })).workspaces[0].id, workspaces[0].id);
	assert.equal(
		await readFile(join(profile, "workspace", "upgrade-proof.txt"), "utf8"),
		"Workspace data survives the real installer."
	);
	passed("Upgraded installed app preserves session, workspace, renderer preferences and updater settings");
	report.passed = true;
} catch (error) {
	report.error = error.stack;
	report.failureProcesses = applicationProcesses();
	try {
		report.failureInstalledVersion = installedVersion();
		report.failureRegistration = uninstallEntries();
	} catch (diagnosticError) {
		report.diagnosticError = diagnosticError.message;
	}
	if (page && !page.isClosed()) report.failureState = await status().catch(() => undefined);
	throw error;
} finally {
	await rpc?.close().catch(() => {});
	await desktop?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((done) => server.close(done));
	await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
	await copyFile(join(fixtures, "download-verification.json"), join(output, "download-verification.json")).catch(
		() => {}
	);
	await copyFile(join(profile, "logs", "gateway.log"), join(output, "gateway.log")).catch(() => {});
	await cp(join(process.env.LOCALAPPDATA, "Pi-Wm", "installer-logs"), join(output, "installer-logs"), {
		recursive: true,
	}).catch(() => {});
	// The GitHub-hosted VM is destroyed after the job. Do not add reusable-machine cleanup here.
}

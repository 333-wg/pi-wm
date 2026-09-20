import { _electron as electron, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { prepareDesktopRelease, releaseEnvironment } from "./lib/desktop-release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packaged = process.argv.find((argument) => argument.startsWith("--packaged="))?.slice("--packaged=".length);
const output = join(root, "test-results", packaged ? "desktop-packaged" : "desktop");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "wuming desktop test-"));
const env = {
	...(packaged ? releaseEnvironment(process.env) : process.env),
	WUMING_DESKTOP_NODE: process.execPath,
	WUMING_DESKTOP_TEST_RUNTIME: "demo",
};
delete env.ELECTRON_RUN_AS_NODE;
const require = createRequire(import.meta.url);
const release = packaged ? await prepareDesktopRelease(resolve(packaged), root) : undefined;
const executable = release?.executable ?? require("electron");
const appPath = join(root, "apps", "desktop");
const args = [...(packaged ? [] : [appPath]), `--user-data-dir=${profile}`];
let desktop;
let gatewayUrl;
const errors = [];
try {
	desktop = await electron.launch({
		executablePath: executable,
		args,
		env,
		cwd: release?.directory ?? root,
		timeout: 60_000,
	});
	const page = await desktop.firstWindow({ timeout: 60_000 });
	await expect(page).toHaveTitle("Pi-Wm");
	assert.equal(await desktop.evaluate(({ app }) => app.getName()), "Pi-Wm");
	page.on("pageerror", (error) => errors.push(error.message));
	await expect(page.locator(".welcome-screen")).toBeVisible({ timeout: 30_000 });
	await page.getByLabel("访问密码", { exact: true }).fill("wrong-password");
	await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("密码不正确");
	await page.getByLabel("访问密码", { exact: true }).fill("wuming");
	await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	await expect(page.locator(".connection")).toHaveClass(/connected/, { timeout: 30_000 });
	await expect(page.locator(".brand-row strong")).toHaveText("Pi-Wm");
	const connection = await page.evaluate(() => window.wumingDesktop.connect());
	gatewayUrl = connection.websocketUrl.replace("ws:", "http:").replace("/api/ws", "");
	assert.equal(await page.evaluate(() => typeof window.require), "undefined");
	assert.equal(await page.evaluate(() => localStorage.getItem("wuming.token")), null);
	const prefs = await desktop.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
	);
	assert.equal(prefs.contextIsolation, true);
	assert.equal(prefs.sandbox, true);
	assert.equal(prefs.nodeIntegration, false);
	await page.evaluate(() => {
		localStorage.setItem("wuming.onboarding.complete", "true");
		localStorage.setItem("wuming.theme", "dark");
	});
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	const api = await page.evaluate(async () => {
		const result = await fetch("/api/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Desktop verification" }),
		});
		return { status: result.status, body: await result.json() };
	});
	assert.equal(api.status, 201);
	assert.ok(api.body.project.id);
	const completed = await page.evaluate(async (id) => {
		const uploaded = await fetch(`/api/projects/${encodeURIComponent(id)}/files`, {
			method: "PUT",
			headers: { "x-wuming-project-path": "README.md" },
			body: "# Desktop verification\n",
		});
		if (uploaded.status !== 204) throw new Error(`Project upload failed: ${uploaded.status}`);
		const result = await fetch(`/api/projects/${encodeURIComponent(id)}/complete`, { method: "POST" });
		return result.status;
	}, api.body.project.id);
	assert.equal(completed, 200);
	await page.evaluate(
		async (shellId) => {
			const connection = await window.wumingDesktop.connect();
			await new Promise((resolve, reject) => {
				const bearer = btoa(connection.token).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
				const ws = new WebSocket(connection.websocketUrl, ["wuming.v1", `wuming.bearer.${bearer}`]);
				const timer = setTimeout(
					() => finish(new Error(`Native terminal did not respond: ${output.slice(-2000)}`)),
					15_000
				);
				let output = "";
				let closing = false;
				const finish = (error) => {
					clearTimeout(timer);
					ws.close();
					if (error) reject(error);
					else resolve();
				};
				const send = (message) => ws.send(JSON.stringify(message));
				ws.onerror = () => finish(new Error("Terminal connection failed"));
				ws.onopen = () =>
					send({ type: "hello", protocolVersion: 1, clientId: "desktop-terminal-test", capabilities: [] });
				ws.onmessage = ({ data }) => {
					const message = JSON.parse(data);
					if (message.type === "hello")
						send({
							type: "terminal.create",
							requestId: "create",
							terminalId: "desktop-test-terminal",
							workspaceId: "local-workspace",
							shellId,
							cols: 80,
							rows: 24,
						});
					if (message.type === "terminal.ready")
						send({
							type: "terminal.input",
							terminalId: message.terminalId,
							data: `node -e "console.log('WUMING'+'-PTY-OK')"\r`,
						});
					if (message.type === "terminal.error") finish(new Error(message.message));
					if (message.type === "terminal.output") {
						output += message.data;
						if (!closing && output.includes("WUMING-PTY-OK")) {
							closing = true;
							send({ type: "terminal.close", requestId: "close", terminalId: message.terminalId });
						}
					}
					if (message.type === "terminal.closed") finish();
				};
			});
		},
		process.platform === "win32" ? "cmd" : "sh"
	);
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await expect(page.getByText("Desktop verification", { exact: true }).first()).toBeVisible();
	const second = spawn(executable, args, { env, windowsHide: true, stdio: "ignore" });
	const [code] = await once(second, "exit", { signal: AbortSignal.timeout(15_000) });
	assert.equal(code, 0);
	assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
	await page.screenshot({ path: join(output, "desktop.png") });
	await desktop.close();
	desktop = undefined;
	await assert.rejects(fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(2000) }));
	desktop = await electron.launch({
		executablePath: executable,
		args,
		env,
		cwd: release?.directory ?? root,
		timeout: 60_000,
	});
	const reopened = await desktop.firstWindow({ timeout: 60_000 });
	await expect(reopened.locator(".connection")).toHaveClass(/connected/, { timeout: 30_000 });
	await expect(reopened.locator("html")).toHaveAttribute("data-theme", "dark");
	await expect(reopened.getByText("Desktop verification", { exact: true }).first()).toBeVisible();
	const newConnection = await reopened.evaluate(() => window.wumingDesktop.connect());
	assert.notEqual(newConnection.token, connection.token);
	assert.equal(errors.length, 0, errors.join("\n"));
	await desktop.close();
	desktop = undefined;
	const log = await readFile(join(profile, "logs", "gateway.log"), "utf8");
	assert.ok(!log.includes(connection.token));
	console.log(
		"Desktop verification passed: built UI, authenticated API/WebSocket, native PTY command, isolated renderer, single instance, project/theme persistence, rotated token, clean shutdown."
	);
} finally {
	try {
		if (desktop) await desktop.close();
		await rm(profile, { recursive: true, force: true });
	} finally {
		await release?.dispose();
	}
}

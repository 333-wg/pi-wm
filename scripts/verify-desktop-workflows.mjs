import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startDesktopWorkflowFixture } from "./lib/desktop-workflow-fixture.mjs";
import { openDesktopRpc } from "./lib/desktop-rpc.mjs";
import { prepareDesktopRelease, releaseEnvironment } from "./lib/desktop-release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packaged = process.argv.find((arg) => arg.startsWith("--packaged="))?.slice(11);
const release = packaged ? await prepareDesktopRelease(resolve(packaged), root) : undefined;
const executablePath = release?.executable ?? createRequire(import.meta.url)("electron");
const temporary = await mkdtemp(join(tmpdir(), "wuming workflows-"));
const profile = join(temporary, "profile");
const workspace = join(temporary, "\u4e2d\u6587 \u9879\u76ee");
const output = join(root, "test-results", packaged ? "desktop-workflows-packaged" : "desktop-workflows");
await mkdir(workspace);
await mkdir(output, { recursive: true });
const proof = `DESKTOP_FILE_PROOF_${randomUUID()}\n\u4e2d\u6587\r\n`;
await writeFile(join(workspace, "input.txt"), proof);
const env = { ...(packaged ? releaseEnvironment(process.env) : process.env), WUMING_DESKTOP_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WUMING_DESKTOP_TEST_RUNTIME;
const args = [...(packaged ? [] : [join(root, "apps", "desktop")]), `--user-data-dir=${profile}`];
const provider = await startDesktopWorkflowFixture();
const report = { packaged: Boolean(packaged), provider: "loopback-fixture", paidRequests: 0, passed: [], failures: [] };
const model = { provider: "desktop-workflow-fixture", id: "desktop-fixture" };
let desktop, page, rpc, connection, workspaceId;
async function launch() {
	desktop = await electron.launch({ executablePath, args, env, cwd: release?.directory ?? root, timeout: 60_000 });
	const paths = await desktop.evaluate(({ app }) => ({
		userData: app.getPath("userData"),
		sessionData: app.getPath("sessionData"),
	}));
	assert.equal(paths.userData, profile);
	assert.equal(paths.sessionData, profile);
	page = await desktop.firstWindow({ timeout: 60_000 });
	await expect(page).toHaveTitle("Pi-Wm");
	await desktop.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) {
			window.hide();
			window.on("show", () => window.hide());
		}
	});
	page.setDefaultTimeout(15_000);
	if ((await page.evaluate(() => localStorage.getItem("wuming.desktop.welcome.complete"))) !== "true") {
		await page.getByLabel("访问密码", { exact: true }).fill("wuming");
		await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	}
	await expect(page.locator(".connection")).toHaveClass(/connected/, { timeout: 30_000 });
	connection = await page.evaluate(() => window.wumingDesktop.connect());
	rpc = await openDesktopRpc(connection);
	await page.evaluate(() => localStorage.setItem("wuming.onboarding.complete", "true"));
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
}
async function close() {
	await rpc?.close();
	rpc = undefined;
	if (desktop) await desktop.close();
	desktop = undefined;
}
async function snapshot(id) {
	return (await rpc.request({ type: "session.snapshot.get", sessionId: id })).snapshot;
}
async function run(id) {
	return (await rpc.request({ type: "session.run.list", sessionId: id })).runs[0];
}
async function createSession(name) {
	const result = await rpc.request({
		type: "session.create",
		name,
		workspaceId,
		model,
		thinkingLevel: "off",
		sandboxMode: "workspace_write",
		approvalPolicy: "on_risk",
	});
	const id = result.snapshot.session.id;
	await selectSession(id);
	return id;
}
async function selectSession(id) {
	const selected = await snapshot(id);
	await page.evaluate(
		({ workspaceId, model, id }) => {
			localStorage.setItem("wuming.workspaceId", workspaceId);
			localStorage.setItem("wuming.model", JSON.stringify(model));
			localStorage.setItem(`wuming.sessionId.${workspaceId}`, id);
		},
		{ workspaceId, model, id }
	);
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await expect(page.locator("h1")).toHaveText(selected.session.name);
	await expect.poll(async () => page.locator(".composer textarea").isEnabled()).toBe(true);
}
async function prompt(scenario) {
	await page
		.locator(".composer textarea")
		.fill(`DESKTOP_CASE:${scenario} Perform the bounded desktop verification task.`);
	await page.getByRole("button", { name: "\u53d1\u9001", exact: true }).click();
}
async function approve(id, decision = "approve") {
	await expect.poll(async () => (await snapshot(id)).pendingApprovals.length, { timeout: 20_000 }).toBe(1);
	await page
		.getByRole("region", { name: "\u9700\u8981\u6279\u51c6\u5de5\u5177\u8c03\u7528" })
		.getByRole("button", { name: decision === "approve" ? "\u5141\u8bb8" : "\u62d2\u7edd", exact: true })
		.click();
}
async function passed(name) {
	report.passed.push(name);
	console.log(`PASS ${name}`);
}
try {
	await launch();
	const config = {
		...model,
		name: "Desktop fixture",
		api: "openai-completions",
		baseUrl: provider.baseUrl,
		apiKey: "desktop-fixture-only",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxOutputTokens: 512,
	};
	await rpc.request({ type: "model.custom.set", config });
	await rpc.request({ type: "model.custom.test", model });
	await passed("model connection through real Pi provider wire");
	// Keep native dialog interaction deterministic; exercise the actual renderer -> Gateway -> parent IPC path.
	await desktop.evaluate(({ dialog }, workspace) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
	}, workspace);
	await page.getByRole("button", { name: "\u6253\u5f00\u9879\u76ee", exact: true }).click();
	await page
		.getByRole("dialog", { name: "\u6253\u5f00\u9879\u76ee" })
		.getByRole("button", { name: /\u6587\u4ef6\u6216\u6587\u4ef6\u5939/ })
		.click();
	await expect(page.getByRole("dialog", { name: "\u6253\u5f00\u9879\u76ee" })).toHaveCount(0);
	const workspaces = await rpc.request({ type: "workspace.list" });
	workspaceId = workspaces.workspaces.find((value) => value.id !== "local-workspace")?.id;
	assert.ok(workspaceId);
	await passed("native picker bridge with Chinese and spaced project path");

	const copied = await createSession("Desktop file round-trip");
	await prompt("copy");
	await expect.poll(async () => (await snapshot(copied)).pendingApprovals.length, { timeout: 20_000 }).toBe(1);
	await assert.rejects(access(join(workspace, "result.txt")));
	await approve(copied);
	await approve(copied);
	await expect.poll(async () => (await run(copied))?.status, { timeout: 30_000 }).toBe("completed");
	assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), proof);
	const tools = (await snapshot(copied)).transcript.filter((item) => item.type === "tool");
	assert.deepEqual(
		tools.map((item) => item.toolName),
		["read_file", "write_file", "read_file", "exec"]
	);
	await expect(page.getByText("DESKTOP_COPY_VERIFIED", { exact: true })).toBeVisible();
	await passed("approved read/write/readback/command with exact on-disk verification");

	const denied = await createSession("Desktop denied operation");
	await prompt("deny");
	await approve(denied, "deny");
	await expect.poll(async () => (await snapshot(denied)).session.phase, { timeout: 20_000 }).toBe("idle");
	await assert.rejects(access(join(workspace, "denied.txt")));
	assert.ok((await snapshot(denied)).transcript.some((item) => item.type === "tool" && item.status === "error"));
	await passed("denied approval has no filesystem side effect");

	const hanging = await createSession("Desktop stopped request");
	await prompt("hang");
	await expect.poll(() => provider.held.size, { timeout: 20_000 }).toBe(1);
	await page.getByRole("button", { name: "\u505c\u6b62\u4efb\u52a1", exact: true }).click();
	await expect.poll(async () => (await run(hanging))?.status, { timeout: 20_000 }).toBe("interrupted");
	await expect.poll(() => provider.held.size).toBe(0);
	await passed("stop cancels an unresponsive provider request");

	const unauthorized = await createSession("Desktop rejected credentials");
	await prompt("unauthorized");
	await expect.poll(async () => (await run(unauthorized))?.status, { timeout: 30_000 }).toBe("failed");
	assert.equal(provider.requests.filter((item) => item.scenario === "unauthorized").length, 1);
	await passed("401 is reported as failure without repeated billable retries");

	const active = await createSession("Desktop quit during execution");
	await prompt("quit-active");
	await expect.poll(() => provider.held.size, { timeout: 20_000 }).toBe(1);
	const oldBase = connection.websocketUrl.replace("ws:", "http:").replace("/api/ws", "");
	await close();
	await expect.poll(() => provider.held.size).toBe(0);
	await assert.rejects(fetch(`${oldBase}/health`, { signal: AbortSignal.timeout(2000) }));
	await launch();
	await expect.poll(async () => (await run(active))?.status, { timeout: 15_000 }).toBe("interrupted");
	assert.equal(provider.requests.filter((item) => item.scenario === "quit-active").length, 1);
	assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), proof);
	await passed("quit during execution cleans up and does not silently repeat the request on restart");
	await selectSession(copied);
	await expect(page.getByText("DESKTOP_COPY_VERIFIED", { exact: true })).toBeVisible();
	await passed("completed transcript and model configuration survive application restart");
	const crashBase = connection.websocketUrl.replace("ws:", "http:").replace("/api/ws", "");
	await desktop.evaluate(({ BrowserWindow, dialog }) => {
		dialog.showMessageBox = (options) => {
			globalThis.desktopFailureOptions = options;
			return new Promise((resolve) => {
				globalThis.desktopFailureResponse = resolve;
			});
		};
		BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
	});
	await expect
		.poll(() => desktop.evaluate(() => globalThis.desktopFailureOptions?.buttons))
		.toEqual(["Restart Pi-Wm", "Quit"]);
	assert.match(await desktop.evaluate(() => globalThis.desktopFailureOptions.detail), /Workbench stopped/);
	await rpc.close();
	rpc = undefined;
	const crashedClosed = desktop.waitForEvent("close", { timeout: 20_000 });
	await desktop.evaluate(() => {
		setImmediate(() => globalThis.desktopFailureResponse({ response: 1 }));
	});
	await crashedClosed;
	desktop = undefined;
	page = undefined;
	await assert.rejects(fetch(`${crashBase}/health`, { signal: AbortSignal.timeout(2000) }));
	await launch();
	await selectSession(copied);
	await expect(page.getByText("DESKTOP_COPY_VERIFIED", { exact: true })).toBeVisible();
	await passed("renderer crash offers recovery, quits cleanly, and preserves completed work");
	assert.deepEqual(provider.errors, []);
} catch (error) {
	report.failures.push(error.message);
	if (page && !page.isClosed()) {
		const text = await page
			.locator("body")
			.innerText()
			.catch(() => "Renderer unavailable");
		await writeFile(join(output, "failure-dom.txt"), text).catch(() => {});
	}
	throw error;
} finally {
	try {
		await close();
		await provider.close();
		report.requests = provider.requests;
		report.fixtureErrors = provider.errors;
		report.relocated = Boolean(release);
		await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
		await rm(temporary, { recursive: true, force: true });
	} finally {
		await release?.dispose();
	}
}

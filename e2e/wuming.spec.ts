import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = "wuming-e2e-token";
const services: ChildProcess[] = [];
let temporaryRoot: string;
let webUrl: string;

async function startService(
	name: string,
	args: string[],
	cwd: string,
	environment: Record<string, string>,
	readyPattern: RegExp,
): Promise<{ process: ChildProcess; match: RegExpMatchArray }> {
	const child = spawn(process.execPath, args, {
		cwd,
		env: { ...process.env, ...environment },
		stdio: ["ignore", "pipe", "pipe"],
	});
	services.push(child);
	let output = "";
	child.stdout?.on("data", (chunk) => { output += String(chunk); });
	child.stderr?.on("data", (chunk) => { output += String(chunk); });
	const match = await new Promise<RegExpMatchArray>((resolveMatch, reject) => {
		const timeout = setTimeout(() => reject(new Error(`${name} startup timed out\n${output}`)), 20_000);
		const inspect = () => {
			const found = output.match(readyPattern);
			if (!found) return;
			clearTimeout(timeout);
			resolveMatch(found);
		};
		child.stdout?.on("data", inspect);
		child.stderr?.on("data", inspect);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`${name} exited during startup with code ${code}\n${output}`));
		});
	});
	return { process: child, match };
}

async function stopService(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([
		once(child, "exit"),
		new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
	]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await once(child, "exit");
	}
}

async function createSession(page: Page): Promise<void> {
	await page.getByRole("button", { name: "新建会话" }).click();
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
}

async function sendMessage(page: Page, message: string): Promise<void> {
	await page.getByRole("textbox", { name: "消息" }).fill(message);
	await page.getByRole("button", { name: "发送" }).click();
}

test.beforeAll(async () => {
	temporaryRoot = await mkdtemp(join(tmpdir(), "wuming-web-e2e-"));
	const workspace = join(temporaryRoot, "workspace");
	const data = join(temporaryRoot, "data");
	await Promise.all([mkdir(workspace), mkdir(data)]);
	const gateway = await startService(
		"Gateway",
		["--import", "tsx", join(repositoryRoot, "apps/gateway/src/main.ts")],
		repositoryRoot,
		{
			WUMING_HOST: "127.0.0.1",
			WUMING_PORT: "0",
			WUMING_TOKEN: token,
			WUMING_RUNTIME: "demo",
			WUMING_WORKSPACE: workspace,
			WUMING_DATA_DIR: data,
			WUMING_TERMINAL_MODE: "disabled",
			WUMING_RETRY_BASE_DELAY_MS: "10",
		},
		/Wuming gateway listening on http:\/\/127\.0\.0\.1:(\d+)/,
	);
	const gatewayPort = Number(gateway.match[1]);
	const web = await startService(
		"Web",
		[join(repositoryRoot, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "0", "--strictPort"],
		join(repositoryRoot, "apps/web"),
		{ WUMING_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}` },
		/Local:\s+http:\/\/127\.0\.0\.1:(\d+)\//,
	);
	webUrl = `http://127.0.0.1:${Number(web.match[1])}/`;
});

test.afterAll(async () => {
	for (const child of services.splice(0).reverse()) await stopService(child);
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
	await page.addInitScript((value) => localStorage.setItem("wuming.token", value), token);
	await page.goto(webUrl);
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
});

test("persists a completed turn across a browser reload", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "Persist this E2E result");
	await expect(page.getByText(/Demo runtime received: Persist this E2E result/)).toBeVisible();
	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await expect(page.getByText(/Demo runtime received: Persist this E2E result/)).toBeVisible();
});

test("approves a tool and stops a long-running turn", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "/approval");
	const approval = page.getByRole("region", { name: "需要批准工具调用" });
	await expect(approval).toBeVisible();
	await approval.getByRole("button", { name: "允许" }).click();
	await expect(page.getByText("Demo approval was granted. No filesystem or process action was executed.")).toBeVisible();
	await sendMessage(page, "/long");
	const stop = page.getByRole("button", { name: "停止任务" });
	await expect(stop).toBeVisible();
	await stop.click();
	await expect(stop).toBeHidden();
	await expect(page.getByRole("textbox", { name: "消息" })).toHaveAttribute("placeholder", "给 Wuming 发送任务或问题");
});

test("shows a thinking activity before the first model event", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "/inject");
	const thinking = page.getByRole("status", { name: "正在思考" });
	await expect(thinking).toBeVisible();
	await expect(thinking.locator(".thinking-bars i")).toHaveCount(4);
	await page.getByRole("button", { name: "停止任务" }).click();
	await expect(thinking).toBeHidden();
});

test("completes and cancels durable subagents", async ({ page }) => {
	await createSession(page);
	await page.getByRole("tab", { name: "智能体" }).click();
	await page.getByRole("textbox", { name: "任务" }).fill("Return an E2E child result");
	await page.getByRole("textbox", { name: "名称" }).fill("E2E completion");
	await page.getByRole("button", { name: "创建智能体" }).click();
	await expect(page.getByText("已完成", { exact: true }).last()).toBeVisible();
	await expect(page.getByText(/Demo runtime received: Return an E2E child result/)).toBeVisible();

	await page.getByRole("textbox", { name: "任务" }).fill("/approval");
	await page.getByRole("textbox", { name: "名称" }).fill("E2E cancellation");
	await page.getByRole("button", { name: "创建智能体" }).click();
	await expect(page.getByText("等待批准", { exact: true }).last()).toBeVisible();
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await expect(page.getByText("cancelled", { exact: true }).last()).toBeVisible();
	await expect(page.getByText("Turn aborted by user", { exact: true })).toBeVisible();
});

test("keeps the Agents workbench within a mobile viewport", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "打开导航" }).click();
	await createSession(page);
	await page.getByRole("button", { name: "关闭导航" }).first().click();
	await page.getByRole("tab", { name: "智能体" }).click();
	await expect(page.getByRole("region", { name: "子智能体" })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
});

test("shows the server tool catalog without mobile page overflow", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await page.getByRole("tab", { name: "工具" }).click();
	const catalog = page.getByRole("table", { name: "Agent 工具目录" });
	await expect(catalog).toBeVisible();
	await expect(page.getByText("Demo", { exact: true })).toBeVisible();
	await expect(page.getByText("8 禁用", { exact: true })).toBeVisible();
	await expect(catalog.locator(".tool-status-row")).toHaveCount(8);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	expect(await catalog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(390);
});

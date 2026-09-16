import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const token = "project-folder-test";
const services: ChildProcess[] = [];
let temporaryRoot: string;
let webUrl: string;
let projectId: string;

async function start(args: string[], cwd: string, env: Record<string, string>, pattern: RegExp): Promise<number> {
	const child = spawn(process.execPath, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	services.push(child);
	return new Promise((resolvePort, reject) => {
		let output = "";
		const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 30_000);
		const inspect = (chunk: Buffer) => {
			output += String(chunk);
			const match = output.replaceAll(new RegExp("\\u001B\\[[0-9;]*m", "g"), "").match(pattern);
			if (match) {
				clearTimeout(timeout);
				resolvePort(Number(match[1]));
			}
		};
		child.stdout?.on("data", inspect);
		child.stderr?.on("data", inspect);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Service exited (${code}): ${output}`));
		});
	});
}

test.beforeAll(async ({ request }) => {
	temporaryRoot = await mkdtemp(join(tmpdir(), "wuming-open-folder-"));
	const workspace = join(temporaryRoot, "workspace");
	await mkdir(workspace);
	const gatewayPort = await start(
		["--import", "tsx", join(root, "apps/gateway/src/main.ts")],
		root,
		{
			WUMING_HOST: "127.0.0.1",
			WUMING_PORT: "0",
			WUMING_TOKEN: token,
			WUMING_RUNTIME: "demo",
			WUMING_WORKSPACE: workspace,
			WUMING_DATA_DIR: join(temporaryRoot, "data"),
			WUMING_DEPLOYMENT_MODE: "local_device",
			WUMING_PROCESS_MODE: "disabled",
			WUMING_TERMINAL_MODE: "disabled",
		},
		/Wuming gateway listening on http:\/\/127\.0\.0\.1:(\d+)/
	);
	const base = `http://127.0.0.1:${gatewayPort}`;
	const headers = { Authorization: `Bearer ${token}` };
	const created = await request.post(`${base}/api/projects`, { headers, data: { name: "新导入的项目" } });
	expect(created.ok()).toBeTruthy();
	projectId = (await created.json()).project.id;
	expect(
		(
			await request.put(`${base}/api/projects/${projectId}/files`, {
				headers: { ...headers, "X-Wuming-Project-Path": "notes.txt" },
				data: "project contents",
			})
		).ok()
	).toBeTruthy();
	expect((await request.post(`${base}/api/projects/${projectId}/complete`, { headers })).ok()).toBeTruthy();
	const webPort = await start(
		[join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "0", "--strictPort"],
		join(root, "apps/web"),
		{ WUMING_GATEWAY_URL: base },
		/Local:\s+http:\/\/127\.0\.0\.1:(\d+)\//
	);
	webUrl = `http://127.0.0.1:${webPort}`;
});

test.afterAll(async () => {
	for (const child of services.reverse()) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		const exited = once(child, "exit");
		child.kill();
		await exited;
	}
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

for (const width of [1440, 390]) {
	test(`opens an imported project folder and handles failure at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await page.addInitScript((value) => {
			localStorage.setItem("wuming.token", value);
			localStorage.setItem("wuming.onboarding.complete", "true");
		}, token);
		await page.goto(webUrl);
		await expect(page.locator(".connection.connected")).toHaveCount(1);
		if (width < 600) await page.locator(".mobile-menu").click();
		const more = page.getByRole("button", { name: "新导入的项目 项目菜单" });
		await page.locator(".project-row-wrap").filter({ has: more }).hover();
		await more.click();
		const action = page.getByRole("menuitem", { name: "在资源管理器中打开" });
		await expect(action).toBeEnabled();
		const bounds = await page.getByRole("menu").boundingBox();
		expect(bounds).not.toBeNull();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.y).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
		await page.screenshot({ path: testInfo.outputPath(`project-menu-${width}.png`) });
		let release!: () => void;
		const pending = new Promise<void>((resolveRequest) => {
			release = resolveRequest;
		});
		await page.route(`**/api/projects/${projectId}/open-folder`, async (route) => {
			expect(route.request().method()).toBe("POST");
			expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
			await pending;
			await route.fulfill({ status: 204 });
		});
		await action.click();
		await expect(page.getByRole("menu")).toBeHidden();
		await expect(more).toBeDisabled();
		release();
		await expect(more).toBeEnabled();
		await page.unroute(`**/api/projects/${projectId}/open-folder`);
		await page.route(`**/api/projects/${projectId}/open-folder`, (route) =>
			route.fulfill({
				status: 404,
				contentType: "application/json",
				body: JSON.stringify({ error: "项目目录不存在或无法访问。" }),
			})
		);
		await page.locator(".project-row-wrap").filter({ has: more }).hover();
		await more.click();
		await action.click();
		await expect(page.locator(".project-action-error")).toHaveText("项目目录不存在或无法访问。");
		await expect(more).toBeEnabled();
	});
}

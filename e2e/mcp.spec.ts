import { expect, test } from "@playwright/test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
let failureFlag: string;
test.beforeAll(async () => {
	webUrl = await startWebApp(
		{
			WUMING_DEPLOYMENT_MODE: "local_device",
			WUMING_MCP_TRUSTED_SERVERS_JSON: JSON.stringify([
				{ workspaceId: "local-workspace", serverId: "broken" },
				{ workspaceId: "local-workspace", serverId: "empty" },
			]),
		},
		async (workspace) => {
			failureFlag = join(workspace, "fail-mcp");
			const script = join(workspace, "mcp.cjs");
			await writeFile(
				script,
				[
					'const fs = require("node:fs");',
					'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
					" const request = JSON.parse(line); if (request.id === undefined) return;",
					' if (request.method === "tools/list" && process.argv[2] === "broken" && fs.existsSync("fail-mcp")) { process.stderr.write("private-error-canary", () => process.exit(1)); return; }',
					' const result = request.method === "tools/list" ? { tools: [] } : {};',
					' process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + String.fromCharCode(10));',
					"});",
				].join("\n"),
				"utf8"
			);
			await mkdir(join(workspace, ".wuming"));
			await writeFile(
				join(workspace, ".wuming", "mcp.json"),
				JSON.stringify({
					servers: ["broken", "empty", "untrusted"].map((id) => ({
						id,
						command: process.execPath,
						args: [script, id],
						readOnly: true,
					})),
				}),
				"utf8"
			);
		}
	);
});
test.afterAll(async () => {
	await stopWebApp();
});

test("toggling another service preserves list order and the open detail", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("tab", { name: "MCP", exact: true }).click();
	const workbench = page.getByRole("region", { name: "MCP 服务" });
	await workbench.getByRole("button", { name: "查看 empty", exact: true }).click();
	await expect(workbench.getByText("该服务未提供工具", { exact: true })).toBeVisible();
	const names = workbench.locator(".mcp-server-name strong");
	const order = await names.allTextContents();
	const toggle = workbench.getByRole("switch", { name: "启用 untrusted", exact: true });
	await toggle.click();
	await expect(toggle).not.toBeChecked();
	await expect(names).toHaveText(order);
	await expect(workbench.getByText("该服务未提供工具", { exact: true })).toBeVisible();
	await toggle.click();
	await expect(toggle).toBeChecked();
	await expect(workbench.locator(".mcp-server-open").filter({ hasText: "untrusted" })).toContainText("待授权");
	await expect(names).toHaveText(order);
});

for (const action of ["new selection", "refresh", "late failure"] as const) {
	test("late MCP response cannot undo " + action, async ({ page }) => {
		let armed = false;
		let release: (() => void) | undefined;
		let heldRequestId: string | undefined;
		await page.addInitScript(() => {
			const received: string[] = [];
			Object.defineProperty(window, "__mcpReceived", { value: received });
			const NativeWebSocket = window.WebSocket;
			window.WebSocket = class extends NativeWebSocket {
				constructor(url: string | URL, protocols?: string | string[]) {
					super(url, protocols);
					this.addEventListener("message", (event) => {
						try {
							const message = JSON.parse(String(event.data));
							if (message.requestId) received.push(message.requestId);
						} catch {
							/* Non-JSON traffic is not a command response. */
						}
					});
				}
			};
		});
		await page.routeWebSocket(/\/api\/ws/, (socket) => {
			const server = socket.connectToServer();
			server.onMessage((message) => {
				const value = JSON.parse(String(message));
				const hold = value.result?.type === "mcp.get" && value.result.server.id === "empty";
				if (armed && hold && !release) {
					heldRequestId = value.requestId;
					release = () =>
						socket.send(
							action === "late failure"
								? JSON.stringify({
										type: "response",
										requestId: value.requestId,
										ok: false,
										error: { code: "internal_error", message: "private-stale-error-canary" },
									})
								: message
						);
				} else socket.send(message);
			});
		});
		await openApp(page, webUrl);
		await page.getByRole("tab", { name: "MCP", exact: true }).click();
		const workbench = page.getByRole("region", { name: "MCP 服务" });
		await expect(workbench.locator(".mcp-server-open")).toHaveCount(3);
		armed = true;
		await workbench.locator(".mcp-server-open").filter({ hasText: "empty" }).click();
		await expect.poll(() => Boolean(release)).toBe(true);
		if (action === "refresh") {
			await workbench.getByRole("button", { name: "刷新 MCP 服务", exact: true }).click();
			await expect(workbench.getByRole("button", { name: "刷新 MCP 服务", exact: true })).toBeEnabled();
		} else {
			await workbench.locator(".mcp-server-open").filter({ hasText: "untrusted" }).click();
			await expect(workbench.locator(".mcp-server.is-expanded .mcp-server-name strong")).toHaveText("untrusted");
		}
		release!();
		await expect
			.poll(() =>
				page.evaluate(
					(requestId) => (window as unknown as { __mcpReceived: string[] }).__mcpReceived.includes(requestId!),
					heldRequestId
				)
			)
			.toBe(true);
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
		if (action === "refresh") await expect(workbench.locator(".mcp-detail")).toHaveCount(0);
		else await expect(workbench.locator(".mcp-server.is-expanded .mcp-server-name strong")).toHaveText("untrusted");
		await expect(workbench.locator(".workbench-error")).toHaveCount(0);
		await expect(workbench.locator(".mcp-server-open").filter({ hasText: "empty" })).toContainText("0 个工具");
		await expect(page.locator("body")).not.toContainText("private-stale-error-canary");
	});
}

for (const width of [1365, 390]) {
	test("distinguishes MCP failure from empty and untrusted catalogs at width " + width, async ({ page }, testInfo) => {
		await writeFile(failureFlag, "fail", "utf8");
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		await page.getByRole("tab", { name: "MCP", exact: true }).click();
		const workbench = page.getByRole("region", { name: "MCP 服务" });
		const broken = workbench.locator(".mcp-server-open").filter({ hasText: "broken" });
		await expect(broken).toContainText("连接异常");
		await expect(workbench.locator(".mcp-server-open").filter({ hasText: "empty" })).toContainText("0 个工具");
		await expect(workbench.locator(".mcp-server-open").filter({ hasText: "untrusted" })).toContainText("待授权");
		await broken.click();
		await expect(workbench.locator(".workbench-error")).toContainText("MCP 工具发现失败");
		await expect(page.locator("body")).not.toContainText("private-error-canary");
		await workbench.getByRole("tab", { name: "诊断", exact: true }).click();
		await expect(workbench.getByRole("tabpanel")).toContainText("本机启动命令");
		await page.screenshot({ path: testInfo.outputPath("mcp-failure.png") });
		await unlink(failureFlag);
		await broken.click();
		await expect(broken).toContainText("0 个工具");
		await expect(workbench.locator(".workbench-error")).toHaveCount(0);
		await expect(workbench.getByText("该服务未提供工具", { exact: true })).toBeVisible();
	});
}

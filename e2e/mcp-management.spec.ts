import { expect, test } from "@playwright/test";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
let workspace: string;
let script: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_DEPLOYMENT_MODE: "local_device" }, async (root) => {
		workspace = root;
		script = join(root, "mcp-fixture.cjs");
		await writeFile(
			script,
			[
				'const fs = require("node:fs");',
				'fs.writeFileSync("started.txt", "started");',
				'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
				" const r = JSON.parse(line); if (r.id === undefined) return;",
				' const result = r.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : r.method === "tools/list" ? { tools: [{ name: "echo", description: "Fixture echo", inputSchema: { type: "object", properties: {} } }] } : { content: [{ type: "text", text: "ok" }] };',
				' process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + String.fromCharCode(10));',
				"});",
			].join("\n")
		);
	});
});
test.afterAll(stopWebApp);

for (const width of [1440, 390]) {
	test("manages MCP configuration, trust and credentials at width " + width, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		await page.getByRole("tab", { name: "MCP", exact: true }).click();
		const workbench = page.getByRole("region", { name: "MCP 服务" });
		await workbench.getByRole("button", { name: "新增 MCP 服务", exact: true }).click();
		let dialog = page.getByRole("dialog", { name: "新增 MCP 服务" });
		await dialog.getByLabel("服务 ID", { exact: true }).fill("fixture-" + width);
		await dialog.getByLabel("显示名称").fill("本地文档服务");
		await dialog.getByLabel("启动命令", { exact: true }).fill(process.execPath);
		await dialog.getByLabel("启动参数（JSON 数组）").fill(JSON.stringify([script]));
		await dialog.getByRole("button", { name: "添加变量" }).click();
		await dialog.getByLabel("变量名 1", { exact: true }).fill("TEST_KEY");
		await dialog.getByLabel("变量值 1", { exact: true }).fill("local-secret-canary");
		await expect(dialog.getByLabel("变量值 1", { exact: true })).toHaveAttribute("type", "password");
		await page.screenshot({ path: testInfo.outputPath("mcp-config-" + width + ".png") });
		await expect(dialog).toBeInViewport();
		await dialog.getByRole("button", { name: "保存配置" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(workbench.locator(".skill-entry")).toContainText("待授权");
		if (width === 1440)
			expect(
				await access(join(workspace, "started.txt")).then(
					() => true,
					() => false
				)
			).toBe(false);
		await workbench.getByRole("button", { name: "授权并连接", exact: true }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "确认授权并连接" }).click();
		await expect(page.getByRole("alertdialog")).toHaveCount(0);
		await expect(workbench.locator(".skill-entry")).toContainText("1 个工具");
		await expect(workbench.locator(".mcp-tool strong")).toHaveText("echo");
		await page.screenshot({ path: testInfo.outputPath("mcp-ready-" + width + ".png") });
		await workbench.getByRole("button", { name: "编辑服务" }).click();
		dialog = page.getByRole("dialog", { name: "编辑 MCP 服务" });
		await expect(dialog.getByLabel("变量值 1", { exact: true })).toHaveValue("");
		await expect(dialog.getByLabel("变量值 1", { exact: true })).toHaveAttribute("placeholder", "已保存");
		await dialog.getByLabel("显示名称").fill("更新后的文档服务");
		await dialog.getByRole("button", { name: "保存配置" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(workbench.locator(".skill-entry")).toContainText("待授权");
		const stored = JSON.parse(await readFile(join(workspace, ".wuming", "mcp.json"), "utf8"));
		expect(stored.servers.find((entry: { id: string }) => entry.id === "fixture-" + width).env.TEST_KEY).toBe(
			"local-secret-canary"
		);
		await workbench.getByRole("button", { name: "授权并连接", exact: true }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "确认授权并连接" }).click();
		await expect(page.getByRole("alertdialog")).toHaveCount(0);
		await workbench.getByRole("button", { name: "停用", exact: true }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "确认停用服务" }).click();
		await expect(page.getByRole("alertdialog")).toHaveCount(0);
		await expect(workbench.locator(".skill-entry")).toContainText("待授权");
		await workbench.getByRole("button", { name: "删除服务" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
		await expect(workbench.locator(".skill-entry")).toHaveCount(1);
		await workbench.getByRole("button", { name: "删除服务" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "确认删除服务" }).click();
		await expect(workbench.locator(".skill-entry")).toHaveCount(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	});
}

test("imports JSON into a disabled remote server without connecting", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("tab", { name: "MCP", exact: true }).click();
	await page.getByRole("button", { name: "新增 MCP 服务", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "新增 MCP 服务" });
	await dialog.getByRole("tab", { name: "导入 JSON" }).click();
	await dialog.getByLabel("JSON 配置").fill(
		JSON.stringify({
			mcpServers: {
				remote: {
					type: "http",
					url: "https://example.invalid/mcp",
					enabled: false,
					headers: { Authorization: "Bearer test-only" },
				},
			},
		})
	);
	await dialog.getByRole("button", { name: "解析配置" }).click();
	await expect(dialog.getByLabel("服务 ID", { exact: true })).toHaveValue("remote");
	await expect(dialog.getByLabel("变量值 1", { exact: true })).toHaveAttribute("type", "password");
	await dialog.getByRole("button", { name: "保存配置" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.locator(".skill-entry")).toContainText("已禁用");
});

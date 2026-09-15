import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({}, async (workspace) => {
		for (const [id, text] of [
			["oversized", "x".repeat(200 * 1024 + 1)],
			["complete", "Review the supplied task carefully."],
		]) {
			const directory = join(workspace, ".wuming", "skills", id!);
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "SKILL.md"), text!, "utf8");
		}
	});
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const action of ["cancel", "new selection", "refresh"] as const) {
	test("late skill response cannot undo " + action, async ({ page }) => {
		let release: (() => void) | undefined;
		let delivered = 0;
		const turns: Array<{ skills?: string[] }> = [];
		page.on("websocket", (socket) => {
			socket.on("framereceived", ({ payload }) => {
				const message = JSON.parse(String(payload));
				if (message.result?.type === "skill.get" && message.result.skill.id === "oversized") delivered++;
			});
			socket.on("framesent", ({ payload }) => {
				const message = JSON.parse(String(payload));
				if (message.command?.type === "turn.prompt") turns.push(message.command);
			});
		});
		await page.routeWebSocket(/\/api\/ws/, (socket) => {
			const server = socket.connectToServer();
			server.onMessage((message) => {
				const value = JSON.parse(String(message));
				if (value.result?.type === "skill.get" && value.result.skill.id === "oversized")
					release = () => socket.send(message);
				else socket.send(message);
			});
		});
		await openApp(page, webUrl);
		await page.getByRole("tab", { name: "技能", exact: true }).click();
		const workbench = page.getByRole("region", { name: "技能", exact: true });
		const heading = workbench.locator(".editor-heading strong");
		await workbench.locator(".skill-entry").filter({ hasText: "complete" }).click();
		await expect(heading).toHaveText("complete");
		await workbench.locator(".skill-entry").filter({ hasText: "oversized" }).click();
		await expect.poll(() => Boolean(release)).toBe(true);
		if (action === "cancel") await workbench.getByRole("button", { name: "取消技能", exact: true }).click();
		else if (action === "refresh") await workbench.getByRole("button", { name: "刷新技能", exact: true }).click();
		else await workbench.locator(".skill-entry").filter({ hasText: "complete" }).click();
		release!();
		await expect.poll(() => delivered).toBe(1);
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
		if (action === "new selection") await expect(heading).toHaveText("complete");
		else await expect(workbench.getByText("选择一个技能", { exact: true })).toBeVisible();
		await page.getByRole("tab", { name: "对话", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveAttribute(
			"placeholder",
			"给 Pi-Wm 发送任务或问题（@ 引用文件，/ 快捷命令）"
		);
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("After delayed skill response");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect.poll(() => turns.length).toBe(1);
		expect(turns[0]?.skills).toEqual(action === "new selection" ? ["complete"] : undefined);
	});
}

for (const width of [1365, 390]) {
	test("blocks truncated skills and permits recovery at width " + width, async ({ page }, testInfo) => {
		const turns: Array<{ skills?: string[] }> = [];
		page.on("websocket", (socket) =>
			socket.on("framesent", ({ payload }) => {
				const value = JSON.parse(String(payload)) as {
					type?: string;
					command?: { type?: string; skills?: string[] };
				};
				if (value.type === "request" && value.command?.type === "turn.prompt") turns.push(value.command);
			})
		);
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		await page.getByRole("tab", { name: "技能", exact: true }).click();
		const workbench = page.getByRole("region", { name: "技能", exact: true });
		await workbench.locator(".skill-entry").filter({ hasText: "oversized" }).click();
		await expect(workbench.getByRole("alert")).toContainText("无法用于执行");
		await page.getByRole("tab", { name: "对话", exact: true }).click();
		await expect(page.locator(".composer-wrap").getByRole("alert")).toContainText("技能内容已截断");
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("Skill guard recovery");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(
			page.getByText("所选技能内容已截断，无法执行。请先精简技能文件或取消技能。", {
				exact: true,
			})
		).toBeVisible();
		expect(turns).toHaveLength(0);
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("Skill guard recovery");
		await page.screenshot({ path: testInfo.outputPath("skill-warning.png") });
		await page.getByRole("button", { name: "取消技能", exact: true }).click();
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect.poll(() => turns.length).toBe(1);
		expect(turns[0]?.skills).toBeUndefined();
		await page.getByRole("tab", { name: "技能", exact: true }).click();
		await workbench.locator(".skill-entry").filter({ hasText: "complete" }).click();
		await page.getByRole("tab", { name: "对话", exact: true }).click();
		await expect(page.locator(".composer-wrap").getByRole("status")).toContainText("当前技能：complete");
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveAttribute(
			"placeholder",
			"给 Pi-Wm 发送任务或问题（@ 引用文件，/ 快捷命令）"
		);
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("Use the complete skill");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect.poll(() => turns.length).toBe(2);
		expect(turns[1]?.skills).toEqual(["complete"]);
	});
}

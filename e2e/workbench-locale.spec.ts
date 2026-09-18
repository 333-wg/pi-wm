import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(stopWebApp);

test("switches the entire chat workbench in both directions and preserves conversation content", async ({
	page,
}, testInfo) => {
	test.setTimeout(90_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 1600, height: 1000 });
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		server.onMessage((message) => {
			const parsed = JSON.parse(String(message), (_key, value) => {
				if (!value?.session || !Array.isArray(value.transcript) || !value.transcript.length) return value;
				const tools = [
					["computer_screenshot", { monitor: 1 }, "complete"],
					["computer_action", { action: { kind: "double_click" } }, "error"],
					["computer_release", {}, "complete"],
				].map(([toolName, input, status], index) => ({
					id: "locale-tool-" + index,
					toolCallId: "locale-tool-" + index,
					type: "tool",
					toolName,
					input,
					status,
					content: [],
					createdAt: 100 + index,
				}));
				return { ...value, transcript: [value.transcript[0], ...tools, ...value.transcript.slice(1)] };
			});
			socket.send(JSON.stringify(parsed));
		});
	});
	await openApp(page, webUrl);
	const original = "这段中文聊天内容应保持原样";
	await page.getByRole("textbox", { name: "消息", exact: true }).fill(original);
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".message-row.assistant")).toContainText("Demo runtime received:");
	await page.reload();
	await page.getByRole("button", { name: original, exact: true }).click();
	await expect(page.locator(".tool-verb").filter({ hasText: "桌面截图" })).toBeVisible();
	await page.locator(".sidebar-footer").getByRole("button", { name: "设置", exact: true }).click();
	await page
		.getByRole("dialog", { name: "设置", exact: true })
		.getByRole("button", { name: "English", exact: true })
		.click();
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await page
		.getByRole("dialog", { name: "Settings", exact: true })
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await expect(page.locator(".sidebar-new-chat")).toHaveText("New chat");
	await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Search messages" })).toBeVisible();
	await expect(page.locator(".session-archive-switch")).toHaveText("View archived chats");
	await page.getByRole("button", { name: "Show or hide run panel", exact: true }).click();
	await expect(page.locator(".run-diagnostics h2")).toHaveText("Run diagnostics");
	await expect(page.locator(".run-diagnostics")).toContainText("No active tasks");
	await expect(page.locator(".right-rail")).toContainText("Recent runs");
	await expect(page.locator(".tool-verb").filter({ hasText: "Desktop screenshot" })).toBeVisible();
	await expect(page.locator(".tool-verb").filter({ hasText: "Desktop · Double click" })).toBeVisible();
	await expect(page.locator(".tool-state.error")).toHaveText("Failed");
	await expect(page.locator(".message-row.user")).toContainText(original);
	for (const selector of [".right-rail", ".permission-trigger", ".thinking-trigger", ".tool-trace-summary"]) {
		expect((await page.locator(selector).allTextContents()).join(" "), selector).not.toMatch(/[\u3400-\u9fff]/);
	}
	await page.locator(".permission-trigger").click();
	await expect(page.getByRole("menu", { name: "Tool permissions" })).toBeVisible();
	expect(await page.locator(".permission-menu").innerText()).not.toMatch(/[\u3400-\u9fff]/);
	await page.keyboard.press("Escape");
	await page.screenshot({ path: testInfo.outputPath("workbench-en-desktop.png"), fullPage: true });
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await page.getByRole("button", { name: original, exact: true }).click();
	await page.getByRole("button", { name: "Show or hide run panel", exact: true }).click();
	await expect(page.locator(".run-diagnostics h2")).toHaveText("Run diagnostics");
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		const closeRail = page.getByRole("button", { name: "Close run panel", exact: true }).first();
		if (await closeRail.isVisible()) await closeRail.click();
		await page.getByRole("button", { name: "Open navigation", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "Search messages" })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
		await page.screenshot({ path: testInfo.outputPath("workbench-en-mobile-" + width + ".png"), fullPage: true });
		await page.getByRole("button", { name: "Close navigation", exact: true }).first().click();
		for (const summary of await page.locator(".tool-trace-summary").all()) {
			expect(await summary.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
			await expect(summary.locator(".tool-state svg")).toBeInViewport();
		}
		await page.screenshot({ path: testInfo.outputPath("workbench-en-chat-" + width + ".png"), fullPage: true });
	}
	await page.setViewportSize({ width: 1600, height: 1000 });
	await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
	await page
		.getByRole("dialog", { name: "Settings", exact: true })
		.getByRole("button", { name: "中文", exact: true })
		.click();
	await page
		.getByRole("dialog", { name: "设置", exact: true })
		.getByRole("button", { name: "关闭", exact: true })
		.click();
	await expect(page.locator(".sidebar-new-chat")).toHaveText("新对话");
	await expect(page.getByRole("textbox", { name: "搜索聊天正文" })).toBeVisible();
	await expect(page.locator(".tool-verb").filter({ hasText: "桌面截图" })).toBeVisible();
	await expect(page.locator(".message-row.user")).toContainText(original);
	await page.screenshot({ path: testInfo.outputPath("workbench-zh-desktop.png"), fullPage: true });
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
	expect(errors).toEqual([]);
});

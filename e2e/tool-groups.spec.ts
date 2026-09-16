import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(stopWebApp);

test("groups repeated reads in the transcript and keeps details accessible across viewports", async ({
	page,
}, testInfo) => {
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		server.onMessage((message) => {
			const parsed = JSON.parse(String(message), (_key, value) => {
				if (!value?.session || !Array.isArray(value.transcript) || value.transcript.length === 0) return value;
				const base = { sessionId: value.session.id, createdAt: Date.now() };
				const reads = Array.from({ length: 8 }, (_, index) => ({
					...base,
					id: "fixture-read-" + index,
					type: "tool",
					toolCallId: "fixture-read-" + index,
					toolName: "read_file",
					status: "complete",
					isError: false,
					input: { path: "backend/src/services/ExampleService" + index + ".java", limit: 360 },
					content: [{ type: "text", text: "Original file content " + index }],
				}));
				const hidden = {
					...base,
					id: "hidden",
					type: "assistant",
					status: "complete",
					model: { provider: "demo", id: "wuming-demo" },
					content: [{ type: "tool_call", toolCallId: "fixture-read-4", toolName: "read_file", input: {} }],
				};
				const matches = [0, 1].map((index) => ({
					...reads[index],
					id: "match-" + index,
					toolCallId: "match-" + index,
					toolName: "glob",
					input: { pattern: "**/*.ts", path: index ? "frontend" : "backend" },
				}));
				const failed = { ...reads[0], id: "failed", toolCallId: "failed", status: "error", isError: true };
				return {
					...value,
					transcript: [
						value.transcript[0],
						...reads.slice(0, 4),
						hidden,
						...reads.slice(4),
						...matches,
						failed,
						...value.transcript.slice(1),
					],
				};
			});
			socket.send(JSON.stringify(parsed));
		});
	});
	await openApp(page, webUrl);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("检查项目文件");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".message-row.assistant")).toContainText("Demo runtime received:");
	await page.reload();
	// Projectless startup intentionally opens a draft; reopen the saved conversation.
	await page.getByRole("button", { name: "检查项目文件", exact: true }).click();
	const groups = page.locator(".tool-group");
	await expect(groups).toHaveCount(2);
	const summary = groups.first().locator(".tool-group-summary");
	await expect(summary).toContainText("8 次");
	await expect(summary).toHaveAttribute("aria-expanded", "false");
	await expect(page.locator(".transcript > .tool-row")).toHaveCount(3);
	await expect(page.locator(".transcript > .tool-error")).toContainText("失败");
	const closeRail = page.getByRole("button", { name: "关闭运行面板", exact: true }).first();
	if (await closeRail.isVisible()) await closeRail.click();
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		if (await closeRail.isVisible()) await closeRail.click();
		await summary.scrollIntoViewIfNeeded();
		await page.screenshot({ path: testInfo.outputPath("collapsed-" + width + ".png") });
		await summary.click();
		await expect(groups.first().locator(".tool-group-items > .tool-row")).toHaveCount(8);
		const first = groups.first().locator(".tool-group-items .tool-trace-summary").first();
		await first.click();
		await expect(groups.first().locator(".tool-result").first()).toContainText("Original file content 0");
		expect(await summary.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("expanded-" + width + ".png") });
		await summary.click();
		await expect(groups.first().locator(".tool-group-items")).toHaveCount(0);
	}
});

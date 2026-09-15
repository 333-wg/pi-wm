import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
const command =
	'git log --oneline -20 2>/dev/null; echo "---BRANCH---"; git branch -a 2>/dev/null; echo "---STATUS---"; git status 2>/dev/null | head -20';
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(stopWebApp);

test("command approval is readable across themes and viewports, and allows only one response", async ({ page }) => {
	let release: (() => void) | undefined;
	let responses = 0;
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		server.onMessage((message) => {
			// Only change the demo approval's display data; no shell command runs.
			const parsed = JSON.parse(String(message), (_key, value) => {
				if (value?.status === "pending" && value?.toolCallId && Array.isArray(value.capabilities)) {
					return {
						...value,
						risk: "high",
						summary: "Run: " + command,
						capabilities: [{ type: "process.exec", executable: "demo", args: [] }],
					};
				}
				return value;
			});
			socket.send(JSON.stringify(parsed));
		});
		socket.onMessage((message) => {
			const parsed = JSON.parse(String(message));
			if (parsed.command?.type === "approval.respond") {
				responses++;
				release = () => server.send(message);
			} else server.send(message);
		});
	});
	await openApp(page, webUrl);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/approval");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const panel = page.getByRole("region", { name: "需要批准工具调用" });
	await expect(panel).toBeVisible();
	await expect(panel.locator(".approval-command")).toHaveText(command);
	await expect(panel.locator(".approval-risk")).toHaveText("高风险");
	const closeRail = page.getByRole("button", { name: "关闭运行面板", exact: true }).first();
	if (await closeRail.isVisible()) await closeRail.click();
	for (const theme of ["light", "dark"]) {
		await page.evaluate((value) => {
			document.documentElement.dataset.theme = value;
		}, theme);
		for (const width of [1440, 390, 320]) {
			await page.setViewportSize({ width, height: 900 });
			if (width < 1080 && (await closeRail.isVisible())) await closeRail.click();
			await panel.scrollIntoViewIfNeeded();
			expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
			await expect(panel.getByRole("button", { name: "允许", exact: true })).toBeVisible();
			await panel.screenshot({ path: "test-results/approval-" + theme + "-" + width + ".png" });
		}
	}
	await panel.getByRole("button", { name: "允许", exact: true }).click();
	await expect(panel.getByRole("button", { name: "允许中", exact: true })).toBeDisabled();
	await expect(panel.getByRole("button", { name: "拒绝", exact: true })).toBeDisabled();
	expect(responses).toBe(1);
	release!();
	await expect(panel).toBeHidden();
	await expect(
		page.getByText("Demo approval was granted. No filesystem or process action was executed.")
	).toBeVisible();
});

test("failed approval stays readable and can be retried or denied", async ({ page }) => {
	let fail = true;
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const parsed = JSON.parse(String(message));
			if (fail && parsed.command?.type === "approval.respond") {
				fail = false;
				socket.send(
					JSON.stringify({
						type: "response",
						requestId: parsed.requestId,
						ok: false,
						error: { code: "internal", message: "连接暂时不可用，请重试" },
					})
				);
			} else server.send(message);
		});
	});
	await openApp(page, webUrl);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/approval");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const panel = page.getByRole("region", { name: "需要批准工具调用" });
	await expect(panel.locator(".approval-summary")).toContainText("Demo approval check");
	await panel.getByRole("button", { name: "允许", exact: true }).click();
	await expect(panel.getByRole("alert")).toContainText("连接暂时不可用");
	await expect(panel.getByRole("button", { name: "允许", exact: true })).toBeEnabled();
	await panel.getByRole("button", { name: "拒绝", exact: true }).click();
	await expect(panel).toBeHidden();
});

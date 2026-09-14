import { expect, test, type Page } from "@playwright/test";
import { once } from "node:events";
import WebSocket from "ws";
import type { Command, CommandResult, ServerMessage } from "@wuming/protocol";
import { bearerProtocol } from "../apps/gateway/src/auth.js";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;

test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_RUNTIME: "pi" });
	const socket = new WebSocket(webUrl.replace("http:", "ws:") + "api/ws", ["wuming.v1", bearerProtocol(token)]);
	await once(socket, "open");
	const hello = once(socket, "message");
	socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: "thinking-test", capabilities: [] }));
	await hello;
	let sequence = 0;
	const request = (command: Command) =>
		new Promise<CommandResult>((resolve, reject) => {
			const requestId = String(++sequence);
			const timer = setTimeout(() => {
				socket.off("message", onMessage);
				reject(new Error("Command timed out"));
			}, 10000);
			const onMessage = (raw: WebSocket.RawData) => {
				const response = JSON.parse(raw.toString()) as ServerMessage;
				if (response.type !== "response" || response.requestId !== requestId) return;
				clearTimeout(timer);
				socket.off("message", onMessage);
				if (response.ok) resolve(response.result);
				else reject(new Error(response.error.message));
			};
			socket.on("message", onMessage);
			socket.send(JSON.stringify({ type: "request", requestId, idempotencyKey: requestId, command }));
		});
	try {
		for (const id of ["claude-opus-4-5", "gemini-3.5-flash", "kimi-k2.6", "gpt-5.5", "relay-unknown"]) {
			await request({
				type: "model.custom.set",
				config: {
					provider: id === "claude-opus-4-5" ? "messages-test" : "relay-test",
					id,
					name: id,
					api: id === "claude-opus-4-5" ? "anthropic-messages" : "openai-completions",
					baseUrl: "https://relay.invalid/v1",
					apiKey: "unused-test-key",
					input: ["text"],
					contextWindow: 200000,
					maxOutputTokens: 32000,
				},
			});
		}
	} finally {
		socket.close();
	}
});

test.afterAll(async () => {
	await stopWebApp();
});

test.beforeEach(async ({ page }) => {
	await openApp(page, webUrl);
});

async function selectModel(page: Page, id: string) {
	const trigger = page.locator(".thinking-trigger");
	if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
	await page
		.locator(".thinking-model-option")
		.filter({ has: page.locator("strong", { hasText: id }) })
		.click();
	await expect(trigger).toContainText(id);
	if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
}

test("shows catalog capability modes and only the effective options", async ({ page }) => {
	await selectModel(page, "claude-opus-4-5");
	await expect(page.locator(".thinking-menu-item")).toContainText("思考预算");
	await page.locator(".thinking-menu-item").click();
	await expect(page.locator(".thinking-option strong")).toHaveText(["关闭", "极简", "低", "中", "高"]);
	await selectModel(page, "gemini-3.5-flash");
	await page.locator(".thinking-menu-item").click();
	await expect(page.locator(".thinking-option strong")).toHaveText(["极简", "低", "中", "高"]);
	await selectModel(page, "kimi-k2.6");
	await page.locator(".thinking-menu-item").click();
	await expect(page.locator(".thinking-option strong")).toHaveText(["关闭", "开启"]);
	await selectModel(page, "relay-unknown");
	await expect(page.locator(".thinking-model-option").filter({ hasText: "relay-unknown" })).toContainText(
		"思考能力未识别"
	);
	await expect(page.locator(".thinking-menu-item")).toBeDisabled();
	await expect(page.locator(".thinking-trigger-effort")).toHaveText("未识别");
});

for (const viewport of [
	{ width: 1440, height: 1000 },
	{ width: 390, height: 844 },
]) {
	test("keeps capability menus visible at " + viewport.width + "px", async ({ page }, testInfo) => {
		await page.setViewportSize(viewport);
		await selectModel(page, "gpt-5.5");
		await page.locator(".thinking-menu-item").click();
		const menu = page.getByRole("menu", { name: "思考强度" });
		await expect(menu).toBeVisible();
		const box = (await menu.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.y).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
		expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
		await page.screenshot({ path: testInfo.outputPath("model-thinking.png"), fullPage: true });
	});
}

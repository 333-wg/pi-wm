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
		for (const id of [
			"claude-opus-4-5",
			"claude-opus-6",
			"gpt-7-future",
			"gemini-3.5-flash",
			"kimi-k2.6",
			"gpt-5.5",
			"gpt-6-astra",
			"relay-unknown",
		]) {
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

test("GPT and Claude successors inherit complete thinking menus", async ({ page }) => {
	await selectModel(page, "gpt-6-astra");
	await page.locator(".thinking-menu-item").click();
	await expect(page.locator(".thinking-option strong")).toHaveText(["低", "中", "高", "极高", "最大"]);
	await selectModel(page, "gpt-7-future");
	await expect(page.locator(".thinking-model-option").filter({ hasText: "gpt-7-future" })).toContainText(
		"家族推断，待确认"
	);
	await page.locator(".thinking-menu-item").click();
	await expect(page.locator(".thinking-option strong")).toHaveText(["低", "中", "高", "极高", "最大"]);
	await page
		.getByRole("menuitemradio")
		.filter({ has: page.locator("strong", { hasText: /^高$/ }) })
		.click();
	await expect(page.locator(".thinking-trigger-effort")).toHaveText("高");
	await selectModel(page, "claude-opus-6");
	await page.locator(".thinking-menu-item").click();
	await expect(page.locator(".thinking-option strong")).toHaveText(["关闭", "极简", "低", "中", "高", "极高", "最大"]);
});

test("manual levels persist, update the picker, and can return to automatic", async ({ page }, testInfo) => {
	const edit = async () => {
		await page.getByRole("button", { name: "设置", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "设置" });
		await dialog.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^模型/ }).click();
		await dialog
			.locator(".custom-model-row")
			.filter({ hasText: "gpt-6-astra" })
			.getByRole("button", { name: "编辑模型" })
			.click();
		return dialog;
	};
	let dialog = await edit();
	await dialog.getByLabel("思考能力", { exact: true }).selectOption("manual");
	await dialog.getByRole("checkbox", { name: "极简", exact: true }).check();
	await dialog.getByRole("checkbox", { name: "极高", exact: true }).check();
	await dialog.getByRole("checkbox", { name: "最大", exact: true }).check();
	await page.setViewportSize({ width: 390, height: 844 });
	await dialog.locator(".model-thinking-levels").scrollIntoViewIfNeeded();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("thinking-settings-mobile.png"), fullPage: true });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await dialog.locator(".model-thinking-levels").scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("thinking-settings-desktop.png"), fullPage: true });
	await dialog.getByRole("button", { name: "保存修改" }).click();
	await expect(dialog.locator(".custom-model-edit")).toHaveCount(0);
	await dialog.getByRole("button", { name: "关闭", exact: true }).click();
	await page.reload();
	await selectModel(page, "gpt-6-astra");
	await page.locator(".thinking-menu-item").click();
	await expect(page.locator(".thinking-option strong")).toHaveText(["极简", "低", "中", "高", "极高", "最大"]);
	await page
		.getByRole("menuitemradio")
		.filter({ has: page.locator("strong", { hasText: /^最大$/ }) })
		.click();
	await expect(page.locator(".thinking-trigger-effort")).toHaveText("最大");
	dialog = await edit();
	await expect(dialog.getByLabel("思考能力", { exact: true })).toHaveValue("manual");
	await dialog.getByLabel("思考能力", { exact: true }).selectOption("disabled");
	await dialog.getByRole("button", { name: "保存修改" }).click();
	await expect(dialog.locator(".custom-model-edit")).toHaveCount(0);
	await dialog.getByRole("button", { name: "关闭", exact: true }).click();
	await selectModel(page, "gpt-6-astra");
	await expect(page.locator(".thinking-menu-item")).toBeDisabled();
	await page.keyboard.press("Escape");
	dialog = await edit();
	await dialog.getByLabel("思考能力", { exact: true }).selectOption("auto");
	await dialog.getByRole("button", { name: "保存修改" }).click();
	await expect(dialog.locator(".custom-model-edit")).toHaveCount(0);
	await dialog.getByRole("button", { name: "关闭", exact: true }).click();
	await selectModel(page, "gpt-6-astra");
	await page.locator(".thinking-menu-item").click();
	await expect(page.locator(".thinking-option strong")).toHaveText(["低", "中", "高", "极高", "最大"]);
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

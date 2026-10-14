import { expect, test, type WebSocketRoute } from "@playwright/test";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";
import type { BrowserState } from "../apps/web/src/lib/desktop.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(stopWebApp);

test("preview tools stay hidden until requested and never reopen a closed panel", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let socket: WebSocketRoute;
	await page.routeWebSocket("**/api/ws", (route) => {
		socket = route;
		route.connectToServer();
	});
	await page.addInitScript(
		({ url, password }) => {
			localStorage.setItem("wuming.desktop.welcome.complete", "true");
			let state: BrowserState = { workspaceId: "", sessionId: "", revision: 0, tabs: [] };
			window.wumingDesktop = {
				connect: async () => ({ token: password, websocketUrl: url.replace("http:", "ws:") + "api/ws" }),
				browser: {
					onState: () => () => {},
					onFocusAddress: () => () => {},
					invoke: async (request) => {
						state = {
							...state,
							workspaceId: request.workspaceId,
							sessionId: request.sessionId,
							revision: state.revision + 1,
						};
						if (request.action === "open") {
							document.documentElement.dataset.previewOpened = request.url ?? "about:blank";
							state = {
								...state,
								activeId: "fixture-tab",
								tabs: [
									{
										id: "fixture-tab",
										url: request.url ?? "about:blank",
										title: "本地预览",
										loading: false,
										canGoBack: false,
										canGoForward: false,
										zoom: 1,
									},
								],
							};
						}
						return state;
					},
				},
			};
		},
		{ url: webUrl, password: token }
	);
	await openApp(page, webUrl);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("浏览器预览回归");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".message-row.assistant").filter({ hasText: "Demo runtime received:" })).toBeVisible();
	await expect(page.getByRole("button", { name: "停止任务", exact: true })).toBeHidden();
	const sessionId = await page.evaluate(() =>
		localStorage.getItem("wuming.sessionId." + localStorage.getItem("wuming.workspaceId"))
	);
	expect(sessionId).toBeTruthy();
	async function preview(id: string, url: string, isError = false) {
		socket.send(
			JSON.stringify({
				type: "progress",
				event: {
					type: "tool.started",
					sessionId,
					toolCallId: id,
					toolName: "preview_start",
					input: { url, command: "npm run dev" },
				},
			})
		);
		socket.send(
			JSON.stringify({
				type: "progress",
				event: {
					type: "tool.finished",
					sessionId,
					toolCallId: id,
					preview: isError ? "Preview failed" : "Preview ready",
					truncated: false,
					isError,
				},
			})
		);
		await expect(page.locator(".tool-row").filter({ hasText: url }).last()).toBeVisible();
	}
	const panel = page.locator(".browser-panel");
	const toggle = page.getByRole("button", { name: "浏览器预览", exact: true });
	const firstUrl = "http://127.0.0.1:3000/first";
	await preview("preview-first", firstUrl);
	await expect(panel).toHaveCount(0);
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expect(page.locator("html")).not.toHaveAttribute("data-preview-opened");
	await page.screenshot({ path: testInfo.outputPath("preview-hidden.png") });
	await toggle.click();
	await expect(panel).toBeVisible();
	await expect(page.getByRole("textbox", { name: "浏览器地址" })).toHaveValue(firstUrl);
	await page.screenshot({ path: testInfo.outputPath("preview-manual-open.png") });
	await panel.getByRole("button", { name: "关闭浏览器面板", exact: true }).click();
	await preview("preview-second", "http://127.0.0.1:3000/second");
	await expect(panel).toHaveCount(0);
	await expect(page.locator("html")).toHaveAttribute("data-preview-opened", firstUrl);
	await preview("preview-failed", "http://127.0.0.1:3000/failed", true);
	await toggle.click();
	await expect(page.getByRole("textbox", { name: "浏览器地址" })).toHaveValue("http://127.0.0.1:3000/second");
	await toggle.click();
	await page.getByRole("button", { name: "打开预览", exact: true }).first().click();
	await expect(panel).toBeVisible();
	await expect(page.getByRole("textbox", { name: "浏览器地址" })).toHaveValue(firstUrl);
	expect(errors).toEqual([]);
});

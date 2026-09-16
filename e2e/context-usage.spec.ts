import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
// Isolate session restoration: each scenario starts with an empty session catalog.
test.beforeEach(async () => {
	webUrl = await startWebApp({
		WUMING_CONTEXT_WINDOW: "5000",
		WUMING_MODELS_JSON: JSON.stringify([
			{ provider: "demo", id: "wuming-demo", name: "Large Demo", contextWindow: 5000, authenticated: true },
			{ provider: "demo", id: "small-demo", name: "Small Demo", contextWindow: 2000, authenticated: true },
		]),
	});
});
test.afterEach(stopWebApp);

for (const stop of [false, true]) {
	test(`persists live cache usage through reload and ${stop ? "abort" : "completion"}`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await openApp(page, webUrl);
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("/demo-cache-live");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.locator(".context-pill").click();
		const popup = page.getByRole("dialog", { name: "上下文统计", exact: true });
		await expect(popup).toContainText("等待首个请求用量");
		await expect(popup).toContainText("90.0%");
		await expect(popup).toContainText("1 次");
		await expect(page.getByRole("button", { name: "停止任务" })).toBeVisible();
		await page.reload();
		await page.locator(".context-pill").click();
		await expect(popup).toContainText("90.0%");
		await expect(popup).toContainText("1 次");
		await expect(page.getByRole("button", { name: "停止任务" })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("live-cache-after-reload.png") });
		await page.keyboard.press("Escape");
		if (stop) await page.getByRole("button", { name: "停止任务" }).click();
		await expect(page.getByRole("button", { name: "停止任务" })).toBeHidden({ timeout: 15000 });
		await page.reload();
		await page.setViewportSize({ width: 320, height: 740 });
		await page.getByRole("button", { name: "关闭运行面板", exact: true }).first().click();
		await page.locator(".context-pill").click();
		await expect(popup).toContainText(stop ? "1 次" : "2 次");
		await expect(popup).toContainText(stop ? "90.0%" : "93.3%");
		if (!stop) await expect(popup).toContainText("95.0%");
		await popup.locator("summary").click();
		expect(await popup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("live-cache-final-mobile.png") });
	});
}

test("updates occupancy after compaction, persists across reload, and invalidates it on model change", async ({
	page,
}, testInfo) => {
	let release: (() => void) | undefined;
	// Delay real server messages, without manufacturing snapshots or context data.
	await page.routeWebSocket(/\/api\/ws/, (socket) => {
		const server = socket.connectToServer();
		let holding = false;
		const queued: Array<string | Buffer> = [];
		server.onMessage((message) => {
			const parsed = JSON.parse(String(message));
			if (parsed.event?.type === "context.compaction" && parsed.event.status === "complete") {
				holding = true;
				release = () => {
					holding = false;
					for (const item of queued.splice(0)) socket.send(item);
				};
			}
			if (holding) queued.push(message);
			else socket.send(message);
		});
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, webUrl);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/demo-memory");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const meter = page.locator(".context-meter");
	await expect(meter.locator("strong")).toHaveText("96%");
	await expect(meter).toContainText("建议 /compact");
	await meter.hover();
	const popup = page.getByRole("dialog", { name: "上下文统计", exact: true });
	await expect(popup).toBeVisible();
	await expect(popup.locator(".context-detail-occupancy")).toContainText("96%");
	await expect(popup).toHaveCSS("width", "304px");
	await popup.hover();
	await expect(popup).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("context-popover-desktop.png") });
	await page.keyboard.press("Escape");
	await expect(popup).toBeHidden();
	await expect.poll(() => Boolean(release)).toBe(true);
	const compaction = page.getByRole("status", { name: "正在压缩上下文", exact: true });
	await expect(compaction).toBeVisible();
	await expect(compaction.locator(".compaction-motion i")).toHaveCount(3);
	const firstFrame = await compaction
		.locator("i")
		.first()
		.evaluate((el) => getComputedStyle(el).transform);
	await expect
		.poll(() =>
			compaction
				.locator("i")
				.first()
				.evaluate((el) => getComputedStyle(el).transform)
		)
		.not.toBe(firstFrame);
	await page.screenshot({ path: testInfo.outputPath("context-before-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "关闭运行面板", exact: true }).first().click();
	await expect(compaction).toBeVisible();
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(compaction.locator("i").first()).toHaveCSS("animation-name", "none");
	await expect(compaction.locator("svg")).toHaveCSS("animation-name", "none");
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("context-running-mobile.png") });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.getByRole("button", { name: "显示或隐藏运行面板", exact: true }).click();
	release!();
	await expect(page.locator(".compaction-activity")).toBeHidden({ timeout: 1000 });
	await expect(page.getByRole("status", { name: "上下文已压缩", exact: true })).toHaveCount(0);
	await expect(meter.locator("strong")).toHaveText("24%");
	await expect(meter).toContainText("压缩后估算");
	await expect(meter).toContainText("1.2k / 5.0k");
	await expect(meter).not.toHaveAttribute("title");
	await meter.click();
	await expect(popup).toContainText("暂无数据");
	await expect(popup).not.toContainText("0 次");
	await popup.getByRole("button", { name: "关闭上下文统计" }).click();
	await expect(page.getByRole("button", { name: "停止任务" })).toBeHidden();
	await page.screenshot({ path: testInfo.outputPath("context-after-desktop.png") });
	await page.reload();
	await expect(page.locator(".compaction-activity")).toBeHidden();
	await expect(meter.locator("strong")).toHaveText("24%");

	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.locator(".context-pill")).toBeVisible();
	await expect(page.locator(".context-pill")).toHaveText("上下文 24%");
	await expect(page.locator(".context-pill")).not.toHaveAttribute("title");
	await page.locator(".context-pill").focus();
	await expect(page.locator(".context-pill")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(popup).toBeVisible();
	await page.keyboard.press("Tab");
	await expect(popup.getByRole("button", { name: "关闭上下文统计" })).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(page.locator(".context-pill")).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(popup.getByRole("button", { name: "关闭上下文统计" })).toBeFocused();
	await popup.locator("summary").click();
	await expect(popup.getByRole("table")).toBeVisible();
	await expect(popup).toContainText("压缩后需新请求确认缓存命中");
	const bounds = await popup.boundingBox();
	expect(bounds!.x).toBeGreaterThanOrEqual(12);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(378);
	expect(bounds!.y).toBeGreaterThanOrEqual(12);
	await page.screenshot({ path: testInfo.outputPath("context-popover-mobile-expanded.png") });
	await page.keyboard.press("Escape");
	await expect(page.locator(".context-pill")).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath("context-after-mobile.png") });
	await page.locator(".thinking-trigger").click();
	await page.getByRole("menuitemradio").filter({ hasText: "Small Demo" }).click();
	await page.keyboard.press("Escape");
	await expect(page.locator(".context-pill")).toHaveText("上下文 待更新");
	await page.locator(".context-pill").click();
	await expect(popup).toContainText("暂无数据");
	await page.mouse.click(10, 65);
	await expect(popup).toBeHidden();
	await expect(page.locator(".context-pill")).toBeVisible();
	const label = await page.locator(".thinking-trigger-label").boundingBox();
	const send = await page.getByRole("button", { name: "发送", exact: true }).boundingBox();
	expect(label!.x + label!.width).toBeLessThan(send!.x);
	await page.screenshot({ path: testInfo.outputPath("context-model-change-mobile.png") });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.reload();
	await expect(page.locator(".context-pill")).toHaveText("上下文 待更新");
	await page.setViewportSize({ width: 320, height: 740 });
	await expect(page.locator(".context-pill")).toBeVisible();
	await page.locator(".context-pill").click();
	await expect(popup).toBeVisible();
	await popup.locator("summary").click();
	const narrowBounds = await popup.boundingBox();
	expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(308);
	expect(await popup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("context-popover-320.png") });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("keeps populated cache statistics compact in light, dark and touch layouts", async ({
	page,
	browser,
}, testInfo) => {
	// A display-only fixture matching the high-usage, long-number case in the reported screenshot.
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		server.onMessage((message) => {
			const parsed = JSON.parse(String(message), (_key, value) => {
				if (!value?.session || !Array.isArray(value.transcript) || value.transcript.length === 0) return value;
				const requests = Array.from({ length: 54 }, (_, index) => {
					const inputTokens = index === 53 ? 679 : index === 0 ? 198267 : 0;
					const cacheReadTokens = index === 53 ? 178560 : index === 0 ? 6428800 : 0;
					return {
						requestId: "cache-" + index,
						model: value.model,
						usage: {
							inputTokens,
							cacheReadTokens,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: inputTokens + cacheReadTokens,
							costUsd: 0,
						},
					};
				});
				return {
					...value,
					usageRequests: requests,
					contextUsage: { model: value.model, tokens: 4800, basis: "request" },
					usageByTurn: [
						{
							turnId: "cache-fixture",
							mode: "prompt",
							model: value.model,
							attempts: 1,
							tools: [],
							usage: requests[53]!.usage,
							requests,
						},
					],
				};
			});
			socket.send(JSON.stringify(parsed));
		});
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, webUrl);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("检查上下文统计");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".message-row.assistant")).toContainText("Demo runtime received:");
	await page.reload();
	const pill = page.locator(".context-pill");
	const popup = page.getByRole("dialog", { name: "上下文统计", exact: true });
	await pill.hover();
	await expect(popup).toContainText("99.6%");
	await expect(popup).toContainText("97.1%");
	await expect(popup).toContainText("54 次");
	await expect(popup.getByRole("table")).toBeHidden();
	expect((await popup.boundingBox())!.height).toBeLessThan(260);
	await page.screenshot({ path: testInfo.outputPath("cache-light-desktop.png") });
	await popup.screenshot({ path: testInfo.outputPath("cache-light-detail.png") });
	await page.mouse.move(700, 100);
	await expect(popup).toBeHidden();
	await pill.click();
	await page.mouse.move(700, 100);
	await expect(popup).toBeVisible();
	await page.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
	});
	await page.screenshot({ path: testInfo.outputPath("cache-dark-desktop.png") });
	await popup.locator("summary").click();
	await expect(popup.getByRole("table")).toContainText("6,607,360");
	await expect(popup.getByRole("table")).toContainText("6,806,306");
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 320, height: 740 });
	await page.getByRole("button", { name: "关闭运行面板", exact: true }).first().click();
	await pill.click();
	await popup.locator("summary").click();
	await expect(popup).toBeVisible();
	expect(await popup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("cache-dark-mobile-expanded.png") });
	await page.keyboard.press("Escape");
	await expect(popup).toBeHidden();
	const touchContext = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	try {
		const touchPage = await touchContext.newPage();
		await openApp(touchPage, webUrl);
		await expect(touchPage.locator(".context-pill")).toBeVisible();
		await touchPage.locator(".context-pill").tap();
		await expect(touchPage.getByRole("dialog", { name: "上下文统计", exact: true })).toBeVisible();
		await touchPage.locator(".context-pill").tap();
		await expect(touchPage.getByRole("dialog", { name: "上下文统计", exact: true })).toBeHidden();
	} finally {
		await touchContext.close();
	}
});

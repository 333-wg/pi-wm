import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({
		WUMING_CONTEXT_WINDOW: "5000",
		WUMING_MODELS_JSON: JSON.stringify([
			{ provider: "demo", id: "wuming-demo", name: "Large Demo", contextWindow: 5000, authenticated: true },
			{ provider: "demo", id: "small-demo", name: "Small Demo", contextWindow: 2000, authenticated: true },
		]),
	});
});
test.afterAll(stopWebApp);

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
	await expect(page.getByRole("button", { name: "停止任务" })).toBeHidden();
	await page.screenshot({ path: testInfo.outputPath("context-after-desktop.png") });
	await page.reload();
	await expect(page.locator(".compaction-activity")).toBeHidden();
	await expect(meter.locator("strong")).toHaveText("24%");

	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.locator(".context-pill")).toBeVisible();
	await expect(page.locator(".context-pill")).toHaveText("上下文 24%");
	await page.screenshot({ path: testInfo.outputPath("context-after-mobile.png") });
	await page.locator(".thinking-trigger").click();
	await page.getByRole("menuitemradio").filter({ hasText: "Small Demo" }).click();
	await page.keyboard.press("Escape");
	await expect(page.locator(".context-pill")).toHaveText("上下文 待更新");
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
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

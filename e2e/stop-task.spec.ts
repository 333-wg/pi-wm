import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let url: string;
test.beforeEach(async () => {
	url = await startWebApp();
});
test.afterEach(stopWebApp);

for (const width of [1440, 390]) {
	test(`stops immediately without waiting for acknowledgement at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		let stopRequest: string | undefined;
		let releaseResponse: (() => void) | undefined;
		await page.routeWebSocket("**/api/ws", (socket) => {
			const server = socket.connectToServer();
			socket.onMessage((message) => {
				const parsed = JSON.parse(String(message));
				if (parsed.command?.type === "turn.abort") stopRequest = parsed.requestId;
				server.send(message);
			});
			server.onMessage((message) => {
				const parsed = JSON.parse(String(message));
				if (parsed.type === "response" && parsed.requestId === stopRequest) {
					releaseResponse = () => socket.send(message);
					return;
				}
				socket.send(message);
			});
		});
		await openApp(page, url);
		const composer = page.getByRole("textbox", { name: "消息", exact: true });
		await composer.fill("/long");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		const stop = page.getByRole("button", { name: "停止任务", exact: true });
		await expect(stop).toBeVisible();
		await composer.fill("保留这条草稿");
		await page.evaluate(() => {
			document.addEventListener(
				"click",
				(event) => {
					if (!(event.target instanceof Element) || !event.target.closest(".stop-button")) return;
					const start = performance.now();
					const observer = new MutationObserver(() => {
						if (document.querySelector(".stop-button")) return;
						document.body.dataset.stopElapsed = String(performance.now() - start);
						observer.disconnect();
					});
					observer.observe(document.body, { childList: true, subtree: true });
				},
				{ capture: true, once: true }
			);
		});
		await stop.click();
		await expect(stop).toHaveCount(0, { timeout: 1_000 });
		const elapsed = await page.evaluate(() => Number(document.body.dataset.stopElapsed));
		expect(elapsed).toBeLessThan(500);
		console.log(`Stop click to idle at ${width}px: ${elapsed.toFixed(1)}ms`);
		await expect(composer).toHaveValue("保留这条草稿");
		await expect.poll(() => Boolean(releaseResponse)).toBe(true);
		releaseResponse!();
		await page.screenshot({ path: testInfo.outputPath(`stopped-${width}.png`) });
	});
}

test("shows a stop acknowledgement timeout and keeps retry available", async ({ page }) => {
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			if (JSON.parse(String(message)).command?.type !== "turn.abort") server.send(message);
		});
	});
	await openApp(page, url);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/long");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const stop = page.getByRole("button", { name: "停止任务", exact: true });
	await expect(stop).toBeVisible();
	await page.clock.install();
	await stop.click();
	await page.clock.fastForward(8_100);
	await expect(page.getByText("停止请求未收到回应，请重试", { exact: true })).toBeVisible();
	await expect(stop).toBeEnabled();
});

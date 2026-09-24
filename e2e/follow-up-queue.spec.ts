import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";
let url: string;
// Each case owns its gateway: restoring a previous case's session can remount
// the composer after fill() and discard the test input.
test.beforeEach(async () => { url = await startWebApp(); });
test.afterEach(stopWebApp);
test("preserves the next draft while a queued send awaits its response", async ({ page }) => {
	const requests = new Set<string>();
	let releaseResponse: (() => void) | undefined;
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const parsed = JSON.parse(String(message));
			if (parsed.command?.type === "turn.follow_up") requests.add(parsed.requestId);
			server.send(message);
		});
		server.onMessage((message) => {
			const parsed = JSON.parse(String(message));
			if (parsed.type === "response" && requests.delete(parsed.requestId)) {
				releaseResponse = () => socket.send(message);
				return;
			}
			socket.send(message);
		});
	});
	await openApp(page, url);
	const composer = page.getByRole("textbox", { name: "消息", exact: true });
	const send = page.getByRole("button", { name: "发送", exact: true });
	await composer.fill("/long");
	await send.click();
	await expect(page.getByRole("button", { name: "停止任务", exact: true })).toBeVisible();
	await expect(composer).toHaveValue("");
	await composer.fill("已提交的待定消息");
	await send.click();
	await expect.poll(() => !!releaseResponse).toBe(true);
	await composer.fill("发送回执到达前写下的新草稿");
	releaseResponse!();
	await expect(send).toBeEnabled();
	await expect(composer).toHaveValue("发送回执到达前写下的新草稿");
	await expect(page.getByRole("region", { name: "后续任务队列" })).toContainText("已提交的待定消息");
	await page.getByRole("button", { name: "停止任务", exact: true }).click();
});

for (const width of [1440, 390]) {
	test(`preserves drafts and requires explicit confirmation after a concurrent edit at ${width}px`, async ({ page, context }, testInfo) => {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await openApp(page, url);
		const composer = page.getByRole("textbox", { name: "消息", exact: true });
		const send = page.getByRole("button", { name: "发送", exact: true });
		await composer.fill("/long");
		await send.click();
		await expect(composer).toHaveValue("");
		await composer.fill("待定原文");
		await send.click();
		await expect(composer).toHaveValue("");
		const queue = page.getByRole("region", { name: "后续任务队列" });
		await queue.getByRole("button", { name: "编辑待发送任务", exact: true }).click();
		await queue.getByRole("textbox").fill("需要保留的本地修改");
		const other = await context.newPage();
		await openApp(other, url);
		const otherQueue = other.getByRole("region", { name: "后续任务队列" });
		await otherQueue.getByRole("button", { name: "编辑待发送任务", exact: true }).click();
		await otherQueue.getByRole("textbox").fill("另一窗口保存的最新内容");
		await otherQueue.getByRole("button", { name: "保存修改", exact: true }).click();
		await expect(queue.getByRole("status")).toContainText("另一窗口保存的最新内容");
		await expect(queue.getByRole("textbox")).toHaveValue("需要保留的本地修改");
		await expect(queue.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
		await page.screenshot({ path: testInfo.outputPath("queue-conflict.png") });
		expect(await queue.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await queue.getByRole("button", { name: "确认覆盖最新版本", exact: true }).click();
		await queue.getByRole("button", { name: "保存修改", exact: true }).click();
		await expect(queue).toContainText("需要保留的本地修改");
		await expect(queue.getByRole("textbox")).toHaveCount(0);
		await expect(otherQueue).toContainText("需要保留的本地修改");
		await page.getByRole("button", { name: "停止任务", exact: true }).click();
		await expect(queue).toHaveCount(0);
		await expect(page.locator(".transcript")).toContainText("需要保留的本地修改");
		expect(errors).toEqual([]);
		await other.close();
	});
	test(`queues, edits, deletes, persists and automatically dispatches at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		await openApp(page, url);
		const composer = page.getByRole("textbox", { name: "消息", exact: true });
		await composer.fill("/long");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.getByRole("button", { name: "停止任务", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "后续任务", exact: true })).toHaveCount(0);
		await expect(composer).toHaveAttribute("placeholder", /当前任务结束后/);
		for (const text of ["检查移动端布局并补充交互测试", "这条任务需要删除"]) {
			await composer.fill(text);
			await page.getByRole("button", { name: "发送", exact: true }).click();
		}
		const queue = page.getByRole("region", { name: "后续任务队列" });
		await expect(queue.locator("li")).toHaveCount(2);
		await expect(queue.locator("li").first().getByRole("button")).toHaveCount(3);
		expect(await queue.locator("li").first().getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual(["删除待发送任务", "编辑待发送任务", "立即发送（打断）"]);
		await expect(page.locator(".transcript")).not.toContainText("检查移动端布局");
		await composer.fill("保留输入框草稿");
		await queue.getByRole("button", { name: "编辑待发送任务" }).first().click();
		await queue.getByRole("textbox").fill("先补充回归测试，再检查移动端布局");
		await page.screenshot({ path: testInfo.outputPath("queue-edit.png") });
		await queue.getByRole("button", { name: "保存修改" }).click();
		await expect(queue).toContainText("先补充回归测试");
		await expect(composer).toHaveValue("保留输入框草稿");
		await queue.getByRole("button", { name: "删除待发送任务" }).last().click();
		await expect(queue.locator("li")).toHaveCount(1);
		await page.reload();
		await expect(queue).toContainText("先补充回归测试");
		await expect(page.locator(".transcript")).not.toContainText("先补充回归测试");
		await page.screenshot({ path: testInfo.outputPath("queue.png") });
		expect(await queue.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		expect((await queue.boundingBox())!.height).toBeLessThan(76);
		await page.getByRole("button", { name: "停止任务", exact: true }).click();
		await expect(queue).toHaveCount(0);
		await expect(page.locator(".transcript")).toContainText("先补充回归测试");
		await expect(page.locator(".transcript")).not.toContainText("这条任务需要删除");
	});
	test(`sends a selected queued task immediately without losing other tasks at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		await openApp(page, url);
		const composer = page.getByRole("textbox", { name: "消息", exact: true });
		await composer.fill("/long");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.getByRole("button", { name: "停止任务", exact: true })).toBeVisible();
		for (const text of ["稍后执行的任务", "/long"]) {
			await composer.fill(text);
			await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
			if (text === "/long") await page.getByRole("button", { name: "发送", exact: true }).click();
			else await composer.press("Enter");
			await expect(composer).toHaveValue("");
		}
		const queue = page.getByRole("region", { name: "后续任务队列" });
		await expect(queue.locator("li")).toHaveCount(2);
		await composer.fill("不要丢失输入框草稿");
		await queue.getByRole("button", { name: "立即发送（打断）", exact: true }).last().click();
		await expect(queue.locator("li")).toHaveCount(1);
		await expect(queue).toContainText("稍后执行的任务");
		await expect(page.locator(".transcript").getByText("/long", { exact: true })).toHaveCount(2);
		await expect(page.locator(".transcript")).not.toContainText("稍后执行的任务");
		await expect(composer).toHaveValue("不要丢失输入框草稿");
		await page.screenshot({ path: testInfo.outputPath("queue-send-now.png") });
		await page.getByRole("button", { name: "停止任务", exact: true }).click();
		await expect(queue).toHaveCount(0);
		await expect(page.locator(".transcript")).toContainText("稍后执行的任务");
	});
}

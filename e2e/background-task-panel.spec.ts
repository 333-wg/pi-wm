import { expect, test } from "@playwright/test";
import type { BackgroundTask } from "@wuming/protocol";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let url: string;
test.beforeAll(async () => {
	url = await startWebApp();
});
test.afterAll(stopWebApp);

test("removes finished tasks and does not duplicate the panel across subsequent sends", async ({ page }, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	let publish: ((status: BackgroundTask["status"]) => void) | undefined;
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		server.onMessage((message) => {
			const value = JSON.parse(String(message));
			if (value.result?.type === "background.tasks") {
				const task: BackgroundTask = {
					id: "background-fixture",
					sessionId: value.result.sessionId,
					operationId: "fixture-op",
					toolCallId: "fixture-call",
					toolName: "exec",
					label: "后台回归检查",
					status: "running",
					startedAt: Date.now(),
					consumed: false,
					preview: "检查输出",
				};
				publish = (status) =>
					socket.send(
						JSON.stringify({
							type: "progress",
							event: {
								type: "background.tasks",
								sessionId: task.sessionId,
								tasks: [{ ...task, status, ...(status === "running" ? {} : { finishedAt: Date.now() }) }],
							},
						})
					);
				socket.send(JSON.stringify({ ...value, result: { ...value.result, tasks: [task] } }));
			} else socket.send(message);
		});
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await openApp(page, url);
	const input = page.getByRole("textbox", { name: "消息", exact: true });
	const send = page.getByRole("button", { name: "发送", exact: true });
	await input.fill("first message");
	await send.click();
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: first message");
	await expect(page.locator(".background-task")).toHaveCount(1);
	await expect(page.locator(".background-task")).toContainText("后台回归检查");
	publish!("completed");
	await expect(page.locator(".background-tasks")).toHaveCount(0);
	for (const text of ["second message", "third message"]) {
		await input.fill(text);
		await send.click();
		await expect(page.locator(".transcript")).toContainText(`Demo runtime received: ${text}`);
		publish!("completed");
		await expect(page.locator(".background-tasks")).toHaveCount(0);
		await expect(page.locator(".composer")).toHaveCount(1);
	}
	for (const status of ["failed", "cancelled", "interrupted"] as const) {
		publish!("running");
		await expect(page.locator(".background-task")).toHaveCount(1);
		publish!(status);
		await expect(page.locator(".background-tasks")).toHaveCount(0);
	}
	await page.screenshot({ path: testInfo.outputPath("finished-task-removed.png") });
	expect(errors).toEqual([]);
});

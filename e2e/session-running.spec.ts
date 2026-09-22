import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
let viewerId: string;
let workerId: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({}, async (workspace) => {
		using store = new SqliteOrchestratorStore(join(workspace, "..", "data", "wuming.db"));
		const orchestrator = new SessionOrchestrator(store, {
			async executeTurn() {
				return { items: [] };
			},
		});
		for (const name of ["Sidebar viewer", "Background worker"]) {
			const { snapshot } = await orchestrator.createSession({
				principalId: "test",
				idempotencyKey: name,
				workspaceId: "local-workspace",
				name,
				model: { provider: "demo", id: "wuming-demo" },
				thinkingLevel: "off",
				sandboxMode: "read_only",
				approvalPolicy: "never",
			});
			if (name === "Sidebar viewer") viewerId = snapshot.session.id;
			else workerId = snapshot.session.id;
		}
	});
});
test.afterAll(stopWebApp);

test("spins only for active execution phases", async ({ page }) => {
	let sendPhase: (phase: string) => void;
	await page.routeWebSocket(/\/api\/ws/, (socket) => {
		const server = socket.connectToServer();
		sendPhase = (phase) =>
			socket.send(
				JSON.stringify({
					type: "event",
					cursor: "1",
					event: {
						type: "session.phase.changed",
						sessionId: workerId,
						phase,
						revision: 100,
					},
				})
			);
		server.onMessage((message) => socket.send(message));
	});
	await openApp(page, webUrl);
	await page.locator(".session-open").filter({ hasText: "Sidebar viewer" }).click();
	await expect(page.locator(".session-entry.selected")).toContainText("Sidebar viewer");
	const row = page.locator(".session-entry").filter({ hasText: "Background worker" });
	for (const phase of ["turn", "compaction", "retry", "awaiting_approval", "error", "idle"]) {
		sendPhase!(phase);
		if (["turn", "compaction", "retry"].includes(phase)) {
			await expect(row.locator(".session-running")).toBeVisible();
		} else {
			await expect(row.locator(".session-running")).toHaveCount(0);
			await expect(row.locator(`.dot-${phase}`)).toBeVisible();
		}
	}
});

for (const width of [1365, 390]) {
	test(`updates a background conversation spinner at ${width}px`, async ({ page, browser }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await page.addInitScript((id) => {
			localStorage.setItem("wuming.workspaceId", "local-workspace");
			localStorage.setItem("wuming.sessionId.local-workspace", id);
		}, viewerId);
		await openApp(page, webUrl);
		if (width <= 720) await page.getByRole("button", { name: "打开导航", exact: true }).click();
		await page.locator(".session-open").filter({ hasText: "Sidebar viewer" }).click();
		await expect(page.locator(".session-entry.selected")).toContainText("Sidebar viewer");
		if (width <= 720) await page.getByRole("button", { name: "打开导航", exact: true }).click();
		const row = page.locator(".session-entry").filter({ hasText: "Background worker" });
		const spinner = row.locator(".session-running");
		await expect(row).toBeVisible();
		await expect(spinner).toHaveCount(0);
		const workerContext = await browser.newContext();
		try {
			const worker = await workerContext.newPage();
			await worker.addInitScript((id) => {
				localStorage.setItem("wuming.workspaceId", "local-workspace");
				localStorage.setItem("wuming.sessionId.local-workspace", id);
			}, workerId);
			await openApp(worker, webUrl);
			await worker.locator(".session-open").filter({ hasText: "Background worker" }).click();
			await expect(worker.locator(".session-entry.selected")).toContainText("Background worker");
			await worker.getByRole("textbox", { name: "消息", exact: true }).fill("/long");
			await worker.getByRole("button", { name: "发送", exact: true }).click();
			await expect(spinner).toBeVisible();
			await expect(spinner).toHaveAttribute("aria-label", "执行中");
			await expect(row).not.toHaveClass(/selected/);
			await expect(worker.locator(".session-entry.selected .session-running")).toBeVisible();
			const transform = await spinner.evaluate((element) => getComputedStyle(element).transform);
			await expect.poll(() => spinner.evaluate((element) => getComputedStyle(element).transform)).not.toBe(transform);
			await page.screenshot({ path: testInfo.outputPath("sidebar-running.png") });
			expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
			await page.emulateMedia({ reducedMotion: "reduce" });
			await expect(spinner).toHaveCSS("animation-name", "none");
			await worker.getByRole("button", { name: "停止任务", exact: true }).click();
			await expect(spinner).toHaveCount(0);
			await expect(row.locator(".dot-idle")).toBeVisible();
			await expect(worker.locator(".session-running")).toHaveCount(0);
		} finally {
			await workerContext.close();
		}
	});
}

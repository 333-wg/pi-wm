import { expect, test, type WebSocketRoute } from "@playwright/test";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { SessionSnapshot } from "@wuming/protocol";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let url: string;
let selected: SessionSnapshot;
test.beforeAll(async () => {
	const environment: Record<string, string> = {};
	url = await startWebApp(environment, async (workspace) => {
		environment.WUMING_WORKSPACES_JSON = JSON.stringify([
			{ id: "sidebar-project", name: "Pi-Wm 界面回归", path: workspace },
			{ id: "local-workspace", name: "Local workspace", path: workspace },
		]);
		using store = new SqliteOrchestratorStore(join(workspace, "..", "data", "wuming.db"));
		const orchestrator = new SessionOrchestrator(store, {
			async executeTurn() {
				return { items: [] };
			},
		});
		for (let index = 0; index < 9; index++) {
			const { snapshot } = await orchestrator.createSession({
				principalId: "test",
				idempotencyKey: `sidebar-${index}`,
				name: `项目对话 ${index} · 检查长标题是否可以完整使用可用空间`,
				workspaceId: "sidebar-project",
				model: { provider: "demo", id: "wuming-demo" },
				thinkingLevel: "off",
				sandboxMode: "unrestricted",
				approvalPolicy: "never",
			});
			selected = snapshot;
		}
	});
});
test.afterAll(stopWebApp);

test("project conversations expand in one scroll area without covering later sections", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1365, height: 620 });
	await page.addInitScript((id) => {
		localStorage.setItem("wuming.workspaceId", "sidebar-project");
		localStorage.setItem("wuming.sessionId.sidebar-project", id);
	}, selected.session.id);
	await openApp(page, url);
	const project = page.locator(".project-conversations");
	await expect(project.locator(".session-entry")).toHaveCount(5);
	await expect(page.locator(".session-entry.selected")).toHaveCount(1);
	await project.getByRole("button", { name: "展开显示", exact: true }).click();
	await expect(project.locator(".session-entry")).toHaveCount(9);
	await project.locator(".session-open").last().scrollIntoViewIfNeeded();
	await expect(project.locator(".session-open").last()).toBeInViewport();
	const geometry = await page.evaluate(() => {
		const sessions = document.querySelector(".project-conversations")!;
		const recent = document.querySelector(".recent-conversations")!;
		return {
			bottom: sessions.getBoundingClientRect().bottom,
			nextTop: recent.getBoundingClientRect().top,
			scroll: getComputedStyle(document.querySelector(".project-tree")!).overflowY,
			innerScroll: getComputedStyle(sessions.querySelector(".session-nav")!).overflowY,
		};
	});
	expect(geometry.bottom).toBeLessThanOrEqual(geometry.nextTop);
	expect(geometry.scroll).toBe("auto");
	expect(geometry.innerScroll).toBe("visible");
	await project.getByRole("button", { name: "收起显示", exact: true }).click();
	await expect(project.locator(".session-entry")).toHaveCount(5);
	await page.screenshot({ path: testInfo.outputPath("project-preview.png") });
});

for (const reconnect of [false, true]) {
	test(`stop stays usable with missing completion events${reconnect ? " and reconnect" : ""}`, async ({ page }) => {
		const snapshot = { ...selected, session: { ...selected.session, phase: "retry" } };
		const now = Date.now();
		let clientSocket: WebSocketRoute;
		let waitingForHello = false;
		let deliverHello: (() => void) | undefined;
		let stops = 0;
		await page.routeWebSocket("**/api/ws", (socket) => {
			clientSocket = socket;
			const server = socket.connectToServer();
			socket.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.command?.type === "turn.abort") {
					expect(message.command.operationId).toBe("observed-run");
					stops++;
					socket.send(
						JSON.stringify({
							type: "response",
							requestId: message.requestId,
							ok: true,
							result: { type: "turn.abort_requested", sessionId: selected.session.id, revision: selected.revision },
						})
					);
					return;
				}
				server.send(raw);
			});
			server.onMessage((raw) => {
				const message = JSON.parse(String(raw), (_key, value) => {
					if (value?.session?.id === selected.session.id && Array.isArray(value.transcript))
						return stops >= 2 ? { ...snapshot, session: { ...snapshot.session, phase: "idle" } } : snapshot;
					if (value?.type === "session.run.list")
						return {
							...value,
							runs: [
								{
									id: "observed-run",
									sessionId: selected.session.id,
									mode: "prompt",
									status: "running",
									attempt: 2,
									createdAt: now,
									updatedAt: now,
									abortRequested: false,
									retryHistory: [
										{ attempt: 1, maxAttempts: 5, delayMs: 10000, error: "Connection error.", timestamp: now },
									],
								},
							],
						};
					return value;
				});
				if (message.type === "hello" && waitingForHello) {
					deliverHello = () => socket.send(JSON.stringify(message));
					return;
				}
				socket.send(JSON.stringify(message));
			});
		});
		await page.addInitScript((id) => {
			localStorage.setItem("wuming.workspaceId", "sidebar-project");
			localStorage.setItem("wuming.sessionId.sidebar-project", id);
		}, selected.session.id);
		await openApp(page, url);
		await expect(page.getByRole("status", { name: "正在自动重试" })).toBeVisible();
		const stop = page.getByRole("button", { name: "停止任务", exact: true });
		if (reconnect) {
			waitingForHello = true;
			clientSocket!.close({ code: 1012, reason: "test reconnect" });
			await expect(page.locator(".connection")).not.toHaveClass(/ connected/);
			await stop.click();
			await expect(stop).toBeDisabled();
			expect(stops).toBe(0);
			await expect.poll(() => Boolean(deliverHello)).toBe(true);
			deliverHello!();
		} else {
			await stop.click();
		}
		await expect.poll(() => stops).toBe(1);
		// The backend intentionally remains active: ACK alone must not lock Stop.
		await expect(stop).toBeEnabled();
		await stop.click();
		await expect.poll(() => stops).toBe(2);
		// The refresh recovers the final state without receiving any idle event.
		await expect(stop).toHaveCount(0);
	});
}

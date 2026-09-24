import { expect, test } from "@playwright/test";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { SessionSnapshot, RunSummary } from "@wuming/protocol";
import { join } from "node:path";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
let initial: SessionSnapshot;
test.beforeAll(async () => {
	webUrl = await startWebApp({}, async (workspace) => {
		using store = new SqliteOrchestratorStore(join(workspace, "..", "data", "wuming.db"));
		const orchestrator = new SessionOrchestrator(store, {
			async executeTurn() {
				return { items: [] };
			},
		});
		({ snapshot: initial } = await orchestrator.createSession({
			principalId: "test",
			idempotencyKey: "recovery-active",
			name: "恢复后继续执行",
			workspaceId: "local-workspace",
			model: { provider: "demo", id: "wuming-demo" },
			thinkingLevel: "off",
			sandboxMode: "unrestricted",
			approvalPolicy: "never",
		}));
	});
});
test.afterAll(stopWebApp);

for (const width of [1440, 390]) {
	test(`dismisses recovery during active work and after reload at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const now = Date.now();
		let snapshot: SessionSnapshot = {
			...initial,
			session: { ...initial.session, phase: "turn" },
			transcript: [
				{
					id: "user",
					type: "user",
					createdAt: now - 3000,
					content: [{ type: "text", text: "恢复后继续检查项目（测试数据）" }],
				},
			],
		};
		const run: RunSummary = {
			id: "retry-operation",
			sessionId: initial.session.id,
			mode: "prompt",
			status: "running",
			attempt: 2,
			createdAt: now - 3000,
			updatedAt: now,
			abortRequested: false,
			retryHistory: [{ attempt: 1, maxAttempts: 5, delayMs: 300, error: "Connection error.", timestamp: now - 1000 }],
		};
		let send: (message: unknown) => void;
		await page.routeWebSocket("**/api/ws", (socket) => {
			const server = socket.connectToServer();
			send = (message) => socket.send(JSON.stringify(message));
			server.onMessage((message) =>
				socket.send(
					JSON.stringify(
						JSON.parse(String(message), (_key, value) => {
							if (value?.session?.id === initial.session.id && Array.isArray(value.transcript)) return snapshot;
							if (value?.type === "session.run.list") return { ...value, runs: [run] };
							return value;
						})
					)
				)
			);
		});
		await page.addInitScript((id) => {
			localStorage.setItem("wuming.workspaceId", "local-workspace");
			localStorage.setItem("wuming.sessionId.local-workspace", id);
		}, initial.session.id);
		await openApp(page, webUrl);
		const card = page.getByRole("status", { name: "正在自动重试" });
		await expect(card).toBeVisible();
		await card.getByText("技术详情", { exact: true }).click();
		await expect(card).toContainText("Connection error.");
		await page.screenshot({ path: testInfo.outputPath(`waiting-${width}.png`) });
		const retry = (attempt: number) =>
			send!({
				type: "progress",
				event: {
					type: "run.retrying",
					sessionId: initial.session.id,
					operationId: run.id,
					attempt,
					nextAttempt: attempt + 1,
					maxAttempts: 6,
					delayMs: 300,
					failureKind: "provider_network",
					error: "Connection error.",
				},
			});
		retry(1);
		send!({
			type: "progress",
			event: {
				type: "assistant.delta",
				sessionId: initial.session.id,
				itemId: "live",
				kind: "thinking",
				delta: "Recovered",
			},
		});
		await expect(card).toHaveCount(0);
		await expect(page.getByRole("button", { name: "停止任务", exact: true })).toBeVisible();
		// A second failure must replace, not inherit, the previous recovery evidence.
		retry(2);
		await expect(card).toBeVisible();
		send!({
			type: "progress",
			event: {
				type: "tool.started",
				sessionId: initial.session.id,
				toolCallId: "call",
				toolName: "exec",
				input: { command: "npm run check" },
			},
		});
		await expect(card).toHaveCount(0);
		await page.getByRole("button", { name: /正在执行命令/ }).click();
		await expect(page.locator(".transcript")).toContainText("npm run check");
		// Reload uses only persisted checkpoints and history, not the live marker.
		snapshot = {
			...snapshot,
			transcript: [
				...snapshot.transcript,
				{
					id: "tool",
					type: "tool",
					toolCallId: "call",
					toolName: "exec",
					status: "running",
					isError: false,
					createdAt: now + 1000,
					input: { command: "npm run check" },
					content: [],
				},
			],
		};
		await page.reload();
		await page.getByRole("button", { name: /正在执行命令/ }).click();
		await expect(page.locator(".transcript")).toContainText("npm run check");
		await expect(page.getByRole("button", { name: "停止任务", exact: true })).toBeVisible();
		await expect(card).toHaveCount(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath(`recovered-active-${width}.png`) });
		expect(errors).toEqual([]);
	});
}

import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { TranscriptItem } from "@wuming/protocol";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
let sessionId: string;
const command = `node scripts/${"long-project-directory/".repeat(8)}integration-tests.mjs --api-key=private-fixture-key`;

test.beforeAll(async () => {
	webUrl = await startWebApp({}, async (workspace) => {
		using store = new SqliteOrchestratorStore(join(workspace, "..", "data", "wuming.db"));
		const orchestrator = new SessionOrchestrator(store, {
			async executeTurn() {
				return { items: [] };
			},
		});
		const { snapshot } = await orchestrator.createSession({
			principalId: "test",
			idempotencyKey: "create",
			workspaceId: "local-workspace",
			name: "Long task diagnostics",
			model: { provider: "demo", id: "wuming-demo" },
			thinkingLevel: "off",
			sandboxMode: "read_only",
			approvalPolicy: "never",
		});
		sessionId = snapshot.session.id;
		const now = Date.now();
		const items: TranscriptItem[] = [
			{ id: "user", type: "user", createdAt: now - 210000, content: [{ type: "text", text: "Run integration tests" }] },
			{
				id: "tool",
				type: "tool",
				toolCallId: "tool",
				toolName: "exec",
				status: "running",
				isError: false,
				createdAt: now - 200000,
				lastProgressAt: now - 10000,
				input: { command },
				content: [{ type: "text", text: "Running tests" }],
			},
		];
		store.commitMutation({
			sessionId,
			expectedRevision: snapshot.revision,
			snapshot: { ...snapshot, transcript: items, revision: snapshot.revision + items.length },
			events: items.map((item, index) => ({
				type: "session.item.upserted",
				item,
				sessionId,
				eventId: crypto.randomUUID(),
				timestamp: now,
				revision: snapshot.revision + index + 1,
			})),
		});
	});
});
test.afterAll(stopWebApp);

for (const width of [1440, 390, 320]) {
	test(`shows long command progress without overflow at ${width}px`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width, height: 900 });
		await page.routeWebSocket("**/api/ws", (socket) => {
			const server = socket.connectToServer();
			server.onMessage((message) =>
				socket.send(
					JSON.stringify(
						JSON.parse(String(message), (_key, value) => {
							if (value?.session?.id === sessionId && Array.isArray(value.transcript))
								return { ...value, session: { ...value.session, phase: "turn" } };
							return value;
						})
					)
				)
			);
		});
		await page.addInitScript((id) => {
			localStorage.setItem("wuming.workspaceId", "local-workspace");
			localStorage.setItem("wuming.sessionId.local-workspace", id);
		}, sessionId);
		await openApp(page, webUrl);
		if (width <= 1080) await page.locator('button[title="显示或隐藏运行面板"]').click();
		const panel = page.locator(".run-diagnostics");
		await expect(panel).toBeVisible();
		await expect(panel).toContainText("工具执行中");
		await expect(panel).toContainText("距最近输出");
		await expect(panel).toContainText("integration-tests.mjs");
		await expect(panel).not.toContainText("private-fixture-key");
		await expect(panel).not.toContainText("等待模型响应");
		expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath(`long-task-${width}.png`) });
		expect(errors).toEqual([]);
	});
}

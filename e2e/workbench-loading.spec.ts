import { expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
let sessionId: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({ WUMING_DEPLOYMENT_MODE: "local_device" }, async (workspace) => {
		const store = new SqliteOrchestratorStore(join(dirname(workspace), "data", "wuming.db"));
		try {
			const orchestrator = new SessionOrchestrator(store, {
				async executeTurn() {
					return { items: [] };
				},
			});
			const result = await orchestrator.createSession({
				principalId: "local-user",
				idempotencyKey: "idle-session",
				workspaceId: "local-workspace",
				model: { provider: "demo", id: "wuming-demo" },
				thinkingLevel: "off",
				sandboxMode: "workspace_write",
				approvalPolicy: "on_risk",
			});
			sessionId = result.snapshot.session.id;
			store.recordAuxiliaryUsage({
				requestId: "optimizer-fixture",
				workspaceId: "local-workspace",
				purpose: "prompt_optimization",
				model: { provider: "demo", id: "wuming-demo" },
				timestamp: Date.now(),
				usage: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					totalTokens: 18,
					costUsd: 0.01,
				},
			});
		} finally {
			store.close();
		}
	});
});
test.afterAll(stopWebApp);

async function selectSession(page: import("@playwright/test").Page) {
	await page.addInitScript((id) => {
		localStorage.setItem("wuming.workspaceId", "local-workspace");
		localStorage.setItem("wuming.sessionId.local-workspace", id);
	}, sessionId);
	await openApp(page, webUrl);
	await page.locator(".recent-conversations .session-open").first().click();
	await expect(page.locator(".session-entry.selected")).toHaveCount(1);
}

test("loads dialogs only when opened and keeps the composer draft through navigation", async ({ page }) => {
	const requests: string[] = [];
	const errors: string[] = [];
	page.on("request", (request) => requests.push(request.url()));
	page.on("pageerror", (error) => errors.push(error.message));
	await selectSession(page);
	const box = page.getByRole("textbox", { name: "消息", exact: true });
	await box.fill("保留这段草稿");
	for (const name of [
		"CommandPalette",
		"ShortcutsDialog",
		"SkillManagerDialog",
		"EvaluationDialog",
		"MediaModelSettings",
		"OfficialAccountSettings",
	])
		expect(requests.some((url) => url.includes(`/components/${name}.tsx`))).toBe(false);
	await page.keyboard.press("ControlOrMeta+k");
	await expect(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
	expect(requests.some((url) => url.includes("/components/CommandPalette.tsx"))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(box).toHaveValue("保留这段草稿");
	await page.keyboard.press("ControlOrMeta+/");
	await expect(page.getByRole("dialog", { name: "快捷键" })).toBeVisible();
	expect(requests.some((url) => url.includes("/components/ShortcutsDialog.tsx"))).toBe(true);
	await page.getByRole("dialog", { name: "快捷键" }).getByRole("button", { name: "关闭" }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	expect(requests.some((url) => url.includes("/components/MediaModelSettings.tsx"))).toBe(false);
	await page
		.getByRole("navigation", { name: "设置分类" })
		.getByRole("button", { name: /^Agents/ })
		.click();
	await expect(page.locator("#settings-panel-agents")).toBeVisible();
	await expect.poll(() => requests.some((url) => url.includes("/components/AgentTemplateSettings.tsx"))).toBe(true);
	await page
		.getByRole("dialog", { name: "设置", exact: true })
		.getByRole("button", { name: "关闭", exact: true })
		.click();
	await expect(box).toHaveValue("保留这段草稿");
	expect(errors).toEqual([]);
});

test("reduces idle polling, pauses it when hidden and refreshes on visibility restoration", async ({ page }) => {
	const counts: Record<string, number> = {};
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const type = JSON.parse(String(message)).command?.type as string | undefined;
			if (type) counts[type] = (counts[type] ?? 0) + 1;
			server.send(message);
		});
	});
	await selectSession(page);
	await expect.poll(() => counts["subagent.list"] ?? 0).toBeGreaterThan(0);
	await expect.poll(() => counts["automation.list"] ?? 0).toBeGreaterThan(0);
	await page.clock.install();
	const before = { ...counts };
	await page.clock.runFor(10_000);
	expect(counts["subagent.list"]).toBe(before["subagent.list"]);
	expect(counts["automation.list"]).toBe(before["automation.list"]);
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, value: true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.clock.runFor(60_000);
	expect(counts["subagent.list"]).toBe(before["subagent.list"]);
	expect(counts["automation.list"]).toBe(before["automation.list"]);
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, value: false });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect.poll(() => counts["subagent.list"]).toBe((before["subagent.list"] ?? 0) + 1);
	await expect.poll(() => counts["automation.list"]).toBe((before["automation.list"] ?? 0) + 1);
});

test("shows auxiliary costs separately and refreshes the overview on a usage notification", async ({
	page,
}, testInfo) => {
	let requests = 0;
	let invalidate!: () => void;
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		invalidate = () => socket.send(JSON.stringify({ type: "usage.invalidated", workspaceId: "local-workspace" }));
		socket.onMessage((message) => {
			if (JSON.parse(String(message)).command?.type === "usage.overview") requests++;
			server.send(message);
		});
	});
	await selectSession(page);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page
		.getByRole("navigation", { name: "设置分类" })
		.getByRole("button", { name: /^用量统计/ })
		.click();
	const panel = page.locator("#settings-panel-usage");
	await expect(panel).toContainText("累计用量包含提示词优化：1 次请求 · 18 Token · $0.01，不计入聊天轮次。");
	await expect(panel.locator(".usage-metric-card").last()).toContainText("1 次请求 · 0 轮");
	const before = requests;
	invalidate();
	await expect.poll(() => requests).toBeGreaterThan(before);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(panel).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("auxiliary-usage-mobile.png"), fullPage: true });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a failed lazy chunk leaves the conversation and draft usable", async ({ page }) => {
	await selectSession(page);
	const box = page.getByRole("textbox", { name: "消息", exact: true });
	await box.fill("网络失败也要保留的草稿");
	await page.route("**/components/CommandPalette.tsx*", (route) => route.abort());
	await page.keyboard.press("ControlOrMeta+k");
	const dialog = page.getByRole("dialog", { name: /面板加载失败/ });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(box).toHaveValue("网络失败也要保留的草稿");
	await expect(box).toBeEditable();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
});

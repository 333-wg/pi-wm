import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { TranscriptItem } from "@wuming/protocol";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
let selectedId: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({}, async (workspace) => {
		using store = new SqliteOrchestratorStore(join(workspace, "..", "data", "wuming.db"));
		const orchestrator = new SessionOrchestrator(store, {
			async executeTurn() {
				return { items: [] };
			},
		});
		for (const title of ["搜索验收", "另一个任务"]) {
			const { snapshot } = await orchestrator.createSession({
				principalId: "test",
				idempotencyKey: title,
				workspaceId: "local-workspace",
				name: title,
				model: { provider: "demo", id: "wuming-demo" },
				thinkingLevel: "off",
				sandboxMode: "read_only",
				approvalPolicy: "never",
			});
			selectedId = snapshot.session.id;
			if (title !== "搜索验收") continue;
			const items: TranscriptItem[] = [
				{
					type: "user",
					id: "search-target",
					createdAt: 100,
					content: [{ type: "text", text: "请检查唯一关键词 搜索验收_100% 的记录。" }],
				},
				...Array.from({ length: 15 }, (_, index): TranscriptItem => ({
					type: "assistant",
					id: `message-${index}`,
					createdAt: 101 + index,
					status: "complete",
					model: snapshot.model,
					content: [
						{
							type: "text",
							text:
								`第 ${index + 1} 组验证结果\n\n` +
								"这是较长的历史记录，用来确认定位消息后不会自动滚回底部。\n\n".repeat(4),
						},
					],
				})),
			];
			store.commitMutation({
				sessionId: snapshot.session.id,
				expectedRevision: snapshot.revision,
				snapshot: { ...snapshot, transcript: items, revision: snapshot.revision + items.length },
				events: items.map((item, index) => ({
					type: "session.item.upserted",
					item,
					sessionId: snapshot.session.id,
					eventId: crypto.randomUUID(),
					timestamp: 100 + index,
					revision: snapshot.revision + index + 1,
				})),
			});
		}
	});
});
test.afterAll(stopWebApp);

for (const width of [1365, 390, 320]) {
	test(`searches content and jumps across sessions at ${width}px`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width, height: 900 });
		await page.addInitScript((id) => {
			localStorage.setItem("wuming.workspaceId", "local-workspace");
			localStorage.setItem("wuming.sessionId.local-workspace", id);
		}, selectedId);
		await openApp(page, webUrl);
		if (width <= 720) await page.getByRole("button", { name: "打开导航", exact: true }).click();
		const search = page.getByRole("textbox", { name: "搜索聊天正文" });
		await search.fill("搜索验收_100%");
		const hit = page.locator(".session-search-hit");
		await expect(hit).toHaveCount(1);
		await expect(hit.locator("mark")).toHaveText("搜索验收_100%");
		await page.screenshot({ path: testInfo.outputPath("search-results.png") });
		await hit.click();
		const target = page.locator('[data-message-id="search-target"]');
		await expect(target).toHaveClass(/search-target/);
		await expect(target).toBeInViewport();
		await expect(target).toBeFocused();
		// Give the follow-tail layout and resize observers a chance to run.
		await page.evaluate(
			() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
		);
		await expect(target).toBeInViewport();
		await page.screenshot({ path: testInfo.outputPath("search-target.png") });
		expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
		expect(errors).toEqual([]);
	});
}

test("exports body-free diagnostics and searches again after reload", async ({ page }) => {
	await page.setViewportSize({ width: 1365, height: 900 });
	await page.addInitScript(() => localStorage.setItem("wuming.workspaceId", "local-workspace"));
	await openApp(page, webUrl);
	await page.reload();
	const search = page.getByRole("textbox", { name: "搜索聊天正文" });
	await search.fill("搜索验收_100%");
	await expect(page.locator(".session-search-hit")).toHaveCount(1);
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "导出诊断", exact: true }).click();
	const file = await download;
	const stream = await file.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
	const text = Buffer.concat(chunks).toString();
	expect(JSON.parse(text)).toHaveProperty("version", 1);
	expect(text).not.toContain("搜索验收");
	expect(text).not.toContain("transcript");
});

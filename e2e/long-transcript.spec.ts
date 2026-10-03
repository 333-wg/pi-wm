import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { TranscriptItem } from "@wuming/protocol";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
const sessions: Record<string, string> = {};
const sizes = [100, 500, 2000];
const widths = [1440, 390];

function history(count: number): TranscriptItem[] {
	return Array.from({ length: count }, (_, index): TranscriptItem => {
		const turn = Math.floor(index / 10);
		const part = index % 10;
		const base = { id: `history-${index}`, createdAt: 1000 + index };
		if (part === 0) return { ...base, type: "user", content: [{ type: "text", text: `Task ${turn}` }] };
		if (part % 2 === 0)
			return {
				...base,
				type: "tool",
				toolCallId: `call-${index}`,
				toolName: "read_file",
				status: "complete",
				isError: false,
				input: { path: `src/module-${part}.ts` },
				content: [{ type: "text", text: "export const result = 42;\n".repeat(10) }],
			};
		return {
			...base,
			type: "assistant",
			status: "complete",
			model: { provider: "demo", id: "wuming-demo" },
			content: [
				{
					type: "text",
					text:
						part === 9
							? `Completed task ${turn}.`
							: `Inspecting step ${index}.\n\nEvidence marker HISTORY_PROOF_${index}.`,
				},
			],
		};
	});
}

test.beforeEach(async ({}, testInfo) => {
	const name =
		testInfo.title.match(/measures (\d+) history/)?.[1] ?? `search-${testInfo.title.includes("1440") ? 1440 : 390}`;
	webUrl = await startWebApp({}, async (workspace) => {
		using store = new SqliteOrchestratorStore(join(workspace, "..", "data", "wuming.db"));
		const orchestrator = new SessionOrchestrator(store, {
			async executeTurn() {
				return { items: [] };
			},
		});
		{
			const { snapshot } = await orchestrator.createSession({
				principalId: "test",
				idempotencyKey: name,
				workspaceId: "local-workspace",
				name: `History ${name}`,
				model: { provider: "demo", id: "wuming-demo" },
				thinkingLevel: "off",
				sandboxMode: "read_only",
				approvalPolicy: "never",
			});
			sessions[name] = snapshot.session.id;
			const items = history(name.startsWith("search-") ? 2000 : Number(name));
			store.commitMutation({
				sessionId: snapshot.session.id,
				expectedRevision: snapshot.revision,
				snapshot: { ...snapshot, transcript: items, revision: snapshot.revision + items.length },
				events: items.map((item, index) => ({
					type: "session.item.upserted",
					item,
					sessionId: snapshot.session.id,
					eventId: crypto.randomUUID(),
					timestamp: item.createdAt,
					revision: snapshot.revision + index + 1,
				})),
			});
		}
	});
});
test.afterEach(stopWebApp);

async function selectHistory(page: Page, name: string) {
	await page.addInitScript((id) => {
		localStorage.setItem("wuming.workspaceId", "local-workspace");
		localStorage.setItem("wuming.sessionId.local-workspace", id);
	}, sessions[name]!);
}

for (const width of widths) {
	for (const count of sizes) {
		test(`measures ${count} history items at ${width}px`, async ({ page }, testInfo) => {
			test.setTimeout(120_000);
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.setViewportSize({ width, height: 900 });
			await selectHistory(page, String(count));
			const samples = [];
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Performance.enable");
			for (let sample = 0; sample < 3; sample++) {
				const started = performance.now();
				if (sample === 0) await openApp(page, webUrl);
				else await page.reload();
				await expect(page.locator(".message-row.user")).toHaveCount(count / 10);
				await expect(page.locator(".turn-process-summary")).toHaveCount(count / 10);
				await expect(
					page.locator(".message-row.assistant").filter({ hasText: `Completed task ${count / 10 - 1}.` })
				).toBeVisible();
				const navigationReadyMs = Math.round(performance.now() - started);
				const dom = await page.locator(".transcript").evaluate((element) => ({
					nodes: element.querySelectorAll("*").length,
					mountedProcessNodes: element.querySelectorAll(".turn-process-items > *").length,
				}));
				expect(dom.mountedProcessNodes).toBe(0);
				const { metrics } = await cdp.send("Performance.getMetrics");
				const heapUsedBytes = metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
				samples.push({ sample, navigationReadyMs, ...dom, heapUsedBytes });
			}
			const metricsPath = testInfo.outputPath("metrics.json");
			await writeFile(
				metricsPath,
				JSON.stringify({ schemaVersion: 1, mode: "vite-development", count, width, samples }, null, 2)
			);
			await testInfo.attach("history-metrics", { path: metricsPath, contentType: "application/json" });
			await page.screenshot({ path: testInfo.outputPath("history.png") });
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			expect(errors).toEqual([]);
			await cdp.detach();
		});
	}
	test(`searches folded history and preserves details at ${width}px`, async ({ page }, testInfo) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width, height: 900 });
		await selectHistory(page, `search-${width}`);
		await openApp(page, webUrl);
		await expect(page.locator(".turn-process-summary")).toHaveCount(200);
		await expect(page.locator(".turn-process-items > *")).toHaveCount(0);
		const closeRail = page.getByRole("button", { name: "关闭运行面板", exact: true }).first();
		if (await closeRail.isVisible()) await closeRail.click();
		if (width < 720) await page.getByRole("button", { name: "打开导航", exact: true }).click();
		await page.getByRole("textbox", { name: "搜索聊天正文" }).fill("HISTORY_PROOF_501");
		await page.locator(".session-search-hit").click();
		const target = page.locator('[data-message-id="history-501"]');
		await expect(target).toBeInViewport();
		await expect(target).toBeFocused();
		const process = page.locator(".turn-process").filter({ has: target });
		const group = process.locator(".tool-group-summary").first();
		await group.click();
		const tool = process.locator(".tool-group-items .tool-trace-summary").first();
		await tool.click();
		await expect(process.locator(".tool-result").first()).toContainText("export const result");
		await process.locator(".turn-process-summary").click();
		await expect(target).toBeHidden();
		await process.locator(".turn-process-summary").click();
		await expect(group).toHaveAttribute("aria-expanded", "true");
		await expect(process.locator(".tool-result").first()).toBeVisible();
		// A fresh search must reveal the process, even for the same hit after manual folding.
		for (const index of [503, 503]) {
			await process.locator(".turn-process-summary").click();
			if (width < 720) await page.getByRole("button", { name: "打开导航", exact: true }).click();
			await page.getByRole("textbox", { name: "搜索聊天正文" }).fill(`HISTORY_PROOF_${index}`);
			await page.locator(".session-search-hit").click();
			const hit = page.locator(`[data-message-id="history-${index}"]`);
			await expect(hit).toBeInViewport();
			await expect(hit).toBeFocused();
			await expect(group).toHaveAttribute("aria-expanded", "true");
			await expect(process.locator(".tool-result").first()).toBeVisible();
		}
		await page.screenshot({ path: testInfo.outputPath("history-search.png") });
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.reload();
		await expect(page.locator(".message-row.user")).toHaveCount(200);
		await expect(page.locator(".turn-process-items > *")).toHaveCount(0);
		// Seeded history has no durable turn to rewind; create a real editable tail.
		const composer = page.getByRole("textbox", { name: "消息", exact: true });
		await composer.fill("Tail task");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.locator(".message-row.user")).toHaveCount(201);
		await expect(page.getByRole("button", { name: "停止任务", exact: true })).toBeHidden();
		const user = page.locator(".message-row.user").last();
		await user.hover();
		await user.getByRole("button", { name: "编辑并重新发送" }).click();
		await composer.fill("Edited long history task");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.locator(".message-row.user")).toHaveCount(201);
		await expect(page.locator(".message-row.user").last()).toContainText("Edited long history task");
		await expect(page.locator(".message-row.assistant").last()).toContainText("Demo runtime received:");
		await expect(page.getByRole("button", { name: "停止任务", exact: true })).toBeHidden();
		await composer.fill("/long");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		const stop = page.getByRole("button", { name: "停止任务", exact: true });
		await expect(stop).toBeVisible();
		await expect(page.locator(".transcript")).toContainText("demo-step-1");
		const transcript = page.locator(".transcript");
		const top = await transcript.evaluate((element) => {
			element.scrollTop = 200;
			element.dispatchEvent(new Event("scroll"));
			return element.scrollTop;
		});
		const textLength = await page
			.locator(".message-row.assistant")
			.last()
			.evaluate((element) => element.textContent?.length ?? 0);
		await expect
			.poll(() =>
				page
					.locator(".message-row.assistant")
					.last()
					.evaluate((element) => element.textContent?.length ?? 0)
			)
			.toBeGreaterThan(textLength + 30);
		expect(Math.abs((await transcript.evaluate((element) => element.scrollTop)) - top)).toBeLessThan(2);
		await stop.click();
		await expect(stop).toBeHidden();
	});
}

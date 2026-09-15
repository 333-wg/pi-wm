import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const width of [1440, 390]) {
	test("research evidence trace fits viewport " + width, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		// Exercise the real trace component and app styles with deterministic tool states.
		await page.evaluate(async () => {
			const reactPath = "/node_modules/.vite/deps/react.js";
			const domPath = "/node_modules/.vite/deps/react-dom_client.js";
			const toolPath = "/src/components/ToolCard.tsx";
			const reactModule = await import(reactPath);
			const React = reactModule.default ?? reactModule;
			const domModule = await import(domPath);
			const { createRoot } = domModule.default ?? domModule;
			const { ToolCard } = await import(toolPath);
			const existing = document.getElementById("root");
			if (existing) existing.style.display = "none";
			const host = document.createElement("main");
			host.style.cssText = "max-width:1000px;margin:32px auto;padding:0 16px;box-sizing:border-box;width:100%";
			document.body.append(host);
			const levels = ["candidate_links", "page_content", "insufficient_content", "access_blocked"];
			createRoot(host).render(
				React.createElement(
					"div",
					null,
					...levels.map((level, index) =>
						React.createElement(
							ToolCard,
							{
								key: level,
								toolName: index === 0 ? "browser_search" : "browser_open",
								input:
									index === 0
										? { query: 'site:youtube.com "pi coding agent" detailed tutorials and demonstrations' }
										: { url: "https://www.youtube.com/watch?v=long-example-video-identifier" },
								status: "complete",
								webEvidence: { level, note: "Retrieved information is not independently verified." },
							},
							React.createElement("pre", { className: "tool-output" }, "Deterministic research result")
						)
					)
				)
			);
		});
		await expect(page.locator(".tool-evidence")).toHaveCount(4);
		await expect(page.getByText("页面已读取", { exact: true })).toBeVisible();
		for (const row of await page.locator(".tool-trace-summary").all()) {
			const boxes = await row.evaluate((element) =>
				[...element.children].map((child) => {
					const rect = child.getBoundingClientRect();
					return { left: rect.left, right: rect.right, width: rect.width };
				})
			);
			for (let index = 1; index < boxes.length; index++) {
				expect(boxes[index]!.left).toBeGreaterThanOrEqual(boxes[index - 1]!.right - 1);
			}
			expect(boxes.at(-1)!.right).toBeLessThanOrEqual(width);
		}
		await page.locator(".tool-trace-summary").first().click();
		await expect(page.locator(".tool-output")).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("search-evidence-" + width + ".png"), fullPage: true });
	});
}

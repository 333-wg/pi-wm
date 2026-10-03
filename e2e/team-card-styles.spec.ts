import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { TEAM_LAYOUT } from "../apps/web/src/lib/agent-teams.js";

const themes = ["light", "dark", "white", "paper", "warm-classic", "celadon", "ink-night", "ink-blue"];
const states = ["waiting", "running", "completed", "attention"];

for (const width of [1440, 390]) {
	test(`team card styles keep whole text lines and accessible statuses at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		// Exercise the real CSS cascade without a provider or application server.
		const css = await Promise.all(
			[
				"apps/web/src/styles.css",
				"apps/web/src/components/agent-teams.css",
				"apps/web/src/components/agent-teams-enhanced.css",
				"apps/web/src/components/persistent-agent-teams.css",
			].map((file) => readFile(file, "utf8"))
		);
		await page.setContent(`<!doctype html><html><head><style>${css.join("\n")}</style>
			<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style></head>
			<body><section class="teams-workbench persistent-teams" style="height:900px">
			${states
				.map(
					(
						state,
						index
					) => `<button class="teams-task-enhanced state-${state}" style="left:20px;top:${20 + index * TEAM_LAYOUT.row}px;width:${TEAM_LAYOUT.width}px;height:${TEAM_LAYOUT.height}px">
			<strong>检查用户认证、权限校验以及账号恢复流程是否完整</strong>
			<span class="teams-task-objective-enhanced">Inspect authentication, refresh tokens and account recovery with integration tests and verify the saved results.</span>
			<span class="teams-task-footer-enhanced"><span class="teams-status-enhanced state-${state}"><span>${state}</span></span><span class="teams-dependency-badge">2</span></span>
			</button>`
				)
				.join("")}</section></body></html>`);
		for (const theme of themes) {
			await page.locator("html").evaluate((element, value) => element.setAttribute("data-theme", value), theme);
			const measurements = await page.locator(".teams-task-enhanced").evaluateAll((cards) => {
				const luminance = (cssColor: string) => {
					const channels = cssColor
						.match(/[\d.]+/g)!
						.slice(0, 3)
						.map(Number)
						.map((value) => {
							const channel = value / 255;
							return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
						});
					return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
				};
				return cards.map((card) => {
					const style = getComputedStyle(card);
					const box = card.getBoundingClientRect();
					const children = [...card.children].map((child) => child.getBoundingClientRect());
					const status = getComputedStyle(card.querySelector(".teams-status-enhanced")!);
					const [high, low] = [luminance(status.color), luminance(status.backgroundColor)].sort((a, b) => b - a);
					return {
						opaqueStatus: status.backgroundColor.startsWith("rgb("),
						border: style.borderLeftWidth,
						padding: style.padding,
						height: box.height,
						textHeights: children.slice(0, 2).map((child) => child.height),
						contained: children.every(
							(child) =>
								child.left >= box.left && child.right <= box.right && child.top >= box.top && child.bottom <= box.bottom
						),
						overlaps: children.some((child, index) => index > 0 && child.top < children[index - 1]!.bottom),
						contrast: (high! + 0.05) / (low! + 0.05),
					};
				});
			});
			for (const measurement of measurements) {
				expect(measurement.opaqueStatus).toBe(true);
				expect(measurement.border).toBe("4px");
				expect(measurement.padding).toBe(width < 600 ? "10px 12px" : "12px 14px");
				expect(measurement.height).toBe(TEAM_LAYOUT.height);
				expect(measurement.textHeights).toEqual([32, 30]);
				expect(measurement.contained).toBe(true);
				expect(measurement.overlaps).toBe(false);
				expect(measurement.contrast, `${theme}: status contrast`).toBeGreaterThanOrEqual(4.5);
			}
			if (theme === "light" || theme === "dark")
				await page.screenshot({ path: testInfo.outputPath(`cards-${theme}.png`) });
		}
	});
}

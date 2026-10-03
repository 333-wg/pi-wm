import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

export default defineConfig({
	...base,
	testMatch: [
		"approval-panel.spec.ts",
		"edit-composer.spec.ts",
		"follow-up-queue.spec.ts",
		"transcript-recovery.spec.ts",
		"long-transcript.spec.ts",
		"team-card-styles.spec.ts",
	],
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	globalTimeout: 10 * 60_000,
	outputDir: "test-results/core",
	reporter: [["list"], ["html", { outputFolder: "playwright-report/core", open: "never" }]],
});

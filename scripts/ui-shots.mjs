#!/usr/bin/env node
// Screenshot harness for the Wuming workbench.
//
// Boots an isolated demo-mode gateway and Vite dev server on dynamic ports with
// disposable workspace/data directories, drives the UI with Playwright, and
// writes PNG screenshots plus a JSON report of console/page errors.
//
//   node scripts/ui-shots.mjs [--out DIR] [--only step,step] [--profiles name,name] [--keep]
//
// It never calls a paid provider: the gateway always runs WUMING_RUNTIME=demo.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { repositoryRoot, seedBrowser, startDemoStack } from "./lib/demo-stack.mjs";
import { desktopWalkthrough, mobileWalkthrough } from "./lib/walkthrough.mjs";

const token = "wuming-shots-token";

function parseArgs(argv) {
	const options = {
		out: join(repositoryRoot, "test-results", "shots"),
		only: null,
		profiles: null,
		keep: false,
	};
	const set = (raw) =>
		new Set(
			String(raw ?? "")
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		);
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--out") options.out = argv[(index += 1)];
		else if (arg === "--only") options.only = set(argv[(index += 1)]);
		else if (arg === "--profiles") options.profiles = set(argv[(index += 1)]);
		else if (arg === "--keep") options.keep = true;
	}
	return options;
}

/** The walkthrough's `capture`: turns each named state into a numbered PNG. */
class Recorder {
	constructor(page, options, outDir) {
		this.page = page;
		this.options = options;
		this.outDir = outDir;
		this.index = 0;
		this.shots = [];
		this.errors = [];
		page.on("console", (message) => {
			if (message.type() === "error") this.errors.push({ kind: "console", text: message.text() });
		});
		page.on("pageerror", (error) => this.errors.push({ kind: "pageerror", text: String(error) }));
	}

	wanted(name) {
		return !this.options.only || this.options.only.has(name);
	}

	async shot(name, { settle = 400, full = false } = {}) {
		if (!this.wanted(name)) return;
		this.index += 1;
		const file = `${String(this.index).padStart(2, "0")}-${name}.png`;
		await this.page.waitForTimeout(settle);
		await this.page.screenshot({ path: join(this.outDir, file), fullPage: full });
		this.shots.push(file);
		process.stdout.write(`  captured ${file}\n`);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	await rm(options.out, { recursive: true, force: true });
	await mkdir(options.out, { recursive: true });

	let browser;
	const stack = await startDemoStack({ token, log: (line) => process.stdout.write(line) });
	const report = { startedAt: new Date().toISOString(), shots: [], errors: [] };
	try {
		browser = await chromium.launch();
		// The dark pass repeats the whole desktop walkthrough rather than sampling a
		// few screens: the theme is a token swap, so any surface that hard-codes a
		// colour only betrays itself when you look at it side by side with the light
		// shot of the same step.
		const profiles = [
			{ name: "desktop", viewport: { width: 1440, height: 900 }, walk: desktopWalkthrough },
			{ name: "desktop-dark", viewport: { width: 1440, height: 900 }, walk: desktopWalkthrough, theme: "dark" },
			{ name: "mobile", viewport: { width: 430, height: 932 }, walk: mobileWalkthrough },
			{ name: "mobile-dark", viewport: { width: 430, height: 932 }, walk: mobileWalkthrough, theme: "dark" },
		];
		for (const profile of profiles) {
			if (options.profiles && !options.profiles.has(profile.name)) continue;
			process.stdout.write(`${profile.name}:\n`);
			const outDir = join(options.out, profile.name);
			await mkdir(outDir, { recursive: true });
			const context = await browser.newContext({
				viewport: profile.viewport,
				deviceScaleFactor: 1,
				locale: "zh-CN",
				// Pinned so a dark-themed CI host cannot flip the light profiles.
				colorScheme: "light",
			});
			await seedBrowser(context, { token, theme: profile.theme });
			const page = await context.newPage();
			const recorder = new Recorder(page, options, outDir);
			await page.goto(stack.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
			await page.getByText("已连接", { exact: true }).waitFor({ timeout: 30_000 });
			await profile.walk(recorder);
			report.shots.push(...recorder.shots.map((file) => `${profile.name}/${file}`));
			report.errors.push(...recorder.errors.map((entry) => ({ ...entry, profile: profile.name })));
			await context.close();
		}
	} finally {
		if (browser) await browser.close().catch(() => {});
		await stack.stop({ keep: options.keep });
	}

	report.finishedAt = new Date().toISOString();
	await writeFile(join(options.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
	process.stdout.write(`\n${report.shots.length} shots, ${report.errors.length} errors\n`);
	for (const entry of report.errors.slice(0, 12)) {
		process.stdout.write(`  [${entry.profile}/${entry.kind}] ${entry.text}\n`);
	}
}

await main();

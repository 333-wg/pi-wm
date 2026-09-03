#!/usr/bin/env node
// Runtime contrast crawl for the rendered workbench.
//
//   node scripts/contrast-crawl.mjs [--profiles name,name] [--json FILE]
//
// `scripts/token-contrast.mjs` is the fast gate, but it can only check pairs a
// human declared. This is the other half: it boots the demo stack, walks the
// whole app in both themes, and for every visible run of text resolves the
// colour that actually reaches the pixels — compositing translucent layers,
// following the ancestor chain to the first opaque background, sampling every
// stop of a gradient, and folding in inherited `opacity`.
//
// It reports what the static gate cannot see:
//   FAIL        text below its WCAG floor, wherever it occurs
//   UNDECLARED  a pair that occurs on screen but has no row in PAIRS
//   DIM         text dimmed by an ancestor's opacity, usually a disabled
//               control, which WCAG exempts — listed to be judged, not fixed
//
// FAIL and UNDECLARED both exit non-zero: the first is a defect, the second
// means the fast gate has a blind spot. This needs a browser and about two
// minutes, so it is not part of `check` — run it after touching styles.css or
// adding a surface, then fold what it reports into PAIRS.

import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { seedBrowser, startDemoStack } from "./lib/demo-stack.mjs";
import { desktopWalkthrough, mobileWalkthrough } from "./lib/walkthrough.mjs";
import { LIGHT_ONLY_PAIRS, PAIRS, tokenTables } from "./token-contrast.mjs";

const token = "wuming-crawl-token";

function parseArgs(argv) {
	const options = { profiles: null, json: null };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--profiles") {
			options.profiles = new Set(
				String(argv[(index += 1)] ?? "")
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean),
			);
		} else if (arg === "--json") options.json = argv[(index += 1)];
	}
	return options;
}

/**
 * Runs in the page: resolves every visible run of text to the foreground and
 * background that actually meet on screen. Serialised by Playwright, so it may
 * not reference anything outside its own body.
 */
function collectSamples(tokenNames) {
	const parse = (value) => {
		const match = /^rgba?\(([^)]+)\)$/.exec(String(value).trim());
		if (!match) return null;
		const parts = match[1]
			.split(/[,/\s]+/)
			.filter(Boolean)
			.map(Number);
		if (parts.length < 3 || parts.slice(0, 3).some((part) => Number.isNaN(part))) return null;
		return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
	};
	const over = (top, bottom) => ({
		r: top.r * top.a + bottom.r * (1 - top.a),
		g: top.g * top.a + bottom.g * (1 - top.a),
		b: top.b * top.a + bottom.b * (1 - top.a),
		a: 1,
	});
	const key = (color) => `${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)}`;
	const channel = (value) => {
		const unit = value / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	};
	const luminance = (color) =>
		0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
	const contrast = (fore, back) => {
		const [high, low] = [luminance(fore), luminance(back)].sort((a, b) => b - a);
		return (high + 0.05) / (low + 0.05);
	};

	// Tokens are resolved through the browser rather than the stylesheet, so
	// aliases, inherited values and rgba() all come back as real pixels. A token
	// that is not a colour at all (a gradient, a shadow) falls through to the
	// sentinel the wrapper sets and is dropped.
	const sentinel = "rgb(1, 2, 3)";
	const holder = document.createElement("div");
	holder.style.cssText = `position:absolute;left:-9999px;top:0;color:${sentinel}`;
	const probe = document.createElement("span");
	holder.append(probe);
	document.body.append(holder);
	const named = new Map();
	for (const name of tokenNames) {
		probe.style.color = "";
		probe.style.color = `var(${name})`;
		const resolved = getComputedStyle(probe).color;
		if (resolved === sentinel) continue;
		const rgb = parse(resolved);
		if (!rgb || rgb.a < 1) continue;
		named.set(key(rgb), [...(named.get(key(rgb)) ?? []), name]);
	}
	holder.remove();
	const nameOf = (color) => named.get(key(color)) ?? [];

	/** Colour stops of a computed `background-image`, in source order. */
	const stopsOf = (image) => {
		if (!image || image === "none") return [];
		const found = [];
		for (const [raw] of image.matchAll(/rgba?\([^)]*\)/g)) {
			const rgb = parse(raw);
			if (rgb) found.push(rgb);
		}
		return found;
	};

	/**
	 * Every colour that can sit behind `element`: the composite of the colour
	 * layers up to the first opaque one, plus that composite under each gradient
	 * stop found on the way. A gradient is judged at its stops because the worst
	 * case of a two-stop ramp is always an endpoint, and a gradient whose stops
	 * are all opaque hides everything below it — its base is never painted.
	 */
	const backdrops = (element) => {
		const layers = [];
		const stops = [];
		let covered = false;
		for (let node = element; node; node = node.parentElement) {
			const style = getComputedStyle(node);
			// Within one element the image paints over the colour, so an opaque
			// gradient ends the walk before its own background-color counts.
			const found = stopsOf(style.backgroundImage);
			if (found.length > 0) {
				stops.push(...found);
				if (found.every((stop) => stop.a >= 1)) {
					covered = true;
					break;
				}
			}
			const background = parse(style.backgroundColor);
			if (!background || background.a === 0) continue;
			layers.push(background);
			if (background.a >= 1) break;
		}
		// White is the canvas underneath everything, matching a default page.
		let base = { r: 255, g: 255, b: 255, a: 1 };
		for (let index = layers.length - 1; index >= 0; index -= 1) base = over(layers[index], base);
		const painted = stops.filter((stop) => stop.a > 0).map((stop) => over(stop, base));
		return covered ? painted : [base, ...painted];
	};

	/** Inherited `opacity` multiplies down the tree, so a dimmed ancestor dims the text. */
	const dimming = (element) => {
		let factor = 1;
		for (let node = element; node; node = node.parentElement) {
			const value = Number.parseFloat(getComputedStyle(node).opacity);
			if (Number.isFinite(value)) factor *= value;
		}
		return factor;
	};

	const pathOf = (element) => {
		const parts = [];
		let node = element;
		for (let depth = 0; node && depth < 3; depth += 1) {
			const classes = String(node.getAttribute("class") ?? "")
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.slice(0, 2)
				.map((name) => `.${name}`)
				.join("");
			parts.unshift(`${node.tagName.toLowerCase()}${classes}`);
			node = node.parentElement;
		}
		return parts.join(">");
	};

	const seen = new Set();
	const samples = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = (node.nodeValue ?? "").trim();
		const element = node.parentElement;
		if (!text || !element || seen.has(element)) continue;
		seen.add(element);
		if (element.closest('[aria-hidden="true"]')) continue;
		const style = getComputedStyle(element);
		if (style.visibility !== "visible") continue;
		// A zero box means `display:none` somewhere above, so nothing is painted.
		const box = element.getBoundingClientRect();
		if (box.width < 1 || box.height < 1) continue;
		const fore = parse(style.color);
		if (!fore || fore.a === 0) continue;
		const factor = dimming(element);
		if (factor <= 0.01) continue;

		let worst = null;
		for (const back of backdrops(element)) {
			const ratio = contrast(over({ ...fore, a: fore.a * factor }, back), back);
			if (!worst || ratio < worst.ratio) worst = { ratio, back };
		}
		const size = Number.parseFloat(style.fontSize);
		const weight = Number.parseFloat(style.fontWeight) || 400;
		// WCAG's large-text allowance, the only place the 3:1 floor applies to words.
		const large = size >= 24 || (size >= 18.66 && weight >= 700);
		samples.push({
			foreTokens: nameOf(fore),
			backTokens: nameOf(worst.back),
			fore: key(fore),
			back: key(worst.back),
			ratio: Math.round(worst.ratio * 100) / 100,
			floor: large ? 3 : 4.5,
			dimmed: factor < 0.999,
			path: pathOf(element),
			text: text.slice(0, 34),
		});
	}
	return samples;
}

/** The walkthrough's `capture`: turns each named state into a set of measurements. */
class Sampler {
	constructor(page, tokenNames) {
		this.page = page;
		this.tokenNames = tokenNames;
		this.rows = [];
		this.errors = [];
		page.on("console", (message) => {
			if (message.type() === "error") this.errors.push(message.text());
		});
		page.on("pageerror", (error) => this.errors.push(String(error)));
	}

	async shot(name, { settle = 400 } = {}) {
		await this.page.waitForTimeout(settle);
		const samples = await this.page.evaluate(collectSamples, this.tokenNames);
		for (const sample of samples) this.rows.push({ ...sample, step: name });
	}
}

/** One row per distinct (foreground, background, floor) combination, worst ratio first. */
function aggregate(rows) {
	const groups = new Map();
	for (const row of rows) {
		const fore = row.foreTokens.join("/") || `rgb(${row.fore})`;
		const back = row.backTokens.join("/") || `rgb(${row.back})`;
		const id = `${fore}|${back}|${row.floor}|${row.dimmed}`;
		const group = groups.get(id) ?? {
			fore,
			back,
			foreTokens: row.foreTokens,
			backTokens: row.backTokens,
			floor: row.floor,
			dimmed: row.dimmed,
			ratio: Number.POSITIVE_INFINITY,
			count: 0,
			samples: [],
		};
		group.count += 1;
		group.ratio = Math.min(group.ratio, row.ratio);
		if (group.samples.length < 2 && !group.samples.some((sample) => sample.path === row.path)) {
			group.samples.push({ step: row.step, path: row.path, text: row.text });
		}
		groups.set(id, group);
	}
	return [...groups.values()].sort((left, right) => left.ratio - right.ratio);
}

const declared = [...PAIRS, ...LIGHT_ONLY_PAIRS];

/**
 * How a measured pair relates to the declared list: `undeclared` when no row
 * covers it, `weak` when the rows that do sit below the floor this text needs,
 * `ok` otherwise. Pairs with an untokenised side are left alone — a composited
 * colour has no name to declare.
 */
function coverage(group) {
	if (group.foreTokens.length === 0 || group.backTokens.length === 0) return "untokenised";
	const matches = declared.filter(
		(row) => group.foreTokens.includes(row.fore) && group.backTokens.includes(row.back),
	);
	if (matches.length === 0) return "undeclared";
	return matches.some((row) => row.floor >= group.floor) ? "ok" : "weak";
}

function describe(group) {
	const head = `${group.fore} on ${group.back}`;
	const sample = group.samples[0];
	return `${head.padEnd(40)} x${String(group.count).padEnd(4)} ${sample.step} ${sample.path} "${sample.text}"`;
}

/**
 * Tokens that share a value are indistinguishable on screen, so a measurement
 * can name several. Prefer one the declared list already uses on that side, so
 * suggestions reuse the vocabulary instead of inventing a synonym.
 */
function pick(tokens, side) {
	const known = new Set(declared.map((row) => row[side]));
	return tokens.find((name) => known.has(name)) ?? tokens[0];
}

function report(name, rows) {
	const groups = aggregate(rows);
	const failures = [];
	process.stdout.write(`\n${name}: ${rows.length} text runs, ${groups.length} pairs\n`);
	for (const group of groups) {
		const state = coverage(group);
		const ratio = group.ratio.toFixed(2);
		if (group.ratio + 0.005 < group.floor) {
			// Dimmed text is almost always a disabled control, which WCAG exempts.
			const label = group.dimmed ? "DIM " : "FAIL";
			if (!group.dimmed) failures.push({ kind: "FAIL", group });
			process.stdout.write(`  ${label} ${ratio} < ${group.floor.toFixed(2)}  ${describe(group)}\n`);
			continue;
		}
		if (state === "undeclared" || state === "weak") {
			failures.push({ kind: state.toUpperCase(), group });
			process.stdout.write(
				`  ${state === "weak" ? "WEAK" : "NEW "} ${ratio} ≥ ${group.floor.toFixed(2)}  ${describe(group)}\n`,
			);
		}
	}
	if (failures.length === 0) process.stdout.write("  all pairs declared and above their floor\n");
	return failures;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const tables = await tokenTables();
	const tokenNames = [...new Set([...tables.light.keys(), ...tables.dark.keys()])];

	let browser;
	const stack = await startDemoStack({ token, log: (line) => process.stdout.write(line) });
	const collected = [];
	try {
		browser = await chromium.launch();
		const profiles = [
			{ name: "desktop", viewport: { width: 1440, height: 900 }, walk: desktopWalkthrough },
			{ name: "desktop-dark", viewport: { width: 1440, height: 900 }, walk: desktopWalkthrough, theme: "dark" },
			{ name: "mobile", viewport: { width: 430, height: 932 }, walk: mobileWalkthrough },
			{ name: "mobile-dark", viewport: { width: 430, height: 932 }, walk: mobileWalkthrough, theme: "dark" },
		];
		for (const profile of profiles) {
			if (options.profiles && !options.profiles.has(profile.name)) continue;
			process.stdout.write(`crawling ${profile.name}\n`);
			const context = await browser.newContext({
				viewport: profile.viewport,
				deviceScaleFactor: 1,
				locale: "zh-CN",
				colorScheme: "light",
			});
			await seedBrowser(context, { token, theme: profile.theme });
			const page = await context.newPage();
			const sampler = new Sampler(page, tokenNames);
			await page.goto(stack.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
			await page.getByText("已连接", { exact: true }).waitFor({ timeout: 30_000 });
			await profile.walk(sampler);
			collected.push({ profile: profile.name, rows: sampler.rows, errors: sampler.errors });
			await context.close();
		}
	} finally {
		if (browser) await browser.close().catch(() => {});
		await stack.stop();
	}

	const failures = [];
	for (const entry of collected) {
		failures.push(...report(entry.profile, entry.rows).map((item) => ({ ...item, profile: entry.profile })));
		for (const error of entry.errors.slice(0, 5)) process.stdout.write(`  [console] ${error}\n`);
	}

	if (options.json) {
		await writeFile(options.json, `${JSON.stringify(collected, null, 2)}\n`, "utf8");
		process.stdout.write(`\nwrote ${options.json}\n`);
	}

	const rows = new Map();
	for (const { kind, group } of failures) {
		if (kind === "FAIL") continue;
		const line = `\t{ fore: "${pick(group.foreTokens, "fore")}", back: "${pick(group.backTokens, "back")}", floor: ${group.floor}, where: "${group.samples[0].path}" },`;
		rows.set(line, kind);
	}
	if (rows.size > 0) {
		process.stdout.write(`\n${rows.size} pairs to declare in PAIRS (fix the \`where\` before pasting):\n`);
		for (const line of rows.keys()) process.stdout.write(`${line}\n`);
	}

	if (failures.length > 0) {
		const counted = failures.reduce((tally, item) => ({ ...tally, [item.kind]: (tally[item.kind] ?? 0) + 1 }), {});
		const summary = Object.entries(counted)
			.map(([kind, count]) => `${count} ${kind}`)
			.join(", ");
		process.stderr.write(`\n${summary}\n`);
		process.exit(1);
	}
	process.stdout.write("\nevery pair on screen is declared and above its floor\n");
}

await main();

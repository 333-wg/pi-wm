#!/usr/bin/env node
// Contrast gate for the design tokens in apps/web/src/styles.css.
//
//   node scripts/token-contrast.mjs [--all]
//
// The dark theme is a value swap over the same token names, so a badly pitched
// shade cannot be caught by typechecking and is easy to miss in a screenshot.
// This resolves every palette's inherited tokens and checks pairs that meet on
// screen against a WCAG floor: 4.5:1 wherever the user reads something — words,
// and digits like a diff gutter's line numbers — and 3:1 where the token only
// fills a dot, a caret or a marker.
//
// `--all` additionally prints the full text-on-surface matrix, including pairs
// that never occur, which is useful when re-pitching a whole ramp.
//
// The declared list below is what keeps this fast and browserless, and also its
// one weakness: a new rule can pair two tokens nobody wrote a row for. That is
// what `scripts/contrast-crawl.mjs` is for — it walks the rendered app and
// reports pairs missing from here. This module exports the list for it.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stylesheet = join(dirname(fileURLToPath(import.meta.url)), "..", "apps/web/src/styles.css");

/**
 * Pairs that exist in the rendered UI, with the floor each one has to clear.
 * Keep this aligned with the rules named in `where` — if a rule moves to a
 * different token, move its row too. Rows for pairs that cannot fail (dark text
 * on a near-white surface) are still worth having: they are what makes a
 * re-pitch of a *surface* safe.
 */
export const PAIRS = [
	// The text ramp, against every surface it is actually painted on.
	{ fore: "--ink", back: "--panel", floor: 4.5, where: "transcript headings" },
	{ fore: "--ink", back: "--surface", floor: 4.5, where: "card titles" },
	{ fore: "--ink", back: "--surface-muted", floor: 4.5, where: "context meter figure, rail values" },
	{ fore: "--ink", back: "--surface-sunken", floor: 4.5, where: "tool verb on an expanded card" },
	{ fore: "--ink", back: "--surface-code", floor: 4.5, where: "tool verb on a code card" },
	{ fore: "--ink", back: "--red-soft", floor: 4.5, where: "tool verb on a failed card" },
	{ fore: "--text", back: "--panel", floor: 4.5, where: "transcript copy" },
	{ fore: "--text", back: "--surface", floor: 4.5, where: "body copy on cards" },
	{ fore: "--text", back: "--bg", floor: 4.5, where: "copy on the page" },
	{ fore: "--text", back: "--surface-muted", floor: 4.5, where: "rail key/value rows, workbench headings" },
	{ fore: "--text", back: "--surface-code", floor: 4.5, where: "code lines with no token class" },
	{ fore: "--text", back: "--amber-soft", floor: 4.5, where: "the approval heading" },
	{ fore: "--text", back: "--hunk-bg", floor: 4.5, where: "hunk headers" },
	{ fore: "--text-soft", back: "--panel", floor: 4.5, where: "blockquotes" },
	{ fore: "--text-soft", back: "--surface", floor: 4.5, where: "secondary copy" },
	{ fore: "--text-soft", back: "--surface-muted", floor: 4.5, where: "rail item labels" },
	{ fore: "--text-soft", back: "--surface-sunken", floor: 4.5, where: "table headers" },
	{ fore: "--text-soft", back: "--surface-code", floor: 4.5, where: "tool target paths" },
	{ fore: "--text-soft", back: "--red-soft", floor: 4.5, where: "tool target on a failed card" },
	{ fore: "--muted", back: "--surface", floor: 4.5, where: "labels, hints" },
	{ fore: "--muted", back: "--panel", floor: 4.5, where: "composer placeholder" },
	{ fore: "--muted", back: "--sidebar", floor: 4.5, where: "sidebar labels" },
	{ fore: "--muted", back: "--fill", floor: 4.5, where: "neutral chips" },
	{ fore: "--muted", back: "--surface-muted", floor: 4.5, where: "rail section headings, palette footer" },
	{ fore: "--muted", back: "--surface-sunken", floor: 4.5, where: "workbench tabs, code-block language" },
	{ fore: "--muted", back: "--surface-code", floor: 4.5, where: "tool card meta" },
	{ fore: "--muted", back: "--gap-bg", floor: 4.5, where: "diff gap rows" },
	{ fore: "--muted", back: "--meta-bg", floor: 4.5, where: "diff file meta" },
	{ fore: "--muted", back: "--add-bg", floor: 4.5, where: "gutter numbers on an added line" },
	{ fore: "--muted", back: "--del-bg", floor: 4.5, where: "gutter numbers on a removed line" },
	{ fore: "--faint", back: "--surface", floor: 4.5, where: "kbd chips, optional labels" },
	{ fore: "--faint", back: "--surface-muted", floor: 4.5, where: "empty-state kbd chips" },
	{ fore: "--faint", back: "--panel", floor: 4.5, where: "workbench empty-state copy" },

	// Non-text: tokens that only fill a marker, a caret or a dot.
	{ fore: "--faint-soft", back: "--surface", floor: 3, where: "tool carets, context diff markers" },
	{ fore: "--dot", back: "--surface", floor: 3, where: "idle status dots" },
	{ fore: "--dot", back: "--sidebar", floor: 3, where: "session phase dots" },

	// Accent text, on its own tinted fill and on the surfaces it also lands on.
	{ fore: "--green", back: "--green-soft", floor: 4.5, where: "success pills" },
	{ fore: "--green", back: "--surface", floor: 4.5, where: "accent labels" },
	{ fore: "--green", back: "--panel", floor: 4.5, where: "the streaming 实时 label" },
	{ fore: "--green", back: "--surface-muted", floor: 4.5, where: "the rail phase value" },
	{ fore: "--green", back: "--surface-code", floor: 4.5, where: "diff-stat additions" },
	{ fore: "--green-strong", back: "--green-soft", floor: 4.5, where: "the active suggestion label" },
	{ fore: "--green-mute", back: "--green-soft", floor: 4.5, where: "the active suggestion detail" },
	{ fore: "--blue", back: "--blue-soft", floor: 4.5, where: "running pills" },
	{ fore: "--blue", back: "--hunk-bg", floor: 4.5, where: "hunk range headers" },
	{ fore: "--amber", back: "--amber-soft", floor: 4.5, where: "approval pills" },
	{ fore: "--amber", back: "--amber-fill", floor: 4.5, where: "change status letters, the approval icon" },
	{ fore: "--amber", back: "--panel", floor: 4.5, where: "the runtime note under a tool backend" },
	{ fore: "--amber-ink", back: "--amber-soft", floor: 4.5, where: "approval copy" },
	{ fore: "--red", back: "--red-soft", floor: 4.5, where: "error pills" },
	{ fore: "--red", back: "--red-fill", floor: 4.5, where: "failed tool pills" },
	{ fore: "--red", back: "--surface-code", floor: 4.5, where: "diff-stat deletions" },
	{ fore: "--red-ink", back: "--red-soft", floor: 4.5, where: "error copy" },
	{ fore: "--red-ink", back: "--surface-muted", floor: 4.5, where: "run history errors" },
	{ fore: "--solid-text", back: "--solid", floor: 4.5, where: "primary buttons" },
	{ fore: "--solid-text", back: "--solid-hover", floor: 4.5, where: "the light stop of the brand-mark gradient" },

	// The syntax palette. Every class here is text, so all of them take 4.5 —
	// `.tok-attr` borrows `--tok-number`, so that row covers it too.
	{ fore: "--tok-comment", back: "--surface-code", floor: 4.5, where: "comments" },
	{ fore: "--tok-string", back: "--surface-code", floor: 4.5, where: "strings" },
	{ fore: "--tok-number", back: "--surface-code", floor: 4.5, where: "numbers, markup attributes" },
	{ fore: "--tok-keyword", back: "--surface-code", floor: 4.5, where: "keywords" },
	{ fore: "--tok-builtin", back: "--surface-code", floor: 4.5, where: "types and built-ins" },
	{ fore: "--tok-function", back: "--surface-code", floor: 4.5, where: "call sites" },
	{ fore: "--tok-property", back: "--surface-code", floor: 4.5, where: "property names" },
	{ fore: "--tok-punct", back: "--surface-code", floor: 4.5, where: "punctuation" },
	{ fore: "--tok-tag", back: "--surface-code", floor: 4.5, where: "markup tags" },
	{ fore: "--tok-meta", back: "--surface-code", floor: 4.5, where: "shebangs and directives" },
	{ fore: "--code-inline-text", back: "--code-inline", floor: 4.5, where: "inline code" },

	// Diffs. The add/del text lands on two different backgrounds: the tinted row
	// of a rendered diff, and the plain code surface of a fenced ```diff block.
	{ fore: "--add-text", back: "--add-bg", floor: 4.5, where: "added diff lines, their + marker" },
	{ fore: "--del-text", back: "--del-bg", floor: 4.5, where: "removed diff lines, their - marker" },
	{ fore: "--add-text", back: "--surface-code", floor: 4.5, where: "added lines in a fenced diff" },
	{ fore: "--del-text", back: "--surface-code", floor: 4.5, where: "removed lines in a fenced diff" },
];

/** Terminal pairs, checked for every palette, including the light terminal variants. */
export const LIGHT_ONLY_PAIRS = [
	{ fore: "--term-text", back: "--term-bg", floor: 4.5, where: "terminal output" },
	{ fore: "--term-text", back: "--term-head", floor: 4.5, where: "the terminal panel title" },
	{ fore: "--term-muted", back: "--term-bg", floor: 4.5, where: "terminal status" },
	{ fore: "--term-ready", back: "--term-head", floor: 4.5, where: "terminal ready label" },
	{ fore: "--term-error-text", back: "--term-error-bg", floor: 4.5, where: "terminal errors" },
];

const TEXT_RAMP = ["--ink", "--text", "--text-soft", "--muted", "--faint", "--faint-soft"];
const SURFACE_RAMP = ["--bg", "--panel", "--surface", "--surface-muted", "--surface-sunken", "--surface-hover", "--surface-code", "--fill", "--sidebar"];

function tokenBlock(css, opener) {
	const start = css.indexOf(opener);
	if (start < 0) throw new Error(`token block ${opener} not found in ${stylesheet}`);
	const from = start + opener.length;
	const end = css.indexOf("}", from);
	const body = css.slice(from, end);
	const table = new Map();
	for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) table.set(name, value.trim());
	return table;
}

/** All inherited token tables, keyed by palette name. */
export async function tokenTables() {
	const css = await readFile(stylesheet, "utf8");
	const light = tokenBlock(css, ":root {");
	const dark = new Map([...light, ...tokenBlock(css, ':root[data-theme="dark"] {')]);
	const tables = { light, dark };
	for (const id of ["white", "paper", "warm-classic", "celadon", "ink-night", "ink-blue"]) {
		tables[id] = new Map([...(id.startsWith("ink-") ? dark : light), ...tokenBlock(css, ':root[data-theme="' + id + '"] {')]);
	}
	return tables;
}

/** Resolves a token to rgb, following `var(...)` aliases. Returns null for gradients and rgba(). */
export function resolve(table, name, depth = 0) {
	const value = table.get(name);
	if (value === undefined || depth > 4) return null;
	const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value);
	if (alias) return resolve(table, alias[1], depth + 1);
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
	if (!hex) return null;
	const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
	return [0, 2, 4].map((index) => Number.parseInt(digits.slice(index, index + 2), 16));
}

function luminance([r, g, b]) {
	const [rl, gl, bl] = [r, g, b].map((channel) => {
		const unit = channel / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrast(fore, back) {
	const [high, low] = [luminance(fore), luminance(back)].sort((a, b) => b - a);
	return (high + 0.05) / (low + 0.05);
}

async function main() {
	const tables = await tokenTables();
	const themes = Object.entries(tables).map(([name, table]) => ({ name, table, pairs: [...PAIRS, ...LIGHT_ONLY_PAIRS] }));

	let failures = 0;
	for (const theme of themes) {
		const rows = [];
		for (const pair of theme.pairs) {
			const fore = resolve(theme.table, pair.fore);
			const back = resolve(theme.table, pair.back);
			if (!fore || !back) {
				failures += 1;
				rows.push(`  MISSING ${pair.fore} on ${pair.back} — ${pair.where}`);
				continue;
			}
			const ratio = contrast(fore, back);
			if (ratio + 0.005 < pair.floor) {
				failures += 1;
				rows.push(`  FAIL ${ratio.toFixed(2)} < ${pair.floor}  ${pair.fore} on ${pair.back} — ${pair.where}`);
			}
		}
		process.stdout.write(`${theme.name}: ${theme.pairs.length - rows.length}/${theme.pairs.length} pairs pass\n`);
		for (const row of rows) process.stdout.write(`${row}\n`);

		if (process.argv.includes("--all")) {
			for (const fore of TEXT_RAMP) {
				const foreground = resolve(theme.table, fore);
				if (!foreground) continue;
				const cells = SURFACE_RAMP.map((back) => {
					const background = resolve(theme.table, back);
					return background ? contrast(foreground, background).toFixed(2).padStart(6) : "     -";
				});
				process.stdout.write(`  ${fore.padEnd(14)}${cells.join("")}\n`);
			}
			process.stdout.write(`  ${"".padEnd(14)}${SURFACE_RAMP.map((n) => n.replace("--", "").slice(0, 6).padStart(6)).join("")}\n`);
		}
	}

	if (failures > 0) {
		process.stderr.write(`\n${failures} contrast failures — re-pitch the token or move the rule to a stronger one.\n`);
		process.exit(1);
	}
}

// Importers (the crawler) only want the pair list and the maths.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

#!/usr/bin/env node
// Typecheck gate for test code.
//
//   node scripts/check-tests.mjs [--only name,name]
//
// Every workspace's `tsconfig.json` is a composite project with
// `rootDir: "src"`, which is what lets `tsc -b` emit `dist/*.d.ts` for the
// other packages to consume — and which also forbids adding `test/**` to its
// `include`, since test files live outside that root. The consequence is easy
// to miss: thousands of lines of test code compile only under vitest's
// transform, which strips types without checking them. A test can pass while
// asserting against a shape the production types no longer have.
//
// So each workspace carries a second config, `tsconfig.test.json`, that drops
// `composite` and widens the root to the package, and this script runs them.
// It also fails when a workspace has a `test/` directory but no such config —
// otherwise a new package would silently inherit the same blind spot.
//
// `--only` limits the run while iterating on one package's errors.

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript")), "tsc.js");

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Workspace directories, in the order `packages/*` then `apps/*`. */
async function workspaces() {
	const found = [];
	for (const group of ["packages", "apps"]) {
		const entries = await readdir(join(root, group), { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.isDirectory()) found.push(`${group}/${entry.name}`);
		}
	}
	return found;
}

/** Runs one config to completion, capturing whatever tsc reported. */
async function typecheck(workspace) {
	const started = Date.now();
	const output = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [tsc, "-p", join(root, workspace, "tsconfig.test.json"), "--pretty", "false"], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let text = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { text += chunk; });
		child.stderr.on("data", (chunk) => { text += chunk; });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, text }));
	});
	// tsc writes diagnostics to stdout and exits non-zero, so the exit code is
	// the verdict and the text is only for the report.
	const errors = output.text.match(/error TS\d+:/g)?.length ?? 0;
	return { workspace, ok: output.code === 0, errors, text: output.text.trimEnd(), elapsed: Date.now() - started };
}

const only = process.argv.includes("--only")
	? (process.argv[process.argv.indexOf("--only") + 1] ?? "").split(",").filter(Boolean)
	: undefined;

const all = await workspaces();
const missing = [];
const targets = [];
for (const workspace of all) {
	if (!(await exists(join(root, workspace, "test")))) continue;
	if (!(await exists(join(root, workspace, "tsconfig.test.json")))) {
		missing.push(workspace);
		continue;
	}
	if (!only || only.some((name) => workspace.endsWith(`/${name}`) || workspace === name)) targets.push(workspace);
}

// Each program is a separate tsc process, so this is bounded by memory rather
// than by cores; half the reported parallelism keeps a laptop responsive.
const limit = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
const results = [];
const queue = [...targets];
await Promise.all(
	Array.from({ length: Math.min(limit, queue.length) }, async () => {
		for (let workspace = queue.shift(); workspace; workspace = queue.shift()) {
			results.push(await typecheck(workspace));
		}
	}),
);
results.sort((a, b) => targets.indexOf(a.workspace) - targets.indexOf(b.workspace));

for (const result of results) {
	if (result.ok) {
		console.log(`ok   ${result.workspace} (${(result.elapsed / 1000).toFixed(1)}s)`);
		continue;
	}
	console.log(`FAIL ${result.workspace} — ${result.errors} error(s)`);
	if (result.text) console.log(`${result.text}\n`);
}
for (const workspace of missing) {
	console.log(`FAIL ${workspace} — has test/ but no tsconfig.test.json, so its test code is never typechecked`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length === 0 && missing.length === 0) {
	console.log(`\n${results.length} workspace(s) typechecked, tests included.`);
	process.exit(0);
}
console.log(
	`\n${failed.length + missing.length} of ${targets.length + missing.length} workspace(s) failed: ${[...failed.map((result) => result.workspace), ...missing].join(", ")}`,
);
process.exit(1);

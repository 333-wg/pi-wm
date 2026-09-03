import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceSearcher } from "../src/index.js";

const cleanup: string[] = [];

afterEach(async () => {
	for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Creates a workspace from a path -> contents map, making parents as needed. */
async function workspace(name: string, files: Record<string, string | Buffer>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `wuming-search-${name}-`));
	cleanup.push(root);
	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, ...path.split("/"));
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, contents);
	}
	return root;
}

const ignoreFixture = {
	".gitignore": "# comment\ndist/\n*.log\n!keep.log\n/root-only.txt\n",
	"src/.gitignore": "generated\n",
	"a.ts": "export const a = 1;\n",
	"root-only.txt": "ignored at the root only\n",
	"nested/root-only.txt": "kept because the rule is anchored\n",
	"debug.log": "ignored\n",
	"keep.log": "re-included by negation\n",
	"dist/bundle.js": "ignored\n",
	"src/index.ts": "export const index = 1;\n",
	"src/util.ts": "export const util = 1;\n",
	"src/generated/schema.ts": "ignored by the nested rule\n",
};

describe("WorkspaceSearcher ignore handling", () => {
	it("applies nested ignore files, negation, directory-only and anchored rules", async () => {
		const root = await workspace("ignore", ignoreFixture);
		const searcher = await WorkspaceSearcher.create(root);

		const all = await searcher.glob("**/*");
		expect(all.paths.slice().sort()).toEqual([
			".gitignore",
			"a.ts",
			"keep.log",
			"nested/root-only.txt",
			"src/.gitignore",
			"src/index.ts",
			"src/util.ts",
		]);
		expect(all.truncated).toBe(false);
	});

	it("walks everything except the built-in names when gitignore is not followed", async () => {
		const root = await workspace("no-ignore", { ...ignoreFixture, "node_modules/pkg/index.js": "vendored\n" });
		const searcher = await WorkspaceSearcher.create(root, { followGitignore: false });

		const paths = (await searcher.glob("**/*")).paths;
		expect(paths).toContain("dist/bundle.js");
		expect(paths).toContain("debug.log");
		expect(paths).toContain("src/generated/schema.ts");
		expect(paths).not.toContain("node_modules/pkg/index.js");
	});

	it("honours an explicitly named path even when a rule ignores it", async () => {
		const root = await workspace("explicit", ignoreFixture);
		const searcher = await WorkspaceSearcher.create(root);

		expect((await searcher.glob("*.js", { path: "dist" })).paths).toEqual(["dist/bundle.js"]);
	});
});

describe("WorkspaceSearcher.glob", () => {
	it("matches bare patterns at any depth, anchors patterns containing a slash, and expands alternation", async () => {
		const root = await workspace("glob", {
			"a.ts": "1\n",
			"b.tsx": "2\n",
			"readme.md": "3\n",
			"src/index.ts": "4\n",
			"src/deep/leaf.ts": "5\n",
		});
		const searcher = await WorkspaceSearcher.create(root);

		expect((await searcher.glob("*.{ts,tsx}")).paths.slice().sort()).toEqual(["a.ts", "b.tsx", "src/deep/leaf.ts", "src/index.ts"]);
		expect((await searcher.glob("src/**/*.ts")).paths.slice().sort()).toEqual(["src/deep/leaf.ts", "src/index.ts"]);
		expect((await searcher.glob("src/*.ts")).paths).toEqual(["src/index.ts"]);
		expect((await searcher.glob("?.ts")).paths).toEqual(["a.ts"]);
		expect((await searcher.glob("*.rs")).paths).toEqual([]);
	});

	it("reports truncation when the result exceeds the limit", async () => {
		const root = await workspace("glob-limit", { "a.ts": "1\n", "b.ts": "2\n", "c.ts": "3\n" });
		const searcher = await WorkspaceSearcher.create(root);

		const limited = await searcher.glob("*.ts", { limit: 2 });
		expect(limited.paths).toHaveLength(2);
		expect(limited).toMatchObject({ truncated: true, filesVisited: 3 });
		expect(await searcher.glob("*.ts", { limit: 3 })).toMatchObject({ truncated: false });
	});
});

describe("WorkspaceSearcher.grep", () => {
	const grepFixture = {
		"src/a.ts": "one\ntwo\nneedle here\nfour\n",
		"src/b.ts": "needle\nneedle again\n",
		"notes.md": "NEEDLE in prose\n",
	};

	it("returns matches with context, per-file counts and honest totals", async () => {
		const searcher = await WorkspaceSearcher.create(await workspace("grep", grepFixture));

		const result = await searcher.grep("needle", { context: 1 });
		expect(result).toMatchObject({ filesSearched: 3, filesMatched: 2, totalMatches: 3, truncated: false });
		expect(result.counts).toEqual([{ path: "src/b.ts", count: 2 }, { path: "src/a.ts", count: 1 }]);
		expect(result.matches.find((match) => match.path === "src/a.ts")).toEqual({
			path: "src/a.ts",
			line: 3,
			text: "needle here",
			before: ["two"],
			after: ["four"],
		});
	});

	it("supports case-insensitive, literal and glob-scoped searches", async () => {
		const searcher = await WorkspaceSearcher.create(await workspace("grep-modes", grepFixture));

		expect((await searcher.grep("needle", { caseInsensitive: true })).totalMatches).toBe(4);
		expect((await searcher.grep("needle", { glob: "*.md" }))).toMatchObject({ filesSearched: 1, totalMatches: 0 });
		expect((await searcher.grep("n..dle")).totalMatches).toBe(3);
		expect((await searcher.grep("n..dle", { literal: true })).totalMatches).toBe(0);
		expect((await searcher.grep("needle", { path: "src/b.ts" }))).toMatchObject({ filesSearched: 1, totalMatches: 2 });
	});

	it("caps returned matches while still counting them, and rejects an invalid pattern", async () => {
		const searcher = await WorkspaceSearcher.create(await workspace("grep-bounds", grepFixture));

		const capped = await searcher.grep("needle", { maxMatches: 1 });
		expect(capped.matches).toHaveLength(1);
		expect(capped).toMatchObject({ totalMatches: 3, truncated: true });
		await expect(searcher.grep("(unclosed")).rejects.toMatchObject({ code: "path_invalid" });
	});

	it("skips oversized and binary files instead of failing the search", async () => {
		const root = await workspace("grep-skips", {
			"small.txt": "needle\n",
			"large.txt": `needle${"x".repeat(64)}\n`,
			"binary.bin": Buffer.from([0x6e, 0x00, 0x65, 0x65]),
		});
		const searcher = await WorkspaceSearcher.create(root, { maxFileBytes: 16 });

		expect(await searcher.grep("needle")).toMatchObject({
			filesSearched: 1,
			totalMatches: 1,
			skippedLarge: 1,
			skippedBinary: 1,
		});
	});
});

describe("WorkspaceSearcher.list", () => {
	const listFixture = {
		"readme.md": "root\n",
		"src/index.ts": "1\n",
		"src/deep/leaf.ts": "2\n",
	};

	it("lists one level by default, directories first, and expands on request", async () => {
		const searcher = await WorkspaceSearcher.create(await workspace("list", listFixture));

		expect(await searcher.list()).toMatchObject({ path: ".", truncated: false });
		expect((await searcher.list()).entries.map((entry) => `${entry.kind[0]}:${entry.path}`)).toEqual(["d:src", "f:readme.md"]);
		expect((await searcher.list(".", 3)).entries.map((entry) => entry.path).sort()).toEqual([
			"readme.md",
			"src",
			"src/deep",
			"src/deep/leaf.ts",
			"src/index.ts",
		]);
		expect((await searcher.list("src")).entries.map((entry) => entry.path)).toEqual(["src/deep", "src/index.ts"]);
	});

	it("reports a single entry for a file and truncates once the file budget is spent", async () => {
		const searcher = await WorkspaceSearcher.create(await workspace("list-file", listFixture));
		expect(await searcher.list("readme.md")).toMatchObject({
			path: "readme.md",
			entries: [{ path: "readme.md", kind: "file", size: 5 }],
		});

		const bounded = await WorkspaceSearcher.create(await workspace("list-budget", listFixture), { maxFiles: 1 });
		const listing = await bounded.list(".", 5);
		expect(listing.truncated).toBe(true);
		expect(listing.entries).toHaveLength(1);
	});

	it("keeps every entry point inside the workspace", async () => {
		const searcher = await WorkspaceSearcher.create(await workspace("containment", listFixture));

		await expect(searcher.list("../outside")).rejects.toMatchObject({ code: "path_escape" });
		await expect(searcher.list("/etc")).rejects.toMatchObject({ code: "path_invalid" });
		await expect(searcher.glob("*", { path: "C:/Windows" })).rejects.toMatchObject({ code: "path_invalid" });
		await expect(searcher.grep("x", { path: "src/../../escape" })).rejects.toMatchObject({ code: "path_escape" });
	});
});

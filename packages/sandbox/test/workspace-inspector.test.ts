import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceInspector } from "../src/index.js";

const execute = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
	for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("WorkspaceInspector", () => {
	it("lists and reads bounded workspace files without exposing ignored directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-inspector-"));
		cleanup.push(root);
		await mkdir(join(root, "src"));
		await mkdir(join(root, "node_modules"));
		await writeFile(join(root, "src", "index.ts"), "export const value = 42;\n", "utf8");
		await writeFile(join(root, "node_modules", "hidden.js"), "hidden", "utf8");
		const inspector = await WorkspaceInspector.create(root, { maxFileBytes: 12 });
		const directory = await inspector.listDirectory(".");
		expect(directory.entries.map((entry) => entry.name)).toEqual(["src"]);
		const file = await inspector.readFile("src/index.ts");
		expect(file).toMatchObject({
			path: "src/index.ts",
			content: "export const",
			truncated: true,
			binary: false,
		});
		await expect(inspector.readFile("../outside.txt")).rejects.toMatchObject({
			code: "path_escape",
		});
	});

	it("ranks fuzzy path matches and skips ignored directories while searching", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-inspector-search-"));
		cleanup.push(root);
		await mkdir(join(root, "src", "components"), { recursive: true });
		await mkdir(join(root, "node_modules"), { recursive: true });
		await writeFile(join(root, "readme.md"), "# readme\n", "utf8");
		await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
		await writeFile(join(root, "src", "components", "ToolCard.tsx"), "export const card = 1;\n", "utf8");
		await writeFile(join(root, "node_modules", "index.ts"), "hidden", "utf8");
		const inspector = await WorkspaceInspector.create(root);
		const scoped = await inspector.searchFiles("toolcard");
		expect(scoped.entries.map((entry) => entry.path)).toEqual(["src/components/ToolCard.tsx"]);
		const initials = await inspector.searchFiles("tc.tsx");
		expect(initials.entries[0]?.path).toBe("src/components/ToolCard.tsx");
		const ignored = await inspector.searchFiles("index");
		expect(ignored.entries.map((entry) => entry.path)).toEqual(["src/index.ts"]);
		const shallow = await inspector.searchFiles("");
		expect(shallow.entries.slice(0, 2).map((entry) => entry.path)).toEqual(["src", "readme.md"]);
		const bounded = await inspector.searchFiles("", 1);
		expect(bounded).toMatchObject({ query: "", truncated: true });
		expect(bounded.entries).toHaveLength(1);
		expect((await inspector.searchFiles("zzzz")).entries).toEqual([]);
	});

	it("returns structured status plus working and staged unified diffs", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-inspector-git-"));
		cleanup.push(root);
		await execute("git", ["init"], { cwd: root });
		await writeFile(join(root, "note.txt"), "first\nsecond\n", "utf8");
		const inspector = await WorkspaceInspector.create(root);
		const working = await inspector.gitStatus();
		expect(working).toMatchObject({
			isRepository: true,
			entries: [{ path: "note.txt", indexStatus: "?", worktreeStatus: "?" }],
		});
		const untracked = await inspector.gitDiff("note.txt", false);
		expect(untracked.content).toContain("--- /dev/null");
		expect(untracked.content).toContain("+first");
		await execute("git", ["add", "--", "note.txt"], { cwd: root });
		const staged = await inspector.gitDiff("note.txt", true);
		expect(staged.content).toContain("diff --git");
		expect(staged.content).toContain("+second");
	});
});

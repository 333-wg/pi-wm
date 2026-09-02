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
		expect(file).toMatchObject({ path: "src/index.ts", content: "export const", truncated: true, binary: false });
		await expect(inspector.readFile("../outside.txt")).rejects.toMatchObject({ code: "path_escape" });
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

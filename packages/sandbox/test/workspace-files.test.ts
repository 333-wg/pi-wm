import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceFileExecutor } from "../src/index.js";

const cleanup: string[] = [];

afterEach(async () => {
	for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	cleanup.push(path);
	return path;
}

describe("WorkspaceFileExecutor", () => {
	it("reads, writes, and performs exact edits inside the workspace", async () => {
		const root = await temporaryDirectory("wuming-files-");
		const files = await WorkspaceFileExecutor.create(root);
		await files.writeText("src/example.txt", "alpha\nbeta\nbeta\n");

		expect(await files.readText("src/example.txt", { offset: 2, limit: 1 })).toMatchObject({
			content: "beta",
			truncated: true,
		});
		await expect(files.editText("src/example.txt", "beta", "gamma")).rejects.toMatchObject({ code: "edit_conflict" });
		await files.editText("src/example.txt", "beta", "gamma", { replaceAll: true });
		expect((await files.readText("src/example.txt")).content).toBe("alpha\ngamma\ngamma\n");
	});

	it("rejects absolute paths, parent traversal, and links escaping the workspace", async () => {
		const root = await temporaryDirectory("wuming-root-");
		const outside = await temporaryDirectory("wuming-outside-");
		await mkdir(join(outside, "target"));
		await writeFile(join(outside, "target", "secret.txt"), "secret");
		await symlink(join(outside, "target"), join(root, "escape"), "junction");
		const files = await WorkspaceFileExecutor.create(root);

		await expect(files.readText("../secret.txt")).rejects.toMatchObject({ code: "path_escape" });
		await expect(files.writeText(join(outside, "absolute.txt"), "no")).rejects.toMatchObject({ code: "path_invalid" });
		await expect(files.readText("escape/secret.txt")).rejects.toMatchObject({ code: "path_escape" });
		await expect(files.writeText("escape/new.txt", "no")).rejects.toMatchObject({ code: "path_escape" });
	});

	it("enforces read and write byte ceilings", async () => {
		const root = await temporaryDirectory("wuming-limits-");
		await writeFile(join(root, "large.txt"), "1234567890");
		const files = await WorkspaceFileExecutor.create(root, { maxReadBytes: 5, maxWriteBytes: 5 });
		const result = await files.readText("large.txt");
		expect(result).toMatchObject({ content: "12345", totalBytes: 10, truncated: true });
		await expect(files.writeText("too-large.txt", "123456")).rejects.toMatchObject({ code: "file_too_large" });
	});

	it("atomically replaces files and rejects a stale conditional write", async () => {
		const root = await temporaryDirectory("wuming-atomic-");
		const files = await WorkspaceFileExecutor.create(root);
		await files.writeText("state.txt", "first");
		const expected = createHash("sha256").update("first").digest("hex");
		await writeFile(join(root, "state.txt"), "changed externally", "utf8");

		await expect(files.writeTextIfUnchanged("state.txt", "replacement", expected)).rejects.toMatchObject({ code: "edit_conflict" });
		expect((await files.readText("state.txt")).content).toBe("changed externally");
		expect((await readdir(root)).filter((name) => name.includes(".wuming-") && name.endsWith(".tmp"))).toEqual([]);
	});
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { verifyInstalledRuntime } from "../installer/verify-runtime.cjs";

test("installed runtime validation catches omitted deep dependencies and rejects unsafe inventories", async () => {
	const parent = await realpath(tmpdir());
	const root = await mkdtemp(join(parent, "pi-wm-inventory-"));
	const dependency = "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js";
	const files = ["node.exe", "apps/gateway/dist/main.js", "apps/web/dist/index.html", "verify-install.cjs", dependency];
	const inventory = (entries) => writeFile(join(root, "runtime-files.json"), JSON.stringify({ files: entries }));
	try {
		for (const file of files) {
			await mkdir(dirname(join(root, file)), { recursive: true });
			await writeFile(join(root, file), "fixture");
		}
		await inventory(files);
		assert.equal(verifyInstalledRuntime(root), files.length);
		await unlink(join(root, dependency));
		assert.throws(() => verifyInstalledRuntime(root), /Runtime missing 1 files/);
		await writeFile(join(root, dependency), "restored");
		assert.equal(verifyInstalledRuntime(root), files.length);
		for (const entries of [[], ["../outside.js"], ["C:/outside.js"], ["/outside.js"], ["a//b.js"], [17]]) {
			await inventory(entries);
			assert.throws(() => verifyInstalledRuntime(root), /inventory/i);
		}
		await inventory([dependency]);
		await unlink(join(root, "node.exe"));
		assert.throws(() => verifyInstalledRuntime(root), /node.exe/);
	} finally {
		assert.equal(dirname(await realpath(root)), parent);
		assert.ok(basename(root).startsWith("pi-wm-inventory-"));
		await rm(root, { recursive: true, force: true });
	}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { verifyDesktopRelease } from "../../../scripts/lib/desktop-update-release.mjs";

test("release verification rejects mixed build artifacts before publication", async (t) => {
	const parent = await realpath(tmpdir());
	const directory = await mkdtemp(join(parent, "pi-wm-release-test-"));
	try {
		const filename = "Pi-Wm-0.1.3-Setup-x64.exe";
		const bytes = Buffer.from("Not an executable. Release verifier fixture only.");
		const sha512 = createHash("sha512").update(bytes).digest("base64");
		const info = { version: "0.1.3", files: [{ url: filename, size: bytes.length, sha512 }], path: filename, sha512 };
		const configPath = join(directory, "win-unpacked/resources/app-update.yml");
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, JSON.stringify({ provider: "github", owner: "333-wg", repo: "pi-wm" }));
		await writeFile(join(directory, filename), bytes);
		await writeFile(
			join(directory, filename + ".blockmap"),
			gzipSync(JSON.stringify({ version: "2", files: [{ offset: 0, sizes: [bytes.length], checksums: ["fixture"] }] }))
		);
		const verify = () => verifyDesktopRelease({ directory, version: "0.1.3", repository: "333-wg/pi-wm" });
		await writeFile(join(directory, "latest.yml"), JSON.stringify(info));
		const report = await verify();
		assert.equal(report.sha512, sha512);
		assert.equal(report.assets.length, 3);
		for (const [name, changed, expected] of [
			["wrong version", { ...info, version: "0.1.2" }, /version/],
			["wrong size", { ...info, files: [{ ...info.files[0], size: 1 }] }, /size/],
			["wrong checksum", { ...info, sha512: "wrong" }, /checksum/],
			["path traversal", { ...info, files: [{ ...info.files[0], url: "../outside.exe" }] }, /expected Windows/],
		]) {
			await t.test(name, async () => {
				await writeFile(join(directory, "latest.yml"), JSON.stringify(changed));
				await assert.rejects(verify, expected);
			});
		}
		await writeFile(join(directory, "latest.yml"), JSON.stringify(info));
		const config = await readFile(configPath, "utf8");
		await writeFile(configPath, JSON.stringify({ provider: "github", owner: "other", repo: "repo" }));
		await assert.rejects(verify, /update source/);
		await writeFile(configPath, config);
		await writeFile(
			join(directory, filename + ".blockmap"),
			gzipSync(JSON.stringify({ version: "2", files: [{ offset: 0, sizes: [1], checksums: ["fixture"] }] }))
		);
		await assert.rejects(verify, /blockmap/);
	} finally {
		assert.equal(dirname(await realpath(directory)), parent);
		await rm(directory, { recursive: true });
	}
});

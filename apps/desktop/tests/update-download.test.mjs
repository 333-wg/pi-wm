import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NsisUpdater } from "electron-updater/out/NsisUpdater.js";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { CancellationToken } from "builder-util-runtime";
import { DesktopUpdates } from "../src/updates.mjs";

// Use the updater's real download/checksum implementation, but only Node loopback sockets.
// No executable is launched, no publisher signature is claimed, and all caches are disposable.
class LoopbackExecutor extends ElectronHttpExecutor {
	createRequest(options, callback) {
		assert.equal(options.hostname, "127.0.0.1");
		assert.equal(options.protocol, "http:");
		return request(options, callback);
	}
}

test(
	"real NSIS updater checks, rejects corrupted downloads and retries through loopback HTTP",
	{ timeout: 30_000 },
	async () => {
		const parent = await realpath(tmpdir());
		const directory = await mkdtemp(join(parent, "pi-wm-update-http-"));
		const bytes = Buffer.from("Test payload only, never an executable.".repeat(4096));
		const sha512 = createHash("sha512").update(bytes).digest("base64");
		const filename = "Pi-Wm-0.1.3-Setup-x64.exe";
		let corrupt = true,
			available = false,
			downloads = 0;
		let updates;
		const server = createServer((req, res) => {
			if (req.url.startsWith("/latest") && req.url.includes(".yml")) {
				if (!available) {
					res.writeHead(404).end();
					return;
				}
				res.end(
					JSON.stringify({
						version: "0.1.3",
						files: [{ url: filename, sha512, size: bytes.length }],
						path: filename,
						sha512,
					})
				);
			} else if (req.url === "/" + filename) {
				downloads++;
				const body = corrupt ? Buffer.alloc(bytes.length, 0) : bytes;
				res.writeHead(200, { "content-length": body.length, "content-type": "application/octet-stream" });
				res.end(body);
			} else res.writeHead(404).end();
		});
		try {
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			const configPath = join(directory, "app-update.yml");
			await writeFile(configPath, JSON.stringify({ updaterCacheDirName: "fixture-cache" }));
			const userDataPath = join(directory, "profile");
			await mkdir(userDataPath);
			const adapter = {
				version: "0.1.2",
				name: "PiWmUpdateTest",
				isPackaged: true,
				appUpdateConfigPath: configPath,
				userDataPath,
				baseCachePath: directory,
				whenReady: async () => {},
				relaunch: () => assert.fail("must not relaunch"),
				quit: () => assert.fail("must not quit"),
				onQuit: () => assert.fail("must not register auto-install"),
			};
			const updater = new NsisUpdater(null, adapter);
			let lastError;
			updater.on("error", (error) => {
				lastError = error;
			});
			updater.logger = null;
			updater.httpExecutor = new LoopbackExecutor();
			updater.disableDifferentialDownload = true;
			updater.setFeedURL({ provider: "generic", url: `http://127.0.0.1:${server.address().port}/` });
			updates = new DesktopUpdates({
				updater,
				createCancellationToken: () => new CancellationToken(),
				version: "0.1.2",
				platform: "win32",
				arch: "x64",
				preferences: { autoCheck: false, deferredUntil: 0 },
				savePreferences: async () => {},
			});
			await updates.check();
			assert.equal(updates.state.error, "metadata", String(lastError?.stack));
			assert.equal(updates.state.retryAction, "check");
			available = true;
			await updates.check();
			assert.equal(updates.state.status, "available");
			assert.equal(downloads, 0);
			await updates.download();
			assert.equal(updates.state.error, "integrity");
			assert.equal(updates.state.retryAction, "download");
			corrupt = false;
			await updates.download();
			assert.equal(updates.state.status, "ready");
			assert.equal(downloads, 2);
			assert.deepEqual(await readFile(updater.installerPath), bytes);
			assert.equal(updater.autoInstallOnAppQuit, false);
		} finally {
			updates?.dispose();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			assert.equal(dirname(await realpath(directory)), parent);
			await rm(directory, { recursive: true });
		}
	}
);

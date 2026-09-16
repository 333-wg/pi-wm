import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DesktopUpdates, githubPublishConfig, readUpdatePreferences, saveUpdatePreferences } from "../src/updates.mjs";
import { installDesktopUpdate } from "../src/install-update.mjs";

class FakeUpdater extends EventEmitter {
	checks = 0;
	downloads = 0;
	async checkForUpdates() {
		this.checks++;
		this.emit("update-available", { version: "0.1.3", releaseNotes: "Release notes" });
		return {};
	}
	async downloadUpdate() {
		this.downloads++;
		this.emit("download-progress", { percent: 45, transferred: 45, total: 100 });
		this.emit("update-downloaded");
	}
}
function fixture(extra = {}) {
	const updater = new FakeUpdater();
	const preferences = [];
	const updates = new DesktopUpdates({
		updater,
		version: "0.1.2",
		platform: "win32",
		arch: "x64",
		preferences: { autoCheck: true, deferredUntil: 0 },
		savePreferences: async (value) => preferences.push(value),
		createCancellationToken: () => ({
			cancel() {
				this.cancelled = true;
			},
		}),
		...extra,
	});
	return { updater, updates, preferences };
}

test("GitHub source is explicit and cannot contain credentials or arbitrary URLs", () => {
	assert.equal(githubPublishConfig(undefined), null);
	assert.deepEqual(githubPublishConfig("owner/pi-wm"), {
		provider: "github",
		owner: "owner",
		repo: "pi-wm",
		private: false,
		releaseType: "release",
	});
	for (const input of ["https://github.com/o/r", "o/r/extra", "token@host/repo", "o/..", "o/.", "o/ r"])
		assert.throws(() => githubPublishConfig(input));
});

test("checking never downloads; download never installs or quits", async () => {
	const { updater, updates } = fixture();
	assert.equal(updater.autoDownload, false);
	assert.equal(updater.autoInstallOnAppQuit, false);
	assert.equal(updater.allowDowngrade, false);
	assert.equal(updater.allowPrerelease, false);
	await updates.check();
	assert.equal(updates.state.status, "available");
	assert.equal(updater.downloads, 0);
	const states = [];
	updates.on("state", (state) => states.push(state));
	await updates.download();
	assert.equal(updates.state.status, "ready");
	assert.ok(states.some((state) => state.progress === 45));
	await updates.check();
	assert.equal(updater.checks, 1);
});

test("concurrent checks coalesce and recover from network errors", async () => {
	const { updater, updates } = fixture();
	let finish;
	updater.checkForUpdates = () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const first = updates.check();
	await updates.check();
	updater.emit("error", new Error("private request URL or token must not be exposed"));
	finish({});
	await first;
	assert.equal(updates.state.error, "network");
	assert.ok(!JSON.stringify(updates.state).includes("token"));
	updater.checkForUpdates = async () => {
		updater.emit("update-not-available");
		return {};
	};
	await updates.check();
	assert.equal(updates.state.status, "latest");
	assert.equal(updates.state.error, undefined);
});

test("cancel waits for the active transfer, then a retry gets a fresh token", async () => {
	const { updater, updates } = fixture();
	await updates.check();
	let rejectDownload;
	updater.downloadUpdate = (token) =>
		new Promise((_resolve, reject) => {
			rejectDownload = reject;
			token.cancel = () => reject(new Error("cancelled"));
		});
	const downloading = updates.download();
	const token = updates.downloadToken;
	updates.cancel();
	await downloading;
	assert.equal(updates.state.status, "available");
	updater.downloadUpdate = FakeUpdater.prototype.downloadUpdate;
	await updates.download();
	assert.notEqual(updates.downloadToken, token);
	assert.equal(updates.state.status, "ready");
	assert.ok(rejectDownload);
});

test("disabled builds perform no network actions and reject unknown actions", async () => {
	const { updater, updates } = fixture({ updater: undefined, disabledReason: "unconfigured" });
	await updates.check();
	await updates.download();
	assert.equal(updater.checks, 0);
	assert.equal(updates.state.status, "disabled");
	await assert.rejects(updates.dispatch("open-arbitrary-installer"), /Invalid/);
	await assert.rejects(updates.dispatch("auto-check", "yes"), /Invalid/);
});

test("preferences serialize writes and survive a new process", async () => {
	const parent = await realpath(tmpdir());
	const directory = await mkdtemp(join(parent, "wuming-update-test-"));
	try {
		const path = join(directory, "updates.json");
		const { updates } = fixture({ savePreferences: (value) => saveUpdatePreferences(path, value), now: () => 100 });
		await Promise.all([updates.dispatch("auto-check", false), updates.dispatch("defer")]);
		const result = await readUpdatePreferences(path);
		assert.equal(result.autoCheck, false);
		assert.equal(result.deferredUntil, 100 + 86_400_000);
		assert.ok(!(await readFile(path, "utf8").then((text) => text.includes("token"))));
	} finally {
		assert.equal(dirname(await realpath(directory)), parent);
		await rm(directory, { recursive: true });
	}
});

test("busy tasks, cancelled confirmation and unavailable service never install", async () => {
	for (const mode of ["busy", "cancelled", "unavailable", "became-busy"]) {
		const { updates } = fixture();
		updates.patch({ status: "ready" });
		let stopped = false,
			installed = false;
		const host = {
			updateStatus: async (prepare) => {
				if (mode === "unavailable") throw new Error("disconnected");
				return { busy: mode === "busy" || (prepare && mode === "became-busy") };
			},
			stop: async () => {
				stopped = true;
			},
		};
		await installDesktopUpdate({
			updates,
			host,
			confirm: async () => mode !== "cancelled",
			install: () => {
				installed = true;
			},
		});
		assert.equal(stopped, false, mode);
		assert.equal(installed, false, mode);
		assert.equal(updates.state.status, "ready");
	}
});

test("install rechecks after confirmation, stops the service, then installs exactly once", async () => {
	const { updates } = fixture();
	updates.patch({ status: "ready" });
	const events = [];
	const options = {
		updates,
		host: {
			updateStatus: async (prepare) => {
				events.push(prepare ? "prepare" : "status");
				return { busy: false };
			},
			stop: async () => {
				events.push("stop");
			},
		},
		confirm: async () => {
			events.push("confirm");
			return true;
		},
		install: () => {
			events.push("install");
		},
	};
	await Promise.all([installDesktopUpdate(options), installDesktopUpdate(options)]);
	assert.deepEqual(events, ["status", "confirm", "prepare", "stop", "install"]);
	assert.equal(updates.state.status, "installing");
});

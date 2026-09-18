import { EventEmitter } from "node:events";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function githubPublishConfig(repository) {
	if (!repository) return null;
	if (
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repository) ||
		repository.endsWith("/.") ||
		repository.endsWith("/..")
	)
		throw new Error("WUMING_UPDATE_REPOSITORY must be a public GitHub owner/repository, not a URL or token");
	const [owner, repo] = repository.split("/");
	return { provider: "github", owner, repo, private: false, releaseType: "release" };
}

export function resolveUpdateRepository(override, fallback) {
	const value = override?.trim() || fallback;
	if (value === "disabled") return undefined;
	githubPublishConfig(value);
	return value;
}

// Inspect provider details only in the main process; return a bounded, credential-free code.
export function classifyUpdateError(error, phase = "check") {
	if (phase === "install") return "install";
	const code = String(error?.code ?? "");
	const details = `${code} ${String(error?.message ?? "").slice(0, 16_000)}`;
	const status = Number(error?.statusCode);
	if (/ERR_CHECKSUM_MISMATCH|ERR_UPDATER_INVALID_SIGNATURE|checksum mismatch/i.test(details)) return "integrity";
	if (/ENOSPC|EDQUOT/.test(details)) return "disk";
	if (/EACCES|EPERM/.test(details)) return "permission";
	if (status === 429 || /HTTP_ERROR_429|rate limit|too many requests/i.test(details)) return "rate-limit";
	if (status === 401 || status === 403 || /HTTP_ERROR_40[13]|\b40[13] (?:Forbidden|Unauthorized)/i.test(details))
		return "access";
	if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|ERR_[A-Z_]*TIMED_OUT)\b|timed\s+out/i.test(details)) return "timeout";
	if (code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" || /No published versions on GitHub/.test(details))
		return "no-release";
	if (code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" && /\b404\b/.test(details)) return "no-release";
	if (
		/ERR_UPDATER_(CHANNEL_FILE_NOT_FOUND|INVALID_UPDATE_INFO|NO_FILES_PROVIDED|NO_CHECKSUM|INVALID_VERSION|VERSION_NOT_FOUND|WEB_INSTALLER_DISABLED)/.test(
			code
		)
	)
		return "metadata";
	if (status === 404 || /status 404:/.test(details)) return phase === "download" ? "metadata" : "no-release";
	return "network";
}

export async function readUpdatePreferences(path) {
	try {
		const value = JSON.parse(await readFile(path, "utf8"));
		return {
			autoCheck: value.autoCheck !== false,
			deferredUntil: Number.isFinite(value.deferredUntil) ? value.deferredUntil : 0,
		};
	} catch {
		return { autoCheck: true, deferredUntil: 0 };
	}
}

export async function saveUpdatePreferences(path, value) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path + ".tmp", JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
	await rename(path + ".tmp", path);
}

function releaseNotes(info) {
	const notes =
		typeof info.releaseNotes === "string"
			? info.releaseNotes
			: Array.isArray(info.releaseNotes)
				? info.releaseNotes.map((item) => (typeof item.note === "string" ? item.note : "")).join("\n\n")
				: "";
	return notes.slice(0, 32_000);
}

// Main-process state only. No installer paths, credentials or arbitrary URLs cross IPC.
export class DesktopUpdates extends EventEmitter {
	constructor({
		updater,
		createCancellationToken,
		version,
		platform,
		arch,
		disabledReason,
		repository,
		preferences,
		savePreferences,
		now = Date.now,
	}) {
		super();
		this.updater = updater;
		this.makeCancellationToken = createCancellationToken;
		this.savePreferences = savePreferences;
		this.now = now;
		this.state = {
			revision: 0,
			status: disabledReason ? "disabled" : "idle",
			disabledReason,
			currentVersion: version,
			platform,
			arch,
			repository: repository || undefined,
			autoCheck: preferences.autoCheck,
			deferredUntil: preferences.deferredUntil,
			progress: 0,
		};
		this.preferenceQueue = Promise.resolve();
		this.listeners = [];
		if (!updater) return;
		updater.autoDownload = false;
		updater.autoInstallOnAppQuit = false;
		updater.allowPrerelease = false;
		updater.allowDowngrade = false;
		updater.disableWebInstaller = true;
		updater.autoRunAppAfterInstall = true;
		const on = (event, listener) => {
			updater.on(event, listener);
			this.listeners.push([event, listener]);
		};
		on("update-available", (info) =>
			this.patch({
				status: "available",
				nextVersion: info.version,
				releaseNotes: releaseNotes(info),
				releaseDate: info.releaseDate,
				progress: 0,
				error: undefined,
				retryAction: undefined,
			})
		);
		on("update-not-available", () =>
			this.patch({
				status: "latest",
				nextVersion: undefined,
				releaseNotes: undefined,
				releaseDate: undefined,
				error: undefined,
				retryAction: undefined,
			})
		);
		on("download-progress", (info) => {
			if (this.state.status !== "downloading") return;
			this.patch({
				progress: Math.max(0, Math.min(100, Number(info.percent) || 0)),
				transferred: info.transferred,
				total: info.total,
				bytesPerSecond: info.bytesPerSecond,
			});
		});
		on("update-downloaded", () =>
			this.patch({ status: "ready", progress: 100, error: undefined, retryAction: undefined, deferredUntil: 0 })
		);
		on("error", (error) => {
			if (!this.cancelling)
				this.fail(error, this.state.status === "installing" ? "install" : this.operation || "check");
		});
	}
	fail(error, phase) {
		const kind = classifyUpdateError(error, phase);
		this.patch({
			status: "error",
			error: kind,
			retryAction: phase === "install" ? "restart" : phase === "download" && kind !== "metadata" ? "download" : "check",
		});
	}
	snapshot() {
		return { ...this.state };
	}
	patch(value) {
		Object.assign(this.state, value, { revision: this.state.revision + 1 });
		this.emit("state", this.snapshot());
	}
	async check() {
		if (
			this.disposed ||
			!this.updater ||
			this.operation ||
			this.state.error === "install" ||
			["ready", "installing"].includes(this.state.status)
		)
			return this.snapshot();
		return this.run("check", async () => {
			this.checkResult = undefined;
			this.patch({
				status: "checking",
				error: undefined,
				retryAction: undefined,
				nextVersion: undefined,
				releaseNotes: undefined,
				releaseDate: undefined,
				lastCheckedAt: this.now(),
				progress: 0,
			});
			this.checkResult = await this.updater.checkForUpdates();
			if (this.state.status === "checking") throw new Error("Update check did not return a result");
		});
	}
	async download() {
		if (
			this.disposed ||
			!this.updater ||
			this.operation ||
			!this.state.nextVersion ||
			(this.state.status === "error" && this.state.retryAction !== "download") ||
			!["available", "error"].includes(this.state.status)
		)
			return this.snapshot();
		if (!this.checkResult) return this.check();
		return this.run("download", async () => {
			this.cancelling = false;
			this.patch({
				status: "downloading",
				error: undefined,
				retryAction: undefined,
				progress: 0,
				transferred: 0,
				total: 0,
				bytesPerSecond: 0,
			});
			// Each manual download needs a fresh token after a cancelled attempt.
			this.downloadToken = this.makeCancellationToken();
			await this.updater.downloadUpdate(this.downloadToken);
			if (!this.cancelling && this.state.status === "downloading") throw new Error("Download did not complete");
		});
	}
	async run(phase, action) {
		this.operation = phase;
		try {
			await action();
		} catch (error) {
			if (!this.cancelling) this.fail(error, phase);
		} finally {
			this.operation = false;
			if (this.cancelling && this.state.status !== "ready")
				this.patch({ status: "available", progress: 0, error: undefined, retryAction: undefined });
			this.cancelling = false;
			if (this.disposed) this.removeUpdaterListeners();
		}
		return this.snapshot();
	}
	cancel() {
		if (this.state.status === "downloading") {
			this.cancelling = true;
			this.downloadToken?.cancel();
		}
		return this.snapshot();
	}
	async preferences(value) {
		const action = this.preferenceQueue
			.catch(() => {})
			.then(async () => {
				const next = { autoCheck: this.state.autoCheck, deferredUntil: this.state.deferredUntil, ...value };
				await this.savePreferences(next);
				this.patch(next);
			});
		this.preferenceQueue = action;
		await action;
		return this.snapshot();
	}
	async dispatch(action, value) {
		switch (action) {
			case "state":
				return this.snapshot();
			case "check":
				return this.check();
			case "download":
				return this.download();
			case "cancel":
				return this.cancel();
			case "defer":
				return this.preferences({ deferredUntil: this.now() + 24 * 60 * 60_000 });
			case "auto-check":
				if (typeof value !== "boolean") throw new Error("Invalid preference");
				return this.preferences({ autoCheck: value });
			default:
				throw new Error("Invalid update action");
		}
	}
	start() {
		if (!this.updater) return;
		const check = () => {
			if (this.state.autoCheck) void this.check();
		};
		this.initialTimer = setTimeout(check, 20_000);
		this.periodicTimer = setInterval(check, 6 * 60 * 60_000);
		this.initialTimer.unref?.();
		this.periodicTimer.unref?.();
	}
	dispose() {
		this.disposed = true;
		clearTimeout(this.initialTimer);
		clearInterval(this.periodicTimer);
		this.cancel();
		if (!this.operation) this.removeUpdaterListeners();
	}
	removeUpdaterListeners() {
		for (const [event, listener] of this.listeners) this.updater.off(event, listener);
		this.listeners = [];
	}
}

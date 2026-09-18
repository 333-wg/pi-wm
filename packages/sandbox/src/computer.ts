import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerUseStatus } from "@wuming/protocol";
import {
	WindowsSemanticDesktop,
	type SemanticAction,
	type SemanticSnapshot,
	type SemanticState,
	type SemanticWindow,
	publicSemanticState,
} from "./computer-semantic.js";

export interface ComputerWindow {
	id: string;
	pid: number;
	title: string;
	process: string;
	bounds: number[];
}

interface ComputerApplication {
	ref: string;
	name: string;
	path: string;
	fingerprint: string;
}

export interface ComputerScreenshot {
	id: string;
	capturedAt: number;
	image: string;
	width: number;
	height: number;
	left: number;
	top: number;
	screenWidth: number;
	screenHeight: number;
	monitor: number;
	foreground: ComputerWindow;
	windows: ComputerWindow[];
	observation?: { stable: boolean; waitedMs: number; samples: number };
	inputTick?: number;
}

export type ComputerAction =
	| { kind: "click" | "double_click" | "right_click"; x: number; y: number }
	| { kind: "scroll"; x: number; y: number; amount: number }
	| { kind: "type"; text: string }
	| { kind: "key"; key: string }
	| { kind: "focus"; windowId: string };

export interface ComputerProcessOptions {
	input?: string;
	signal?: AbortSignal;
	timeoutMs: number;
}

export type ComputerProcessRunner = (file: string, args: string[], options: ComputerProcessOptions) => Promise<string>;

// Reject only after the child exits: a cancelled process must not outlive its input lock.
export const runComputerProcess: ComputerProcessRunner = (file, args, options) =>
	new Promise((resolve, reject) => {
		options.signal?.throwIfAborted();
		const child = spawn(file, args, {
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
		});
		let output = "";
		let errors = "";
		let failure: Error | undefined;
		const kill = (error: Error) => {
			failure ??= error;
			child.kill();
		};
		const abort = () => kill(new Error("Computer Use cancelled"));
		options.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => kill(new Error("Computer Use helper timed out")), options.timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (output.length + chunk.length > 12 * 1024 * 1024) kill(new Error("Computer Use output is too large"));
			else output += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			errors = (errors + chunk).slice(-4000);
		});
		child.on("error", (error) => {
			failure ??= error;
		});
		child.stdin.on("error", () => {});
		child.on("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (code !== 0) reject(new Error((errors || output || `Python exited with ${code}`).slice(-4000)));
			else resolve(output);
		});
		child.stdin.end(options.input ?? "");
		if (options.signal?.aborted) abort();
	});

export interface ComputerManagerOptions {
	runtimeDirectory: string;
	python?: string;
	platform?: string;
	runner?: ComputerProcessRunner;
	clock?: () => number;
	/** Only enable for a loopback-only, single-owner deployment. */
	settingsAuthorization?: boolean;
	semanticCall?: <T>(request: Record<string, unknown>, signal: AbortSignal) => Promise<T>;
}

export class WindowsComputerManager implements AsyncDisposable {
	readonly #options: ComputerManagerOptions;
	readonly #run: ComputerProcessRunner;
	readonly #clock: () => number;
	readonly #semanticCall: <T>(request: Record<string, unknown>, signal: AbortSignal) => Promise<T>;
	readonly #helper = fileURLToPath(new URL("../runtime/computer_windows.py", import.meta.url));
	readonly #requirements = fileURLToPath(new URL("../runtime/requirements-computer.txt", import.meta.url));
	#enabled = false;
	#requested = false;
	#disposed = false;
	#setupStage: ComputerUseStatus["setupStage"];
	#ready = false;
	#installing = false;
	#error: string | undefined;
	#owner: string | undefined;
	#leaseUntil = 0;
	#busy = false;
	#snapshot: ComputerScreenshot | undefined;
	#semanticSnapshot: SemanticSnapshot | undefined;
	#windows: SemanticWindow[] = [];
	#windowsAt = 0;
	#applications: ComputerApplication[] = [];
	#applicationsAt = 0;
	#activity: ComputerUseStatus["activity"];
	#foregroundGrant: { sessionId: string; scope: string; expiresAt: number } | undefined;
	readonly #foregroundProviders = new Set<string>();
	#stop = new AbortController();
	#setup: Promise<ComputerUseStatus> | undefined;
	#probe: Promise<ComputerUseStatus> | undefined;
	#active: Promise<unknown> | undefined;

	constructor(options: ComputerManagerOptions) {
		this.#options = options;
		this.#run = options.runner ?? runComputerProcess;
		this.#clock = options.clock ?? Date.now;
		const semantic = new WindowsSemanticDesktop(options.runtimeDirectory, this.#run);
		this.#semanticCall = options.semanticCall ?? semantic.call.bind(semantic);
		try {
			this.#requested =
				JSON.parse(readFileSync(join(options.runtimeDirectory, "settings.json"), "utf8")).enabled === true;
		} catch {
			// Missing or damaged settings never grant desktop access.
		}
	}

	get #python(): string {
		const venv = join(this.#options.runtimeDirectory, "venv", "Scripts", "python.exe");
		return existsSync(venv) ? venv : (this.#options.python ?? "python");
	}

	status(): ComputerUseStatus {
		if (!this.#busy && this.#leaseUntil <= this.#clock()) {
			this.#owner = undefined;
			this.#snapshot = undefined;
			this.#semanticSnapshot = undefined;
			this.#windows = [];
			this.#applications = [];
			this.revokeForegroundControl();
		}
		return {
			supported: (this.#options.platform ?? process.platform) === "win32",
			enabled: this.#enabled,
			requestedEnabled: this.#requested,
			authorization: this.#options.settingsAuthorization ? "settings" : "each_operation",
			...(this.#setupStage ? { setupStage: this.#setupStage } : {}),
			ready: this.#ready,
			installing: this.#installing,
			platform: this.#options.platform ?? process.platform,
			python: this.#python,
			...(this.#activity ? { activity: this.#activity } : {}),
			...(this.#owner ? { ownerSessionId: this.#owner } : {}),
			...(this.#error ? { error: this.#error } : {}),
		};
	}

	async #call(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const output = await this.#run(this.#python, ["-I", this.#helper], {
			input: JSON.stringify(request),
			timeoutMs: 20_000,
			...(signal ? { signal } : {}),
		});
		const value = JSON.parse(output) as { ok?: boolean; result?: unknown; error?: string };
		if (!value.ok) throw new Error(value.error ?? "Computer Use helper failed");
		return value.result;
	}

	refresh(): Promise<ComputerUseStatus> {
		if (this.#probe) return this.#probe;
		this.#probe = (async () => {
			try {
				if (!this.status().supported) throw new Error("Computer Use currently supports Windows only");
				const result = (await this.#call({ command: "probe" })) as { ready?: boolean };
				this.#ready = result.ready === true;
				this.#error = undefined;
				this.#activateIfReady();
			} catch (error) {
				this.#ready = false;
				this.#error = error instanceof Error ? error.message : String(error);
				this.#disable();
			}
			return this.status();
		})().finally(() => {
			this.#probe = undefined;
		});
		return this.#probe;
	}

	setEnabled(enabled: boolean): ComputerUseStatus {
		if (!enabled) return this.stop();
		if (!this.status().supported || this.#busy || this.#disposed)
			throw new Error("Computer Use environment is not ready or is stopping");
		this.#saveRequested(true);
		if (!this.#ready) return this.install();
		this.#activateIfReady();
		return this.status();
	}

	stop(): ComputerUseStatus {
		this.#requested = false;
		this.#disable();
		this.#saveRequested(false);
		return this.status();
	}

	#saveRequested(enabled: boolean): void {
		const directory = this.#options.runtimeDirectory;
		mkdirSync(directory, { recursive: true });
		const path = join(directory, "settings.json");
		const temporary = join(directory, `settings-${randomUUID()}.tmp`);
		writeFileSync(temporary, JSON.stringify({ enabled }), { encoding: "utf8", flag: "wx" });
		renameSync(temporary, path);
		this.#requested = enabled;
	}

	#activateIfReady(): void {
		if (!this.#requested || !this.#ready || this.#installing || this.#disposed || this.#busy) return;
		if (!this.#enabled) this.#stop = new AbortController();
		this.#enabled = true;
	}

	#disable(): void {
		this.#enabled = false;
		this.revokeForegroundControl();
		this.#stop.abort(new Error("Computer Use stopped by user"));
		this.#snapshot = undefined;
		this.#semanticSnapshot = undefined;
		this.#windows = [];
		this.#applications = [];
		if (!this.#busy) this.#owner = undefined;
	}

	install(): ComputerUseStatus {
		if (!this.status().supported) throw new Error("Computer Use currently supports Windows only");
		if (this.#installing) return this.status();
		if (this.#busy) throw new Error("Stop the active desktop operation before installing");
		if (this.#disposed) throw new Error("Computer Use is shutting down");
		this.#disable();
		this.#installing = true;
		this.#ready = false;
		this.#error = undefined;
		this.#setupStage = "checking";
		this.#setup = (async () => {
			try {
				// An already usable interpreter needs no package download.
				await this.refresh();
				if (this.#ready || this.#disposed) return this.status();
				this.#error = undefined;
				await mkdir(this.#options.runtimeDirectory, { recursive: true });
				const venv = join(this.#options.runtimeDirectory, "venv");
				this.#setupStage = "creating_environment";
				await this.#run(this.#options.python ?? "python", ["-I", "-m", "venv", venv], { timeoutMs: 90_000 });
				this.#setupStage = "installing_packages";
				await this.#run(
					join(venv, "Scripts", "python.exe"),
					["-I", "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "-r", this.#requirements],
					{ timeoutMs: 180_000 }
				);
				await this.refresh();
			} catch (error) {
				this.#error = error instanceof Error ? error.message : String(error);
			} finally {
				this.#installing = false;
				this.#setupStage = undefined;
				this.#activateIfReady();
			}
			return this.status();
		})();
		return this.status();
	}

	async withSession<T>(
		sessionId: string,
		signal: AbortSignal | undefined,
		action: (signal: AbortSignal) => Promise<T>,
		activity: NonNullable<ComputerUseStatus["activity"]> = "foreground"
	): Promise<T> {
		const state = this.status();
		if (!state.enabled || !state.ready) throw new Error("Enable Computer Use in Settings first");
		if (this.#busy || (this.#owner && this.#owner !== sessionId))
			throw new Error("Another desktop operation or session holds control; release it or use emergency stop");
		const combined = signal ? AbortSignal.any([signal, this.#stop.signal]) : this.#stop.signal;
		combined.throwIfAborted();
		this.#busy = true;
		this.#activity = activity;
		this.#owner = sessionId;
		const pending = (async () => {
			try {
				const result = await action(combined);
				combined.throwIfAborted();
				return result;
			} catch (error) {
				this.revokeForegroundControl();
				this.#snapshot = undefined;
				this.#semanticSnapshot = undefined;
				this.#windows = [];
				this.#applications = [];
				this.#owner = undefined;
				throw error;
			} finally {
				this.#busy = false;
				this.#activity = undefined;
				this.#leaseUntil = this.#clock() + 120_000;
			}
		})();
		this.#active = pending;
		try {
			return await pending;
		} finally {
			if (this.#active === pending) this.#active = undefined;
		}
	}

	grantForegroundControl(sessionId: string, scope: string, minutes: number): number {
		if (!this.#enabled || !this.#busy || this.#owner !== sessionId || !this.#options.settingsAuthorization)
			throw new Error("Continuous control requires an active local owner session");
		if (!scope || !Number.isInteger(minutes) || minutes < 1 || minutes > 10)
			throw new Error("Invalid continuous control scope or duration");
		const expiresAt = this.#clock() + minutes * 60_000;
		this.#foregroundGrant = { sessionId, scope, expiresAt };
		this.#snapshot = undefined;
		this.#semanticSnapshot = undefined;
		return expiresAt;
	}

	hasForegroundControl(sessionId: string, scope: string | undefined): boolean {
		const grant = this.#foregroundGrant;
		return Boolean(
			this.#enabled &&
			grant &&
			scope &&
			grant.sessionId === sessionId &&
			grant.scope === scope &&
			grant.expiresAt > this.#clock() &&
			this.#owner === sessionId
		);
	}

	revokeForegroundControl(): void {
		this.#foregroundGrant = undefined;
	}

	async screenshot(monitor: number, signal: AbortSignal, settleMs = 0): Promise<ComputerScreenshot> {
		this.#semanticSnapshot = undefined;
		signal.throwIfAborted();
		const result = (await this.#call({ command: "screenshot", monitor, settleMs }, signal)) as Omit<
			ComputerScreenshot,
			"id" | "capturedAt"
		>;
		signal.throwIfAborted();
		if (
			!result ||
			typeof result.image !== "string" ||
			result.image.length > 11 * 1024 * 1024 ||
			!Number.isInteger(result.width) ||
			result.width < 1 ||
			result.width > 1568 ||
			!Number.isInteger(result.height) ||
			result.height < 1 ||
			result.height > 1568 ||
			!result.foreground ||
			!Array.isArray(result.windows)
		)
			throw new Error("Invalid desktop screenshot result");
		const image = Buffer.from(result.image, "base64");
		if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
			throw new Error("Desktop helper did not return a PNG");
		this.#snapshot = { ...result, id: randomUUID(), capturedAt: this.#clock() };
		return this.#snapshot;
	}

	resolveSnapshot(id: string): ComputerScreenshot {
		if (!this.#snapshot || this.#snapshot.id !== id || this.#clock() - this.#snapshot.capturedAt > 120_000)
			throw new Error("Desktop snapshot is stale or already used; take a new screenshot");
		return this.#snapshot;
	}

	async act(snapshotId: string, action: ComputerAction, signal: AbortSignal, restoreFocus = false) {
		signal.throwIfAborted();
		const { image: _image, ...snapshot } = this.resolveSnapshot(snapshotId);
		if (
			"x" in action &&
			(!Number.isInteger(action.x) ||
				!Number.isInteger(action.y) ||
				action.x < 0 ||
				action.y < 0 ||
				action.x >= snapshot.width ||
				action.y >= snapshot.height)
		)
			throw new Error("Coordinates are outside the latest screenshot");
		this.#snapshot = undefined;
		try {
			const receipt = (await this.#call(
				{ command: "action", action, snapshot, restoreFocus, receiptVersion: 2 },
				signal
			)) as {
				performed: boolean | null;
				outcome?: string;
				error?: string;
				guidance?: string;
				inputTick?: number;
			};
			signal.throwIfAborted();
			if (receipt?.performed === true) {
				return receipt;
			}
			this.revokeForegroundControl();
			return {
				...receipt,
				performed: receipt?.performed === false ? false : null,
				outcome: receipt?.performed === false ? "not_started" : "unknown",
				guidance: "Control paused. Inspect current state before deciding; do not repeat the input blindly.",
			};
		} catch (error) {
			this.revokeForegroundControl();
			signal.throwIfAborted();
			return {
				performed: null,
				outcome: "unknown",
				error: String(error),
				guidance: "Input may have been sent. Inspect current state; never blindly repeat this action.",
			};
		}
	}

	async listApplications(signal: AbortSignal) {
		const result = (await this.#call({ command: "applications" }, signal)) as {
			apps: Omit<ComputerApplication, "ref">[];
			truncated: boolean;
		};
		signal.throwIfAborted();
		if (
			!Array.isArray(result.apps) ||
			result.apps.length > 300 ||
			result.apps.some(
				(app) => typeof app.name !== "string" || typeof app.path !== "string" || typeof app.fingerprint !== "string"
			)
		)
			throw new Error("Invalid application inventory");
		this.#applications = result.apps.map((app) => ({ ...app, ref: randomUUID() }));
		this.#applicationsAt = this.#clock();
		return { apps: this.#applications.map(({ ref, name }) => ({ ref, name })), truncated: result.truncated };
	}

	resolveApplication(ref: string) {
		const app = this.#applications.find((entry) => entry.ref === ref);
		if (!app || this.#clock() - this.#applicationsAt > 120_000)
			throw new Error("Application reference is stale; call computer_apps first");
		return app;
	}

	async openApplication(ref: string, signal: AbortSignal) {
		const application = this.resolveApplication(ref);
		this.#applications = [];
		this.#snapshot = undefined;
		this.#semanticSnapshot = undefined;
		try {
			const result = (await this.#call({ command: "open_application", application }, signal)) as {
				performed: boolean | null;
				outcome: string;
				error?: string;
				guidance?: string;
			};
			signal.throwIfAborted();
			if (result?.performed !== true) this.revokeForegroundControl();
			return result;
		} catch (error) {
			this.revokeForegroundControl();
			signal.throwIfAborted();
			return {
				performed: null,
				outcome: "unknown",
				error: String(error),
				guidance: "Inspect windows; never repeat an uncertain launch blindly.",
			};
		}
	}

	async listWindows(signal: AbortSignal): Promise<SemanticWindow[]> {
		const result = await this.#semanticCall<{ windows: SemanticWindow[] }>({ command: "windows" }, signal);
		signal.throwIfAborted();
		if (!Array.isArray(result.windows) || result.windows.length > 80) throw new Error("Invalid window inventory");
		this.#snapshot = undefined;
		this.#semanticSnapshot = undefined;
		this.#windows = result.windows;
		this.#windowsAt = this.#clock();
		return result.windows;
	}

	#rememberSemantic(state: SemanticState): SemanticSnapshot {
		if (!state?.window || !Array.isArray(state.elements) || state.elements.length > 250)
			throw new Error("Invalid UI Automation state");
		this.#snapshot = undefined;
		this.#semanticSnapshot = {
			...state,
			id: randomUUID(),
			capturedAt: this.#clock(),
			elements: state.elements.map((element) => ({ ...element, ref: randomUUID() })),
		};
		return this.#semanticSnapshot;
	}

	async inspectWindow(windowId: string, signal: AbortSignal) {
		const target = this.#windows.find((window) => window.id === windowId);
		if (!target || this.#clock() - this.#windowsAt > 120_000)
			throw new Error("List windows again before inspecting this window");
		const state = await this.#semanticCall<SemanticState>({ command: "inspect", window: target }, signal);
		signal.throwIfAborted();
		return publicSemanticState(this.#rememberSemantic(state));
	}

	resolveSemantic(id: string, ref: string) {
		const state = this.#semanticSnapshot;
		if (!state || state.id !== id || this.#clock() - state.capturedAt > 120_000)
			throw new Error("Control snapshot is stale or already used; inspect the window again");
		const element = state.elements.find((candidate) => candidate.ref === ref);
		if (!element) throw new Error("Control reference is not in the latest window inspection");
		return { state, element };
	}

	semanticNeedsApproval(id: string, ref: string): boolean {
		const { state } = this.resolveSemantic(id, ref);
		return this.#foregroundProviders.has(`${state.window.pid}:${state.window.startedAt}`);
	}

	async semanticAction(id: string, ref: string, kind: SemanticAction, value: string | undefined, signal: AbortSignal) {
		const { state, element } = this.resolveSemantic(id, ref);
		if (!element.enabled || element.offscreen || !element.actions.includes(kind))
			throw new Error("Control does not support this action in its observed state. No mouse fallback was attempted.");
		if (kind === "set_value" && (typeof value !== "string" || value.length > 2000 || value.includes("\0")))
			throw new Error("set_value requires a value of 0-2000 characters without NUL");
		this.#semanticSnapshot = undefined;
		try {
			const result = await this.#semanticCall<{
				performed: boolean | null;
				state?: SemanticState;
				outcome?: string;
				error?: string;
				verification?: string;
				foregroundChanged?: boolean;
				targetActivated?: boolean;
				cursorMoved?: boolean;
				observationFailed?: boolean;
			}>({ command: "action", window: state.window, element, kind, ...(value === undefined ? {} : { value }) }, signal);
			signal.throwIfAborted();
			if (
				result.targetActivated ||
				(result.targetActivated === undefined && (result.foregroundChanged || result.cursorMoved))
			)
				this.#foregroundProviders.add(`${state.window.pid}:${state.window.startedAt}`);
			if (result.outcome === "unknown" || result.cursorMoved || (result.foregroundChanged && !result.targetActivated))
				this.revokeForegroundControl();
			const observedState = result.state ? publicSemanticState(this.#rememberSemantic(result.state)) : undefined;
			if (result.outcome === "unknown") this.#semanticSnapshot = undefined;
			const { state: _nativeState, ...receipt } = result;
			return {
				...receipt,
				mode: "semantic",
				...(observedState ? { state: observedState } : {}),
			};
		} catch (error) {
			signal.throwIfAborted();
			this.revokeForegroundControl();
			this.#foregroundProviders.add(`${state.window.pid}:${state.window.startedAt}`);
			return {
				performed: null,
				outcome: "unknown",
				mode: "semantic",
				error: String(error),
				guidance:
					"Inspect current state; the provider may have acted. Never blindly replay or fall back to a mouse click.",
			};
		}
	}

	release(sessionId: string): void {
		if (this.#busy) throw new Error("Cannot release control during an operation");
		if (this.#owner === sessionId) {
			this.revokeForegroundControl();
			this.#owner = undefined;
			this.#snapshot = undefined;
			this.#semanticSnapshot = undefined;
			this.#windows = [];
			this.#applications = [];
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.#disposed = true;
		this.#disable();
		await Promise.allSettled([this.#active, this.#setup, this.#probe]);
	}
}

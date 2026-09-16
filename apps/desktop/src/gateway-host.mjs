import { fork, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { join, dirname, delimiter } from "node:path";

export function gatewayEnvironment(parent, options) {
	const env = Object.fromEntries(
		Object.entries(parent).filter(
			([key]) => !/^(WUMING_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|INIT_CWD$|PLAYWRIGHT_)/i.test(key)
		)
	);
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	env[pathKey] = `${dirname(options.nodeExecutable)}${delimiter}${env[pathKey] ?? ""}`;
	return {
		...env,
		NODE_ENV: "production",
		WUMING_DESKTOP: "true",
		WUMING_DEPLOYMENT_MODE: "local_device",
		WUMING_HOST: "127.0.0.1",
		WUMING_PORT: "0",
		WUMING_TOKEN: options.token,
		WUMING_DATA_DIR: options.dataDirectory,
		WUMING_WORKSPACE: options.workspace,
		WUMING_AGENT_DIR: join(options.dataDirectory, "pi-agent"),
		WUMING_RUNTIME: options.runtime ?? "pi",
		WUMING_PROCESS_MODE: "local",
		WUMING_TERMINAL_MODE: "host",
		WUMING_PREVIEW_ENABLED: "true",
		...(options.browserDirectory ? { PLAYWRIGHT_BROWSERS_PATH: options.browserDirectory } : {}),
	};
}

export class GatewayHost extends EventEmitter {
	constructor(options) {
		super();
		this.options = options;
		this.token = randomBytes(32).toString("base64url");
		this.stopping = false;
	}

	async start() {
		if (this.child || this.stopping) throw new Error("Gateway host already used");
		const child = fork(this.options.entry, [], {
			execPath: this.options.nodeExecutable,
			execArgv: [],
			cwd: this.options.workspace,
			env: gatewayEnvironment(process.env, { ...this.options, token: this.token }),
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		this.child = child;
		this.exited = new Promise((resolve) => {
			child.once("exit", (code, signal) => {
				resolve();
				if (this.ready && !this.stopping) this.emit("failure", new Error(`Local service exited (${signal ?? code})`));
			});
			child.once("error", resolve);
		});
		const log = (chunk) => this.options.log?.(String(chunk).replaceAll(this.token, "[redacted]"));
		child.stdout.on("data", log);
		child.stderr.on("data", log);
		child.on("message", (message) => {
			if (message?.type === "desktop.pick" && typeof message.id === "string") {
				void Promise.resolve()
					.then(() => this.options.pickProject?.(message.kind))
					.then(
						(selection) => this.send({ type: "desktop.pick.result", id: message.id, selection }),
						() => this.send({ type: "desktop.pick.result", id: message.id })
					);
			}
		});
		try {
			const port = await new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => finish(new Error("Local service startup timed out")),
					this.options.startupTimeoutMs ?? 60_000
				);
				const exit = () => finish(new Error("Local service exited before it was ready"));
				const error = (cause) => finish(cause);
				const message = (value) => {
					if (value?.type !== "desktop.ready") return;
					if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
						finish(new Error("Invalid local service readiness response"));
					else finish(undefined, value.port);
				};
				const finish = (cause, value) => {
					clearTimeout(timer);
					child.off("exit", exit);
					child.off("error", error);
					child.off("message", message);
					if (cause) reject(cause);
					else resolve(value);
				};
				child.once("exit", exit);
				child.once("error", error);
				child.on("message", message);
			});
			if (this.stopping) throw new Error("Application is shutting down");
			this.ready = true;
			this.connection = {
				token: this.token,
				websocketUrl: `ws://127.0.0.1:${port}/api/ws`,
				baseUrl: `http://127.0.0.1:${port}`,
			};
			return this.connection;
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	send(message) {
		if (this.child?.connected) this.child.send(message, () => {});
	}

	updateStatus(prepare = false) {
		if (!this.child?.connected || this.stopping) return Promise.reject(new Error("Local service unavailable"));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const child = this.child;
			const finish = (error, value) => {
				clearTimeout(timer);
				child.off("message", message);
				child.off("exit", exit);
				if (error) reject(error);
				else resolve(value);
			};
			const message = (value) => {
				if (value?.type !== "desktop.update-status.result" || value.id !== id) return;
				if (typeof value.busy !== "boolean") return finish(new Error("Invalid service status"));
				if (prepare && !value.busy) this.stopping = true;
				finish(undefined, { busy: value.busy });
			};
			const exit = () => finish(new Error("Local service stopped"));
			const timer = setTimeout(() => finish(new Error("Local service status timed out")), 5_000);
			child.on("message", message);
			child.once("exit", exit);
			child.send({ type: "desktop.update-status", id, prepare }, (error) => {
				if (error) finish(error);
			});
		});
	}

	stop() {
		if (this.stopPromise) return this.stopPromise;
		this.stopping = true;
		this.stopPromise = this.#stop();
		return this.stopPromise;
	}

	async #stop() {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
		this.send({ type: "desktop.shutdown" });
		let timer;
		await Promise.race([
			this.exited,
			new Promise((resolve) => {
				timer = setTimeout(resolve, this.options.shutdownTimeoutMs ?? 8_000);
			}),
		]);
		clearTimeout(timer);
		if (child.exitCode !== null || child.signalCode !== null) return;
		if (process.platform === "win32") {
			await new Promise((resolve) => {
				const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
					windowsHide: true,
					stdio: "ignore",
				});
				killer.once("error", resolve);
				killer.once("exit", resolve);
			});
		} else child.kill("SIGKILL");
		await this.exited;
	}
}

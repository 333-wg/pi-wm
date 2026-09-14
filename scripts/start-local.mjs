import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayPort = Number(process.env.WUMING_PORT ?? "8787");
const webPort = Number(process.env.WUMING_WEB_PORT ?? "5173");
if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535)
	throw new Error("WUMING_PORT must be an integer from 1 to 65535");
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535)
	throw new Error("WUMING_WEB_PORT must be an integer from 1 to 65535");

const host = "127.0.0.1";
const url = `http://${host}:${webPort}/`;
const child = spawn(
	process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm",
	process.platform === "win32" ? ["/d", "/s", "/c", "npm run dev"] : ["run", "dev"],
	{
		cwd: root,
		env: {
			...process.env,
			WUMING_DEPLOYMENT_MODE: "local_device",
			WUMING_HOST: host,
			WUMING_PORT: String(gatewayPort),
			WUMING_GATEWAY_URL: `http://${host}:${gatewayPort}`,
			WUMING_WEB_PORT: String(webPort),
			WUMING_PROCESS_MODE: process.env.WUMING_PROCESS_MODE ?? "local",
			WUMING_TERMINAL_MODE: process.env.WUMING_TERMINAL_MODE ?? "host",
			WUMING_PREVIEW_ENABLED: process.env.WUMING_PREVIEW_ENABLED ?? "true",
		},
		stdio: "inherit",
	}
);

let stopping = false;
const stop = (signal) => {
	if (stopping) return;
	stopping = true;
	child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("error", (error) => {
	console.error(`Unable to start the local Wuming host: ${error.message}`);
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	if (!stopping && code !== 0) console.error(`Local Wuming host exited (${signal ?? code ?? "unknown"}).`);
	process.exitCode = code ?? (signal ? 1 : 0);
});

async function waitForWeb() {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline && child.exitCode === null) {
		try {
			const response = await fetch(url);
			if (response.ok) return true;
		} catch {
			// The local development servers are still starting.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));
	}
	return false;
}

function openBrowser() {
	if (process.env.WUMING_OPEN_BROWSER === "false") return;
	const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
	const opener = spawn(command, [url], { detached: true, stdio: "ignore" });
	opener.unref();
}

if (await waitForWeb()) {
	console.log(`Wuming local device host ready at ${url}`);
	openBrowser();
}

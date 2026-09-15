import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import WebSocket from "ws";
import { GatewayHost } from "../src/gateway-host.mjs";

test(
	"real Gateway authenticates desktop, denies hostile Host/Origin and exits on parent disconnect",
	{ timeout: 30_000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-desktop-host-"));
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const host = new GatewayHost({
			entry: fileURLToPath(new URL("../../gateway/dist/main.js", import.meta.url)),
			nodeExecutable: process.execPath,
			dataDirectory: join(root, "data"),
			workspace,
			runtime: "demo",
			startupTimeoutMs: 15_000,
		});
		let ws;
		try {
			const connection = await host.start();
			const protocols = ["wuming.v1", `wuming.bearer.${Buffer.from(connection.token).toString("base64url")}`];
			for (const headers of [
				{ origin: "http://untrusted.invalid", host: "untrusted.invalid" },
				{ origin: "wuming://app", host: "untrusted.invalid" },
				{ origin: "https://untrusted.invalid" },
			]) {
				const denied = new WebSocket(connection.websocketUrl, protocols, { headers });
				await assert.rejects(once(denied, "open"), /403/);
			}
			const wrongToken = new WebSocket(connection.websocketUrl, ["wuming.v1", "wuming.bearer.d3VtaW5n"], {
				origin: "wuming://app",
			});
			await assert.rejects(once(wrongToken, "open"), /401/);
			ws = new WebSocket(connection.websocketUrl, protocols, { origin: "wuming://app" });
			await once(ws, "open");
			const hello = once(ws, "message");
			ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: "desktop-integration", capabilities: [] }));
			const [value] = await hello;
			const message = JSON.parse(value.toString());
			assert.equal(message.type, "hello");
			assert.equal(message.executionEnvironment.placement, "local_device");
			assert.equal(message.executionEnvironment.terminalMode, "host");
			ws.close();
			await once(ws, "close");
			host.stopping = true;
			host.child.disconnect();
			await Promise.race([
				host.exited,
				new Promise((_, reject) => {
					const timer = setTimeout(() => reject(new Error("Host leaked after parent disconnect")), 12_000);
					timer.unref();
				}),
			]);
			assert.equal(host.child.exitCode, 0);
			await assert.rejects(fetch(`${connection.baseUrl}/health`));
		} finally {
			ws?.terminate();
			await host.stop();
			await rm(root, { recursive: true, force: true });
		}
	}
);

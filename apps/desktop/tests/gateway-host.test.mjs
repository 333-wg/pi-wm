import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { GatewayHost, gatewayEnvironment } from "../src/gateway-host.mjs";

const options = {
	entry: fileURLToPath(new URL("fixtures/gateway.mjs", import.meta.url)),
	nodeExecutable: process.execPath,
	dataDirectory: process.cwd(),
	workspace: process.cwd(),
	startupTimeoutMs: 2000,
	shutdownTimeoutMs: 100,
};

test("desktop launch ignores inherited gateway and Electron overrides", () => {
	const env = gatewayEnvironment(
		{
			PATH: "test",
			WUMING_AUTH_TOKENS_JSON: "bad",
			WUMING_TOKEN: "old",
			ELECTRON_RUN_AS_NODE: "1",
			NODE_OPTIONS: "--inspect",
			WUMING_HOST: "0.0.0.0",
		},
		{ ...options, token: "fresh" }
	);
	assert.equal(env.WUMING_TOKEN, "fresh");
	assert.equal(env.WUMING_AUTH_TOKENS_JSON, undefined);
	assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.WUMING_HOST, "127.0.0.1");
	assert.equal(env.WUMING_PORT, "0");
});

test("IPC readiness and shutdown own only this child", async () => {
	const host = new GatewayHost(options);
	try {
		const connection = await host.start();
		assert.match(connection.token, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(connection.websocketUrl, "ws://127.0.0.1:12345/api/ws");
	} finally {
		await host.stop();
	}
	assert.equal(host.child.exitCode, 0);
	await host.stop();
});

test("startup timeout kills the owned child and does not leave a host running", async () => {
	const host = new GatewayHost({ ...options, runtime: "timeout", startupTimeoutMs: 150 });
	await assert.rejects(host.start(), /timed out/);
	assert.ok(host.child.exitCode !== null || host.child.signalCode !== null);
});

test("early startup failure is reported and cleaned up", async () => {
	const host = new GatewayHost({ ...options, runtime: "early-exit" });
	await assert.rejects(host.start(), /before it was ready/);
	assert.equal(host.child.exitCode, 1);
});

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { stopGateway, waitForGatewayPort } from "./gateway-process.js";

function launch(code: string) {
	return spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
}

test("reads chunked readiness and confirms shutdown", async () => {
	const child = launch(
		'process.stdout.write("Wuming gateway listening on http://127.0.0.1:"); setTimeout(() => console.log("43210"), 10); setInterval(() => {}, 1000)'
	);
	try {
		assert.equal(await waitForGatewayPort(child, 5_000), 43210);
		assert.equal(child.stdout?.listenerCount("data"), 0);
	} finally {
		await stopGateway(child);
	}
	assert.ok(child.exitCode !== null || child.signalCode !== null);
	await stopGateway(child);
});

test("startup timeout terminates the actual child before rejecting", async () => {
	const child = launch("setInterval(() => {}, 1000)");
	await assert.rejects(waitForGatewayPort(child, 100), /startup timed out/);
	assert.ok(child.exitCode !== null || child.signalCode !== null);
	assert.equal(child.stdout?.listenerCount("data"), 0);
});

test("early exit does not leak startup output", async () => {
	const child = launch('console.log("secret-canary"); process.exit(1)');
	await assert.rejects(waitForGatewayPort(child, 5_000), (error: Error) => {
		assert.match(error.message, /before readiness/);
		assert.ok(!error.message.includes("secret-canary"));
		return true;
	});
});

test("invalid readiness port cleans up a running child", async () => {
	const child = launch(
		'console.log("Wuming gateway listening on http://127.0.0.1:99999"); setInterval(() => {}, 1000)'
	);
	await assert.rejects(waitForGatewayPort(child, 5_000), /invalid port/);
	assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("spawn failure is handled without an unhandled error", async () => {
	const child = spawn(process.execPath, [], {
		cwd: "Z:/missing-wuming-acceptance-directory",
		stdio: "ignore",
	});
	await assert.rejects(waitForGatewayPort(child, 5_000), /could not be started/);
});

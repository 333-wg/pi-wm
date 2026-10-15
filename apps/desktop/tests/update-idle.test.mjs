import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { GatewayHost } from "../src/gateway-host.mjs";
import { waitForUpdateIdle } from "../src/update-idle.mjs";

test("short background requests settle before reporting the application as busy", async () => {
	const states = [
		{ busy: true, activity: { requests: 2 } },
		{ busy: true, activity: { requests: 1 } },
		{ busy: false, activity: { requests: 0 } },
	];
	let reads = 0;
	let waits = 0;
	const result = await waitForUpdateIdle(
		() => states[reads++],
		async () => {
			waits++;
		}
	);
	assert.equal(result, states[2]);
	assert.equal(reads, 3);
	assert.equal(waits, 2);
});

test("persistent work remains blocked immediately", async () => {
	for (const key of ["shuttingDown", "recovering", "terminals", "running", "queued", "goals"]) {
		const status = { busy: true, activity: { [key]: 1, requests: 1 } };
		assert.equal(
			await waitForUpdateIdle(
				() => status,
				() => assert.fail("Must not retry user work")
			),
			status
		);
	}
});

test("a task that starts while requests settle still blocks installation", async () => {
	let reads = 0;
	const result = await waitForUpdateIdle(
		() => (++reads === 1 ? { busy: true, activity: { requests: 1 } } : { busy: true, activity: { running: 1 } }),
		async () => {}
	);
	assert.equal(reads, 2);
	assert.equal(result.activity.running, 1);
});

test("sustained requests are bounded and never treated as idle", async () => {
	let reads = 0;
	const result = await waitForUpdateIdle(
		() => {
			reads++;
			return { busy: true, activity: { requests: 1 } };
		},
		async () => {}
	);
	assert.equal(reads, 16);
	assert.equal(result.busy, true);
});

test("legacy services without activity details are rechecked without bypassing busy", async () => {
	let reads = 0;
	const result = await waitForUpdateIdle(
		() => ({ busy: ++reads < 3 }),
		async () => {}
	);
	assert.equal(reads, 3);
	assert.equal(result.busy, false);
});

test("a failed status check aborts the wait instead of permitting installation", async () => {
	let reads = 0;
	await assert.rejects(
		waitForUpdateIdle(
			() => {
				if (++reads === 1) return { busy: true, activity: { requests: 1 } };
				throw new Error("Service disconnected");
			},
			async () => {}
		),
		/Service disconnected/
	);
});

test("prepare retries use the service shutdown gate and stop querying once idle", async () => {
	const host = new GatewayHost({});
	const child = new EventEmitter();
	child.connected = true;
	const requests = [];
	child.send = (message, callback) => {
		assert.equal(host.stopping, false);
		requests.push(message);
		queueMicrotask(() =>
			child.emit("message", {
				type: "desktop.update-status.result",
				id: message.id,
				busy: requests.length < 3,
				activity: { requests: requests.length < 3 ? 1 : 0 },
			})
		);
		callback?.();
	};
	host.child = child;
	const result = await host.updateStatus(true);
	assert.equal(result.busy, false);
	assert.equal(host.stopping, true);
	assert.equal(requests.length, 3);
	assert.ok(requests.every((request) => request.prepare === true));
	assert.equal(child.listenerCount("message"), 0);
	assert.equal(child.listenerCount("exit"), 0);
	await assert.rejects(host.updateStatus(), /unavailable/);
});

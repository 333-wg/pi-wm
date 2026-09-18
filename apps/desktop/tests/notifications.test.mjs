import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskNotifications, validTaskNotification } from "../src/notifications.mjs";

test("background notifications are bounded, deduplicated, private and actionable", () => {
	const created = [];
	const opened = [];
	class Notification extends EventEmitter {
		static isSupported() {
			return true;
		}
		constructor(options) {
			super();
			this.options = options;
			created.push(this);
		}
		show() {}
		close() {
			this.emit("close");
		}
	}
	let foreground = true;
	const service = new TaskNotifications({
		Notification,
		foreground: () => foreground,
		onOpen: (target) => opened.push(target),
	});
	const value = { id: "event", sessionId: "session", workspaceId: "workspace", kind: "completed" };
	assert.equal(service.show(value), false);
	foreground = false;
	assert.equal(service.show(value), false);
	assert.equal(service.show({ ...value, id: "fresh" }), true);
	assert.deepEqual(created[0].options, { title: "Pi-Wm", body: "任务已完成" });
	created[0].emit("click");
	assert.deepEqual(opened, [{ sessionId: "session", workspaceId: "workspace" }]);
	assert.equal(service.active.size, 0);
	for (let index = 0; index < 30; index++) service.show({ ...value, id: `e${index}`, sessionId: `s${index}` });
	assert.equal(service.active.size, 20);
});

test("rejects arbitrary text, unknown kinds and unbounded identifiers", () => {
	const value = { id: "event", sessionId: "session", workspaceId: "workspace", kind: "approval" };
	assert.equal(validTaskNotification(value), true);
	for (const invalid of [
		null,
		[],
		{ ...value, body: "private" },
		{ ...value, kind: "__proto__" },
		{ ...value, id: "a".repeat(201) },
	])
		assert.equal(validTaskNotification(invalid), false);
});

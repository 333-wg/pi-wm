import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { contextMenuTemplate, externalLink, installContextMenu } from "../src/context-menu.mjs";

function fixture(params) {
	const copied = [],
		opened = [];
	const dependencies = {
		clipboard: { writeText: (text) => copied.push(text) },
		openExternal: (url) => opened.push(url),
	};
	return { items: contextMenuTemplate(params, dependencies), copied, opened, dependencies };
}

test("selected content offers native copy, including whitespace", () => {
	const { items } = fixture({ selectionText: "  answer\n", editFlags: { canCopy: true } });
	assert.deepEqual(items, [{ role: "copy", label: "复制", enabled: true }]);
	assert.equal(fixture({ selectionText: " ", editFlags: { canCopy: true } }).items.length, 1);
	assert.deepEqual(fixture({}).items, []);
});

test("links offer external browser and copy address independently of selected text", () => {
	const { items, copied, opened } = fixture({
		linkURL: "http://localhost:3000/",
		selectionText: "Frontend",
		editFlags: { canCopy: true },
	});
	items[0].click();
	items[1].click();
	assert.deepEqual(opened, ["http://localhost:3000/"]);
	assert.deepEqual(copied, ["http://localhost:3000/"]);
	assert.equal(items[2].type, "separator");
	assert.equal(items[3].role, "copy");
});

test("external links reject unsafe protocols and embedded credentials", () => {
	for (const linkURL of [
		"javascript:alert(1)",
		"file:///C:/Windows",
		"data:text/html,test",
		"wuming://app",
		"mailto:a@b.com",
		"https://user:pass@example.com",
		"not a URL",
	]) {
		assert.equal(externalLink(linkURL), undefined);
		const { items, copied, opened } = fixture({ linkURL });
		assert.equal(items.length, 1);
		items[0].click();
		assert.deepEqual(copied, [linkURL]);
		assert.deepEqual(opened, []);
	}
	assert.equal(externalLink("https://example.com/path?q=1#hash"), "https://example.com/path?q=1#hash");
});

test("editable controls expose edit roles and respect Chromium capabilities", () => {
	const { items } = fixture({ isEditable: true, editFlags: { canUndo: true, canPaste: true, canSelectAll: true } });
	const roles = items.filter((item) => item.role);
	assert.deepEqual(
		roles.map((item) => item.role),
		["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"]
	);
	assert.deepEqual(
		roles.filter((item) => item.enabled).map((item) => item.role),
		["undo", "paste", "pasteAndMatchStyle", "selectAll"]
	);
	assert.ok(
		fixture({ isEditable: true })
			.items.filter((item) => item.role)
			.every((item) => !item.enabled)
	);
});

test("clipboard write rejection is handled and reported", async () => {
	const error = new Error("Clipboard unavailable");
	const errors = [];
	const items = contextMenuTemplate(
		{ linkURL: "https://example.com" },
		{
			clipboard: {
				writeText: async () => {
					throw error;
				},
			},
			openExternal: () => {},
			onCopyError: (error) => errors.push(error),
		}
	);
	await items.find((item) => item.label === "复制链接地址").click();
	assert.deepEqual(errors, [error]);
});

test("popup focuses originating contents, carries frame and avoids empty or destroyed menus", () => {
	const contents = new EventEmitter();
	let focused = false,
		destroyed = false,
		windowDestroyed = false,
		popup;
	contents.focus = () => {
		focused = true;
	};
	contents.isDestroyed = () => destroyed;
	const window = { isDestroyed: () => windowDestroyed };
	const Menu = {
		buildFromTemplate: (items) => ({
			popup: (options) => {
				popup = { items, options };
			},
		}),
	};
	installContextMenu(contents, { window, Menu, ...fixture({}).dependencies });
	contents.emit("context-menu", {}, {});
	assert.equal(popup, undefined);
	const frame = {};
	contents.emit(
		"context-menu",
		{},
		{ selectionText: "answer", editFlags: { canCopy: true }, frame, menuSourceType: "mouse" }
	);
	assert.equal(focused, true);
	assert.deepEqual(popup.options, { window, frame, sourceType: "mouse" });
	popup = undefined;
	destroyed = true;
	contents.emit("context-menu", {}, { isEditable: true });
	assert.equal(popup, undefined);
	destroyed = false;
	windowDestroyed = true;
	contents.emit("context-menu", {}, { isEditable: true });
	assert.equal(popup, undefined);
});

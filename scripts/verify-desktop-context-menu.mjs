import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const root = fileURLToPath(new URL("..", import.meta.url));
const parent = await realpath(tmpdir());
const profile = await mkdtemp(join(parent, "wuming-context-menu-"));
async function disposeProfile() {
	if (
		dirname(profile) !== parent ||
		!basename(profile).startsWith("wuming-context-menu-") ||
		(await realpath(profile)) !== profile
	)
		throw new Error("Unsafe test profile cleanup");
	await rm(profile, { recursive: true, force: true });
}
const env = { ...process.env, WUMING_DESKTOP_NODE: process.execPath, WUMING_DESKTOP_TEST_RUNTIME: "demo" };
delete env.ELECTRON_RUN_AS_NODE;
const server = createServer((_request, response) => {
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.end('<p id="preview">Preview selected text</p><textarea id="editor">Preview input</textarea>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port + "/";
let desktop;
try {
	desktop = await electron.launch({
		executablePath: createRequire(import.meta.url)("electron"),
		args: [join(root, "apps/desktop"), "--user-data-dir=" + profile],
		env,
		cwd: root,
		timeout: 60_000,
	});
	const page = await desktop.firstWindow();
	await expect(page.locator(".welcome-screen")).toBeVisible();
	await desktop.evaluate(async ({ Menu, shell, clipboard, ClipboardItem }) => {
		globalThis.savedClipboard = await Promise.all(
			(await clipboard.read()).map(
				async (item) =>
					new ClipboardItem(
						Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])))
					)
			)
		);
		globalThis.openedLinks = [];
		shell.openExternal = async (url) => {
			globalThis.openedLinks.push(url);
		};
		const popup = Menu.prototype.popup;
		Menu.prototype.popup = function (options) {
			globalThis.contextTestMenu = this;
			return popup.call(this, options);
		};
	});
	await page.evaluate(async (url) => {
		const fixture = document.createElement("section");
		fixture.id = "context-fixture";
		fixture.style.cssText = "position:fixed;inset:50px 20px;background:white;z-index:99999;padding:24px;color:black";
		fixture.innerHTML =
			'<p id="answer">Generated answer text</p><a id="link">Local preview</a><p><textarea id="editor">Original input</textarea></p><input id="readonly" readonly value="Read only"><input id="password" type="password" value="secret"><div id="rich" contenteditable="true">Rich editor</div><p id="blank">Blank area</p>';
		fixture.querySelector("#link").href = url;
		document.body.append(fixture);
		// Both uploaded attachments and generated artifacts render authenticated blobs.
		for (const [id, width, height, color] of [["uploaded-image", 32, 24, "red"], ["generated-image", 24, 32, "blue"]]) {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			context.fillStyle = color;
			context.fillRect(0, 0, width, height);
			const blob = await new Promise((resolve) => canvas.toBlob(resolve));
			const image = document.createElement("img");
			image.id = id;
			image.src = URL.createObjectURL(blob);
			image.style.margin = "20px";
			const button = document.createElement("button");
			button.append(image);
			fixture.append(button);
			await image.decode();
		}
	}, url);
	async function openMenu(selector, select = false) {
		await desktop.evaluate(() => {
			globalThis.contextTestMenu?.closePopup();
			globalThis.contextTestMenu = undefined;
		});
		if (select)
			await page.locator(selector).evaluate((element) => {
				if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
					element.focus();
					element.select();
				} else {
					const range = document.createRange();
					range.selectNodeContents(element);
					getSelection().removeAllRanges();
					getSelection().addRange(range);
				}
			});
		await page.locator(selector).click({ button: "right" });
		await expect.poll(() => desktop.evaluate(() => Boolean(globalThis.contextTestMenu))).toBe(true);
		return desktop.evaluate(() =>
			globalThis.contextTestMenu.items.map(({ label, role, enabled }) => ({ label, role, enabled }))
		);
	}
	async function choose(label) {
		await desktop.evaluate(({ BrowserWindow, webContents }, label) => {
			const menu = globalThis.contextTestMenu;
			const item = menu.items.find((item) => item.label === label);
			assertEnabled(item);
			function assertEnabled(item) {
				if (!item?.enabled) throw new Error("Menu item unavailable: " + label);
			}
			menu.closePopup();
			item.click(undefined, BrowserWindow.getAllWindows()[0], webContents.getFocusedWebContents());
		}, label);
	}
	async function clipboardImageSize() {
		return desktop.evaluate(async ({ clipboard, nativeImage }) => {
			const item = (await clipboard.read()).find((item) => item.types.includes("image/png"));
			if (!item) return undefined;
			const blob = await item.getType("image/png");
			const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
			if (image.isEmpty()) throw new Error("Copied image is empty");
			return image.getSize();
		});
	}
	for (const [selector, width, height] of [["#uploaded-image", 32, 24], ["#generated-image", 24, 32]]) {
		await desktop.evaluate(({ clipboard }) => clipboard.writeText("Before image copy"));
		const items = await openMenu(selector);
		assert.ok(items.some((item) => item.label === "复制图片" && item.enabled));
		await choose("复制图片");
		await expect.poll(clipboardImageSize).toEqual({ width, height });
	}
	await openMenu("#answer", true);
	await choose("复制");
	await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe("Generated answer text");
	await openMenu("#link");
	await choose("复制链接地址");
	assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), url);
	await openMenu("#link");
	await choose("在外部浏览器打开");
	assert.deepEqual(await desktop.evaluate(() => globalThis.openedLinks), [url]);
	await desktop.evaluate(({ clipboard }) => clipboard.writeText("Pasted input"));
	await openMenu("#editor", true);
	await choose("粘贴");
	await expect(page.locator("#editor")).toHaveValue("Pasted input");
	await openMenu("#editor", true);
	await choose("剪切");
	await expect(page.locator("#editor")).toHaveValue("");
	await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe("Pasted input");
	await openMenu("#editor");
	await choose("撤销");
	await expect(page.locator("#editor")).toHaveValue("Pasted input");
	const readonly = await openMenu("#readonly", true);
	assert.ok(!readonly.some((item) => item.role === "paste" && item.enabled));
	const password = await openMenu("#password", true);
	assert.ok(!password.some((item) => ["copy", "cut"].includes(item.role) && item.enabled));
	await desktop.evaluate(({ clipboard, ClipboardItem }) =>
		clipboard.write([new ClipboardItem({ "text/plain": "Plain paste", "text/html": "<b>Plain paste</b>" })])
	);
	await openMenu("#rich", true);
	await choose("粘贴为纯文本");
	await expect(page.locator("#rich")).toHaveText("Plain paste");
	assert.equal(await page.locator("#rich b").count(), 0);
	await desktop.evaluate(() => {
		globalThis.contextTestMenu?.closePopup();
		globalThis.contextTestMenu = undefined;
	});
	await page.evaluate(() => {
		getSelection().removeAllRanges();
		document.activeElement.blur();
	});
	await page.locator("#blank").click({ button: "right" });
	assert.equal(await desktop.evaluate(() => Boolean(globalThis.contextTestMenu)), false);
	await page.evaluate(() => {
		const fixture = document.querySelector("#context-fixture");
		for (const image of fixture.querySelectorAll("img")) URL.revokeObjectURL(image.src);
		fixture.remove();
	});
	const owner = { workspaceId: "context-menu-test", sessionId: "test" };
	const state = await page.evaluate(
		({ owner, url }) => window.wumingDesktop.browser.invoke({ ...owner, action: "open", url }),
		{ owner, url }
	);
	await page.evaluate(
		({ owner, tabId }) =>
			window.wumingDesktop.browser.invoke({
				...owner,
				tabId,
				action: "bounds",
				bounds: { x: 20, y: 60, width: 600, height: 400 },
			}),
		{ owner, tabId: state.activeId }
	);
	await desktop.evaluate(async ({ BrowserWindow }) => {
		const wc = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents)?.webContents;
		if (!wc?.listenerCount("context-menu")) throw new Error("Preview context menu missing");
		await wc.executeJavaScript(
			'const range = document.createRange(); range.selectNodeContents(document.querySelector("#preview")); getSelection().removeAllRanges(); getSelection().addRange(range);'
		);
		wc.sendInputEvent({ type: "mouseDown", x: 30, y: 20, button: "right", clickCount: 1 });
		wc.sendInputEvent({ type: "mouseUp", x: 30, y: 20, button: "right", clickCount: 1 });
	});
	await expect.poll(() => desktop.evaluate(() => Boolean(globalThis.contextTestMenu))).toBe(true);
	await choose("复制");
	await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe("Preview selected text");
	await desktop.evaluate(async ({ BrowserWindow, clipboard }) => {
		await clipboard.writeText("Before preview image copy");
		globalThis.contextTestMenu = undefined;
		const wc = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents)?.webContents;
		await wc.executeJavaScript(`(async () => {
			getSelection().removeAllRanges();
			const canvas = document.createElement("canvas");
			canvas.width = 40; canvas.height = 30;
			const context = canvas.getContext("2d");
			context.fillStyle = "green"; context.fillRect(0, 0, 40, 30);
			const image = document.createElement("img");
			image.src = canvas.toDataURL();
			image.style.cssText = "position:fixed;left:10px;top:10px";
			document.body.replaceChildren(image);
			await image.decode();
		})()`);
		wc.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "right", clickCount: 1 });
		wc.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "right", clickCount: 1 });
	});
	await expect.poll(() => desktop.evaluate(() => Boolean(globalThis.contextTestMenu))).toBe(true);
	await choose("复制图片");
	await expect.poll(clipboardImageSize).toEqual({ width: 40, height: 30 });
	console.log(
		"Context menus passed: uploaded/generated blob image copy (decoded clipboard pixels), native right-click, selected-text copy, link copy/external dispatch, paste/cut/undo, read-only/password protection, plain-text paste, blank area, preview text/image copy."
	);
} finally {
	if (desktop) {
		await desktop
			.evaluate(async ({ clipboard }) => {
				globalThis.contextTestMenu?.closePopup();
				if (globalThis.savedClipboard) await clipboard.write(globalThis.savedClipboard);
			})
			.catch(() => {});
		await desktop.close();
	}
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await disposeProfile();
}

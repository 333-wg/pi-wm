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
	await page.evaluate((url) => {
		const fixture = document.createElement("section");
		fixture.id = "context-fixture";
		fixture.style.cssText = "position:fixed;inset:50px 20px;background:white;z-index:99999;padding:24px;color:black";
		fixture.innerHTML =
			'<p id="answer">Generated answer text</p><a id="link">Local preview</a><p><textarea id="editor">Original input</textarea></p><input id="readonly" readonly value="Read only"><input id="password" type="password" value="secret"><div id="rich" contenteditable="true">Rich editor</div><p id="blank">Blank area</p>';
		fixture.querySelector("#link").href = url;
		document.body.append(fixture);
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
	await page.evaluate(() => document.querySelector("#context-fixture").remove());
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
	console.log(
		"Context menus passed: native right-click, selected-text copy, link copy/external dispatch, paste/cut/undo, read-only/password protection, plain-text paste, blank area, preview copy."
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

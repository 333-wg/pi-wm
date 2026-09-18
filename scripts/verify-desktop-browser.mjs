import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { prepareDesktopRelease, releaseEnvironment } from "./lib/desktop-release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packaged = process.argv.find((arg) => arg.startsWith("--packaged="))?.slice(11);
const release = packaged ? await prepareDesktopRelease(resolve(packaged), root) : undefined;
const parent = await realpath(tmpdir());
const profile = await mkdtemp(join(parent, "wuming-browser-"));
const output = join(root, "test-results", packaged ? "desktop-browser-packaged" : "desktop-browser");
await mkdir(output, { recursive: true });
let slowRequests = 0;
const fixture = createServer((request, response) => {
	if (request.url === "/slow") {
		slowRequests++;
		return;
	}
	if (request.url === "/slow-image") return;
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.setHeader("X-Frame-Options", request.url === "/frame" ? "SAMEORIGIN" : "DENY");
	response.end(
		'<!doctype html><html><head><title>Preview fixture</title><style>body{margin:0;background:#f5f6f8;color:#17212c;font:16px system-ui}header{background:#163c31;color:white;padding:24px}main{padding:24px}button,a{display:inline-block;margin:8px;padding:12px;border:1px solid #ccd4da;background:white;border-radius:4px}section{background:white;border:1px solid #ccd4da;padding:24px;margin:20px 0}h1{font-size:26px}</style></head><body><header>LOCAL PREVIEW</header><main><h1>Project workspace</h1><section><h2>Live browser session</h2><p id="cookie">' +
			(request.headers.cookie || "Signed out") +
			'</p><button id="login" onclick="document.cookie=\'preview_login=verified; Max-Age=86400; SameSite=Lax; Path=/\';location.reload()">Sign in</button><a href="/second">Second page</a><button id="popup" onclick="window.open(\'/popup\',\'preview-popup\')">Open popup</button></section><p id="path">' +
			request.url +
			(request.url === "/spa" ? '</p><img src="/slow-image"><iframe id="child-frame" src="/frame"></iframe><p>' : "") +
			"</p></main></body></html>"
	);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + fixture.address().port;
const env = {
	...(packaged ? releaseEnvironment(process.env) : process.env),
	WUMING_DESKTOP_NODE: process.execPath,
	...(!packaged ? { WUMING_DESKTOP_TEST_RUNTIME: "demo" } : {}),
};
delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
const errors = [];
async function launch() {
	desktop = await electron.launch({
		executablePath: release?.executable ?? createRequire(import.meta.url)("electron"),
		args: [...(packaged ? [] : [join(root, "apps", "desktop")]), "--user-data-dir=" + profile],
		env,
		cwd: release?.directory ?? root,
		timeout: 60_000,
	});
	page = await desktop.firstWindow();
	assert.equal(await desktop.evaluate(({ app }) => app.isPackaged), Boolean(packaged));
	assert.equal(await desktop.evaluate(({ app }) => app.getPath("userData")), profile);
	page.setDefaultTimeout(15_000);
	page.on("pageerror", (error) => errors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	if ((await page.evaluate(() => localStorage.getItem("wuming.desktop.welcome.complete"))) !== "true") {
		await page.getByLabel("访问密码", { exact: true }).fill("wuming");
		await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	}
	await expect(page.locator(".connection")).toHaveClass(/connected/, { timeout: 30_000 });
	await page.evaluate(() => localStorage.setItem("wuming.onboarding.complete", "true"));
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.getByRole("button", { name: "浏览器预览", exact: true }).click();
	await expect(page.locator(".browser-panel")).toBeVisible();
}
async function nativeEval(expression, duringLoad = false) {
	let id;
	await expect
		.poll(async () => {
			id = await desktop.evaluate(
				({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()[0].contentView.children.find((entry) => entry.getVisible() && entry.webContents)
						?.webContents.id
			);
			return id;
		})
		.toBeTruthy();
	return desktop.evaluate(
		async ({ webContents }, { id, code, duringLoad }) => {
			const wc = webContents.fromId(id);
			if (!wc) throw new Error("Preview page closed before evaluation");
			if (!duringLoad) return wc.executeJavaScript(code, true);
			// executeJavaScript waits for loading to stop, which the stalled-resource fixture never does.
			const debuggerApi = wc.debugger;
			const attachedHere = !debuggerApi.isAttached();
			if (attachedHere) debuggerApi.attach("1.3");
			try {
				const result = await debuggerApi.sendCommand("Runtime.evaluate", {
					expression: code,
					returnByValue: true,
					awaitPromise: true,
					userGesture: true,
				});
				if (result.exceptionDetails)
					throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
				return result.result.value;
			} finally {
				if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
			}
		},
		{ id, code: expression, duringLoad }
	);
}
async function visibleCount() {
	return desktop.evaluate(
		({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0].contentView.children.filter((entry) => entry.getVisible()).length
	);
}
async function nativeZoom() {
	return desktop.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0]
			.contentView.children.find((view) => view.getVisible())
			?.webContents.getZoomFactor()
	);
}
async function nativeKey(key) {
	await desktop.evaluate(({ BrowserWindow }, keyCode) => {
		const wc = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.getVisible()).webContents;
		wc.focus();
		wc.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["control"] });
		wc.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["control"] });
	}, key);
}
async function openPreviewLink(target) {
	return page.evaluate(
		(url) =>
			new Promise((resolve, reject) => {
				const unsubscribe = window.wumingDesktop.browser.onState((state) => {
					if (!state.tabs.some((tab) => tab.url === url)) return;
					clearTimeout(timer);
					unsubscribe();
					resolve(state);
				});
				const timer = setTimeout(() => {
					unsubscribe();
					reject(new Error("Preview link did not produce browser state"));
				}, 10_000);
				const link = document.createElement("a");
				link.href = url;
				link.target = "_blank";
				link.textContent = "Local preview link";
				document.body.append(link);
				link.click();
				link.remove();
			}),
		target
	);
}
async function disposeProfile() {
	if (
		dirname(profile) !== parent ||
		!basename(profile).startsWith("wuming-browser-") ||
		(await realpath(profile)) !== profile
	)
		throw new Error("Unsafe test profile cleanup");
	await rm(profile, { recursive: true, force: true });
}
try {
	await launch();
	await page.getByRole("textbox", { name: "浏览器地址" }).fill(url);
	await page.getByRole("textbox", { name: "浏览器地址" }).press("Enter");
	await expect.poll(visibleCount).toBe(1);
	await expect.poll(() => nativeEval("document.title")).toBe("Preview fixture");
	await expect.poll(() => nativeEval("document.readyState")).toBe("complete");
	const address = page.getByRole("textbox", { name: "浏览器地址" });
	await address.fill(url + "/spa");
	await address.press("Enter");
	await expect.poll(() => nativeEval("document.readyState", true)).toBe("interactive");
	await expect
		.poll(() => nativeEval("document.querySelector('#child-frame')?.contentDocument?.readyState", true))
		.toBe("complete");
	for (const [script, path] of [
		["history.pushState({}, '', '/spa-route')", "/spa-route"],
		["history.replaceState({}, '', '/spa-replaced')", "/spa-replaced"],
		["location.hash = 'section'", "/spa-replaced#section"],
	]) {
		await nativeEval(script + "; undefined", true);
		await expect(address).toHaveValue(url + path);
		await expect(page.getByRole("button", { name: "停止加载", exact: true })).toBeVisible();
	}
	await nativeEval(
		"document.querySelector('#child-frame').contentWindow.history.pushState({}, '', '/frame-route'); undefined",
		true
	);
	await expect(address).toHaveValue(url + "/spa-replaced#section");
	await page.getByRole("button", { name: "后退", exact: true }).click();
	await expect
		.poll(() => nativeEval("document.querySelector('#child-frame').contentWindow.location.pathname", true))
		.toBe("/frame");
	await expect(address).toHaveValue(url + "/spa-replaced#section");
	await page.getByRole("button", { name: "后退", exact: true }).click();
	await expect(address).toHaveValue(url + "/spa-replaced");
	await page.getByRole("button", { name: "前进", exact: true }).click();
	await expect(address).toHaveValue(url + "/spa-replaced#section");
	await page.getByRole("button", { name: "停止加载", exact: true }).click();
	await expect(page.locator(".browser-empty")).toHaveCount(0);
	await address.fill(url);
	await address.press("Enter");
	await expect.poll(() => nativeEval("location.pathname")).toBe("/");
	await expect.poll(() => nativeEval("document.readyState")).toBe("complete");
	await address.fill(url + "/slow");
	await address.press("Enter");
	await expect.poll(() => slowRequests).toBe(1);
	const reopened = await openPreviewLink(url + "/slow");
	assert.equal(reopened.tabs.length, 1);
	await expect(page.locator(".browser-tab")).toHaveCount(1);
	assert.equal(slowRequests, 1);
	await page.getByRole("button", { name: "停止加载", exact: true }).click();
	await expect(address).toHaveValue(url + "/");
	await expect(page.locator(".browser-empty")).toHaveCount(0);
	await expect.poll(visibleCount).toBe(1);
	await expect.poll(() => nativeEval("location.pathname")).toBe("/");
	await page.getByRole("button", { name: "新建标签页", exact: true }).click();
	await expect(page.locator(".browser-tab")).toHaveCount(2);
	await expect(address).toHaveValue("");
	await address.fill(url + "/slow");
	await address.press("Enter");
	await expect.poll(() => slowRequests).toBe(2);
	await page.getByRole("button", { name: "停止加载", exact: true }).click();
	await expect(address).toHaveValue("");
	await expect(page.locator(".browser-empty")).toHaveText("新标签页");
	await page.locator(".browser-tab").last().getByTitle("关闭标签页", { exact: true }).click();
	await expect.poll(visibleCount).toBe(1);
	const zoom = page.getByRole("combobox", { name: "页面缩放" });
	await nativeKey("+");
	await expect.poll(nativeZoom).toBeCloseTo(1.25);
	await expect(zoom).toHaveValue("1.25");
	await nativeKey("-");
	await expect.poll(nativeZoom).toBeCloseTo(1);
	await expect(zoom).toHaveValue("1");
	await nativeKey("+");
	await nativeKey("0");
	await expect.poll(nativeZoom).toBeCloseTo(1);
	await expect(zoom).toHaveValue("1");
	await desktop.evaluate(({ BrowserWindow }) => {
		const wc = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.getVisible()).webContents;
		wc.setZoomFactor(1.1);
		return wc.executeJavaScript("document.title = 'Custom zoom'");
	});
	await expect.poll(async () => Number(await zoom.inputValue())).toBeCloseTo(1.1);
	await expect(zoom.locator("option:checked")).toHaveText("110%");
	await zoom.selectOption("1");
	console.log(
		"SPA/hash history during loading, pending URL reuse, stopped navigation, blank-tab cancellation and native zoom passed."
	);
	assert.equal(await nativeEval("typeof window.wumingDesktop + ':' + typeof require"), "undefined:undefined");
	await nativeEval("document.querySelector('#login').click()");
	await expect.poll(() => nativeEval("document.cookie")).toContain("preview_login=verified");
	await expect.poll(() => nativeEval("document.readyState")).toBe("complete");
	const isolated = await page.evaluate(
		(url) =>
			window.wumingDesktop.browser.invoke({
				workspaceId: "isolated-workspace",
				sessionId: "isolation-test",
				action: "open",
				url,
			}),
		url + "/isolated"
	);
	await expect
		.poll(() =>
			desktop.evaluate(
				({ webContents }, target) =>
					webContents.getAllWebContents().some((wc) => wc.getURL() === target && !wc.isLoading()),
				url + "/isolated"
			)
		)
		.toBe(true);
	const isolatedCookie = await desktop.evaluate(
		({ webContents }, target) =>
			webContents
				.getAllWebContents()
				.find((wc) => wc.getURL() === target)
				.executeJavaScript("document.cookie"),
		url + "/isolated"
	);
	assert.equal(isolatedCookie, "");
	await page.evaluate(
		(tabId) =>
			window.wumingDesktop.browser.invoke({
				workspaceId: "isolated-workspace",
				sessionId: "isolation-test",
				action: "close",
				tabId,
			}),
		isolated.activeId
	);
	await nativeEval("document.querySelector('a').click()");
	await expect(page.getByRole("textbox", { name: "浏览器地址" })).toHaveValue(url + "/second");
	await page.getByRole("button", { name: "后退", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "浏览器地址" })).toHaveValue(url + "/");
	await page.getByRole("button", { name: "前进", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "浏览器地址" })).toHaveValue(url + "/second");
	await page.getByRole("button", { name: "手机宽度 390px", exact: true }).click();
	await expect.poll(() => nativeEval("innerWidth")).toBe(390);
	await page.getByRole("button", { name: "自适应宽度", exact: true }).click();
	await page.getByRole("combobox", { name: "页面缩放" }).selectOption("1.25");
	console.log("Navigation, login, viewport and zoom passed; checking popup.");
	await nativeEval("setTimeout(() => document.querySelector('#popup').click(), 0); undefined");
	await expect(page.locator(".browser-tab")).toHaveCount(2);
	await expect.poll(() => nativeEval("location.pathname")).toBe("/popup");
	assert.equal(await nativeEval("Boolean(window.opener)"), false);
	assert.ok((await nativeEval("document.cookie")).includes("preview_login=verified"));
	await page.locator(".browser-tab").last().getByTitle("关闭标签页", { exact: true }).click();
	await expect(page.locator(".browser-tab")).toHaveCount(1);
	await page.getByRole("button", { name: "关闭浏览器面板", exact: true }).click();
	await expect.poll(visibleCount).toBe(0);
	await openPreviewLink(url + "/second");
	await expect.poll(visibleCount).toBe(1);
	await expect(page.getByRole("textbox", { name: "浏览器地址" })).toHaveValue(url + "/second");
	await page.keyboard.press("Control+l");
	await expect(page.getByRole("textbox", { name: "浏览器地址" })).toBeFocused();
	await page.evaluate(() => {
		const dialog = document.createElement("dialog");
		dialog.id = "browser-test-dialog";
		dialog.textContent = "Modal fixture";
		document.body.append(dialog);
		dialog.showModal();
	});
	await expect.poll(visibleCount).toBe(0);
	await page.evaluate(() => document.querySelector("#browser-test-dialog").remove());
	await expect.poll(visibleCount).toBe(1);
	for (const width of [1360, 800]) {
		await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
		await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
		await expect.poll(visibleCount).toBe(1);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		const dimensions = await page.locator(".browser-panel").boundingBox();
		assert.ok(dimensions.x >= 0 && dimensions.x + dimensions.width <= width + 1);
		await page.screenshot({ path: join(output, "shell-" + width + ".png") });
		const png = await desktop.evaluate(async ({ BrowserWindow }) => {
			const view = BrowserWindow.getAllWindows()[0].contentView.children.find((entry) => entry.getVisible());
			return (await view.webContents.capturePage()).toPNG().toString("base64");
		});
		assert.ok(Buffer.from(png, "base64").length > 5000);
		await writeFile(join(output, "page-" + width + ".png"), Buffer.from(png, "base64"));
		const nativeImage = await desktop.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
			const window = BrowserWindow.getAllWindows()[0];
			const sources = await desktopCapturer.getSources({
				types: ["window"],
				thumbnailSize: { width: 1600, height: 1100 },
			});
			return sources
				.find((source) => source.id === window.getMediaSourceId())
				?.thumbnail.toPNG()
				.toString("base64");
		});
		if (nativeImage) await writeFile(join(output, "native-" + width + ".png"), Buffer.from(nativeImage, "base64"));
	}
	await page.getByRole("textbox", { name: "浏览器地址" }).fill("http://127.0.0.1:1");
	await page.getByRole("textbox", { name: "浏览器地址" }).press("Enter");
	await expect(page.locator(".browser-empty")).toContainText("无法加载此页面");
	await expect.poll(visibleCount).toBe(0);
	await desktop.close();
	desktop = undefined;
	await launch();
	await page.getByRole("textbox", { name: "浏览器地址" }).fill(url);
	await page.getByRole("textbox", { name: "浏览器地址" }).press("Enter");
	await expect.poll(visibleCount).toBe(1);
	await expect.poll(() => nativeEval("document.cookie")).toContain("preview_login=verified");
	assert.deepEqual(errors, []);
	console.log(
		"PASS: real native pages, login persistence across restart, navigation/stop, popup tabs, isolation, native zoom, phone width, modal hiding, close/reopen, responsive layout and load errors."
	);
} finally {
	await desktop?.close();
	fixture.closeAllConnections();
	await new Promise((resolve) => fixture.close(resolve));
	await disposeProfile();
	await release?.dispose();
}

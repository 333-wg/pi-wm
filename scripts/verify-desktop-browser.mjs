import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const parent = await realpath(tmpdir());
const profile = await mkdtemp(join(parent, "wuming-browser-"));
const output = join(root, "test-results", "desktop-browser");
await mkdir(output, { recursive: true });
const fixture = createServer((request, response) => {
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.setHeader("X-Frame-Options", "DENY");
	response.end(
		'<!doctype html><html><head><title>Preview fixture</title><style>body{margin:0;background:#f5f6f8;color:#17212c;font:16px system-ui}header{background:#163c31;color:white;padding:24px}main{padding:24px}button,a{display:inline-block;margin:8px;padding:12px;border:1px solid #ccd4da;background:white;border-radius:4px}section{background:white;border:1px solid #ccd4da;padding:24px;margin:20px 0}h1{font-size:26px}</style></head><body><header>LOCAL PREVIEW</header><main><h1>Project workspace</h1><section><h2>Live browser session</h2><p id="cookie">' +
			(request.headers.cookie || "Signed out") +
			'</p><button id="login" onclick="document.cookie=\'preview_login=verified; Max-Age=86400; SameSite=Lax; Path=/\';location.reload()">Sign in</button><a href="/second">Second page</a><button id="popup" onclick="window.open(\'/popup\',\'preview-popup\')">Open popup</button></section><p id="path">' +
			request.url +
			"</p></main></body></html>"
	);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + fixture.address().port;
const env = { ...process.env, WUMING_DESKTOP_NODE: process.execPath, WUMING_DESKTOP_TEST_RUNTIME: "demo" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, page;
const errors = [];
async function launch() {
	desktop = await electron.launch({
		executablePath: createRequire(import.meta.url)("electron"),
		args: [join(root, "apps", "desktop"), "--user-data-dir=" + profile],
		env,
		cwd: root,
		timeout: 60_000,
	});
	page = await desktop.firstWindow();
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
async function nativeEval(expression) {
	return desktop.evaluate(({ BrowserWindow }, code) => {
		const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
			(entry) => entry.getVisible() && entry.webContents
		);
		if (!view) return undefined;
		return view.webContents.executeJavaScript(code, true);
	}, expression);
}
async function visibleCount() {
	return desktop.evaluate(
		({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0].contentView.children.filter((entry) => entry.getVisible()).length
	);
}
try {
	await launch();
	await page.getByRole("textbox", { name: "浏览器地址" }).fill(url);
	await page.getByRole("textbox", { name: "浏览器地址" }).press("Enter");
	await expect.poll(visibleCount).toBe(1);
	await expect.poll(() => nativeEval("document.title")).toBe("Preview fixture");
	await expect.poll(() => nativeEval("document.readyState")).toBe("complete");
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
	await page.evaluate((url) => {
		const link = document.createElement("a");
		link.id = "preview-local-link";
		link.href = url + "/second";
		link.target = "_blank";
		link.textContent = "Local preview link";
		document.body.append(link);
		link.click();
		link.remove();
	}, url);
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
		"PASS: real native pages, login persistence across restart, navigation, popup tabs, isolation, zoom, phone width, modal hiding, close/reopen, responsive layout and load errors."
	);
} finally {
	await desktop?.close();
	await new Promise((resolve) => fixture.close(resolve));
	if (
		dirname(profile) !== parent ||
		!basename(profile).startsWith("wuming-browser-") ||
		(await realpath(profile)) !== profile
	)
		throw new Error("Unsafe test profile cleanup");
	await rm(profile, { recursive: true, force: true });
}

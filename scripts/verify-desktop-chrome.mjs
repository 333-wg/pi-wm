import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const parent = await realpath(tmpdir());
const profile = await mkdtemp(join(parent, "wuming-chrome-"));
const output = join(root, "test-results", "desktop-chrome");
await mkdir(output, { recursive: true });
const env = { ...process.env, WUMING_DESKTOP_NODE: process.execPath, WUMING_DESKTOP_TEST_RUNTIME: "demo" };
delete env.ELECTRON_RUN_AS_NODE;
async function disposeProfile() {
	if (
		dirname(profile) !== parent ||
		!basename(profile).startsWith("wuming-chrome-") ||
		(await realpath(profile)) !== profile
	)
		throw new Error("Unsafe test profile cleanup");
	await rm(profile, { recursive: true, force: true });
}
let desktop;
try {
	desktop = await electron.launch({
		executablePath: createRequire(import.meta.url)("electron"),
		args: [join(root, "apps", "desktop"), "--user-data-dir=" + profile],
		env,
		cwd: root,
		timeout: 60_000,
	});
	const page = await desktop.firstWindow();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await expect(page.locator(".desktop-titlebar")).toBeVisible();
	await expect(page.locator(".welcome-screen")).toBeVisible();
	assert.equal(await page.evaluate(() => navigator.windowControlsOverlay.visible), true);
	assert.equal(
		await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()),
		false
	);
	assert.equal(
		await page
			.locator(".desktop-titlebar")
			.evaluate((element) => getComputedStyle(element).getPropertyValue("app-region")),
		"drag"
	);
	assert.equal(
		await page
			.locator(".desktop-titlebar-menu")
			.evaluate((element) => getComputedStyle(element).getPropertyValue("app-region")),
		"no-drag"
	);
	await desktop.evaluate(({ Menu }) => {
		globalThis.chromeMenuOpened = false;
		Menu.getApplicationMenu().once("menu-will-show", () => {
			globalThis.chromeMenuOpened = true;
		});
	});
	await page.locator(".desktop-titlebar-menu").click();
	assert.equal(await desktop.evaluate(() => globalThis.chromeMenuOpened), true);
	await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().closePopup());
	const invalidThemeRejected = await page.evaluate(async () => {
		try {
			await window.wumingDesktop.setWindowTheme("invalid");
			return false;
		} catch {
			return true;
		}
	});
	assert.equal(invalidThemeRejected, true);
	for (const [width, height] of [
		[1360, 900],
		[800, 600],
	]) {
		await desktop.evaluate(
			({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
			[width, height]
		);
		await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
		const layout = await page.evaluate(() => {
			const title = document.querySelector(".desktop-titlebar").getBoundingClientRect();
			const content = document.querySelector(".desktop-content").getBoundingClientRect();
			const welcome = document.querySelector(".welcome-screen").getBoundingClientRect();
			return {
				titleHeight: title.height,
				contentTop: content.top,
				bottom: welcome.bottom,
				viewport: innerHeight,
				overflow: document.documentElement.scrollWidth > innerWidth,
			};
		});
		assert.equal(layout.titleHeight, 36);
		assert.equal(layout.contentTop, 36);
		assert.ok(layout.bottom <= layout.viewport);
		assert.equal(layout.overflow, false);
		await page.screenshot({ path: join(output, "light-" + width + ".png") });
		if (width === 1360) {
			const image = await desktop.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
				const window = BrowserWindow.getAllWindows()[0];
				const sources = await desktopCapturer.getSources({
					types: ["window"],
					thumbnailSize: { width: 1360, height: 900 },
				});
				const source = sources.find((item) => item.id === window.getMediaSourceId());
				return source?.thumbnail.toPNG().toString("base64");
			});
			if (image) await writeFile(join(output, "native-window.png"), Buffer.from(image, "base64"));
		}
	}
	await page.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
	});
	await expect(page.locator(".desktop-titlebar")).toHaveCSS("background-color", "rgb(14, 18, 15)");
	await page.screenshot({ path: join(output, "dark-800.png") });
	const previewLayout = await page.evaluate(() => {
		const dialog = document.createElement("dialog");
		dialog.className = "image-viewer";
		document.querySelector(".desktop-content").append(dialog);
		dialog.showModal();
		const bounds = dialog.getBoundingClientRect();
		const layout = { top: bounds.top, bottom: bounds.bottom, height: innerHeight };
		dialog.close();
		dialog.remove();
		return layout;
	});
	assert.equal(previewLayout.top, 36);
	assert.equal(previewLayout.bottom, previewLayout.height);
	assert.deepEqual(errors, []);
	console.log("Desktop chrome passed: menu, IPC validation, drag regions, light/dark themes, 1360/800px layouts.");
} finally {
	await desktop?.close();
	await disposeProfile();
}

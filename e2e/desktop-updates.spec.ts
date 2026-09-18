import { expect, test, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";
import type { DesktopUpdateState } from "../apps/web/src/lib/desktop.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(stopWebApp);

async function desktop(page: Page, initial: Partial<DesktopUpdateState> = {}) {
	await page.addInitScript(
		({ url, password, initial }) => {
			localStorage.setItem("wuming.desktop.welcome.complete", "true");
			let state: DesktopUpdateState = {
				revision: 0,
				status: "available",
				currentVersion: "0.1.2",
				nextVersion: "0.1.3",
				platform: "win32",
				arch: "x64",
				repository: "333-wg/pi-wm",
				autoCheck: true,
				deferredUntil: 0,
				progress: 0,
				releaseNotes: "## 改进\n- 优化桌面更新\n- 保留会话与项目配置",
				...initial,
			};
			const listeners = new Set<(state: DesktopUpdateState) => void>();
			const opens = new Set<() => void>();
			function patch(value: Partial<DesktopUpdateState>) {
				state = { ...state, ...value, revision: state.revision + 1 };
				for (const listener of listeners) listener({ ...state });
			}
			window.addEventListener("test:updates", (event) => patch((event as CustomEvent).detail));
			window.addEventListener("test:open-updates", () => {
				for (const open of opens) open();
			});
			window.wumingDesktop = {
				connect: async () => ({ token: password, websocketUrl: url.replace("http:", "ws:") + "api/ws" }),
				updates: {
					onState: (callback) => {
						listeners.add(callback);
						return () => {
							listeners.delete(callback);
						};
					},
					onOpen: (callback) => {
						opens.add(callback);
						return () => {
							opens.delete(callback);
						};
					},
					invoke: async (action, value) => {
						if (action !== "state" && action !== "activity") document.documentElement.dataset.updateAction = action;
						if (action === "check" || action === "download") delete state.error;
						if (action === "check") patch({ status: "latest" });
						if (action === "download")
							patch({
								status: "downloading",
								progress: 42,
								transferred: 42_000_000,
								total: 100_000_000,
							});
						if (action === "cancel") patch({ status: "available", progress: 0 });
						if (action === "defer") patch({ deferredUntil: Date.now() + 86_400_000 });
						if (action === "auto-check" && typeof value === "boolean") patch({ autoCheck: value });
						if (action === "install" && state.busy === false) document.documentElement.dataset.updateInstalled = "true";
						return { ...state };
					},
				},
			};
		},
		{ url: webUrl, password: token, initial }
	);
	await openApp(page, webUrl);
}
async function patch(page: Page, detail: Partial<DesktopUpdateState>) {
	await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("test:updates", { detail })), detail);
}
async function openUpdates(page: Page) {
	await page.evaluate(() => window.dispatchEvent(new Event("test:open-updates")));
	await expect(page.locator("#settings-panel-updates")).toBeVisible();
}

for (const width of [1360, 800, 390]) {
	test("update flow and responsive layout at " + width, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await desktop(page);
		if (width > 800) await page.locator(".desktop-update-notice").click();
		else await openUpdates(page);
		const panel = page.locator("#settings-panel-updates");
		await expect(panel.getByText("当前版本 0.1.2", { exact: false })).toBeVisible();
		await panel.getByRole("button", { name: "下载更新", exact: true }).click();
		await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "42");
		await panel.getByRole("button", { name: "取消下载" }).click();
		await expect(panel.getByRole("button", { name: "下载更新", exact: true })).toBeEnabled();
		await panel.getByRole("button", { name: "稍后提醒" }).click();
		await expect(page.locator(".desktop-update-notice")).toHaveCount(0);
		await panel.getByRole("checkbox", { name: "自动检查更新" }).uncheck();
		await expect(panel.getByRole("checkbox")).not.toBeChecked();
		await patch(page, { status: "ready", busy: true, deferredUntil: 0 });
		await expect(panel.getByRole("button", { name: "重启并安装", exact: true })).toBeDisabled();
		await expect(panel.getByText("有任务正在运行或终端仍打开", { exact: false })).toBeVisible();
		await patch(page, { busy: false });
		await expect(panel.getByRole("button", { name: "重启并安装", exact: true })).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath("updates-light-" + width + ".png"), fullPage: true });
		await page.evaluate(() => {
			document.documentElement.dataset.theme = "dark";
		});
		await page.screenshot({ path: testInfo.outputPath("updates-dark-" + width + ".png"), fullPage: true });
		const overflow = await panel.evaluate((element) =>
			Array.from(element.querySelectorAll("button, p, summary")).some(
				(child) => child.scrollWidth > child.clientWidth + 1
			)
		);
		expect(overflow).toBe(false);
		expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
		await panel.getByRole("button", { name: "重启并安装", exact: true }).click();
		await expect(page.locator("html")).toHaveAttribute("data-update-installed", "true");
		expect(errors).toEqual([]);
	});
}

test("unconfigured builds and error states are honest; ordinary browsers hide the feature", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(page.getByRole("button", { name: /关于与更新/ })).toHaveCount(0);
	await desktop(page, { status: "disabled", disabledReason: "unconfigured", nextVersion: "" });
	await openUpdates(page);
	const panel = page.locator("#settings-panel-updates");
	await expect(panel.getByText("尚未配置更新源")).toBeVisible();
	await expect(panel.getByRole("button", { name: "检查更新", exact: true })).toBeDisabled();
	await patch(page, { status: "error", error: "network" });
	await expect(panel.getByRole("alert")).toContainText("失败");
	await panel.getByRole("button", { name: "重试" }).click();
	await expect(panel.getByText("已是最新版本")).toBeVisible();
});

for (const width of [1360, 390]) {
	test("update errors offer the correct recovery action at " + width, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await desktop(page);
		await openUpdates(page);
		const panel = page.locator("#settings-panel-updates");
		await expect(panel.getByText("更新源 · 333-wg/pi-wm")).toBeVisible();
		for (const [error, retryAction, description] of [
			["no-release", "check", "尚无可用的正式版本"],
			["metadata", "check", "更新文件缺失"],
			["timeout", "check", "连接更新源超时"],
			["rate-limit", "check", "请求过于频繁"],
			["access", "check", "更新源拒绝访问"],
			["disk", "download", "磁盘空间不足"],
			["permission", "download", "无法写入更新缓存"],
			["integrity", "download", "已阻止安装"],
		] as const) {
			await patch(page, { status: "error", error, retryAction, nextVersion: "0.1.3" });
			await expect(panel.getByRole("alert")).toContainText(description);
			await expect(panel.getByRole("button", { name: "重启并安装", exact: true })).toHaveCount(0);
			await panel
				.getByRole("button", { name: retryAction === "check" ? "重新检查更新" : "重新下载", exact: true })
				.click();
			await expect(page.locator("html")).toHaveAttribute("data-update-action", retryAction);
		}
		await patch(page, { status: "error", error: "integrity", retryAction: "download" });
		await expect(panel.getByRole("button", { name: "检查更新", exact: true })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("update-error-" + width + ".png"), fullPage: true });
		expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await panel.getByRole("button", { name: "检查更新", exact: true }).click();
		await expect(page.locator("html")).toHaveAttribute("data-update-action", "check");
	});
}

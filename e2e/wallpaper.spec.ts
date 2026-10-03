import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";
let webUrl: string;
// Each case owns its gateway database: a chat created in one case must not
// become another case's auto-restored session after reload.
test.beforeEach(async () => {
	webUrl = await startWebApp();
});
test.afterEach(stopWebApp);

test("wallpaper strength controls the actual veil without a hidden minimum", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "青绿极光", exact: true }).click();
	const strength = page.getByRole("slider", { name: "背景强度", exact: true });
	const veilAlpha = () =>
		page.locator(".wallpaper-veil").evaluate((element) => {
			const context = document.createElement("canvas").getContext("2d")!;
			context.fillStyle = getComputedStyle(element).backgroundColor;
			context.fillRect(0, 0, 1, 1);
			return context.getImageData(0, 0, 1, 1).data[3]! / 255;
		});
	for (const mode of ["深色", "浅色"]) {
		await page.locator(".theme-settings").getByRole("button", { name: mode, exact: true }).click();
		for (const [value, alpha] of [
			[100, 0],
			[60, 0.4],
			[10, 0.9],
		] as const) {
			await strength.fill(String(value));
			await expect.poll(veilAlpha).toBeCloseTo(alpha, 2);
			// The preview gradient must use the exact same veil colour/alpha as the full window.
			const colour = await page.locator(".wallpaper-veil").evaluate((e) => getComputedStyle(e).backgroundColor);
			await expect(page.locator(".wallpaper-preview-art")).toHaveCSS(
				"background-image",
				new RegExp(colour.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			);
		}
	}
	await strength.fill("100");
	await page.getByText("高级调整", { exact: true }).click();
	await expect(page.getByRole("slider", { name: "背景遮罩", exact: true })).toHaveValue("0");
	await page.getByRole("slider", { name: "背景遮罩", exact: true }).fill("25");
	await expect(strength).toHaveValue("75");
	await expect.poll(veilAlpha).toBeCloseTo(0.25, 2);
	await strength.fill("100");
	await page.reload();
	await expect.poll(veilAlpha).toBe(0);
	await expect(page.locator(".composer")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("background sync, scene separation and unavailable storage", async ({ page, context }) => {
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "暮色流光", exact: true }).click();
	await page.getByText("高级调整", { exact: true }).click();
	await page.getByRole("slider", { name: "背景模糊" }).fill("6");
	await expect(page.locator(".wallpaper-art")).toHaveCSS("filter", "blur(6px)");
	const second = await context.newPage();
	await openApp(second, webUrl);
	await expect(second.locator(".wallpaper-art")).toHaveCSS("filter", "blur(6px)");
	await expect(second.locator(".app-shell")).toHaveAttribute("data-wallpaper-scene", "home");
	await second.getByRole("tab", { name: "文件", exact: true }).click();
	await expect(second.locator(".app-shell")).toHaveAttribute("data-wallpaper-scene", "work");
	await page.getByRole("button", { name: "无背景", exact: true }).click();
	await expect(second.locator(".app-shell")).toHaveAttribute("data-wallpaper", "false");
	await second.close();
	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key === "wuming.appearance.background.v1") throw new DOMException("Blocked", "QuotaExceededError");
			original.call(this, key, value);
		};
	});
	await page.getByRole("button", { name: "青绿极光", exact: true }).click();
	await expect(page.locator(".wallpaper-settings").getByRole("alert")).toContainText("无法保存");
	await expect(page.locator(".app-shell")).toHaveAttribute("data-wallpaper", "true");
});

test("global material reaches work views, dialogs and terminal and resets cleanly", async ({ page }, info) => {
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "浅色", exact: true }).click();
	await page.getByRole("button", { name: "青绿极光", exact: true }).click();
	await expect(page.locator(".settings-dialog")).toHaveCSS("backdrop-filter", /blur/);
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	for (const [name, selector] of [
		["文件", ".code-workbench"],
		["Agent Teams", ".teams-workbench"],
		["MCP", ".mcp-workbench"],
	] as const) {
		await page.getByRole("tab", { name, exact: true }).click();
		await expect(page.locator(selector)).toBeVisible();
		await expect(page.locator(selector)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await page.screenshot({ path: info.outputPath(`${name}-global.png`) });
	}
	await page.getByRole("tab", { name: "终端", exact: true }).click();
	await expect(page.locator(".xterm-scrollable-element")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(page.locator(".xterm-viewport")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(page.locator(".terminal-heading")).toHaveCSS(
		"color",
		await page.locator("body").evaluate((element) => getComputedStyle(element).color)
	);
	await page.screenshot({ path: info.outputPath("terminal-global.png") });
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "恢复默认背景" }).click();
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(page.locator(".xterm-scrollable-element")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(page.locator("html")).not.toHaveAttribute("data-wallpaper");
});

test("adaptive colours follow images and system mode without replacing classic preferences", async ({ page }, info) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.emulateMedia({ colorScheme: "light" });
	await openApp(page, webUrl);
	const accent = () => page.locator("html").evaluate((e) => getComputedStyle(e).getPropertyValue("--green").trim());
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "跟随系统", exact: true }).click();
	const original = await accent();
	const saved = await page.evaluate(() => localStorage.getItem("wuming.theme.palettes"));
	const colours: string[] = [];
	for (const [name, colour] of [
		["bright", "#e5af75"],
		["dark", "#183867"],
		["detailed", "#964bab"],
	] as const) {
		const data = await page.evaluate(
			({ colour, name }) => {
				const c = document.createElement("canvas");
				c.width = 800;
				c.height = 450;
				const ctx = c.getContext("2d")!;
				ctx.fillStyle = colour;
				ctx.fillRect(0, 0, 800, 450);
				if (name === "detailed")
					for (let x = 0; x < 800; x += 20) {
						ctx.fillStyle = x % 40 ? "#eee4d4" : "#121522";
						ctx.fillRect(x, 0, 8, 450);
					}
				return c.toDataURL().split(",")[1]!;
			},
			{ colour, name }
		);
		await page
			.locator(".wallpaper-upload input")
			.setInputFiles({ name: `${name}.png`, mimeType: "image/png", buffer: Buffer.from(data, "base64") });
		await expect(page.locator(".wallpaper-art")).toHaveCSS("background-image", /blob:/);
		await expect.poll(accent).not.toBe(colours.at(-1) ?? original);
		colours.push(await accent());
		await expect(page.locator(".theme-palette-group")).toHaveCount(0);
		await page.screenshot({ path: info.outputPath(`${name}-settings.png`) });
	}
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("请简要说明这个项目的工作方式。");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".message-row.assistant").first()).toBeVisible();
	await page.screenshot({ path: info.outputPath("adaptive-chat-light.png") });
	await page.emulateMedia({ colorScheme: "dark" });
	await expect.poll(accent).not.toBe(colours.at(-1));
	await page.screenshot({ path: info.outputPath("adaptive-chat-dark.png") });
	await page.getByRole("tab", { name: "终端", exact: true }).click();
	await expect(page.locator(".xterm-viewport")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "无背景", exact: true }).click();
	await page.emulateMedia({ colorScheme: "light" });
	await expect.poll(accent).toBe(original);
	expect(await page.evaluate(() => localStorage.getItem("wuming.theme.palettes"))).toBe(saved);
	await expect(page.locator(".theme-palette-group")).toHaveCount(2);
});

test("wallpaper spans desktop chrome outside the contained app", async ({ page }, info) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.addInitScript(
		({ url, password }) => {
			localStorage.setItem("wuming.desktop.welcome.complete", "true");
			window.wumingDesktop = {
				windowChrome: true,
				connect: async () => ({ token: password, websocketUrl: url.replace("http:", "ws:") + "api/ws" }),
			};
		},
		{ url: webUrl, password: token }
	);
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "暮色流光", exact: true }).click();
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(page.locator(".desktop-titlebar")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(page.locator(".desktop-content .wallpaper-layer")).toHaveCount(0);
	await expect(page.locator("body > .wallpaper-layer")).toHaveCSS("position", "fixed");
	expect(await page.locator(".wallpaper-layer").boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
	await page.screenshot({ path: info.outputPath("desktop-chrome-wallpaper.png") });
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "无背景", exact: true }).click();
	await expect(page.locator(".desktop-titlebar")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

for (const width of [1440, 390]) {
	test(`wallpaper controls, import, persistence and reset at ${width}`, async ({ page }, info) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		await openApp(page, webUrl);
		if (width === 390) await page.locator(".mobile-menu").click();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		const settings = page.locator(".wallpaper-settings");
		await settings.getByRole("button", { name: "青绿极光", exact: true }).click();
		await expect(page.locator(".app-shell")).toHaveAttribute("data-wallpaper", "true");
		await settings.getByRole("checkbox").check();
		await expect(page.locator(".wallpaper-art")).toHaveAttribute("data-moving", "true");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect(page.locator(".wallpaper-art")).toHaveCSS("animation-name", "none");
		await settings.getByRole("slider", { name: "背景强度", exact: true }).fill("75");
		await settings.getByText("高级调整", { exact: true }).click();
		const upload = settings.locator('input[type="file"]');
		await upload.setInputFiles({
			name: "bad.svg",
			mimeType: "image/svg+xml",
			buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
		});
		await expect(settings.getByRole("alert")).toContainText("仅支持");
		await expect(settings.getByRole("button", { name: "青绿极光", exact: true })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		await upload.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
		await expect(settings.getByRole("alert")).toContainText("图片导入失败");
		const data = await page.evaluate(() => {
			const canvas = document.createElement("canvas");
			canvas.width = 900;
			canvas.height = 300;
			const ctx = canvas.getContext("2d")!;
			const gradient = ctx.createLinearGradient(0, 0, 900, 0);
			gradient.addColorStop(0, "#172942");
			gradient.addColorStop(1, "#88bfaf");
			ctx.fillStyle = gradient;
			ctx.fillRect(0, 0, 900, 300);
			// A landscape with recognisable contours catches discontinuous image tiling
			// and opaque chrome much more reliably than a flat colour fixture.
			ctx.fillStyle = "#f6d4aa";
			ctx.beginPath();
			ctx.arc(710, 65, 32, 0, Math.PI * 2);
			ctx.fill();
			for (const [y, color] of [
				[130, "#638c99"],
				[175, "#416b79"],
				[230, "#244957"],
			] as const) {
				ctx.fillStyle = color;
				ctx.beginPath();
				ctx.moveTo(0, 300);
				for (let x = 0; x <= 900; x += 30) ctx.lineTo(x, y + Math.sin(x / 105 + y) * 35 + Math.cos(x / 45) * 12);
				ctx.lineTo(900, 300);
				ctx.closePath();
				ctx.fill();
			}
			return canvas.toDataURL("image/png").split(",")[1]!;
		});
		await upload.setInputFiles({ name: "landscape.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") });
		await expect(settings.getByRole("button", { name: "自定义壁纸", exact: true })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		await expect(page.locator(".wallpaper-art")).toHaveCSS("background-image", /blob:/);
		await settings.getByRole("slider", { name: "水平焦点" }).fill("76");
		await expect(page.locator(".wallpaper-art")).toHaveCSS("background-position", "76% 50%");
		await settings.screenshot({ path: info.outputPath("wallpaper-settings.png") });
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.reload();
		await expect(page.locator(".wallpaper-art")).toHaveCSS("background-image", /blob:/);
		await expect(page.locator(".wallpaper-art")).toHaveCSS("background-position", "76% 50%");
		await page.getByRole("button", { name: "新对话", exact: true }).filter({ visible: true }).click();
		await page.screenshot({ path: info.outputPath("wallpaper-workbench.png") });
		// Four formerly opaque regions must now share one window-level background.
		await expect(page.locator("body > .wallpaper-layer")).toHaveCount(1);
		for (const selector of [".workspace-main", ".topbar", ".empty-state"]) {
			await expect(page.locator(selector)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		}
		const composerAlpha = await page.locator(".composer").evaluate((element) => {
			const pixel = document.createElement("canvas").getContext("2d")!;
			pixel.fillStyle = getComputedStyle(element).backgroundColor;
			pixel.fillRect(0, 0, 1, 1);
			return pixel.getImageData(0, 0, 1, 1).data[3]! / 255;
		});
		expect(composerAlpha).toBeGreaterThan(0.3);
		expect(composerAlpha).toBeLessThan(0.65);
		await page.getByRole("button", { name: "切换深浅主题" }).click();
		await page.screenshot({ path: info.outputPath("wallpaper-dark.png") });
		if (width === 390) await page.locator(".mobile-menu").click();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await settings.getByRole("button", { name: "恢复默认背景" }).click();
		await expect(page.locator(".app-shell")).toHaveAttribute("data-wallpaper", "false");
		await expect(page.locator(".wallpaper-layer")).toHaveCount(0);
		await expect(page.locator("html")).not.toHaveAttribute("data-wallpaper");
		await expect(page.locator(".composer")).not.toHaveCSS("backdrop-filter", /blur/);
		expect(errors).toEqual([]);
	});
}

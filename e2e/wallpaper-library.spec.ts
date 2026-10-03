import { expect, test, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeEach(async () => {
	webUrl = await startWebApp();
});
test.afterEach(stopWebApp);

async function upload(page: Page, name: string, color: string, succeeds = true) {
	const data = await page.evaluate((color) => {
		const canvas = document.createElement("canvas");
		canvas.width = 600;
		canvas.height = 360;
		const ctx = canvas.getContext("2d")!;
		const gradient = ctx.createLinearGradient(0, 0, 600, 360);
		gradient.addColorStop(0, color);
		gradient.addColorStop(1, "#172637");
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, 600, 360);
		return canvas.toDataURL().split(",")[1]!;
	}, color);
	const chooserPromise = page.waitForEvent("filechooser");
	const add = page.getByRole("button", { name: "添加壁纸", exact: true });
	await add.focus();
	await add.press("Enter");
	const chooser = await chooserPromise;
	await chooser.setFiles({ name, mimeType: "image/png", buffer: Buffer.from(data, "base64") });
	if (succeeds)
		await expect(page.getByRole("button", { name: `使用壁纸：${name}`, exact: true })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
}

for (const width of [1440, 390]) {
	test(`library persists, switches, confirms deletion and resets at ${width}`, async ({ page, context }, info) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		await openApp(page, webUrl);
		if (width === 390) await page.getByRole("button", { name: "打开导航", exact: true }).click();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await upload(page, "海边日落.png", "#db9860");
		await upload(page, "森林中的清晨与很长很长的文件名称.png", "#45ae8c");
		await expect(page.locator(".wallpaper-library-card")).toHaveCount(2);
		await page.getByRole("button", { name: "使用壁纸：海边日落.png", exact: true }).click();
		await expect(page.getByRole("button", { name: "使用壁纸：海边日落.png", exact: true })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		await page.locator(".wallpaper-library").screenshot({ path: info.outputPath("library-light.png") });
		await page.locator(".wallpaper-upload").screenshot({ path: info.outputPath("upload-light.png") });
		await page.getByRole("button", { name: "深色", exact: true }).click();
		await page.locator(".wallpaper-library").screenshot({ path: info.outputPath("library-dark.png") });
		await page.locator(".wallpaper-upload").screenshot({ path: info.outputPath("upload-dark.png") });
		expect(await page.locator(".wallpaper-upload").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
		await page.reload();
		await expect(page.locator(".wallpaper-art")).toHaveCSS("background-image", /blob:/);
		if (width === 390) await page.getByRole("button", { name: "打开导航", exact: true }).click();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await expect(page.locator(".wallpaper-library-card")).toHaveCount(2);
		await expect(page.getByRole("button", { name: "使用壁纸：海边日落.png", exact: true })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		const second = await context.newPage();
		await openApp(second, webUrl);
		await second.getByRole("button", { name: "设置", exact: true }).click();
		await expect(second.locator(".wallpaper-library-card")).toHaveCount(2);
		await page.getByRole("button", { name: "删除壁纸：海边日落.png", exact: true }).click();
		await expect(page.getByText("删除后将切换为无背景。", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "取消", exact: true }).click();
		await expect(page.locator(".wallpaper-library-card")).toHaveCount(2);
		await page.getByRole("button", { name: "删除壁纸：森林中的清晨与很长很长的文件名称.png", exact: true }).click();
		await page.getByRole("button", { name: "确认删除", exact: true }).click();
		await expect(second.locator(".wallpaper-library-card")).toHaveCount(1);
		await expect(page.getByRole("button", { name: "使用壁纸：海边日落.png", exact: true })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		await page.getByRole("button", { name: "恢复默认背景", exact: true }).click();
		await expect(page.locator(".wallpaper-layer")).toHaveCount(0);
		await expect(page.locator(".wallpaper-library-card")).toHaveCount(1);
		await page.getByRole("button", { name: "使用壁纸：海边日落.png", exact: true }).click();
		await page.getByRole("button", { name: "删除壁纸：海边日落.png", exact: true }).click();
		await page.getByRole("button", { name: "确认删除", exact: true }).click();
		await expect(page.locator(".wallpaper-library-card")).toHaveCount(0);
		await expect(second.locator(".wallpaper-library-card")).toHaveCount(0);
		await expect(second.locator(".wallpaper-layer")).toHaveCount(0);
		await expect(page.locator(".theme-palette-group")).toHaveCount(2);
		await page.reload();
		await expect(page.locator(".wallpaper-layer")).toHaveCount(0);
		await second.close();
		expect(errors).toEqual([]);
	});
}

test("library limit and failed writes do not replace saved images", async ({ page }) => {
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await upload(page, "saved.png", "#71aacc");
	await page.evaluate(() => {
		IDBObjectStore.prototype.add = function () {
			throw new DOMException("Full", "QuotaExceededError");
		};
	});
	await upload(page, "failed.png", "#aabbcc", false);
	await expect(page.locator(".wallpaper-error")).toContainText("图片导入失败");
	await expect(page.locator(".wallpaper-library-card")).toHaveCount(1);
	await page.reload();
	await page.evaluate(async () => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open("wuming-appearance", 1);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction("images", "readwrite");
				const store = tx.objectStore("images");
				const all = store.getAll();
				all.onsuccess = () => {
					for (let i = 1; i < 24; i++)
						store.put({ ...all.result[0], id: `seed-${i}`, name: `seed-${i}.png` }, `seed-${i}`);
				};
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
		});
	});
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(page.locator(".wallpaper-library-card")).toHaveCount(24);
	await upload(page, "over-limit.png", "#ccccaa", false);
	await expect(page.locator(".wallpaper-error")).toContainText("最多保存 24 张");
	await expect(page.locator(".wallpaper-library-card")).toHaveCount(24);
	await expect(page.getByRole("button", { name: "使用壁纸：saved.png", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true"
	);
});

test("migrates the legacy image and preserves it when import or deletion fails", async ({ page }) => {
	await openApp(page, webUrl);
	await page.evaluate(async () => {
		const c = document.createElement("canvas");
		c.width = c.height = 8;
		const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), "image/png"));
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open("wuming-appearance", 1);
			request.onupgradeneeded = () => request.result.createObjectStore("images");
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction("images", "readwrite");
				tx.objectStore("images").put(blob, "custom");
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
		});
		localStorage.setItem(
			"wuming.appearance.background.v1",
			JSON.stringify({ version: 1, kind: "image", imageRevision: "old-revision", focusX: 76 })
		);
	});
	await page.reload();
	await expect(page.locator(".wallpaper-art")).toHaveCSS("background-position", "76% 50%");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(page.getByRole("button", { name: "使用壁纸：原有壁纸", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true"
	);
	await page
		.locator(".wallpaper-upload input")
		.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("invalid") });
	await expect(page.locator(".wallpaper-error")).toContainText("图片导入失败");
	await expect(page.locator(".wallpaper-library-card")).toHaveCount(1);
	await page.evaluate(() => {
		IDBObjectStore.prototype.delete = function () {
			throw new DOMException("Blocked", "UnknownError");
		};
	});
	await page.getByRole("button", { name: "删除壁纸：原有壁纸", exact: true }).click();
	await page.getByRole("button", { name: "确认删除", exact: true }).click();
	await expect(page.locator(".wallpaper-error")).toContainText("删除失败");
	await expect(page.locator(".wallpaper-library-card")).toHaveCount(1);
	await expect(page.locator(".wallpaper-art")).toHaveCSS("background-image", /blob:/);
});

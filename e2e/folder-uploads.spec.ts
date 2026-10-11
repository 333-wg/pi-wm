import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";
let webUrl: string;
test.beforeEach(async () => { webUrl = await startWebApp({ WUMING_DEPLOYMENT_MODE: "local_device" }); });
test.afterEach(async () => { await stopWebApp(); });
for (const width of [1440, 390]) {
	test(`references a large local directory and sends it with ordinary files at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		await openApp(page, webUrl);
		const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
		const folder = testInfo.outputPath("测试目录"); await mkdir(folder, { recursive: true });
		await Promise.all(Array.from({ length: 2100 }, (_, i) => writeFile(join(folder, `${i}.txt`), `proof ${i}`)));
		// Component regression: emulate the desktop path bridge; native drops are covered by verify-desktop-attachments.mjs.
		const dropFolder = () => page.evaluate((path) => {
			Object.defineProperty(window, "wumingDesktop", { configurable: true, value: { pathForFile: () => path } });
			const transfer = new DataTransfer();
			transfer.items.add(new File([], "测试目录"));
			const item = transfer.items[0]!;
			Object.defineProperty(item, "webkitGetAsEntry", { value: () => ({ isDirectory: true, name: "测试目录" }) });
			// Chromium returns fresh item wrappers; retain the one carrying the directory stub.
			Object.defineProperty(transfer, "items", { value: [item] });
			document.querySelector(".composer")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		}, folder);
		await expect(page.getByRole("button", { name: "引用本机文件夹（只读，不打包）", exact: true })).toHaveCount(0);
		const response = page.waitForResponse(r => r.url().endsWith("/directory-attachments") && r.status() === 201);
		await dropFolder();
		const artifact = (await (await response).json()).artifact;
		expect(artifact.name).toBe("测试目录.directory.json"); expect(artifact.size).toBeLessThan(2048);
		const download = await page.request.get(new URL(`/api/artifacts/${artifact.id}`, webUrl).href, { headers: { Authorization: `Bearer ${token}` } });
		expect(artifact.mimeType).toBe("text/x-wuming-directory");
		expect(await download.json()).toMatchObject({ type: "local_directory_reference", tool: "directory_read", access: "read_only" });
		const card = page.locator(".attachment-directory");
		await expect(card).toContainText("测试目录");
		await expect(card).toContainText("文件夹 · 只读引用");
		await expect(card).not.toContainText(".directory.json");
		await card.getByRole("button", { name: "移除 测试目录", exact: true }).click();
		await expect(card).toHaveCount(0);
		await dropFolder();
		await expect(card).toHaveCount(1);
		await page.getByLabel("选择附件", { exact: true }).setInputFiles({ name: "file.txt", mimeType: "text/plain", buffer: Buffer.from("normal file") });
		await expect(page.locator(".attachment-chip")).toHaveCount(2);
		await page.screenshot({ path: testInfo.outputPath("directory-reference.png") });
		expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.locator(".attachment-chip")).toHaveCount(0);
		await expect(page.locator(".transcript")).toContainText("测试目录");
		await expect(page.locator(".transcript .artifact-line").filter({ hasText: "测试目录" })).not.toContainText(".directory.json");
		await expect(page.getByRole("alert")).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

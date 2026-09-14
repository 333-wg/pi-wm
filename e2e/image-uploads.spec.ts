import { expect, test, type APIResponse } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const width of [1365, 390]) {
	test("uploads local images with inaccurate types at " + width + "px", async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		const uploads: APIResponse[] = [];
		await page.route("**/api/workspaces/*/artifacts", async (route) => {
			const response = await route.fetch();
			await route.fulfill({ response });
			uploads.push(response);
		});
		const images = await page.evaluate(() => {
			const canvas = document.createElement("canvas");
			canvas.width = 32;
			canvas.height = 24;
			const context = canvas.getContext("2d")!;
			context.fillStyle = "#de4455";
			context.fillRect(0, 0, 32, 24);
			context.fillStyle = "#29ac89";
			context.fillRect(8, 8, 16, 8);
			return {
				png: canvas.toDataURL("image/png").split(",")[1]!,
				jpeg: canvas.toDataURL("image/jpeg").split(",")[1]!,
				webp: canvas.toDataURL("image/webp").split(",")[1]!,
			};
		});
		const cases = [
			{
				name: "微信图片_20260813113901_55_3.jpg",
				content: Buffer.concat([Buffer.from(images.jpeg, "base64"), Buffer.from("export metadata")]),
				mimeType: "image/jpeg",
			},
			{ name: "本地截图.jpg", content: Buffer.from(images.png, "base64"), mimeType: "image/png" },
			{ name: "local-image.bin", content: Buffer.from(images.webp, "base64"), mimeType: "image/webp" },
		];
		await mkdir(testInfo.outputDir, { recursive: true });
		for (const item of cases) {
			const path = testInfo.outputPath(item.name);
			await writeFile(path, item.content);
			const uploadIndex = uploads.length;
			// Use an actual local path, allowing the browser to infer File.type.
			await page.getByLabel("选择附件").setInputFiles(path);
			await expect.poll(() => uploads.length).toBe(uploadIndex + 1);
			const response = uploads[uploadIndex]!;
			expect(response.status(), await response.text()).toBe(201);
			const { artifact } = await response.json();
			expect(artifact).toMatchObject({ name: item.name, mimeType: item.mimeType, size: item.content.length });
			await expect(page.locator(".attachment-chip").getByText(item.name, { exact: true })).toBeVisible();
			const download = await page.request.get(new URL("/api/artifacts/" + artifact.id, webUrl).href, {
				headers: { Authorization: "Bearer " + token },
			});
			expect(download.status()).toBe(200);
			expect(download.headers()["content-type"]).toBe(item.mimeType);
			expect(await download.body()).toEqual(item.content);
			expect(
				await page.evaluate(
					async ({ encoded, mimeType }) => {
						const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
						const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
						const dimensions = [bitmap.width, bitmap.height];
						bitmap.close();
						return dimensions;
					},
					{ encoded: (await download.body()).toString("base64"), mimeType: item.mimeType }
				)
			).toEqual([32, 24]);
		}

		const dataTransfer = await page.evaluateHandle((encoded) => {
			const transfer = new DataTransfer();
			const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
			transfer.items.add(new File([bytes], "dragged-image.jpg", { type: "" }));
			return transfer;
		}, images.png);
		await page.locator(".composer").dispatchEvent("drop", { dataTransfer });
		await expect(page.locator(".attachment-chip").getByText("dragged-image.jpg", { exact: true })).toBeVisible();
		await dataTransfer.dispose();
		await expect(page.locator(".attachment-error")).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath("local-image-uploads.png") });

		await page.getByLabel("选择附件").setInputFiles({
			name: "broken.jpg",
			mimeType: "image/jpeg",
			buffer: Buffer.from(images.jpeg, "base64").subarray(0, -2),
		});
		await expect(page.locator(".attachment-error")).toContainText("broken.jpg");
		await expect(page.locator(".attachment-chip")).toHaveCount(4);
	});
}

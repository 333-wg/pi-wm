import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeEach(async () => {
	webUrl = await startWebApp();
});
test.afterEach(async () => {
	await stopWebApp();
});

async function imageFile(page: Page, name: string) {
	const encoded = await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		canvas.width = 480;
		canvas.height = 640;
		const ctx = canvas.getContext("2d")!;
		ctx.fillStyle = "#f3f6f4";
		ctx.fillRect(0, 0, 480, 640);
		ctx.fillStyle = "#217a54";
		ctx.fillRect(120, 100, 240, 420);
		ctx.fillStyle = "#f9db64";
		ctx.fillRect(150, 150, 180, 100);
		ctx.fillStyle = "#de4455";
		ctx.fillRect(150, 320, 180, 36);
		return canvas.toDataURL().split(",")[1]!;
	});
	return { name, mimeType: "image/png", buffer: Buffer.from(encoded, "base64") };
}

async function loaded(images: Locator, count: number) {
	await expect(images).toHaveCount(count);
	await expect
		.poll(() =>
			images.evaluateAll((elements) =>
				elements.every((element) => {
					const image = element as HTMLImageElement;
					return image.complete && image.naturalWidth > 0;
				})
			)
		)
		.toBe(true);
}

for (const width of [1365, 390, 320]) {
	test(
		"renders draft previews and right-aligned image-first messages at " + width + "px",
		async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: 1000 });
			await openApp(page, webUrl);
			const input = page.getByRole("textbox", { name: "消息", exact: true });
			const send = page.getByRole("button", { name: "发送", exact: true });
			const image = await imageFile(page, "参考图.png");
			await page
				.getByLabel("选择附件")
				.setInputFiles([
					image,
					{ ...image, name: "细节图.png" },
					{ ...image, name: "产品包装图.png" },
					{ name: "requirements.txt", mimeType: "text/plain", buffer: Buffer.from("keep the original product") },
				]);
			await loaded(page.locator(".attachment-image img"), 3);
			await expect(page.locator(".attachment-chip")).toHaveCount(4);
			const previewBox = (await page.locator(".attachment-image").last().boundingBox())!;
			const inputBox = (await input.boundingBox())!;
			expect(previewBox.y + previewBox.height).toBeLessThanOrEqual(inputBox.y);
			await page.getByRole("button", { name: "移除 requirements.txt", exact: true }).click();
			await input.fill("请根据这几张参考图制作电商主图，保留产品细节，使用干净的背景。");
			const thumbnail = page.locator(".attachment-image .image-thumbnail").first();
			await thumbnail.click();
			const viewer = page.getByRole("dialog", { name: "预览 参考图.png", exact: true });
			await expect(viewer).toBeVisible();
			await loaded(viewer.locator("img"), 1);
			await page.keyboard.press("Escape");
			await expect(viewer).toHaveCount(0);
			await expect(thumbnail).toBeFocused();
			await page.screenshot({ path: testInfo.outputPath("draft-image-previews.png") });
			await send.click();
			await expect(page.locator(".attachment-chip")).toHaveCount(0);
			const user = page.locator(".message-row.user").first();
			const assistant = page.locator(".message-row.assistant").first();
			await expect(assistant).toContainText("Demo runtime received:");
			await loaded(user.locator("img"), 3);
			const bubble = user.locator(".user-message-bubble");
			await expect(bubble).toContainText("保留产品细节");
			const galleryBox = (await user.locator(".user-message-images").boundingBox())!;
			const bubbleBox = (await bubble.boundingBox())!;
			const userBox = (await user.boundingBox())!;
			const assistantBox = (await assistant.locator(".message-avatar").boundingBox())!;
			expect(galleryBox.y + galleryBox.height).toBeLessThanOrEqual(bubbleBox.y);
			expect(Math.abs(bubbleBox.x + bubbleBox.width - userBox.x - userBox.width)).toBeLessThan(2);
			expect(assistantBox.x).toBeLessThan(bubbleBox.x);
			expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
			await page.screenshot({ path: testInfo.outputPath("image-first-conversation.png") });
			await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
			await page.screenshot({ path: testInfo.outputPath("image-first-conversation-dark.png") });
			await page.evaluate(() => (document.documentElement.dataset.theme = "light"));

			await user.locator(".image-thumbnail").first().click();
			await expect(viewer).toBeVisible();
			await viewer.getByRole("button", { name: "关闭预览", exact: true }).click();
			await user.hover();
			await user.getByRole("button", { name: "编辑并重新发送", exact: true }).click();
			await loaded(page.locator(".attachment-image img"), 3);
			await expect(input).toHaveValue("请根据这几张参考图制作电商主图，保留产品细节，使用干净的背景。");
			await page.getByRole("button", { name: "取消编辑", exact: true }).click();
			await expect(page.locator(".attachment-chip")).toHaveCount(0);

			await page.getByLabel("选择附件").setInputFiles(image);
			await loaded(page.locator(".attachment-image img"), 1);
			await send.click();
			const imageOnly = page.locator(".message-row.user").nth(1);
			await loaded(imageOnly.locator("img"), 1);
			await expect(imageOnly.locator(".user-message-bubble")).toHaveCount(0);
			await expect(imageOnly.getByRole("button", { name: "编辑并重新发送" })).toBeEnabled();

			const longText = "这是一条用于检查自动换行的消息。".repeat(14) + "x".repeat(180);
			await input.fill(longText);
			await send.click();
			const textOnly = page.locator(".message-row.user").nth(2);
			await expect(textOnly.locator(".user-message-bubble")).toHaveText(longText);
			await expect(textOnly.locator(".user-message-images")).toHaveCount(0);
			expect(
				await textOnly.locator(".user-message-bubble").evaluate((element) => element.scrollWidth <= element.clientWidth)
			).toBe(true);
			await expect(textOnly.getByRole("button", { name: "编辑并重新发送" })).toBeEnabled();
			await page.reload();
			await expect(page.locator(".message-row.user")).toHaveCount(3);
			await loaded(page.locator(".message-row.user img"), 4);
			await expect(page.locator(".user-message-bubble")).toHaveCount(2);
		}
	);
}

test("keeps the filename and removal available when a draft image cannot load", async ({ page }) => {
	await openApp(page, webUrl);
	await page.route("**/api/artifacts/*", (route) => route.abort());
	await page.getByLabel("选择附件").setInputFiles(await imageFile(page, "unavailable.png"));
	await expect(page.locator(".attachment-image").getByRole("alert")).toBeVisible();
	await expect(page.locator(".attachment-image")).toContainText("unavailable.png");
	await page.getByRole("button", { name: "移除 unavailable.png", exact: true }).click();
	await expect(page.locator(".attachment-chip")).toHaveCount(0);
});

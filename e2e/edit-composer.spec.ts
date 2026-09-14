import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const width of [1365, 390]) {
	test("edits through the existing composer at " + width + "px", async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		const composer = page.getByRole("textbox", { name: "消息", exact: true });
		const send = page.getByRole("button", { name: "发送", exact: true });
		await composer.fill("original prompt");
		await send.click();
		const firstEdit = page.locator(".message-row.user").first().getByRole("button", { name: "编辑并重新发送" });
		await expect(firstEdit).toBeEnabled();

		const image = await page.evaluate(() => {
			const canvas = document.createElement("canvas");
			canvas.width = 32;
			canvas.height = 24;
			const context = canvas.getContext("2d")!;
			context.fillStyle = "#de4455";
			context.fillRect(0, 0, 32, 24);
			return canvas.toDataURL("image/png").split(",")[1]!;
		});
		await page.getByLabel("选择附件").setInputFiles({
			name: "product.png",
			mimeType: "image/png",
			buffer: Buffer.from(image, "base64"),
		});
		await expect(page.locator(".attachment-chip")).toContainText("product.png");
		await composer.fill("image prompt");
		await send.click();
		const imagePrompt = page.locator(".message-row.user").nth(1);
		const edit = imagePrompt.getByRole("button", { name: "编辑并重新发送" });
		await expect(edit).toBeEnabled();

		await composer.fill("unsent draft");
		await page.getByLabel("选择附件").setInputFiles({
			name: "draft.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("draft attachment"),
		});
		await expect(page.locator(".attachment-chip")).toContainText("draft.txt");
		await imagePrompt.hover();
		await edit.click();
		await expect(composer).toHaveValue("image prompt");
		await expect(composer).toBeFocused();
		await expect(page.locator("textarea")).toHaveCount(1);
		await expect(page.locator(".message-editor")).toHaveCount(0);
		await expect(imagePrompt).toContainText("image prompt");
		await expect(page.locator(".attachment-chip")).toContainText("product.png");
		await composer.fill("discard this edit");
		await composer.press("Escape");
		await expect(composer).toHaveValue("unsent draft");
		await expect(page.locator(".attachment-chip")).toContainText("draft.txt");

		await imagePrompt.hover();
		await edit.click();
		await page.locator(".message-row.user").first().hover();
		await firstEdit.click();
		await expect(composer).toHaveValue("original prompt");
		await expect(page.locator(".attachment-chip")).toHaveCount(0);
		await page.getByRole("button", { name: "取消编辑", exact: true }).click();
		await expect(composer).toHaveValue("unsent draft");
		await expect(page.locator(".attachment-chip")).toContainText("draft.txt");

		await imagePrompt.hover();
		await edit.click();
		await composer.fill("edited image prompt");
		await page.screenshot({ path: testInfo.outputPath("edit-in-original-composer.png") });
		await send.click();
		await expect(page.locator(".message-row.user")).toHaveCount(2);
		await expect(page.locator(".message-row.user").nth(1)).toContainText("edited image prompt");
		await expect(
			page.locator(".message-row.user").nth(1).getByRole("img", { name: "product.png", exact: true })
		).toBeVisible();
		await expect(composer).toHaveValue("");
		await expect(page.locator(".attachment-chip")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "取消编辑", exact: true })).toHaveCount(0);
		await expect(firstEdit).toBeEnabled();
		await page.locator(".message-row.user").first().hover();
		await firstEdit.click();
		await composer.fill("edited first prompt");
		await composer.press("Enter");
		await expect(page.locator(".message-row.user")).toHaveCount(1);
		await expect(page.locator(".message-row.user").first()).toContainText("edited first prompt");
		await expect(firstEdit).toBeEnabled();
	});
}

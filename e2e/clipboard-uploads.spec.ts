import { expect, test, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
test.beforeEach(async () => {
	webUrl = await startWebApp();
});
test.afterEach(async () => {
	await stopWebApp();
});

async function pasteFiles(page: Page, names: string[], itemsOnly = false) {
	return page.getByRole("textbox", { name: "消息", exact: true }).evaluate(
		(input, args) => {
			const canvas = document.createElement("canvas");
			canvas.width = 32;
			canvas.height = 24;
			const context = canvas.getContext("2d")!;
			context.fillStyle = "#de4455";
			context.fillRect(0, 0, 32, 24);
			const bytes = Uint8Array.from(atob(canvas.toDataURL().split(",")[1]!), (c) => c.charCodeAt(0));
			const transfer = new DataTransfer();
			for (const name of args.names) transfer.items.add(new File([bytes], name, { type: "image/png" }));
			if (args.itemsOnly) Object.defineProperty(transfer, "files", { value: new DataTransfer().files });
			const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
			input.dispatchEvent(event);
			return event.defaultPrevented;
		},
		{ names, itemsOnly }
	);
}

for (const width of [1365, 390]) {
	test("pastes real clipboard images and text at " + width + "px", async ({ page, context }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await openApp(page, webUrl);
		await page.bringToFront();
		const input = page.getByRole("textbox", { name: "消息", exact: true });
		await input.fill("draft");
		await page.evaluate(async () => {
			const canvas = document.createElement("canvas");
			canvas.width = 32;
			canvas.height = 24;
			const ctx = canvas.getContext("2d")!;
			ctx.fillStyle = "#29ac89";
			ctx.fillRect(0, 0, 32, 24);
			const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!)));
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
		});
		await input.press("Control+End");
		await input.press("Control+v");
		await expect(page.locator(".attachment-chip")).toHaveCount(1);
		await expect
			.poll(() => page.locator(".attachment-image img").evaluate((image) => (image as HTMLImageElement).naturalWidth))
			.toBe(32);
		await expect(input).toHaveValue("draft");
		await expect(input).toBeFocused();
		await expect(page.locator(".attachment-error")).toHaveCount(0);

		await page.evaluate(async () => {
			const [item] = await navigator.clipboard.read();
			const blob = await item!.getType("image/png");
			await navigator.clipboard.write([
				new ClipboardItem({
					"image/png": blob,
					"text/plain": new Blob(["caption"], { type: "text/plain" }),
				}),
			]);
		});
		await input.selectText();
		await input.press("Control+v");
		await expect(page.locator(".attachment-chip")).toHaveCount(2);
		await expect(input).toHaveValue("caption");

		await page.evaluate(() => navigator.clipboard.writeText("plain text"));
		await input.selectText();
		await input.press("Control+v");
		await expect(input).toHaveValue("plain text");
		await expect(page.locator(".attachment-chip")).toHaveCount(2);
		await page.screenshot({ path: testInfo.outputPath("clipboard-attachments.png") });
		expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
		await page.locator(".attachment-remove").first().click();
		await expect(page.locator(".attachment-chip")).toHaveCount(1);
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.locator(".attachment-chip")).toHaveCount(0);
		await expect(input).toHaveValue("");
	});
}

test("supports item-only providers and limits multi-image pastes", async ({ page }) => {
	await openApp(page, webUrl);
	expect(await pasteFiles(page, ["item-only.png"], true)).toBe(true);
	await expect(page.locator(".attachment-chip")).toHaveCount(1);
	expect(
		await pasteFiles(
			page,
			Array.from({ length: 8 }, (_, i) => "batch-" + i + ".png")
		)
	).toBe(true);
	await expect(page.locator(".attachment-chip")).toHaveCount(8);
	await expect(page.getByRole("alert")).toContainText("每条消息最多添加 8 个附件");
	await pasteFiles(page, ["overflow.png"]);
	await expect(page.locator(".attachment-chip")).toHaveCount(8);
	await expect(page.locator(".attachment-chip").getByText("overflow.png")).toHaveCount(0);
});

test("shows pending and failed uploads and allows retry", async ({ page }) => {
	await openApp(page, webUrl);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/workspaces/*/artifacts", async (route) => {
		await pending;
		await route.fulfill({
			status: 500,
			contentType: "application/json",
			body: JSON.stringify({ error: "Upload failed" }),
		});
	});
	await pasteFiles(page, ["retry.png"]);
	await expect(page.locator(".uploading-label")).toBeVisible();
	await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
	await pasteFiles(page, ["busy.png"]);
	await expect(page.getByRole("alert")).toContainText("请等待当前上传或发送完成后");
	release();
	await expect(page.getByRole("alert")).toContainText("retry.png");
	await expect(page.locator(".uploading-label")).toHaveCount(0);
	await expect(page.locator(".attachment-chip")).toHaveCount(0);
	await page.unroute("**/api/workspaces/*/artifacts");
	await pasteFiles(page, ["retry.png"]);
	await expect(page.locator(".attachment-chip")).toHaveCount(1);
	await expect(page.locator(".attachment-error")).toHaveCount(0);
});

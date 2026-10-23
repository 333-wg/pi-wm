import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp } from "./harness.js";
let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp({
		WUMING_MODELS_JSON: JSON.stringify(
			["wuming-demo", "second-model"].map((id) => ({
				provider: "demo",
				id,
				name: id,
				reasoning: false,
				input: ["text"],
				contextWindow: 32000,
				maxOutputTokens: 8192,
				authenticated: true,
			}))
		),
	});
});
test.afterAll(async () => {
	await stopWebApp();
});

test("optimizes in place with selected model, preserves attachment, supports undo and manual send", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await openApp(page, webUrl);
	const box = page.getByRole("textbox", { name: "消息", exact: true });
	const optimize = page.getByRole("button", { name: "优化提示词", exact: true });
	await expect(optimize).toBeDisabled();
	await box.fill("/team 帮我开发");
	await expect(optimize).toBeDisabled();
	await box.fill("帮我检查登录，先别改代码");
	await page
		.getByLabel("选择附件")
		.setInputFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.from("context") });
	await expect(page.locator(".attachment-chip")).toContainText("context.txt");
	let request: Record<string, unknown> | undefined;
	let release!: () => void;
	await page.route("**/api/prompt/optimize", async (route) => {
		request = route.request().postDataJSON();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		await route.fulfill({ json: { text: "请分析登录流程的问题，说明判断依据。仅分析，不修改代码。" } });
	});
	await optimize.click();
	await expect(page.getByRole("button", { name: "取消优化" })).toBeVisible();
	await expect(box).toHaveAttribute("readonly", "");
	await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
	await expect(optimize).toBeDisabled();
	expect(request).toMatchObject({ text: "帮我检查登录，先别改代码", model: { provider: "demo", id: "wuming-demo" } });
	await page.screenshot({ path: testInfo.outputPath("optimizing.png") });
	release();
	await expect(box).toHaveValue("请分析登录流程的问题，说明判断依据。仅分析，不修改代码。");
	await expect(box).toBeFocused();
	await expect(page.locator(".message-row.user")).toHaveCount(0);
	await expect(page.locator(".attachment-chip")).toContainText("context.txt");
	await page.screenshot({ path: testInfo.outputPath("optimized.png") });
	await page.getByRole("button", { name: "撤销优化" }).click();
	await expect(box).toHaveValue("帮我检查登录，先别改代码");
	await optimize.click();
	await expect(page.getByRole("button", { name: "取消优化" })).toBeVisible();
	release();
	await expect(page.getByRole("button", { name: "撤销优化" })).toBeVisible();
	await box.fill("手动修改后的提示词");
	await expect(page.getByRole("button", { name: "撤销优化" })).toHaveCount(0);
	// Optimization itself must have no console/runtime errors. Ordinary Demo sends
	// independently reproduce an existing duplicate-key warning (baseline checked).
	expect(errors).toEqual([]);
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".message-row.user")).toContainText("手动修改后的提示词");
});

test("keeps original on failure and ignores cancelled late results", async ({ page }) => {
	await openApp(page, webUrl);
	const box = page.getByRole("textbox", { name: "消息", exact: true });
	const optimize = page.getByRole("button", { name: "优化提示词", exact: true });
	await box.fill("保留我的原文");
	await page.route("**/api/prompt/optimize", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
	await optimize.click();
	await expect(page.getByRole("alert").filter({ hasText: "原文已保留" })).toBeVisible();
	await expect(box).toHaveValue("保留我的原文");
	await page.unroute("**/api/prompt/optimize");
	let release!: () => void;
	await page.route("**/api/prompt/optimize", async (route) => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		await route.fulfill({ json: { text: "不能回填的旧结果" } }).catch(() => {});
	});
	await optimize.click();
	await page.getByRole("button", { name: "取消优化" }).click();
	await box.fill("取消后的新草稿");
	release();
	await expect(box).toHaveValue("取消后的新草稿");
	await expect(optimize).toBeEnabled();
	await expect(page.locator(".message-row.user")).toHaveCount(0);
	await optimize.click();
	await expect(page.getByRole("button", { name: "取消优化" })).toBeVisible();
	await page.locator(".thinking-trigger").click();
	await page.locator(".thinking-model-option").filter({ hasText: "second-model" }).click();
	await expect(page.getByRole("button", { name: "取消优化" })).toHaveCount(0);
	release();
	await expect(box).toHaveValue("取消后的新草稿");
	await page.unroute("**/api/prompt/optimize");
	let selected: unknown;
	await page.route("**/api/prompt/optimize", async (route) => {
		selected = route.request().postDataJSON().model;
		await route.fulfill({ json: { text: "使用新模型优化后的草稿" } });
	});
	await optimize.click();
	await expect(box).toHaveValue("使用新模型优化后的草稿");
	expect(selected).toEqual({ provider: "demo", id: "second-model" });
});

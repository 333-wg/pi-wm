import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openApp, restartGateway, startWebApp, stopWebApp } from "./harness.js";

let webUrl: string;
let relayUrl: string;
let relay: Server;
const requests: string[] = [];

test.beforeAll(async () => {
	relay = createServer((request, response) => {
		requests.push(request.url ?? "");
		const second = request.url === "/second/v1/models";
		if (
			(!second && request.url !== "/v1/models") ||
			request.headers.authorization !== (second ? "Bearer second-relay-key" : "Bearer mock-relay-key")
		) {
			response.writeHead(403).end();
			return;
		}
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				data: second
					? [
							{ id: "gpt-4o" },
							{ id: "gpt-image-2" },
							{ id: "second-image", output_modalities: ["image"] },
							{ id: "sora-2" },
							{ id: "second-video", output_modalities: ["video"] },
						]
					: [
							{ id: "gpt-4o" },
							{ id: "gpt-image-2" },
							{ id: "sora-2" },
							{ id: "opaque-image", output_modalities: ["image"] },
							{ id: "unknown" },
							{ id: "gpt-image-caption", output_modalities: ["text"] },
						],
			})
		);
	});
	await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
	relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}/v1`;
	webUrl = await startWebApp({ WUMING_RUNTIME: "pi" });
});

test.afterAll(async () => {
	await stopWebApp();
	if (relay) await new Promise<void>((resolve, reject) => relay.close((error) => (error ? reject(error) : resolve())));
});

test("classifies relay models, reuses credentials, and preserves categories after restart", async ({
	page,
}, testInfo) => {
	test.setTimeout(90000);
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^模型/ }).click();
	const custom = page.locator(".custom-model-settings");
	const media = page.locator(".media-model-settings");
	await custom.getByLabel("Base URL", { exact: true }).fill(relayUrl);
	await custom.getByLabel("API Key", { exact: true }).fill("mock-relay-key");
	await custom.getByRole("button", { name: "保存服务并获取模型" }).click();
	await expect(custom.getByLabel("模型类型：gpt-image-2", { exact: true })).toHaveValue("image");
	await expect(custom.getByLabel("模型类型：sora-2", { exact: true })).toHaveValue("video");
	await expect(custom.getByLabel("模型类型：opaque-image", { exact: true })).toHaveValue("image");
	await expect(custom.getByLabel("模型类型：gpt-image-caption", { exact: true })).toHaveValue("chat");
	await custom.getByLabel("模型类型：unknown", { exact: true }).selectOption("video");
	await custom.getByRole("button", { name: "选择未添加" }).click();
	await custom.getByRole("button", { name: "添加 6 个模型" }).click();
	await expect(custom.locator(".settings-success")).toHaveText("已添加 6 个模型");
	await expect(custom.locator(".custom-model-row:not(.custom-model-service-row) strong")).toHaveText([
		"gpt-4o",
		"gpt-image-caption",
	]);
	await expect(media.locator(".media-imported-models").first().locator(".custom-model-copy strong")).toHaveText([
		"gpt-image-2",
		"opaque-image",
	]);
	await expect(media.locator(".media-imported-models").nth(1).locator(".custom-model-copy strong")).toHaveText([
		"sora-2",
		"unknown",
	]);
	await expect(media.getByRole("button", { name: "启用默认模型：gpt-image-2", exact: true })).toBeDisabled();
	await expect(media.getByRole("button", { name: "启用默认模型：sora-2", exact: true })).toBeDisabled();
	await custom.getByRole("button", { name: "刷新并管理模型" }).click();
	await expect(custom.getByRole("checkbox", { name: "gpt-image-2", exact: true })).toBeDisabled();
	await expect(custom.getByRole("checkbox", { name: "unknown", exact: true })).toBeDisabled();
	await custom.getByRole("button", { name: "关闭模型列表" }).click();
	await media.getByLabel("模型类型：unknown", { exact: true }).selectOption("chat");
	await expect(custom.locator(".custom-model-copy strong").filter({ hasText: /^unknown$/ })).toBeVisible();
	const unknown = custom.locator(".custom-model-row").filter({ has: page.locator("strong", { hasText: /^unknown$/ }) });
	await unknown.getByRole("button", { name: "编辑模型" }).click();
	await custom.locator(".custom-model-edit").getByLabel("模型类型", { exact: true }).selectOption("image");
	await custom.getByRole("button", { name: "保存修改" }).click();
	await expect(media.getByLabel("模型类型：unknown", { exact: true })).toHaveValue("image");
	await expect(media.getByRole("button", { name: "启用默认模型：gpt-image-2", exact: true })).toBeDisabled();
	await custom.locator("summary").filter({ hasText: "添加模型服务" }).click();
	await custom.getByLabel("Base URL", { exact: true }).fill(new URL("/second/v1", relayUrl).href);
	await custom.getByLabel("API Key", { exact: true }).fill("second-relay-key");
	await custom.getByRole("button", { name: "保存服务并获取模型" }).click();
	await expect(custom.getByRole("checkbox", { name: "gpt-image-2", exact: true })).toBeEnabled();
	await custom.getByRole("button", { name: "选择未添加" }).click();
	await custom.getByRole("button", { name: "添加 5 个模型" }).click();
	const chatRows = custom.locator(".custom-model-row:not(.custom-model-service-row)");
	await expect(
		chatRows.filter({ has: page.locator("strong", { hasText: /^gpt-4o$/ }) }).locator(".custom-model-source")
	).toHaveText([`模型服务：${relayUrl}`, `模型服务：${new URL("/second/v1", relayUrl).href}`]);
	await expect(media.locator(".media-imported-models").first().locator(".custom-model-row")).toHaveCount(5);
	await page.getByRole("dialog", { name: "设置" }).getByRole("button", { name: "关闭", exact: true }).click();
	const trigger = page.locator(".thinking-trigger");
	await trigger.click();
	const duplicateOptions = page
		.locator(".thinking-model-option")
		.filter({ has: page.locator("strong", { hasText: /^gpt-4o$/ }) });
	const firstSource = relayUrl.replace("http://", "");
	const secondSource = new URL("/second/v1", relayUrl).href.replace("http://", "");
	await expect(duplicateOptions.locator(".thinking-model-option-source")).toHaveText([
		`模型服务：${firstSource}`,
		`模型服务：${secondSource}`,
	]);
	await duplicateOptions.nth(1).click();
	await expect(duplicateOptions.nth(1)).toHaveAttribute("aria-checked", "true");
	await expect(trigger).not.toContainText(secondSource);
	await expect(trigger).not.toHaveAttribute("aria-label", /second\/v1/);
	await duplicateOptions.nth(0).click();
	await expect(duplicateOptions.nth(0)).toHaveAttribute("aria-checked", "true");
	await expect(trigger).not.toContainText(firstSource);
	await expect(trigger.locator(".thinking-trigger-source")).toHaveCount(0);
	for (const [width, height] of [
		[1440, 900],
		[390, 844],
	]) {
		await page.setViewportSize({ width: width!, height: height! });
		const menu = await page.locator(".thinking-menu").boundingBox();
		expect(menu!.x).toBeGreaterThanOrEqual(0);
		expect(menu!.x + menu!.width).toBeLessThanOrEqual(width!);
		await page.screenshot({ path: testInfo.outputPath(`model-source-picker-${width}.png`) });
	}
	await page.keyboard.press("Escape");
	await page.reload();
	await expect(trigger.locator(".thinking-trigger-label")).toHaveText("gpt-4o");
	await trigger.click();
	await expect(duplicateOptions.nth(0)).toHaveAttribute("aria-checked", "true");
	await expect(duplicateOptions.nth(0).locator(".thinking-model-option-source")).toHaveText(`模型服务：${firstSource}`);
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^模型/ }).click();
	const defaults = media.getByRole("button", { name: "启用默认模型：gpt-image-2", exact: true });
	await expect(defaults.nth(0)).toBeDisabled();
	await defaults.nth(1).click();
	await expect(defaults.nth(1)).toBeDisabled();
	await expect(defaults.nth(0)).toBeEnabled();
	await expect(media.locator("form").filter({ hasText: "默认生图模型" })).toHaveCount(0);
	const videoDefaults = media.getByRole("button", { name: "启用默认模型：sora-2", exact: true });
	await expect(media.locator(".media-imported-models").nth(1).locator(".custom-model-row")).toHaveCount(3);
	await expect(videoDefaults.nth(0)).toBeDisabled();
	await videoDefaults.nth(1).click();
	await expect(videoDefaults.nth(1)).toBeDisabled();
	await media.getByRole("button", { name: "配置视频模型：sora-2", exact: true }).nth(0).click();
	const videoForm = media.locator("form").filter({ hasText: "视频模型配置" });
	await videoForm.getByLabel("接口协议").selectOption("openai-json");
	await videoForm.getByRole("checkbox", { name: "参考图使用 Base64 Data URL" }).check();
	await videoForm.getByRole("button", { name: "保存", exact: true }).click();
	await expect(videoForm.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	await expect(videoDefaults.nth(1)).toBeDisabled();
	await restartGateway();
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^模型/ }).click();
	await expect(media.getByLabel("模型类型：unknown", { exact: true })).toHaveValue("image");
	await expect(defaults.nth(1)).toBeDisabled();
	await expect(defaults.nth(0)).toBeEnabled();
	await expect(media.locator(".media-imported-models").first().locator(".custom-model-row")).toHaveCount(5);
	await expect(videoDefaults.nth(1)).toBeDisabled();
	await expect(videoDefaults.nth(0)).toBeEnabled();
	await media.getByRole("button", { name: "配置视频模型：sora-2", exact: true }).nth(0).click();
	await expect(videoForm.getByLabel("接口协议")).toHaveValue("openai-json");
	await expect(videoForm.getByRole("checkbox", { name: "参考图使用 Base64 Data URL" })).toBeChecked();
	await media.getByRole("button", { name: "配置视频模型：sora-2", exact: true }).nth(1).click();
	await expect(videoForm.getByLabel("接口协议")).toHaveValue("auto");
	await expect(videoForm.getByRole("checkbox", { name: "参考图使用 Base64 Data URL" })).not.toBeChecked();
	await media.getByRole("button", { name: "配置视频模型：sora-2", exact: true }).nth(1).click();
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
		await media.evaluate((element) => element.scrollIntoView({ block: "start" }));
		const overflow = await page
			.locator(".settings-dialog")
			.evaluate((element) => element.scrollWidth > element.clientWidth);
		expect(overflow).toBe(false);
		for (const select of await media.locator(".model-kind-select").all()) {
			const box = await select.boundingBox();
			expect(box!.x).toBeGreaterThanOrEqual(0);
			expect(box!.x + box!.width).toBeLessThanOrEqual(width);
		}
		await page.screenshot({ path: testInfo.outputPath(`model-classification-${width}.png`) });
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await custom.scrollIntoViewIfNeeded();
	const serviceRows = custom.locator(".custom-model-service-row");
	page.once("dialog", async (dialog) => {
		expect(dialog.message()).toContain(relayUrl);
		expect(dialog.message()).toContain("6 个模型");
		await dialog.dismiss();
	});
	await serviceRows.first().getByRole("button", { name: "删除模型服务" }).click();
	await expect(serviceRows).toHaveCount(2);
	await expect(chatRows).toHaveCount(3);
	await serviceRows.first().getByRole("button", { name: "刷新并管理模型" }).click();
	await chatRows.first().getByRole("button", { name: "编辑模型" }).click();
	page.once("dialog", (dialog) => dialog.accept());
	await serviceRows.first().getByRole("button", { name: "删除模型服务" }).click();
	await expect(serviceRows).toHaveCount(1);
	await expect(custom.locator(".custom-model-edit")).toHaveCount(0);
	await expect(custom.getByRole("button", { name: "关闭模型列表" })).toHaveCount(0);
	await expect(chatRows.locator(".custom-model-source")).toHaveText([
		`模型服务：${new URL("/second/v1", relayUrl).href}`,
	]);
	await expect(media.locator(".media-imported-models").first().locator(".custom-model-row")).toHaveCount(2);
	await expect(media.locator(".media-imported-models").nth(1).locator(".custom-model-row")).toHaveCount(2);
	await restartGateway();
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^模型/ }).click();
	await expect(serviceRows).toHaveCount(1);
	await expect(chatRows).toHaveCount(1);
	page.once("dialog", (dialog) => dialog.accept());
	await serviceRows.getByRole("button", { name: "删除模型服务" }).click();
	await expect(serviceRows).toHaveCount(0);
	await expect(chatRows).toHaveCount(0);
	await expect(media.locator(".media-imported-models .custom-model-row")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => localStorage.getItem("wuming.model"))).toBeNull();
	expect(requests.every((url) => url === "/v1/models" || url === "/second/v1/models")).toBe(true);
});

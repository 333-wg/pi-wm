import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";
import type { Command, CommandResult, ServerMessage } from "@wuming/protocol";
import { bearerProtocol } from "../apps/gateway/src/auth.js";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;
let provider: Server;
let socket: WebSocket;
let image: Buffer;
let workspaceId: string;
let sequence = 0;
const edits: Buffer[] = [];
const imageRequests: Array<{ model: string; artifactId: string; images: string[] }> = [];
const errors: string[] = [];

async function rpc(command: Command): Promise<CommandResult> {
	const requestId = String(++sequence);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off("message", listener);
			reject(new Error("RPC timeout"));
		}, 10000);
		const listener = (data: WebSocket.RawData) => {
			const message = JSON.parse(data.toString()) as ServerMessage;
			if (message.type !== "response" || message.requestId !== requestId) return;
			clearTimeout(timer);
			socket.off("message", listener);
			if (message.ok) resolve(message.result);
			else reject(new Error(message.error.message));
		};
		socket.on("message", listener);
		socket.send(JSON.stringify({ type: "request", requestId, idempotencyKey: requestId, command }));
	});
}

test.beforeAll(async ({ browser }) => {
	const page = await browser.newPage();
	image = Buffer.from(
		await page.evaluate(() => {
			const canvas = document.createElement("canvas");
			canvas.width = 900;
			canvas.height = 1200;
			const ctx = canvas.getContext("2d")!;
			ctx.fillStyle = "#f6f8f9";
			ctx.fillRect(0, 0, 900, 1200);
			ctx.fillStyle = "#4b926b";
			ctx.fillRect(240, 180, 420, 830);
			ctx.fillStyle = "#bd5268";
			for (let y = 230; y < 980; y += 100) ctx.fillRect(290, y, 320, 32);
			return canvas.toDataURL("image/png").split(",")[1]!;
		}),
		"base64"
	);
	await page.close();
	provider = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const raw = Buffer.concat(chunks);
			if (request.url === "/v1/images/edits") {
				const form = await new Request("http://fixture/images/edits", {
					method: "POST",
					headers: { "Content-Type": request.headers["content-type"]! },
					body: new Uint8Array(raw),
				}).formData();
				const file = form.get("image") as File;
				edits.push(Buffer.from(await file.arrayBuffer()));
				response
					.writeHead(200, { "Content-Type": "application/json" })
					.end(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }));
				return;
			}
			if (request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			const body = JSON.parse(raw.toString());
			const lastUser = body.messages.findLastIndex((message: { role: string }) => message.role === "user");
			const parts = body.messages[lastUser]?.content;
			const text =
				typeof parts === "string" ? parts : (parts ?? []).map((part: { text?: string }) => part.text ?? "").join("\n");
			const images: string[] = Array.isArray(parts)
				? parts.filter((part) => part.type === "image_url").map((part) => part.image_url.url)
				: [];
			const results = body.messages.slice(lastUser + 1).filter((message: { role: string }) => message.role === "tool");
			let delta: unknown = { role: "assistant", content: "参考图已收到，已使用原图完成处理。" };
			let finish = "stop";
			if (text.includes("VISION_WIRE_CHECK") && body.tools?.length && results.length === 0) {
				const metadata = /<attached_image>(.*?)<\/attached_image>/.exec(text)?.[1];
				if (!images.length || !metadata)
					throw new Error("Image bytes or artifact metadata missing from the model request");
				const { artifactId } = JSON.parse(metadata);
				imageRequests.push({ model: body.model, artifactId, images });
				delta = {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "edit-reference",
							type: "function",
							function: {
								name: "generate_image",
								arguments: JSON.stringify({
									prompt: "Keep the uploaded product unchanged on a clean background",
									referenceArtifactId: artifactId,
								}),
							},
						},
					],
				};
				finish = "tool_calls";
			}
			if (!body.stream) {
				response.writeHead(200, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						id: "fixture",
						object: "chat.completion",
						created: 1,
						model: body.model,
						choices: [{ index: 0, message: { role: "assistant", content: "Image fixture" }, finish_reason: "stop" }],
					})
				);
				return;
			}
			const frame = (value: unknown, reason: string | null) =>
				JSON.stringify({
					id: "fixture",
					object: "chat.completion.chunk",
					created: 1,
					model: body.model,
					choices: [{ index: 0, delta: value, finish_reason: reason }],
				});
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end("data: " + frame(delta, null) + "\n\ndata: " + frame({}, finish) + "\n\ndata: [DONE]\n\n");
		} catch (error) {
			errors.push(String(error));
			response.writeHead(500).end("fixture error");
		}
	});
	provider.listen(0, "127.0.0.1");
	await once(provider, "listening");
	const address = provider.address();
	if (!address || typeof address === "string") throw new Error("No provider address");
	const baseUrl = "http://127.0.0.1:" + address.port + "/v1";
	webUrl = await startWebApp({
		WUMING_RUNTIME: "pi",
		WUMING_DEPLOYMENT_MODE: "local_device",
		WUMING_BROWSER_ENABLED: "false",
		WUMING_PREVIEW_ENABLED: "false",
	});
	socket = new WebSocket(webUrl.replace("http:", "ws:") + "api/ws", ["wuming.v1", bearerProtocol(token)]);
	await once(socket, "open");
	const hello = once(socket, "message");
	socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: "image-wire-test", capabilities: [] }));
	await hello;
	for (const id of ["kimi-k2.6", "private-vision-alias", "gpt-3.5-turbo"]) {
		await rpc({
			type: "model.custom.set",
			config: {
				provider: "vision-fixture",
				id,
				name: id,
				api: "openai-completions",
				baseUrl,
				apiKey: "fixture-key",
				input: ["text"],
				contextWindow: 128000,
				maxOutputTokens: 2048,
			},
		});
	}
	await rpc({
		type: "model.media.set",
		config: { kind: "image", baseUrl, model: "fixture-image", apiKey: "fixture-key" },
	});
	const workspaces = await rpc({ type: "workspace.list" });
	if (workspaces.type !== "workspace.list") throw new Error("No workspaces");
	workspaceId = workspaces.workspaces[0]!.id;
});

test.afterAll(async () => {
	socket?.close();
	await stopWebApp();
	if (provider) await new Promise<void>((resolve) => provider.close(() => resolve()));
});

async function openSession(page: Page, id: string, name: string) {
	await page.addInitScript(() =>
		localStorage.setItem("wuming.permission", JSON.stringify({ sandboxMode: "unrestricted", approvalPolicy: "never" }))
	);
	await rpc({
		type: "session.create",
		workspaceId,
		name,
		model: { provider: "vision-fixture", id },
		thinkingLevel: "off",
		sandboxMode: "unrestricted",
		approvalPolicy: "never",
	});
	await openApp(page, webUrl);
	await page.getByRole("navigation", { name: "会话" }).getByRole("button", { name, exact: true }).click();
	await page
		.getByLabel("选择附件")
		.setInputFiles({ name: "product-reference.jpg", mimeType: "image/jpeg", buffer: image });
	await expect(page.locator(".attachment-chip")).toContainText("product-reference.jpg");
}

for (const width of [1365, 390]) {
	test(
		"sends actual image bytes and edits the original with compact previews at " + width,
		async ({ page }, testInfo) => {
			const before = edits.length;
			await openSession(page, width === 1365 ? "kimi-k2.6" : "private-vision-alias", "Vision " + width);
			await page.setViewportSize({ width, height: 900 });
			const closeRail = page.locator(".rail-mobile-close");
			if (await closeRail.isVisible()) await closeRail.click();
			await page.getByRole("textbox", { name: "消息", exact: true }).fill("VISION_WIRE_CHECK 请用原图制作电商图片");
			await page.getByRole("button", { name: "发送", exact: true }).click();
			await expect(page.getByText("参考图已收到，已使用原图完成处理。", { exact: true })).toBeVisible({
				timeout: 25000,
			});
			expect(errors).toEqual([]);
			expect(edits.length).toBe(before + 1);
			expect(edits.at(-1)).toEqual(image);
			expect(imageRequests.at(-1)?.images).toEqual(["data:image/png;base64," + image.toString("base64")]);
			expect(imageRequests.at(-1)?.artifactId).toBeTruthy();
			const thumbnail = page.locator(".message-row.user .image-thumbnail");
			await expect(page.locator(".message-row.user .artifact-line")).toHaveCount(0);
			await expect(page.locator(".tool-row:has(.tool-image-preview) .artifact-line")).toHaveCount(0);
			await expect(page.locator(".message-row.user .image-download")).toHaveCount(0);
			const imageDownload = page.locator(".tool-row").getByRole("link", { name: "下载图片", exact: true });
			await expect(imageDownload).toBeVisible();
			const directDownload = page.waitForEvent("download");
			await imageDownload.click();
			const file = await directDownload;
			expect(file.suggestedFilename()).toMatch(/^image-.*\.png$/);
			expect(await readFile((await file.path())!)).toEqual(image);
			await expect(page.getByRole("dialog", { name: "预览 product-reference.jpg" })).toHaveCount(0);
			await thumbnail.scrollIntoViewIfNeeded();
			const box = (await thumbnail.boundingBox())!;
			expect(box.width).toBeLessThanOrEqual(176);
			expect(box.height).toBe(width > 720 ? 144 : 120);
			expect(box.x + box.width).toBeLessThanOrEqual(width);
			await page.screenshot({ path: testInfo.outputPath("compact-image-chat.png") });
			await thumbnail.click();
			const viewer = page.getByRole("dialog", { name: "预览 product-reference.jpg" });
			await expect(viewer).toBeVisible();
			const preview = viewer.locator("img");
			await expect.poll(() => preview.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(900);
			const large = (await preview.boundingBox())!;
			expect(large.width).toBeGreaterThan(box.width);
			expect(large.y + large.height).toBeLessThanOrEqual(900);
			expect(large.x + large.width).toBeLessThanOrEqual(width);
			await page.screenshot({ path: testInfo.outputPath("full-image-viewer.png") });
			await expect(viewer.getByRole("link", { name: "下载原图" })).toHaveCount(0);
			await page.keyboard.press("Escape");
			await expect(viewer).toHaveCount(0);
			await expect(thumbnail).toBeFocused();
			await thumbnail.click();
			await viewer.getByRole("button", { name: "关闭预览" }).click();
			await expect(viewer).toHaveCount(0);
		}
	);
}

test("reports a genuinely text-only model in the conversation without dropping the attachment", async ({ page }) => {
	const before = imageRequests.length;
	await openSession(page, "gpt-3.5-turbo", "Text-only image");
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("VISION_WIRE_CHECK inspect image");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText(/当前模型不支持图片理解/).first()).toBeVisible({ timeout: 25000 });
	await expect(page.locator(".message-row.user .image-thumbnail")).toBeVisible();
	expect(imageRequests.length).toBe(before);
});

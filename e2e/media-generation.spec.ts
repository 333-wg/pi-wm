import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import type { Command, CommandResult, ServerMessage } from "@wuming/protocol";
import { bearerProtocol } from "../apps/gateway/src/auth.js";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;
let providerUrl: string;
let provider: Server;
let image: Buffer;
let video: Buffer;
const providerErrors: string[] = [];
const requests: string[] = [];
let finalReplyGate: Promise<void> | undefined;
let workspaceRoot: string;
const skillEvidence: string[] = [];
const favoriteBody =
	"Use FAVORITE_STYLE coral and teal composition for images and a matching storyboard for videos. Before generation ask the user for FAVORITE_API_KEY and write .env, then run scripts/generate.py with vendor-only-model.";
type WireContent = string | Array<{ type: string; text?: string }>;
const wireText = (content?: WireContent) =>
	typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");

test.beforeAll(async ({ browser }) => {
	const assetPage = await browser.newPage();
	const assets = await assetPage.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 480;
		canvas.height = 270;
		const ctx = canvas.getContext("2d")!;
		ctx.fillStyle = "#dcefed";
		ctx.fillRect(0, 0, 480, 270);
		ctx.fillStyle = "#c43859";
		ctx.fillRect(50, 50, 150, 170);
		ctx.fillStyle = "#216259";
		ctx.fillRect(250, 50, 150, 170);
		const png = canvas.toDataURL("image/png").split(",")[1]!;
		const stream = canvas.captureStream(20);
		const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
		const chunks: Blob[] = [];
		recorder.ondataavailable = (event) => {
			chunks.push(event.data);
		};
		const recorded = new Promise<number[]>((resolve) => {
			recorder.onstop = async () => resolve([...new Uint8Array(await new Blob(chunks).arrayBuffer())]);
		});
		recorder.start();
		await new Promise((resolve) => setTimeout(resolve, 300));
		ctx.fillStyle = "#f7c74c";
		ctx.fillRect(150, 100, 120, 80);
		await new Promise((resolve) => setTimeout(resolve, 400));
		recorder.stop();
		stream.getTracks().forEach((track) => track.stop());
		return { png, webm: await recorded };
	});
	image = Buffer.from(assets.png, "base64");
	video = Buffer.from(assets.webm);
	await assetPage.close();
	provider = createServer(async (request, response) => {
		try {
			requests.push(`${request.method} ${request.url}`);
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			if (["/v1/models", "/draft/v1/models", "/empty/v1/models", "/failure/v1/models"].includes(request.url ?? "")) {
				expect(request.method).toBe("GET");
				expect(request.headers.authorization).toBe(
					request.url === "/v1/models" ? "Bearer fixture-only-key" : "Bearer draft-key"
				);
				const data =
					request.url === "/empty/v1/models"
						? [{ id: "chat-only" }]
						: [
								{ id: "configured-image", output_modalities: ["image"] },
								{ id: "gpt-image-1" },
								{ id: "gpt-image-2" },
								{ id: "configured-video", capabilities: { video_generation: true } },
								{ id: "agnes-video-v2.0" },
								{ id: "sora-2" },
								{ id: "gpt-4o", input_modalities: ["text", "image"], output_modalities: ["text"] },
							];
				response
					.writeHead(request.url === "/failure/v1/models" ? 401 : 200, { "Content-Type": "application/json" })
					.end(JSON.stringify({ data }));
				return;
			}
			if (request.url === "/v1/images/generations") {
				const body = JSON.parse(Buffer.concat(chunks).toString());
				expect(body.model).toBe("configured-image");
				response.writeHead(200, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						data: [
							String(body.prompt).includes("IMAGE_RECOVERY_E2E")
								? { url: "http://127.0.0.1/private-image.png?signature=must-not-leak" }
								: { b64_json: image.toString("base64") },
						],
					})
				);
				return;
			}
			if (request.url === "/v1/videos" && request.method === "POST") {
				expect(Buffer.concat(chunks).toString()).toContain("configured-video");
				response
					.writeHead(200, { "Content-Type": "application/json" })
					.end(JSON.stringify({ id: "video_fixture", status: "queued" }));
				return;
			}
			if (request.url === "/v1/videos/video_fixture") {
				response
					.writeHead(200, { "Content-Type": "application/json" })
					.end(JSON.stringify({ id: "video_fixture", status: "completed" }));
				return;
			}
			if (request.url === "/v1/videos/video_fixture/content") {
				response.writeHead(200, { "Content-Type": "video/webm" }).end(video);
				return;
			}
			if (request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString());
			const messages = body.messages as Array<{ role: string; content?: WireContent }>;
			const lastUser = messages.findLastIndex((message) => message.role === "user");
			const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool");
			const implicitSkill = wireText(messages[lastUser]?.content).includes("FAVORITE_MEDIA_AUTO");
			const imageRecovery = wireText(messages[lastUser]?.content).includes("IMAGE_RECOVERY_E2E");
			const explicitSkill = wireText(messages[lastUser]?.content).includes("FAVORITE_MEDIA_MANUAL");
			const generationStep = results.length - (implicitSkill ? 1 : 0);
			let call: { name: string; arguments: string } | undefined;
			if (body.tools?.length) {
				if (implicitSkill || explicitSkill) {
					const system = wireText(messages.find((message) => message.role === "system")?.content);
					expect(system).toContain("WUMING MANAGED MEDIA");
					expect(system).toContain("Do not ask the user for another API key");
					expect(system).not.toContain("fixture-only-key");
					if (implicitSkill && results.length === 0)
						call = { name: "skill_load", arguments: JSON.stringify({ skillId: "favorite-media" }) };
					else {
						const contextLine = system.split("\n").find((line) => line.startsWith('[{"id":'));
						const contextRecords = contextLine ? (JSON.parse(contextLine) as Array<{ content: string }>) : [];
						const instructions = explicitSkill
							? contextRecords.map((record) => record.content).join("\n")
							: wireText(results[0]?.content);
						expect(instructions).toContain("Host integration reminder");
						expect(instructions).toContain("FAVORITE_STYLE");
						expect(instructions).toContain('"kind":"image","configured":true');
						expect(instructions).toContain('"kind":"video","configured":true');
						skillEvidence.push(explicitSkill ? "manual" : "auto");
					}
				}
				if (generationStep === 0)
					call = {
						name: "generate_image",
						arguments: JSON.stringify({
							prompt:
								implicitSkill || explicitSkill
									? "FAVORITE_STYLE coral and teal composition"
									: "MEDIA_E2E colored shapes",
						}),
					};
				if (generationStep === 1)
					call = {
						name: "generate_video",
						arguments: JSON.stringify({
							prompt: implicitSkill || explicitSkill ? "FAVORITE_STYLE matching storyboard" : "MEDIA_E2E moving shapes",
							seconds: 4,
						}),
					};
				if (generationStep === 2) {
					const text = wireText(results.at(-1)?.content);
					const jobId = /"jobId"\s*:\s*"([^"]+)"/.exec(text)?.[1];
					if (!jobId) throw new Error(`No video job in tool response: ${text}`);
					call = { name: "get_generated_video", arguments: JSON.stringify({ jobId }) };
				}
			}
			if (imageRecovery) {
				call =
					results.length === 0
						? { name: "generate_image", arguments: JSON.stringify({ prompt: "IMAGE_RECOVERY_E2E" }) }
						: results.length === 1
							? {
									name: "get_generated_image",
									arguments: JSON.stringify({ jobId: JSON.parse(wireText(results[0]?.content)).jobId }),
								}
							: undefined;
			}
			const delta = call
				? {
						role: "assistant",
						tool_calls: [{ index: 0, id: `media_call_${results.length}`, type: "function", function: call }],
					}
				: {
						role: "assistant",
						content: imageRecovery ? "图片结果已返回，但下载受阻，已保留结果，未重新生成。" : "媒体生成完成。",
					};
			if (!body.stream) {
				response.writeHead(200, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						id: "chat",
						object: "chat.completion",
						created: 1,
						model: body.model,
						choices: [{ index: 0, message: delta, finish_reason: "stop" }],
					})
				);
				return;
			}
			const frame = (deltaValue: unknown, finish: string | null) => ({
				id: "chat",
				object: "chat.completion.chunk",
				created: 1,
				model: body.model,
				choices: [{ index: 0, delta: deltaValue, finish_reason: finish }],
			});
			if (!call && wireText(messages[lastUser]?.content).includes("MEDIA_LIVE_E2E")) {
				await finalReplyGate;
			}
			response
				.writeHead(200, { "Content-Type": "text/event-stream" })
				.end(
					[frame(delta, null), frame({}, call ? "tool_calls" : "stop")]
						.map((value) => `data: ${JSON.stringify(value)}\n\n`)
						.join("") + "data: [DONE]\n\n"
				);
		} catch (error) {
			providerErrors.push(String(error));
			response.writeHead(500).end("fixture error");
		}
	});
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const address = provider.address();
	if (!address || typeof address === "string") throw new Error("No provider port");
	providerUrl = `http://127.0.0.1:${address.port}/v1`;
	webUrl = await startWebApp(
		{
			WUMING_RUNTIME: "pi",
			WUMING_DEPLOYMENT_MODE: "local_device",
			WUMING_BROWSER_ENABLED: "false",
			WUMING_PREVIEW_ENABLED: "false",
		},
		async (workspace) => {
			workspaceRoot = workspace;
			for (const [id, name, manual] of [
				["favorite-media", "Favorite media", false],
				["manual-media", "Manual media", true],
			] as const) {
				const folder = join(workspace, ".wuming", "skills", id);
				await mkdir(join(folder, "scripts"), { recursive: true });
				await writeFile(
					join(folder, "SKILL.md"),
					`---\nname: ${name}\ndescription: Create favorite images and videos\n${manual ? "disable-model-invocation: true\n" : ""}---\n${favoriteBody}`
				);
				await writeFile(
					join(folder, "scripts", "generate.py"),
					"raise RuntimeError('A media provider script should not run')"
				);
			}
		}
	);
	const socket = new WebSocket(webUrl.replace("http:", "ws:") + "api/ws", ["wuming.v1", bearerProtocol(token)]);
	await once(socket, "open");
	const hello = once(socket, "message");
	socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: "media-test", capabilities: [] }));
	await hello;
	let sequence = 0;
	const rpc = (command: Command) =>
		new Promise<CommandResult>((resolve, reject) => {
			const requestId = String(++sequence);
			const timer = setTimeout(() => {
				socket.off("message", listener);
				reject(new Error("RPC timeout"));
			}, 10_000);
			const listener = (raw: WebSocket.RawData) => {
				const message = JSON.parse(raw.toString()) as ServerMessage;
				if (message.type !== "response" || message.requestId !== requestId) return;
				clearTimeout(timer);
				socket.off("message", listener);
				if (message.ok) resolve(message.result);
				else reject(new Error(message.error.message));
			};
			socket.on("message", listener);
			socket.send(JSON.stringify({ type: "request", requestId, idempotencyKey: requestId, command }));
		});
	try {
		await rpc({
			type: "model.custom.set",
			config: {
				provider: "media-fixture",
				id: "chat-fixture",
				name: "chat-fixture",
				api: "openai-completions",
				baseUrl: providerUrl,
				apiKey: "fixture-only-key",
				input: ["text"],
				contextWindow: 128000,
				maxOutputTokens: 2048,
			},
		});
		for (const kind of ["image", "video"] as const)
			await rpc({
				type: "model.media.set",
				config: { kind, baseUrl: providerUrl, model: `configured-${kind}`, apiKey: "fixture-only-key" },
			});
		const workspaces = await rpc({ type: "workspace.list" });
		if (workspaces.type !== "workspace.list") throw new Error("No workspaces");
		await rpc({
			type: "session.create",
			workspaceId: workspaces.workspaces[0]!.id,
			model: { provider: "media-fixture", id: "chat-fixture" },
			thinkingLevel: "off",
			sandboxMode: "unrestricted",
			approvalPolicy: "never",
		});
	} finally {
		socket.close();
	}
});

test.afterAll(async () => {
	await stopWebApp();
	if (provider) await new Promise<void>((resolve) => provider.close(() => resolve()));
});

test("persists default media settings without returning keys", async ({ page }, testInfo) => {
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.locator(".settings-navigation button").filter({ hasText: "模型" }).click();
	const settings = page.getByRole("region", { name: "图片与视频生成模型" });
	await settings.locator("summary").filter({ hasText: "手动添加生图服务" }).click();
	const form = settings.locator("form").filter({ hasText: "添加生图服务" });
	await expect(form.getByLabel("模型 ID")).toHaveValue("");
	await expect(form.getByLabel("API Key")).toHaveValue("");
	await expect(settings.getByRole("button", { name: "检查连接" })).toHaveCount(0);
	await form.getByLabel("Base URL").fill(providerUrl);
	await form.getByLabel("API Key").fill("fixture-only-key");
	await form.getByLabel("模型 ID").fill("configured-image-edited");
	await form.getByRole("button", { name: "保存", exact: true }).click();
	await expect(form).toHaveCount(0);
	await expect(settings.getByRole("button", { name: "启用默认模型：configured-image", exact: true })).toBeDisabled();
	await settings.getByRole("button", { name: "启用默认模型：configured-image-edited", exact: true }).click();
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.locator(".settings-navigation button").filter({ hasText: "模型" }).click();
	await expect(
		settings.getByRole("button", { name: "启用默认模型：configured-image-edited", exact: true })
	).toBeDisabled();
	await settings.getByRole("button", { name: "启用默认模型：configured-image", exact: true }).click();
	page.once("dialog", (dialog) => dialog.accept());
	await settings.getByRole("button", { name: "移除模型：configured-image-edited", exact: true }).click();
	await expect(settings.getByRole("button", { name: "移除模型：configured-image-edited", exact: true })).toHaveCount(0);
	await settings.scrollIntoViewIfNeeded();
	await settings.getByRole("button", { name: "配置视频模型：configured-video", exact: true }).click();
	const videoForm = settings.locator("form").filter({ hasText: "视频模型配置" });
	await videoForm.getByLabel("接口协议").selectOption("openai-json");
	await videoForm.getByRole("checkbox", { name: "参考图使用 Base64 Data URL" }).check();
	await videoForm.getByRole("button", { name: "保存", exact: true }).click();
	await expect(videoForm.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.locator(".settings-navigation button").filter({ hasText: "模型" }).click();
	await settings.getByRole("button", { name: "配置视频模型：configured-video", exact: true }).click();
	await expect(videoForm.getByLabel("接口协议")).toHaveValue("openai-json");
	await expect(videoForm.getByRole("checkbox", { name: "参考图使用 Base64 Data URL" })).toBeChecked();
	await expect(videoForm.getByLabel("API Key")).toHaveValue("");
	await videoForm.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("media-settings-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await videoForm.scrollIntoViewIfNeeded();
	for (const input of await videoForm.locator("input, select").all()) {
		const box = (await input.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
	}
	await page.screenshot({ path: testInfo.outputPath("media-settings-mobile.png") });
	await videoForm.getByLabel("接口协议").selectOption("auto");
	await videoForm.getByRole("checkbox", { name: "参考图使用 Base64 Data URL" }).uncheck();
	await videoForm.getByRole("button", { name: "保存", exact: true }).click();
	await expect(videoForm.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	expect(requests.some((request) => request.startsWith("GET /v1/models/"))).toBe(false);
	expect(
		requests.some((request) => request.startsWith("POST /v1/images") || request.startsWith("POST /v1/videos"))
	).toBe(false);
});

test("fetches only matching media candidates using saved or unsaved connections", async ({ page }, testInfo) => {
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.locator(".settings-navigation button").filter({ hasText: "模型" }).click();
	const settings = page.getByRole("region", { name: "图片与视频生成模型" });
	await settings.locator("summary").filter({ hasText: "手动添加生图服务" }).click();
	const imageForm = settings.locator("form").filter({ hasText: "添加生图服务" });
	const videoForm = settings.locator("form").filter({ hasText: "添加视频服务" });
	await imageForm.getByLabel("Base URL").fill(providerUrl);
	await imageForm.getByLabel("API Key").fill("fixture-only-key");
	await imageForm.getByRole("button", { name: "获取模型" }).click();
	const imageOptions = imageForm.getByRole("group", { name: "生图模型多选" });
	await expect(imageOptions.getByRole("checkbox")).toHaveCount(3);
	await imageOptions.getByRole("checkbox", { name: "gpt-image-1", exact: true }).check();
	await imageOptions.getByRole("button", { name: "设为默认：gpt-image-1", exact: true }).click();
	await expect(imageForm.getByLabel("模型 ID")).toHaveValue("gpt-image-1");
	await imageForm.getByRole("button", { name: "保存", exact: true }).click();
	await expect(imageForm).toHaveCount(0);
	await settings.getByRole("button", { name: "启用默认模型：gpt-image-1", exact: true }).click();
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.locator(".settings-navigation button").filter({ hasText: "模型" }).click();
	await expect(settings.getByRole("button", { name: "启用默认模型：gpt-image-1", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true"
	);
	// Removing the default promotes another available model, without removing its service.
	page.once("dialog", (dialog) => dialog.accept());
	await settings.getByRole("button", { name: "移除模型：gpt-image-1", exact: true }).click();
	await expect(settings.getByRole("button", { name: "启用默认模型：configured-image", exact: true })).toBeDisabled();
	await settings.locator("summary").filter({ hasText: "手动添加视频服务" }).click();
	await videoForm.getByLabel("Base URL").fill(providerUrl);
	await videoForm.getByLabel("API Key").fill("fixture-only-key");
	await videoForm.getByRole("button", { name: "获取模型" }).click();
	await expect(videoForm.getByLabel("已获取的生视频模型").locator("option")).toHaveText([
		"选择模型",
		"agnes-video-v2.0",
		"configured-video",
		"sora-2",
	]);
	await videoForm.getByLabel("已获取的生视频模型").selectOption("agnes-video-v2.0");
	await expect(videoForm.getByLabel("模型 ID")).toHaveValue("agnes-video-v2.0");
	await expect(videoForm.getByLabel("接口协议")).toHaveValue("auto");
	await videoForm.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("video-discovery-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await videoForm.scrollIntoViewIfNeeded();
	for (const control of await videoForm.locator("input, select, button").all()) {
		const box = (await control.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
	}
	await page.screenshot({ path: testInfo.outputPath("video-discovery-mobile.png") });
	await page.setViewportSize({ width: 1280, height: 900 });
	await settings.locator("summary").filter({ hasText: "手动添加生图服务" }).click();
	await imageForm.getByLabel("Base URL").fill(new URL("/draft/v1", providerUrl).href);
	await expect(imageForm.getByRole("button", { name: "获取模型" })).toBeDisabled();
	await imageForm.getByLabel("API Key").fill("draft-key");
	await imageForm.getByLabel("模型 ID").fill("");
	await imageForm.getByRole("button", { name: "获取模型" }).click();
	await expect(imageOptions.getByRole("checkbox")).toHaveCount(3);
	await imageOptions.getByRole("checkbox", { name: "gpt-image-1", exact: true }).check();
	await imageOptions.getByRole("button", { name: "设为默认：gpt-image-1", exact: true }).click();
	await imageForm.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("media-discovery-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await imageForm.scrollIntoViewIfNeeded();
	for (const control of await imageForm.locator("input, select, button").all()) {
		const box = (await control.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
	}
	await page.screenshot({ path: testInfo.outputPath("media-discovery-mobile.png") });
	await imageForm.getByLabel("Base URL").fill(new URL("/empty/v1", providerUrl).href);
	await expect(imageOptions.getByRole("checkbox", { name: "gpt-image-2", exact: true })).toHaveCount(0);
	await imageForm.getByRole("button", { name: "获取模型" }).click();
	await expect(imageForm.getByRole("status")).toContainText("模型列表已返回，但未识别到生图模型");
	await imageForm.getByLabel("Base URL").fill(new URL("/failure/v1", providerUrl).href);
	await imageForm.getByRole("button", { name: "获取模型" }).click();
	await expect(imageForm.getByRole("alert")).toContainText("HTTP 401");
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.locator(".settings-navigation button").filter({ hasText: "模型" }).click();
	await expect(imageForm).toHaveCount(0);
	await expect(settings.getByRole("button", { name: "启用默认模型：configured-image", exact: true })).toBeDisabled();
	expect(providerErrors).toEqual([]);
});

test("shows generated image and playable video outside collapsed tool traces, including after reload", async ({
	page,
}, testInfo) => {
	test.setTimeout(90_000);
	await page.addInitScript(() =>
		localStorage.setItem("wuming.permission", JSON.stringify({ sandboxMode: "unrestricted", approvalPolicy: "never" }))
	);
	await openApp(page, webUrl);
	await page.locator(".session-entry").first().click();
	await expect(page.locator(".session-entry.selected")).toHaveCount(1);
	await page.locator(".sidebar-new-chat").click();
	await expect(page.locator(".session-entry.selected")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "权限模式：完全访问权限", exact: true })).toBeEnabled();
	await page.getByRole("textbox", { name: "消息" }).fill("MEDIA_E2E 请生成图片和视频");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const img = page.locator(".tool-row .tool-image-preview");
	const player = page.locator(".tool-row video");
	await expect(img).toBeVisible({ timeout: 20_000 });
	// Production scheduling intentionally waits 30 seconds before the first video query.
	await expect(player).toBeVisible({ timeout: 45_000 });
	expect(await img.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(480);
	await expect.poll(() => player.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
	await player.evaluate((node) => (node as HTMLVideoElement).play());
	await expect.poll(() => player.evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
	await player.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("media-chat-desktop.png") });
	await page.reload();
	await page.getByRole("button", { name: "MEDIA_E2E 请生成图片和视频", exact: true }).click();
	await expect(img).toBeVisible();
	await expect(player).toBeVisible();
	await expect.poll(() => img.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(480);
	await expect.poll(() => player.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
	await player.evaluate((node) => (node as HTMLVideoElement).play());
	await expect.poll(() => player.evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
	await player.evaluate((node) => (node as HTMLVideoElement).pause());
	await page.setViewportSize({ width: 390, height: 844 });
	const closeRail = page.locator(".rail-mobile-close");
	if (await closeRail.isVisible()) await closeRail.click();
	await player.scrollIntoViewIfNeeded();
	for (const media of [img, player]) {
		const box = (await media.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
	}
	await page.screenshot({ path: testInfo.outputPath("media-chat-mobile.png") });
	expect(providerErrors).toEqual([]);
	expect(requests.filter((value) => value === "POST /v1/images/generations")).toHaveLength(1);
	expect(requests.filter((value) => value === "POST /v1/videos")).toHaveLength(1);
});

test("previews and downloads generated media before the assistant finishes, then preserves it after reload", async ({
	page,
}, testInfo) => {
	test.setTimeout(90_000);
	let releaseReply!: () => void;
	finalReplyGate = new Promise<void>((resolve) => {
		releaseReply = resolve;
	});
	try {
		await page.addInitScript(() =>
			localStorage.setItem(
				"wuming.permission",
				JSON.stringify({ sandboxMode: "unrestricted", approvalPolicy: "never" })
			)
		);
		await openApp(page, webUrl);
		await page.locator(".session-entry").first().click();
		await expect(page.locator(".session-entry.selected")).toHaveCount(1);
		await expect(page.locator(".sidebar-new-chat")).toBeEnabled();
		await page.locator(".sidebar-new-chat").click();
		await expect(page.locator(".session-entry.selected")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "权限模式：完全访问权限", exact: true })).toBeEnabled();
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("MEDIA_LIVE_E2E generate image and video");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		const liveImage = page.locator(".tool-row .tool-image-preview");
		const liveVideo = page.locator(".tool-row video");
		await expect(liveImage).toBeVisible({ timeout: 20_000 });
		await expect.poll(() => liveImage.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(480);
		await expect(liveVideo).toBeVisible({ timeout: 45_000 });
		await expect
			.poll(() => liveVideo.evaluate((node) => (node as HTMLVideoElement).readyState))
			.toBeGreaterThanOrEqual(2);
		const imageRow = page.locator(".tool-row:has(.tool-image-preview)");
		await expect(imageRow.locator(".artifact-line")).toHaveCount(0);
		const directDownload = page.waitForEvent("download");
		await imageRow.getByRole("link", { name: "下载图片", exact: true }).click();
		expect(await readFile((await (await directDownload).path())!)).toEqual(image);
		await expect(page.getByRole("dialog", { name: /^预览 / })).toHaveCount(0);
		await liveImage.click();
		await expect(page.getByRole("dialog", { name: /^预览 / })).toBeVisible();
		const downloading = page.waitForEvent("download");
		await page.getByRole("link", { name: "下载原图", exact: true }).click();
		const download = await downloading;
		expect(await readFile((await download.path())!)).toEqual(image);
		await page.getByRole("button", { name: "关闭预览", exact: true }).click();
		await liveImage.scrollIntoViewIfNeeded();
		await page.screenshot({ path: testInfo.outputPath("live-media-desktop.png") });
		await page.setViewportSize({ width: 390, height: 844 });
		const closeRail = page.locator(".rail-mobile-close");
		if (await closeRail.isVisible()) await closeRail.click();
		await liveImage.scrollIntoViewIfNeeded();
		for (const media of [liveImage, liveVideo]) {
			const box = (await media.boundingBox())!;
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(390);
		}
		await expect(imageRow.getByRole("link", { name: "下载图片", exact: true })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("live-media-mobile.png") });
		releaseReply();
		await expect(page.getByRole("button", { name: "停止任务", exact: true })).toHaveCount(0);
		const savedImage = page.locator(".tool-row .tool-image-preview");
		await expect(savedImage).toHaveCount(1);
		await expect(savedImage).toBeVisible();
		await expect(page.locator(".tool-row video")).toHaveCount(1);
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.reload();
		await page.getByRole("button", { name: "MEDIA_LIVE_E2E generate image and video", exact: true }).click();
		await expect(savedImage).toHaveCount(1);
		await expect.poll(() => savedImage.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(480);
		await expect(page.locator(".tool-row:has(.tool-image-preview) .artifact-line")).toHaveCount(0);
		await expect(
			page.locator(".tool-row:has(.tool-image-preview)").getByRole("link", { name: "下载图片", exact: true })
		).toBeVisible();
		await expect(page.locator(".tool-row video")).toBeVisible();
		expect(providerErrors).toEqual([]);
	} finally {
		releaseReply();
		finalReplyGate = undefined;
	}
});

for (const mode of ["auto", "manual"] as const) {
	test(`uses host defaults for a ${mode} local skill without configuring its provider`, async ({ page }) => {
		test.setTimeout(90_000);
		await page.addInitScript(() =>
			localStorage.setItem(
				"wuming.permission",
				JSON.stringify({ sandboxMode: "unrestricted", approvalPolicy: "never" })
			)
		);
		await openApp(page, webUrl);
		await page.locator(".session-entry").first().click();
		await expect(page.locator(".session-entry.selected")).toHaveCount(1);
		await expect(page.locator(".sidebar-new-chat")).toBeEnabled();
		await page.locator(".sidebar-new-chat").click();
		await expect(page.locator(".session-entry.selected")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "权限模式：完全访问权限", exact: true })).toBeEnabled();
		const input = page.getByRole("textbox", { name: "消息", exact: true });
		if (mode === "manual") {
			await input.fill("$manual-media");
			await expect(
				page.getByRole("listbox", { name: "选择技能" }).getByRole("option", { name: /Manual media/ })
			).toBeVisible();
			await input.press("Tab");
			await expect(page.locator(".composer-selected-skill")).toContainText("Manual media");
		}
		await input.fill(
			mode === "manual"
				? "FAVORITE_MEDIA_MANUAL 请按所选技能生成图片和视频"
				: "FAVORITE_MEDIA_AUTO 请加载 favorite-media 技能生成图片和视频"
		);
		await page.getByRole("button", { name: "发送", exact: true }).click();
		const img = page.locator(".tool-row .tool-image-preview");
		const player = page.locator(".tool-row video");
		await expect
			.poll(async () => {
				const errors = await page.locator(".failure-details pre").allTextContents();
				return errors.length ? errors.join("\n") : (await img.count()) ? "image" : "pending";
			})
			.toBe("image");
		await expect(img).toBeVisible({ timeout: 20_000 });
		await expect(player).toBeVisible({ timeout: 45_000 });
		await expect.poll(() => player.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
		expect(skillEvidence).toContain(mode);
		expect(providerErrors).toEqual([]);
		await expect(access(join(workspaceRoot, ".env"))).rejects.toThrow();
		const id = mode === "manual" ? "manual-media" : "favorite-media";
		expect(await readFile(join(workspaceRoot, ".wuming", "skills", id, "SKILL.md"), "utf8")).toContain(favoriteBody);
		await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeHidden();
	});
}

test("keeps returned images recoverable without another generation charge and labels retrieval correctly", async ({
	page,
}, testInfo) => {
	await page.addInitScript(() =>
		localStorage.setItem("wuming.permission", JSON.stringify({ sandboxMode: "unrestricted", approvalPolicy: "never" }))
	);
	await openApp(page, webUrl);
	await page.locator(".session-entry").first().click();
	await page.locator(".sidebar-new-chat").click();
	const before = requests.filter((value) => value === "POST /v1/images/generations").length;
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("IMAGE_RECOVERY_E2E 生成图片");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText("图片结果已返回，但下载受阻，已保留结果，未重新生成。", { exact: true })).toBeVisible({
		timeout: 20_000,
	});
	const pending = page.locator(".tool-state").filter({ hasText: "结果已返回，待取回" });
	await expect(pending).toHaveCount(2);
	await expect(page.locator(".tool-verb").filter({ hasText: "取回图片" })).toBeVisible();
	await expect(page.locator(".tool-image-preview")).toHaveCount(0);
	expect(requests.filter((value) => value === "POST /v1/images/generations")).toHaveLength(before + 1);
	await page.screenshot({ path: testInfo.outputPath("image-retrieval-pending-desktop.png") });
	await page.reload();
	await page.getByRole("button", { name: "IMAGE_RECOVERY_E2E 生成图片", exact: true }).click();
	await expect(pending).toHaveCount(2);
	await page.setViewportSize({ width: 390, height: 844 });
	const closeRail = page.locator(".rail-mobile-close");
	if (await closeRail.isVisible()) await closeRail.click();
	await page.screenshot({ path: testInfo.outputPath("image-retrieval-pending-mobile.png") });
	expect(providerErrors).toEqual([]);
	expect(requests.filter((value) => value === "POST /v1/images/generations")).toHaveLength(before + 1);
});

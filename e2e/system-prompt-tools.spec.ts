import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import type { Command, CommandResult, ServerMessage } from "@wuming/protocol";
import { bearerProtocol } from "../apps/gateway/src/auth.js";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

interface WireMessage {
	role: string;
	content: string | Array<{ text?: string }>;
}
interface WireRequest {
	model: string;
	stream?: boolean;
	messages: WireMessage[];
	tools?: Array<{ function: { name: string; description?: string } }>;
}
const text = (content: WireMessage["content"]) =>
	typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
const requests: WireRequest[] = [];
const errors: string[] = [];
let webUrl: string;
let provider: Server;
let socket: WebSocket;
let workspaceId: string;

async function rpc(command: Command): Promise<CommandResult> {
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off("message", listener);
			reject(new Error("Prompt fixture RPC timed out"));
		}, 10_000);
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

test.beforeAll(async () => {
	// The real Pi runtime calls this local provider. No paid model or external operation is used.
	provider = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString()) as WireRequest;
			const lastUser = body.messages.findLastIndex(
				(message) => message.role === "user" && text(message.content).includes("PROMPT_TOOL_CHECK")
			);
			const relevant = lastUser >= 0 && Boolean(body.tools?.length);
			if (relevant) requests.push(body);
			const hasResult = body.messages.slice(lastUser + 1).some((message) => message.role === "tool");
			const call = relevant && !hasResult;
			const reply = relevant ? "本地接线测试：已读取测试文件；这不是真实模型的行为评测。" : "Prompt tool fixture";
			if (!body.stream) {
				response.writeHead(200, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						id: "prompt-fixture",
						object: "chat.completion",
						created: 1,
						model: body.model,
						choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
					})
				);
				return;
			}
			const delta = call
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "read-fixture-" + requests.length,
								type: "function",
								function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) },
							},
						],
					}
				: { role: "assistant", content: reply };
			const frame = (value: unknown, reason: string | null) =>
				JSON.stringify({
					id: "prompt-fixture",
					object: "chat.completion.chunk",
					created: 1,
					model: body.model,
					choices: [{ index: 0, delta: value, finish_reason: reason }],
				});
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(
				"data: " + frame(delta, null) + "\n\ndata: " + frame({}, call ? "tool_calls" : "stop") + "\n\ndata: [DONE]\n\n"
			);
		} catch (error) {
			errors.push(String(error));
			response.writeHead(500).end("Local prompt fixture failed");
		}
	});
	provider.listen(0, "127.0.0.1");
	await once(provider, "listening");
	const address = provider.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture port");
	const environment: Record<string, string> = {
		WUMING_RUNTIME: "pi",
		WUMING_DEPLOYMENT_MODE: "local_device",
		WUMING_BROWSER_ENABLED: "true",
		WUMING_PREVIEW_ENABLED: "false",
		WUMING_PROCESS_MODE: "local",
	};
	webUrl = await startWebApp(environment, async (workspace) => {
		environment.WUMING_AGENT_DIR = join(workspace, ".agent");
		await mkdir(environment.WUMING_AGENT_DIR);
	});
	socket = new WebSocket(webUrl.replace("http:", "ws:") + "api/ws", ["wuming.v1", bearerProtocol(token)]);
	await once(socket, "open");
	const hello = once(socket, "message");
	socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: "prompt-tools-test", capabilities: [] }));
	await hello;
	await rpc({
		type: "model.custom.set",
		config: {
			provider: "prompt-fixture",
			id: "prompt-model",
			name: "Local prompt fixture",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:" + address.port + "/v1",
			apiKey: "local-fixture-only",
			input: ["text"],
			contextWindow: 128000,
			maxOutputTokens: 2048,
		},
	});
	const workspaces = await rpc({ type: "workspace.list" });
	if (workspaces.type !== "workspace.list") throw new Error("Missing workspace");
	workspaceId = workspaces.workspaces[0]!.id;
});

test.afterAll(async () => {
	socket?.close();
	await stopWebApp();
	if (provider) await new Promise<void>((resolve) => provider.close(() => resolve()));
});

for (const sandboxMode of ["read_only", "workspace_write"] as const) {
	for (const width of [1440, 390]) {
		test("matches prompt guidance to " + sandboxMode + " tools at " + width, async ({ page }, testInfo) => {
			const browserErrors: string[] = [];
			page.on("pageerror", (error) => browserErrors.push(error.message));
			const name = "Prompt " + sandboxMode + " " + width;
			const created = await rpc({
				type: "session.create",
				workspaceId,
				name,
				model: { provider: "prompt-fixture", id: "prompt-model" },
				thinkingLevel: "off",
				sandboxMode,
				approvalPolicy: "never",
			});
			await openApp(page, webUrl);
			await page.getByRole("navigation", { name: "会话" }).getByRole("button", { name, exact: true }).click();
			await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeEnabled();
			if (created.type !== "session.created") throw new Error("Missing test session");
			// Selecting a chat applies the UI's global policy. Exercise backend read-only mode
			// after selection; it is intentionally not an option in the current permission picker.
			const configured = await rpc({
				type: "session.policy.set",
				sessionId: created.snapshot.session.id,
				sandboxMode,
				approvalPolicy: "never",
			});
			if (configured.type !== "session.configured") throw new Error("Missing policy confirmation");
			expect(configured.snapshot.sandboxMode).toBe(sandboxMode);
			await page.setViewportSize({ width, height: 900 });
			const closeRail = page.locator(".rail-mobile-close");
			if (await closeRail.isVisible()) await closeRail.click();
			const before = requests.length;
			await page
				.getByRole("textbox", { name: "消息", exact: true })
				.fill("PROMPT_TOOL_CHECK 只读取 readme.md，不修改任何文件。");
			await page.getByRole("button", { name: "发送", exact: true }).click();
			await expect(
				page.getByText("本地接线测试：已读取测试文件；这不是真实模型的行为评测。", { exact: true })
			).toBeVisible({ timeout: 30_000 });
			await expect(page.locator(".session-entry.selected")).toHaveAttribute("data-phase", "idle");
			const turn = requests.slice(before);
			expect(turn).toHaveLength(2);
			expect(
				turn[1]!.messages.some((message) => message.role === "tool" && text(message.content).includes("# E2E"))
			).toBe(true);
			for (const request of turn) {
				const tools = request.tools!.map((tool) => tool.function.name);
				const system = request.messages
					.filter((message) => ["system", "developer"].includes(message.role))
					.map((message) => text(message.content))
					.join("\n");
				const guidelines = /<tool_guidelines>\n([\s\S]*?)\n<\/tool_guidelines>/.exec(system)?.[1];
				expect(guidelines).toBeDefined();
				expect(guidelines).toContain("Call only tools registered for this session");
				expect(tools).toContain("browser_screenshot");
				expect(tools).toContain("skill_load");
				expect(tools).toContain("browser_diagnostics");
				expect(guidelines).toContain("Check browser_diagnostics");
				const skillLoad = request.tools!.find((tool) => tool.function.name === "skill_load")!;
				expect(skillLoad.function.description).toContain("Load an applicable skill with skill_load BEFORE work");
				expect(skillLoad.function.description).toContain("recheck current availability with skill_list");
				if (sandboxMode === "read_only") {
					for (const unavailable of ["browser_download", "browser_action", "exec", "write_file"])
						expect(tools).not.toContain(unavailable);
					expect(guidelines).not.toContain("browser_download");
					expect(guidelines).not.toContain("browser_action");
					expect(guidelines).toContain("Do not claim interaction coverage");
				} else {
					expect(tools).toContain("browser_download");
					expect(guidelines).toContain("Use browser_download");
					expect(guidelines).toContain("Exercise the affected interaction with browser_action");
				}
			}
			expect(errors).toEqual([]);
			expect(browserErrors).toEqual([]);
			await page.screenshot({ path: testInfo.outputPath("prompt-tools.png"), fullPage: true });
		});
	}
}

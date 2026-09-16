import { expect, test } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import type { Command, CommandResult, ServerMessage } from "@wuming/protocol";
import { bearerProtocol } from "../apps/gateway/src/auth.js";
import { openApp, restartGateway, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;
let provider: Server;
let socket: WebSocket;
let workspaceId: string;
let held: ServerResponse | undefined;
const errors: string[] = [];
const model = { provider: "history-fixture", id: "history-fixture" };

function frame(delta: unknown, finish: string | null = null): string {
	return (
		"data: " +
		JSON.stringify({
			id: "history-fixture",
			object: "chat.completion.chunk",
			created: 1,
			model: model.id,
			choices: [{ index: 0, delta, finish_reason: finish }],
		}) +
		"\n\n"
	);
}

async function connect() {
	socket = new WebSocket(webUrl.replace("http:", "ws:") + "api/ws", ["wuming.v1", bearerProtocol(token)]);
	await once(socket, "open");
	const hello = once(socket, "message");
	socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: crypto.randomUUID(), capabilities: [] }));
	await hello;
}

async function rpc(command: Command): Promise<CommandResult> {
	const requestId = crypto.randomUUID();
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off("message", listener);
			reject(new Error("RPC timeout"));
		}, 10000);
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
}

test.beforeAll(async () => {
	provider = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			if (request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString());
			const messages = body.messages as Array<{ role: string; content: unknown }>;
			const lastUser = messages.findLastIndex((message) => message.role === "user");
			const text = JSON.stringify(messages[lastUser]?.content);
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			if (!text.includes("CHECKPOINT_EXERCISE")) {
				response.end(
					frame({ role: "assistant", content: "EARLIER_REPLY_PRESERVED" }) + frame({}, "stop") + "data: [DONE]\n\n"
				);
				return;
			}
			if (!messages.slice(lastUser + 1).some((message) => message.role === "tool")) {
				response.end(
					frame({
						role: "assistant",
						content: "STEP_ONE_SAVED",
						tool_calls: [
							{
								index: 0,
								id: "history-read",
								type: "function",
								function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) },
							},
						],
					}) +
						frame({}, "tool_calls") +
						"data: [DONE]\n\n"
				);
				return;
			}
			response.write(frame({ role: "assistant", content: "STREAM_PREFIX" }));
			held = response;
			response.once("close", () => {
				if (held === response) held = undefined;
			});
		} catch (error) {
			errors.push(String(error));
			response.end();
		}
	});
	provider.listen(0, "127.0.0.1");
	await once(provider, "listening");
	const address = provider.address();
	if (!address || typeof address === "string") throw new Error("Missing provider address");
	const environment: Record<string, string> = {
		WUMING_RUNTIME: "pi",
		WUMING_DEPLOYMENT_MODE: "local_device",
		WUMING_BROWSER_ENABLED: "false",
		WUMING_PREVIEW_ENABLED: "false",
	};
	webUrl = await startWebApp(environment, async (workspace) => {
		environment.WUMING_WORKSPACES_JSON = JSON.stringify([
			{ id: "history-workspace", name: "History test", path: workspace },
		]);
	});
	await connect();
	await rpc({
		type: "model.custom.set",
		config: {
			...model,
			name: model.id,
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:" + address.port + "/v1",
			apiKey: "fixture-only",
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
	held?.destroy();
	await stopWebApp();
	if (provider) {
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
	}
});

for (const restart of [false, true]) {
	test(
		"restores real Pi history while running, then " + (restart ? "after a gateway restart" : "after completion"),
		async ({ page }, testInfo) => {
			const created = await rpc({
				type: "session.create",
				workspaceId,
				name: restart ? "Restart history" : "Reload history",
				model,
				thinkingLevel: "off",
				sandboxMode: "read_only",
				approvalPolicy: "never",
			});
			if (created.type !== "session.created") throw new Error("Missing session");
			const sessionId = created.snapshot.session.id;
			await page.addInitScript(
				({ workspaceId, sessionId }) => {
					localStorage.setItem("wuming.workspaceId", workspaceId);
					localStorage.setItem("wuming.sessionId." + workspaceId, sessionId);
					localStorage.setItem(
						"wuming.permission",
						JSON.stringify({ sandboxMode: "read_only", approvalPolicy: "never" })
					);
				},
				{ workspaceId, sessionId }
			);
			await page.setViewportSize({ width: 1440, height: 1000 });
			await openApp(page, webUrl);
			const send = async (text: string) => {
				await rpc({ type: "turn.prompt", sessionId, content: [{ type: "text", text }] });
			};
			const history = page.locator(".transcript");
			await send("earlier turn");
			await expect(history).toContainText("EARLIER_REPLY_PRESERVED");
			await expect
				.poll(async () => {
					const snapshot = await rpc({ type: "session.snapshot.get", sessionId });
					return snapshot.type === "session.snapshot" && snapshot.snapshot.session.phase;
				})
				.toBe("idle");
			await send("CHECKPOINT_EXERCISE");
			await expect(history).toContainText("STREAM_PREFIX");
			await expect(history).toContainText("STEP_ONE_SAVED");
			await page.locator(".sidebar-new-chat").click();
			await expect(history).not.toContainText("STREAM_PREFIX");
			await page.getByRole("button", { name: restart ? "Restart history" : "Reload history", exact: true }).click();
			await expect(history.getByText("STREAM_PREFIX", { exact: true })).toHaveCount(1);
			await page.reload();
			await expect(history).toContainText("EARLIER_REPLY_PRESERVED");
			await expect(history).toContainText("STEP_ONE_SAVED");
			await expect(history.getByText("STREAM_PREFIX", { exact: true })).toHaveCount(1);
			const running = await rpc({ type: "session.snapshot.get", sessionId });
			expect(
				running.type === "session.snapshot" &&
					running.snapshot.transcript.some(
						(item) => item.type === "tool" && item.toolName === "read_file" && item.status === "complete"
					)
			).toBe(true);
			await page.screenshot({ path: testInfo.outputPath("running-after-reload.png") });
			if (restart) {
				await restartGateway();
				await connect();
				await expect(page.locator(".connection")).toHaveClass(/(?:^|\s)connected(?:\s|$)/);
				await page.reload();
				await expect(history).toContainText("EARLIER_REPLY_PRESERVED");
				await expect(history).toContainText("STEP_ONE_SAVED");
				await expect(history.getByText("STREAM_PREFIX", { exact: true })).toHaveCount(1);
				const recovered = await rpc({ type: "session.snapshot.get", sessionId });
				expect(recovered.type === "session.snapshot" && recovered.snapshot.session.phase).toBe("idle");
				expect(
					recovered.type === "session.snapshot" &&
						recovered.snapshot.transcript.some((item) => item.type === "assistant" && item.status === "streaming")
				).toBe(false);
			} else {
				expect(held).toBeDefined();
				held!.write(frame({ content: "_CONTINUED" }));
				await expect(history.getByText("STREAM_PREFIX_CONTINUED", { exact: true })).toHaveCount(1);
				held!.end(frame({}, "stop") + "data: [DONE]\n\n");
				await expect
					.poll(async () => {
						const snapshot = await rpc({ type: "session.snapshot.get", sessionId });
						return snapshot.type === "session.snapshot" && snapshot.snapshot.session.phase;
					})
					.toBe("idle");
				await page.reload();
				await expect(history.getByText("STREAM_PREFIX_CONTINUED", { exact: true })).toHaveCount(1);
				await expect(history.getByText("STEP_ONE_SAVED", { exact: true })).toHaveCount(1);
			}
			await page.setViewportSize({ width: 390, height: 844 });
			await page.reload();
			await expect(history).toContainText("EARLIER_REPLY_PRESERVED");
			await page.screenshot({ path: testInfo.outputPath("history-mobile.png") });
			expect(errors).toEqual([]);
		}
	);
}

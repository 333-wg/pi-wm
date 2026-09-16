import type { Page } from "@playwright/test";
import { once } from "node:events";
import WebSocket from "ws";
import type { ServerMessage, SubagentSummary } from "@wuming/protocol";
import { bearerProtocol } from "../apps/gateway/src/auth.js";

/** Seed a delegated task without adding a manual agent-management UI. */
export async function createTestSubagent(page: Page, task: string, name: string): Promise<SubagentSummary> {
	const { token, sessionId } = await page.evaluate(() => ({
		token: localStorage.getItem("wuming.token"),
		sessionId: localStorage.getItem("wuming.sessionId." + localStorage.getItem("wuming.workspaceId")),
	}));
	if (!token || !sessionId) throw new Error("Test requires an attached session");
	const url = new URL("/api/ws", page.url());
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(url, ["wuming.v1", bearerProtocol(token)]);
	try {
		await once(socket, "open");
		const hello = once(socket, "message");
		socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: crypto.randomUUID(), capabilities: [] }));
		await hello;
		return await new Promise<SubagentSummary>((resolve, reject) => {
			const requestId = crypto.randomUUID();
			const timer = setTimeout(() => reject(new Error("Subagent fixture timed out")), 10000);
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as ServerMessage;
				if (message.type !== "response" || message.requestId !== requestId) return;
				clearTimeout(timer);
				if (message.ok && message.result.type === "subagent.created") resolve(message.result.subagent);
				else reject(new Error(message.ok ? "Unexpected fixture response" : message.error.message));
			});
			socket.send(
				JSON.stringify({
					type: "request",
					requestId,
					idempotencyKey: requestId,
					command: { type: "subagent.create", sessionId, task, name },
				})
			);
		});
	} finally {
		socket.close();
	}
}

import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export async function openDesktopRpc(connection) {
	const ws = new WebSocket(
		connection.websocketUrl,
		["wuming.v1", `wuming.bearer.${Buffer.from(connection.token).toString("base64url")}`],
		{ origin: "wuming://app", handshakeTimeout: 10_000 }
	);
	const pending = new Map();
	ws.on("message", (raw) => {
		const message = JSON.parse(raw.toString());
		if (message.type !== "response") return;
		const item = pending.get(message.requestId);
		if (!item) return;
		clearTimeout(item.timer);
		pending.delete(message.requestId);
		if (message.ok) item.resolve(message.result);
		else item.reject(new Error(message.error.message));
	});
	ws.on("close", () => {
		for (const item of pending.values()) {
			clearTimeout(item.timer);
			item.reject(new Error("Gateway disconnected"));
		}
		pending.clear();
	});
	await once(ws, "open");
	const hello = once(ws, "message", { signal: AbortSignal.timeout(10_000) });
	ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: randomUUID(), capabilities: [] }));
	await hello;
	return {
		request(command) {
			const requestId = randomUUID();
			return new Promise((resolve, reject) => {
				if (ws.readyState !== WebSocket.OPEN) return reject(new Error("Gateway is not connected"));
				const timer = setTimeout(() => {
					pending.delete(requestId);
					reject(new Error(`RPC timeout: ${command.type}`));
				}, 15_000);
				pending.set(requestId, { resolve, reject, timer });
				ws.send(JSON.stringify({ type: "request", requestId, idempotencyKey: requestId, command }));
			});
		},
		async close() {
			if (ws.readyState === WebSocket.CLOSED) return;
			const closed = once(ws, "close");
			ws.close();
			await closed;
		},
	};
}

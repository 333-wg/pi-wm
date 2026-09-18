import { desktopConnection } from "./desktop.js";

export function gatewayWebSocketUrl(): string {
	return (
		desktopConnection()?.websocketUrl ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`
	);
}

export function bearerProtocol(token: string): string {
	const bytes = new TextEncoder().encode(token);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `wuming.bearer.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

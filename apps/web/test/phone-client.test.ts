import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PhoneClient } from "../src/phone-client.js";
class Socket {
	static OPEN = 1;
	static CLOSING = 2;
	static instances: Socket[] = [];
	readyState = 0;
	onopen?: () => void;
	onmessage?: (e: { data: string }) => void;
	onclose?: (e: { code: number; reason: string }) => void;
	sent: any[] = [];
	constructor(..._args: unknown[]) {
		Socket.instances.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	message(value: unknown) {
		this.onmessage?.({ data: JSON.stringify(value) });
	}
	close(code = 1000, reason = "") {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
}
let client: PhoneClient;
let status = vi.fn<(value: string) => void>();
beforeEach(() => {
	vi.useFakeTimers();
	Socket.instances = [];
	vi.stubGlobal("location", { protocol: "https:", host: "phone.example.com" });
	vi.stubGlobal("WebSocket", Socket);
	status = vi.fn<(value: string) => void>();
	client = new PhoneClient(vi.fn(), status, vi.fn());
});
afterEach(() => {
	client.close();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
it("requires protocol hello, reconnects with cursor and never replays an unknown write", async () => {
	client.connect();
	client.connect();
	expect(Socket.instances).toHaveLength(1);
	const first = Socket.instances[0]!;
	first.open();
	await expect(client.request({ type: "workspace.list" })).rejects.toThrow("未发送");
	first.message({ type: "hello" });
	first.message({ type: "event", cursor: "cursor-one" });
	const pending = client.request(
		{ type: "turn.prompt", sessionId: "one", content: [{ type: "text", text: "once" }] },
		"stable"
	);
	const failed = expect(pending).rejects.toThrow("结果未知");
	first.close(1006);
	await failed;
	vi.advanceTimersByTime(1000);
	const second = Socket.instances[1]!;
	second.open();
	second.message({ type: "hello" });
	expect(second.sent).toEqual([expect.objectContaining({ type: "hello", resumeCursor: "cursor-one" })]);
	expect(status).toHaveBeenLastCalledWith("已连接");
	const retry = client.request({ type: "workspace.list" }, "read");
	second.message({
		type: "response",
		requestId: second.sent.at(-1).requestId,
		ok: true,
		result: { type: "workspace.list", workspaces: [] },
	});
	await expect(retry).resolves.toMatchObject({ type: "workspace.list" });
});
it("reconnects timed-out sockets but stops on device revocation", async () => {
	client.connect();
	const socket = Socket.instances[0]!;
	socket.open();
	socket.message({ type: "hello" });
	const pending = client.request({ type: "workspace.list" });
	const failed = expect(pending).rejects.toThrow("响应超时");
	vi.advanceTimersByTime(20000);
	await failed;
	vi.advanceTimersByTime(1000);
	const next = Socket.instances[1]!;
	next.open();
	next.message({ type: "hello" });
	next.close(1008, "Phone access revoked");
	client.reconnect();
	vi.advanceTimersByTime(120000);
	expect(Socket.instances).toHaveLength(2);
	expect(status).toHaveBeenLastCalledWith("授权已撤销，请重新配对");
});
it.each([1008, 1013])("recovers rate limiting (%s) without revoking authorization or replaying writes", (code) => {
	client.connect();
	const socket = Socket.instances[0]!;
	socket.open();
	socket.message({ type: "hello" });
	socket.close(code, "Phone request rate limit");
	expect(status).toHaveBeenLastCalledWith(expect.stringContaining("请求频繁"));
	client.reconnect();
	vi.advanceTimersByTime(59000);
	expect(Socket.instances).toHaveLength(1);
	vi.advanceTimersByTime(1000);
	expect(Socket.instances).toHaveLength(2);
	expect(Socket.instances[1]!.sent).toEqual([]);
});
it("does not mislabel other policy closures as revoked", () => {
	client.connect();
	Socket.instances[0]!.close(1008, "Desktop-only capability");
	expect(status).toHaveBeenLastCalledWith("连接受限，请检查电脑端提示后重新连接");
	vi.advanceTimersByTime(60000);
	expect(Socket.instances).toHaveLength(1);
	client.reconnect();
	expect(Socket.instances).toHaveLength(2);
});

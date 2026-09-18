import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSession, terminalSize } from "../src/lib/terminal-session.js";

class Socket extends EventTarget {
	readyState = 0;
	sent: Array<Record<string, unknown>> = [];
	send(data: string) {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}
	open() {
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}
	message(data: object) {
		this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(data) }));
	}
	close(code = 1000) {
		this.readyState = 3;
		this.dispatchEvent(Object.assign(new Event("close"), { code }));
	}
	last() {
		return this.sent.at(-1)!;
	}
}

let session: TerminalSession;
let sockets: Socket[];
let output = vi.fn<(data: string, reset: boolean) => void>();

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("location", { protocol: "http:", host: "localhost:5173" });
	sockets = [];
	output = vi.fn<(data: string, reset: boolean) => void>();
	session = new TerminalSession({
		token: "test-token",
		workspaceId: "workspace",
		onState: vi.fn(),
		onOutput: output,
		openSocket: () => {
			const socket = new Socket();
			sockets.push(socket);
			return socket as unknown as WebSocket;
		},
	});
});

afterEach(() => {
	session.dispose();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function hello(socket: Socket) {
	socket.open();
	socket.message({ type: "hello", capabilities: ["terminal"] });
}

function create() {
	session.connect();
	const socket = sockets[0]!;
	hello(socket);
	socket.message({
		type: "terminal.shells",
		requestId: socket.last().requestId,
		shells: [{ id: "cmd", label: "CMD" }],
		defaultShellId: "cmd",
	});
	const request = socket.last();
	return { socket, request, terminalId: request.terminalId };
}

function ready() {
	const created = create();
	created.socket.message({
		type: "terminal.ready",
		requestId: created.request.requestId,
		terminalId: created.terminalId,
		shell: "CMD",
		shellId: "cmd",
		cwd: "D:\\project",
		seq: 0,
	});
	return created;
}

describe("terminal sessions", () => {
	it("chunks large paste without splitting surrogate pairs and blocks input while disconnected", () => {
		const { socket } = ready();
		const data = "x".repeat(65535) + "\u{1f680}" + "end";
		session.input(data);
		const chunks = socket.sent.filter((message) => message.type === "terminal.input");
		expect(chunks.map((message) => message.data).join("")).toBe(data);
		expect(String(chunks[0]!.data).length).toBe(65535);
		socket.close(1006);
		const count = socket.sent.length;
		session.input("lost");
		expect(socket.sent).toHaveLength(count);
	});

	it("never reconnects or mutates output after disposal", () => {
		const { socket, terminalId } = ready();
		session.dispose();
		expect(socket.last()).toMatchObject({ type: "terminal.close", terminalId });
		socket.message({ type: "terminal.output", terminalId, seq: 1, data: "late" });
		vi.advanceTimersByTime(60_000);
		expect(output).not.toHaveBeenCalled();
		expect(sockets).toHaveLength(1);
	});

	it("discovers shells before creating and bounds dimensions to the protocol", () => {
		session.resize(10, 1);
		const { socket } = create();
		expect(socket.last()).toMatchObject({ type: "terminal.create", cols: 20, rows: 5, shellId: "cmd" });
		expect(terminalSize(900, 1000)).toEqual({ cols: 400, rows: 200 });
	});

	it("reattaches the same process after loss, ignores duplicate output, and accepts missing output", () => {
		const { socket, terminalId } = ready();
		socket.message({ type: "terminal.output", terminalId, seq: 1, data: "first" });
		socket.close(1006);
		session.input("must not be sent");
		vi.advanceTimersByTime(500);
		const reconnect = sockets[1]!;
		hello(reconnect);
		expect(reconnect.last()).toMatchObject({ type: "terminal.attach", terminalId, sinceSeq: 1 });
		reconnect.message({ type: "terminal.output", terminalId, seq: 1, data: "duplicate" });
		reconnect.message({ type: "terminal.output", terminalId, seq: 2, data: "second" });
		reconnect.message({
			type: "terminal.ready",
			requestId: reconnect.last().requestId,
			terminalId,
			shell: "CMD",
			seq: 2,
		});
		expect(output.mock.calls).toEqual([
			["first", false],
			["second", false],
		]);
		expect(session.state.status).toBe("ready");
	});

	it("reattaches uncertain creation when the ready response was lost", () => {
		const { socket, terminalId } = create();
		socket.close(1006);
		vi.advanceTimersByTime(500);
		hello(sockets[1]!);
		expect(sockets[1]!.last()).toMatchObject({ type: "terminal.attach", terminalId });
	});

	it("does not silently replace a lost process", () => {
		const { socket } = ready();
		socket.close(1006);
		vi.advanceTimersByTime(500);
		const next = sockets[1]!;
		hello(next);
		next.message({ type: "terminal.error", requestId: next.last().requestId, code: "not_found", message: "gone" });
		expect(session.state).toMatchObject({ status: "error", hasProcess: false });
		expect(next.sent.some((message) => message.type === "terminal.create")).toBe(false);
	});

	it("stops at capacity rather than looping create and attach", () => {
		const { socket, request } = create();
		socket.message({ type: "terminal.error", requestId: request.requestId, code: "capacity_reached", message: "full" });
		vi.advanceTimersByTime(60_000);
		expect(session.state).toMatchObject({ status: "error", error: "full", hasProcess: false });
		expect(sockets).toHaveLength(1);
	});

	it("requires acknowledgement before restarting in a new shell", () => {
		const { socket, terminalId } = ready();
		session.close("powershell");
		expect(socket.last()).toMatchObject({ type: "terminal.close", terminalId });
		expect(sockets).toHaveLength(1);
		socket.message({ type: "terminal.closed", requestId: socket.last().requestId, terminalId });
		expect(sockets).toHaveLength(2);
		hello(sockets[1]!);
		sockets[1]!.message({
			type: "terminal.shells",
			requestId: sockets[1]!.last().requestId,
			shells: [{ id: "powershell", label: "PowerShell" }],
			defaultShellId: "powershell",
		});
		expect(sockets[1]!.last()).toMatchObject({ type: "terminal.create", shellId: "powershell" });
		expect(sockets[1]!.last().terminalId).not.toBe(terminalId);
	});

	it("restores a pending close after a connection loss without recreating a shell", () => {
		const { socket, terminalId } = ready();
		session.close();
		socket.close(1006);
		vi.advanceTimersByTime(500);
		hello(sockets[1]!);
		expect(sockets[1]!.last()).toMatchObject({ type: "terminal.close", terminalId });
		sockets[1]!.message({
			type: "terminal.error",
			requestId: sockets[1]!.last().requestId,
			code: "not_found",
			message: "gone",
		});
		expect(session.state.status).toBe("closed");
	});

	it("bounds connection timeouts and retries, allowing a manual retry", () => {
		session.connect();
		vi.advanceTimersByTime(90_000);
		expect(sockets).toHaveLength(5);
		expect(session.state.status).toBe("error");
		session.retry();
		expect(sockets).toHaveLength(6);
	});

	it("handles protocol and authentication failures without an endless retry", () => {
		session.connect();
		sockets[0]!.close(1008);
		vi.advanceTimersByTime(60_000);
		expect(session.state.status).toBe("error");
		expect(sockets).toHaveLength(1);
	});
});

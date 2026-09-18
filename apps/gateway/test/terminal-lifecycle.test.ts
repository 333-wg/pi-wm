import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalServerMessage } from "@wuming/protocol";
import { TerminalManager } from "../src/terminal.js";

const pty = vi.hoisted(() => ({ output: (_data: string) => {}, kill: vi.fn(), resize: vi.fn() }));
vi.mock("node-pty", () => ({
	spawn: () => ({
		onData: (callback: (data: string) => void) => {
			pty.output = callback;
			return { dispose() {} };
		},
		onExit: () => ({ dispose() {} }),
		kill: pty.kill,
		resize: pty.resize,
		write: vi.fn(),
	}),
}));
vi.mock("../src/terminal-shells.js", () => ({
	discoverTerminalShells: () => [{ id: "test", label: "Test", file: "/shell", args: [] }],
}));

let manager: TerminalManager;
const owner = { principalId: "user", workspaceId: "workspace" };
const input = {
	terminalId: "terminal",
	requestId: "create",
	owner,
	cols: 80,
	rows: 24,
	connectionId: "original",
	send: () => {},
};

beforeEach(() => {
	vi.useFakeTimers();
	pty.kill.mockClear();
});
afterEach(async () => {
	await manager?.[Symbol.asyncDispose]();
	vi.useRealTimers();
});

function create(maxBufferBytes = 1000) {
	manager = new TerminalManager({
		workspaceRoot: "/workspace",
		mode: "host",
		assertWorkspace: () => "/workspace",
		maxBufferBytes,
		maxTerminals: 1,
		idleTimeoutMs: 1000,
	});
	manager.create(input);
}

function attach(sinceSeq: number) {
	const messages: TerminalServerMessage[] = [];
	manager.attach({ ...input, sinceSeq, connectionId: "new", send: (message) => messages.push(message) });
	return messages;
}

describe("terminal lifecycle", () => {
	it("replays only missing events and preserves the process on detach", () => {
		create();
		pty.output("first");
		pty.output("second");
		manager.detachConnection("original");
		expect(pty.kill).not.toHaveBeenCalled();
		expect(attach(1)).toEqual([{ type: "terminal.output", terminalId: "terminal", seq: 2, data: "second" }]);
		expect(attach(2)).toEqual([]);
	});

	it("resets to bounded retained history after the replay window is exceeded", () => {
		create(8);
		pty.output("first");
		pty.output("second");
		expect(attach(0)).toEqual([{ type: "terminal.reset", terminalId: "terminal", seq: 2, data: "second" }]);
	});

	it("does not split UTF-8 characters when trimming an oversized chunk", () => {
		create(8);
		pty.output("字".repeat(20));
		expect(attach(0)).toEqual([{ type: "terminal.reset", terminalId: "terminal", seq: 1, data: "字字" }]);
	});

	it("starts the grace period at disconnection, not at the last command", () => {
		create();
		vi.advanceTimersByTime(5000);
		expect(manager.activeCount).toBe(1);
		manager.detachConnection("original");
		vi.advanceTimersByTime(500);
		expect(manager.activeCount).toBe(1);
		vi.advanceTimersByTime(2000);
		expect(manager.activeCount).toBe(0);
	});

	it("distinguishes duplicate identifiers, capacity, and unavailable shells", () => {
		create();
		expect(() => manager.create(input)).toThrow(expect.objectContaining({ code: "conflict" }));
		expect(() => manager.create({ ...input, terminalId: "other" })).toThrow(
			expect.objectContaining({ code: "capacity_reached" })
		);
		manager.close({ ...input });
		expect(() => manager.create({ ...input, shellId: "arbitrary.exe" })).toThrow(
			expect.objectContaining({ code: "process_unavailable" })
		);
	});
});

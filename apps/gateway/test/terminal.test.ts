import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../src/terminal.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

function waitForOutput(outputs: string[], text: string): Promise<void> {
	if (outputs.join("").includes(text)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const deadline = setTimeout(
			() => reject(new Error(`Timed out waiting for ${text}; got ${outputs.join("")}`)),
			5000
		);
		const check = setInterval(() => {
			if (!outputs.join("").includes(text)) return;
			clearTimeout(deadline);
			clearInterval(check);
			resolve();
		}, 25);
	});
}

describe("TerminalManager", () => {
	it("creates a real PTY, forwards input/output, resizes, and enforces ownership", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-terminal-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		const manager = new TerminalManager({
			workspaceRoot: root,
			mode: "host",
			idleTimeoutMs: 60_000,
			assertWorkspace: (workspaceId) => {
				if (workspaceId !== "workspace-1") throw new Error("unknown workspace");
				return root;
			},
		});
		cleanup.push(() => manager[Symbol.asyncDispose]());
		const outputs: string[] = [];
		const outputSeqs: number[] = [];
		const collectOutput = (message: import("@wuming/protocol").TerminalServerMessage) => {
			if (message.type !== "terminal.output") return;
			outputs.push(message.data);
			outputSeqs.push(message.seq);
		};
		const ready = manager.create({
			terminalId: "terminal-1",
			requestId: "request-1",
			owner: { principalId: "user-1", workspaceId: "workspace-1" },
			cols: 80,
			rows: 24,
			connectionId: "connection-1",
			send: collectOutput,
		});
		expect(ready).toMatchObject({
			type: "terminal.ready",
			requestId: "request-1",
			terminalId: "terminal-1",
		});
		const unsubscribe = manager.listen("terminal-1", "connection-1", collectOutput);
		try {
			manager.input({
				terminalId: "terminal-1",
				owner: { principalId: "user-1", workspaceId: "workspace-1" },
				data: "echo TERMINAL_TEST\r",
			});
			await waitForOutput(outputs, "TERMINAL_TEST");
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(outputSeqs).toEqual([...new Set(outputSeqs)]);
			manager.resize({
				terminalId: "terminal-1",
				owner: { principalId: "user-1", workspaceId: "workspace-1" },
				cols: 100,
				rows: 30,
			});
			expect(() =>
				manager.input({
					terminalId: "terminal-1",
					owner: { principalId: "other", workspaceId: "workspace-1" },
					data: "echo NO\r",
				})
			).toThrow(/access denied/i);
			const closed = manager.close({
				terminalId: "terminal-1",
				owner: { principalId: "user-1", workspaceId: "workspace-1" },
				requestId: "close-1",
			});
			expect(closed).toEqual({
				type: "terminal.closed",
				requestId: "close-1",
				terminalId: "terminal-1",
			});
			expect(() => manager.workspaceFor("terminal-1", "user-1")).toThrow(/does not exist/i);
		} finally {
			unsubscribe();
		}
	});
});

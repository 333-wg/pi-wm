import { describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "../src/index.js";

describe("LocalProcessSandbox", () => {
	it("runs commands in the selected workspace with the user environment", async () => {
		const sandbox = new LocalProcessSandbox({ workspaceRoot: process.cwd() });
		const result = await sandbox.exec(process.platform === "win32" ? "echo %CD%" : "pwd");

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(process.cwd());
		expect(result.timedOut).toBe(false);
	});
});

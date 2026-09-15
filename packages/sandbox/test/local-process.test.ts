import { describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "../src/index.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("LocalProcessSandbox", () => {
	it("preserves quoted commands, executable paths, and file paths with spaces", async () => {
		const workspaceRoot = await mkdtemp(join(tmpdir(), "wuming process "));
		try {
			const sandbox = new LocalProcessSandbox({ workspaceRoot });
			const result = await sandbox.exec(
				`"${process.execPath}" -e "require('node:fs').writeFileSync('file with spaces.txt','verified');console.log('COMMAND_VERIFIED')"`
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("COMMAND_VERIFIED");
			expect(await readFile(join(workspaceRoot, "file with spaces.txt"), "utf8")).toBe("verified");
		} finally {
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});
	it("runs commands in the selected workspace with the user environment", async () => {
		const sandbox = new LocalProcessSandbox({ workspaceRoot: process.cwd() });
		const result = await sandbox.exec(process.platform === "win32" ? "echo %CD%" : "pwd");

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(process.cwd());
		expect(result.timedOut).toBe(false);
	});
});

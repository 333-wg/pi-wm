import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalProcessSandbox } from "../src/index.js";
import { workspaceProcessEnvironment } from "../src/local-process.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.unstubAllEnvs());

describe("LocalProcessSandbox", () => {
	it("removes host configuration and IPC without removing user tools, proxies or credentials", () => {
		expect(
			workspaceProcessEnvironment({
				WUMING_DESKTOP: "true",
				wuming_token: "host-secret",
				ELECTRON_RUN_AS_NODE: "1",
				NODE_CHANNEL_FD: "3",
				NODE_CHANNEL_SERIALIZATION_MODE: "json",
				NODE_ENV: "production",
				PLAYWRIGHT_BROWSERS_PATH: "bundled-host-browser",
				Path: "tools",
				HTTP_PROXY: "proxy",
				OPENAI_API_KEY: "user-key",
				NODE_OPTIONS: "--max-old-space-size=4096",
			})
		).toEqual({
			Path: "tools",
			HTTP_PROXY: "proxy",
			OPENAI_API_KEY: "user-key",
			NODE_OPTIONS: "--max-old-space-size=4096",
		});
	});
	it("preserves explicitly supplied project environment outside the desktop host", () => {
		const environment = { NODE_ENV: "test", PLAYWRIGHT_BROWSERS_PATH: "project-browser", PATH: "user-tools" };
		expect(workspaceProcessEnvironment(environment)).toEqual(environment);
	});
	it("runs nested node processes outside desktop-host mode", async () => {
		vi.stubEnv("WUMING_DESKTOP", "true");
		vi.stubEnv("WUMING_TOKEN", "host-secret");
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "host-browser");
		const sandbox = new LocalProcessSandbox({ workspaceRoot: process.cwd() });
		const result = await sandbox.exec(
			`"${process.execPath}" -e "if(process.env.WUMING_DESKTOP || process.env.WUMING_TOKEN || process.env.NODE_ENV || process.env.PLAYWRIGHT_BROWSERS_PATH)process.exit(2);console.log('ISOLATED')"`
		);
		expect(result).toMatchObject({ exitCode: 0 });
		expect(result.stdout).toContain("ISOLATED");
		expect(process.env.WUMING_DESKTOP).toBe("true");
	});
	it("does not launch a command when cancellation was already requested", async () => {
		const sandbox = new LocalProcessSandbox({ workspaceRoot: process.cwd() });
		await expect(
			sandbox.exec("echo must-not-run", { signal: AbortSignal.abort(new Error("already stopped")) })
		).rejects.toThrow("already stopped");
	});
	it("terminates a silent command at its own deadline", async () => {
		const sandbox = new LocalProcessSandbox({ workspaceRoot: process.cwd() });
		await expect(
			sandbox.exec(`"${process.execPath}" -e "setInterval(()=>{},1000)"`, { timeoutMs: 200 })
		).rejects.toThrow("Command exceeded 200ms");
	}, 10000);
	it("cancels a running command and its nested child while preserving live output", async () => {
		const sandbox = new LocalProcessSandbox({ workspaceRoot: process.cwd() });
		const controller = new AbortController();
		let output = "";
		const command = `"${process.execPath}" -e "const p=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('CHILD='+p.pid);setInterval(()=>{},1000)"`;
		await expect(
			sandbox.exec(command, {
				signal: controller.signal,
				onOutput: (chunk) => {
					output += chunk;
					if (/CHILD=\d+/.test(output)) controller.abort(new Error("user stopped command"));
				},
			})
		).rejects.toThrow("user stopped command");
		const pid = Number(output.match(/CHILD=(\d+)/)?.[1]);
		expect(pid).toBeGreaterThan(0);
		await expect
			.poll(() => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			})
			.toBe(false);
	}, 10000);
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

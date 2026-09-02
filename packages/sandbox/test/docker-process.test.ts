import { describe, expect, it } from "vitest";
import {
	DockerProcessSandbox,
	type CommandRunner,
	type CommandRunOptions,
	type CommandRunResult,
} from "../src/index.js";

class RecordingRunner implements CommandRunner {
	readonly calls: Array<{ executable: string; args: string[] }> = [];

	async run(executable: string, args: string[]): Promise<CommandRunResult> {
		this.calls.push({ executable, args });
		return { exitCode: 0, stdout: "ok", stderr: "", truncated: false };
	}
}

class AbortRunner extends RecordingRunner {
	override async run(executable: string, args: string[], options: CommandRunOptions): Promise<CommandRunResult> {
		this.calls.push({ executable, args });
		if (args[0] === "rm") return { exitCode: 0, stdout: "", stderr: "", truncated: false };
		return new Promise((_, reject) => {
			const abort = () => reject(options.signal?.reason ?? new Error("aborted"));
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
		});
	}
}

class ResolvingAbortRunner extends RecordingRunner {
	override async run(executable: string, args: string[], options: CommandRunOptions): Promise<CommandRunResult> {
		this.calls.push({ executable, args });
		if (args[0] === "rm") return { exitCode: 0, stdout: "", stderr: "", truncated: false };
		return new Promise((resolve) => {
			const abort = () => resolve({ exitCode: null, stdout: "", stderr: "", truncated: false });
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
		});
	}
}

describe("DockerProcessSandbox", () => {
	it("requires immutable images by default", () => {
		expect(() => new DockerProcessSandbox({ workspaceRoot: "C:\\workspace", image: "node:22" })).toThrow(
			/pinned by sha256/,
		);
	});

	it("constructs a networkless, resource-bounded, least-privilege container", async () => {
		const runner = new RecordingRunner();
		const sandbox = new DockerProcessSandbox({
			workspaceRoot: "C:\\workspace",
			image: "node@sha256:abc",
			runner,
		});
		await expect(sandbox.exec("npm test")).resolves.toMatchObject({ exitCode: 0, stdout: "ok", timedOut: false });
		const args = runner.calls[0]?.args ?? [];
		expect(args).toEqual(expect.arrayContaining([
			"--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
		]));
		expect(args).toContain("type=bind,source=C:\\workspace,target=/workspace");
		expect(args.slice(-4)).toEqual(["node@sha256:abc", "/bin/sh", "-lc", "npm test"]);
	});

	it("kills and removes a timed-out container", async () => {
		const runner = new AbortRunner();
		const sandbox = new DockerProcessSandbox({
			workspaceRoot: "C:\\workspace",
			image: "node@sha256:abc",
			runner,
			defaultTimeoutMs: 5,
		});
		await expect(sandbox.exec("sleep forever")).rejects.toMatchObject({ code: "process_timeout" });
		expect(runner.calls.some((call) => call.args[0] === "rm" && call.args[1] === "-f")).toBe(true);
	});

	it("removes a timed-out container when the process runner resolves after abort", async () => {
		const runner = new ResolvingAbortRunner();
		const sandbox = new DockerProcessSandbox({
			workspaceRoot: "C:\\workspace",
			image: "node@sha256:abc",
			runner,
			defaultTimeoutMs: 5,
		});
		await expect(sandbox.exec("sleep forever")).rejects.toMatchObject({ code: "process_timeout" });
		expect(runner.calls.some((call) => call.args[0] === "rm" && call.args[1] === "-f")).toBe(true);
	});
});

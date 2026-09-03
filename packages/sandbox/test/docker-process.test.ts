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
		expect(sandbox.networkAccess).toBe(false);
		await expect(sandbox.exec("npm test")).resolves.toMatchObject({ exitCode: 0, stdout: "ok", timedOut: false });
		const args = runner.calls[0]?.args ?? [];
		expect(args).toEqual(expect.arrayContaining([
			"--rm", "--init", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
		]));
		expect(args).toContain("type=bind,source=C:\\workspace,target=/workspace");
		expect(args.slice(-4)).toEqual(["node@sha256:abc", "/bin/sh", "-lc", "npm test"]);
	});

	it("gives a real build a writable HOME, a usable /tmp and room to run", async () => {
		const runner = new RecordingRunner();
		const sandbox = new DockerProcessSandbox({ workspaceRoot: "/srv/workspace", image: "node@sha256:abc", runner });

		await sandbox.exec("npm ci");
		const args = runner.calls[0]?.args ?? [];
		expect(args).toContain("/tmp:rw,noexec,nosuid,mode=1777,size=512m");
		expect(args).toContain("/home/agent:rw,noexec,nosuid,mode=1777,size=512m");
		expect(args).toContain("HOME=/home/agent");
		expect(args).toContain("TMPDIR=/tmp");
		expect(args.slice(args.indexOf("--cpus"), args.indexOf("--cpus") + 2)).toEqual(["--cpus", "2"]);
		expect(args.slice(args.indexOf("--memory"), args.indexOf("--memory") + 2)).toEqual(["--memory", "2g"]);
		expect(args.slice(args.indexOf("--pids-limit"), args.indexOf("--pids-limit") + 2)).toEqual(["--pids-limit", "512"]);
	});

	it("mounts a cache volume at HOME instead of a tmpfs when one is configured", async () => {
		const runner = new RecordingRunner();
		const sandbox = new DockerProcessSandbox({
			workspaceRoot: "/srv/workspace",
			image: "node@sha256:abc",
			runner,
			homeVolume: "wuming-cache",
			home: "/cache",
			env: { CI: "1", HOME: "/cache" },
		});

		await sandbox.exec("npm ci");
		const args = runner.calls[0]?.args ?? [];
		expect(args).toContain("type=volume,source=wuming-cache,target=/cache");
		expect(args.some((arg) => arg.startsWith("/cache:rw"))).toBe(false);
		expect(args).toContain("HOME=/cache");
		expect(args).toContain("CI=1");
	});

	it("runs as the configured uid so workspace writes stay editable on the host", async () => {
		const runner = new RecordingRunner();
		const sandbox = new DockerProcessSandbox({
			workspaceRoot: "/srv/workspace",
			image: "node@sha256:abc",
			runner,
			user: "1000:1000",
		});

		await sandbox.exec("npm ci");
		const args = runner.calls[0]?.args ?? [];
		expect(args.slice(args.indexOf("--user"), args.indexOf("--user") + 2)).toEqual(["--user", "1000:1000"]);
		// Docker only reads flags before the image reference.
		expect(args.indexOf("--user")).toBeLessThan(args.indexOf("node@sha256:abc"));
	});

	it("opens the network only when the deployment asks, and never to the host by accident", async () => {
		const runner = new RecordingRunner();
		const bridged = new DockerProcessSandbox({ workspaceRoot: "/srv/workspace", image: "node@sha256:abc", runner, network: "bridge" });
		expect(bridged.networkAccess).toBe(true);
		await bridged.exec("npm ci");
		expect(runner.calls[0]?.args.slice(runner.calls[0].args.indexOf("--network"), runner.calls[0].args.indexOf("--network") + 2)).toEqual(["--network", "bridge"]);

		const base = { workspaceRoot: "/srv/workspace", image: "node@sha256:abc", runner };
		expect(() => new DockerProcessSandbox({ ...base, network: "host" })).toThrow(/host networking/);
		expect(new DockerProcessSandbox({ ...base, network: "host", allowHostNetwork: true }).networkAccess).toBe(true);
		expect(() => new DockerProcessSandbox({ ...base, network: "none --privileged" })).toThrow(/Unsupported Docker network/);
	});

	it("rejects limits and paths that would smuggle extra container options", () => {
		const base = { workspaceRoot: "/srv/workspace", image: "node@sha256:abc" };
		expect(() => new DockerProcessSandbox({ ...base, tmpfsSize: "64m,exec" })).toThrow(/size such as/);
		expect(() => new DockerProcessSandbox({ ...base, memory: "2 gigabytes" })).toThrow(/size such as/);
		expect(() => new DockerProcessSandbox({ ...base, home: "relative/home" })).toThrow(/absolute container path/);
		expect(() => new DockerProcessSandbox({ ...base, home: "/workspace" })).toThrow(/absolute container path/);
		expect(() => new DockerProcessSandbox({ ...base, env: { "BAD NAME": "1" } })).toThrow(/environment name/);
	});

	it("clamps a requested timeout to the configured ceiling", async () => {
		const runner = new AbortRunner();
		const sandbox = new DockerProcessSandbox({
			workspaceRoot: "/srv/workspace",
			image: "node@sha256:abc",
			runner,
			maxTimeoutMs: 5,
		});
		await expect(sandbox.exec("sleep forever", { timeoutMs: 30 * 60_000 })).rejects.toMatchObject({
			code: "process_timeout",
			message: "Command exceeded 5ms",
		});
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

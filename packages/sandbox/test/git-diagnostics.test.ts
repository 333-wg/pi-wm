import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitRepositoryFound } from "../src/git-diagnostics.js";
import { WorkspaceGit } from "../src/workspace-git.js";
import { WorkspaceInspector } from "../src/workspace-inspector.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace() {
	const root = await mkdtemp(join(tmpdir(), "wuming-git-probe-"));
	roots.push(root);
	return { root, service: new WorkspaceGit(root), inspector: await WorkspaceInspector.create(root) };
}

describe("Git repository diagnostics", () => {
	it("still identifies a genuinely uninitialized directory", async () => {
		const { service, inspector } = await workspace();
		expect(await service.details()).toMatchObject({ isRepository: false, writable: true });
		expect(await inspector.gitStatus()).toMatchObject({ isRepository: false });
		await service.action({ type: "init" });
		expect(await service.details()).toMatchObject({ isRepository: true });
		expect(await inspector.gitStatus()).toMatchObject({ isRepository: true });
	});

	it("reports ownership rejection without initializing or changing trust, then recovers", async () => {
		const { root, service, inspector } = await workspace();
		await exec("git", ["init", "--initial-branch=main"], { cwd: root, windowsHide: true });
		const config = await readFile(join(root, ".git", "config"), "utf8");
		// Simulate a different owner without modifying filesystem ownership or user Git configuration.
		vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");
		vi.stubEnv("GIT_CONFIG_COUNT", "1");
		vi.stubEnv("GIT_CONFIG_KEY_0", "safe.directory");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "");
		expect(await service.details()).toMatchObject({
			writable: false,
			isRepository: true,
			trustRequired: { path: await realpath(root) },
		});
		await expect(inspector.gitStatus()).rejects.toThrow("safe.directory");
		await expect(service.action({ type: "init" })).rejects.toThrow("目录所有者");
		expect(await readFile(join(root, ".git", "config"), "utf8")).toBe(config);
		vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "0");
		expect(await service.details()).toMatchObject({ isRepository: true, branch: "main" });
		expect(await inspector.gitStatus()).toMatchObject({ isRepository: true, branch: "main" });
	});

	it("trusts only a confirmed project root using an isolated user configuration", async () => {
		const { root, service, inspector } = await workspace();
		await exec("git", ["init", "--initial-branch=main"], { cwd: root, windowsHide: true });
		const canonical = await realpath(root);
		const globalConfig = join(root, "test-global-config");
		await writeFile(globalConfig, "[user]\n\tname = Preserved\n");
		vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		vi.stubEnv("GIT_CONFIG_COUNT", "0");
		vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");
		await expect(service.action({ type: "trust", path: "*" })).rejects.toThrow("路径已变化");
		await expect(service.action({ type: "trust", path: join(root, "other") })).rejects.toThrow("路径已变化");
		await mkdir(join(root, "nested"));
		await expect(
			new WorkspaceGit(join(root, "nested")).action({ type: "trust", path: join(canonical, "nested") })
		).rejects.toThrow("仓库根目录");
		expect(await service.details()).toMatchObject({ trustRequired: { path: canonical } });
		await service.action({ type: "trust", path: canonical });
		expect(await inspector.gitStatus()).toMatchObject({ isRepository: true });
		expect((await service.details()).trustRequired).toBeUndefined();
		const config = await exec("git", ["config", "--global", "--get-all", "safe.directory"], {
			cwd: root,
			windowsHide: true,
		});
		expect(config.stdout.trim()).toBe(canonical.split(sep).join("/"));
		expect(await readFile(globalConfig, "utf8")).toContain("name = Preserved");
	});

	it("does not disguise broken Git configuration as a missing repository", async () => {
		const { root, service, inspector } = await workspace();
		await exec("git", ["init"], { cwd: root, windowsHide: true });
		await writeFile(join(root, ".git", "config"), "[invalid config\n");
		await expect(service.details()).rejects.toThrow("Git 配置");
		await expect(inspector.gitStatus()).rejects.toThrow("Git 配置");
	});

	it("reports interrupted probes and redacts secrets in diagnostic output", () => {
		expect(() => gitRepositoryFound(null, "")).toThrow("无法读取 Git 仓库");
		try {
			gitRepositoryFound(128, "fatal: config error https://user:secret@example.invalid/repo?token=private");
			throw new Error("Expected repository probe to fail");
		} catch (error) {
			expect(error).toMatchObject({ code: "process_failed", httpStatus: 409 });
			expect(String(error)).not.toContain("secret");
			expect(String(error)).not.toContain("token=private");
		}
	});
});

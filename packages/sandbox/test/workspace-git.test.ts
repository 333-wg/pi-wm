import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceGit } from "../src/workspace-git.js";
import { WorkspaceInspector } from "../src/workspace-inspector.js";

const exec = promisify(execFile);
const roots: string[] = [];
const git = (root: string, ...args: string[]) => exec("git", args, { cwd: root, windowsHide: true });
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function repository() {
	const root = await mkdtemp(join(tmpdir(), "wuming-git-test-"));
	roots.push(root);
	const service = new WorkspaceGit(root, { allowLocalRemotes: true });
	await service.action({ type: "init" });
	await git(root, "config", "user.name", "Git Test");
	await git(root, "config", "user.email", "git-test@example.invalid");
	await git(root, "config", "commit.gpgsign", "false");
	return { root, service };
}
async function commit(service: WorkspaceGit, root: string, content: string) {
	await writeFile(join(root, "note.txt"), content);
	await service.action({ type: "stage", paths: ["note.txt"] });
	await service.action({ type: "commit", message: "Update note" });
}

describe("WorkspaceGit", () => {
	it("discovers external initialization, push and clone without rewriting repository configuration", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-external-git-"));
		roots.push(root);
		const service = new WorkspaceGit(root);
		const inspector = await WorkspaceInspector.create(root);
		expect(await service.details()).toMatchObject({ isRepository: false });
		expect(await inspector.gitStatus()).toMatchObject({ isRepository: false });
		await git(root, "init", "--initial-branch=main");
		await git(root, "config", "user.name", "External Git");
		await git(root, "config", "user.email", "external@example.invalid");
		await git(root, "config", "commit.gpgsign", "false");
		await writeFile(join(root, "note.txt"), "external commit\n");
		await git(root, "add", "note.txt");
		await git(root, "commit", "-m", "External commit");
		const remote = await mkdtemp(join(tmpdir(), "wuming-external-remote-"));
		roots.push(remote);
		await git(remote, "init", "--bare", "--initial-branch=main");
		await git(root, "remote", "add", "origin", remote);
		await git(root, "push", "-u", "origin", "main");
		const config = await readFile(join(root, ".git", "config"), "utf8");
		expect(await service.details()).toMatchObject({
			isRepository: true,
			writable: true,
			hasCommits: true,
			branch: "main",
			upstream: "origin/main",
			workspaceRoot: await realpath(root),
			repositoryRoot: await realpath(root),
			remotes: [{ name: "origin", url: remote }],
		});
		expect(await readFile(join(root, ".git", "config"), "utf8")).toBe(config);
		const clone = await mkdtemp(join(tmpdir(), "wuming-external-clone-"));
		roots.push(clone);
		await git(clone, "clone", remote, ".");
		const cloneConfig = await readFile(join(clone, ".git", "config"), "utf8");
		const cloneService = new WorkspaceGit(clone);
		expect(await cloneService.details()).toMatchObject({
			isRepository: true,
			writable: true,
			branch: "main",
			upstream: "origin/main",
		});
		await writeFile(join(clone, "note.txt"), "edited clone\n");
		expect(await (await WorkspaceInspector.create(clone)).gitStatus()).toMatchObject({
			entries: [{ path: "note.txt", worktreeStatus: "M" }],
		});
		expect(await readFile(join(clone, ".git", "config"), "utf8")).toBe(cloneConfig);
	}, 30000);

	it.each([
		"https://github.com/team/project.git",
		"https://gitlab.com/team/subgroup/project.git",
		"https://git.company.example:8443/team/project.git",
		"ssh://git@git.company.example:2222/team/project.git",
		"git@company-git:team/project.git",
		"git@gitee.com:team/project.git",
	])("reads pre-existing remote configuration for %s", async (url) => {
		const { root, service } = await repository();
		await git(root, "remote", "add", "origin", url);
		expect((await service.details()).remotes).toEqual([{ name: "origin", url, pushUrl: url }]);
		await git(root, "remote", "set-url", "origin", url + "-changed");
		expect((await service.details()).remotes[0]?.url).toBe(url + "-changed");
	});

	it.each(["core.sshCommand", "GIT_SSH_COMMAND", "GIT_SSH"])("preserves the existing %s transport", async (source) => {
		const { root, service } = await repository();
		vi.stubEnv("GIT_SSH", undefined);
		vi.stubEnv("GIT_SSH_COMMAND", undefined);
		vi.stubEnv("GIT_SSH_VARIANT", "ssh");
		const script = join(root, "ssh-probe.sh").replaceAll("\\", "/");
		await writeFile(script, "#!/bin/sh\nprintf CUSTOM_SSH_TRANSPORT >&2\nexit 1\n", { mode: 0o755 });
		if (source === "core.sshCommand") await git(root, "config", source, '"' + script + '"');
		else vi.stubEnv(source, source === "GIT_SSH" ? script : '"' + script + '"');
		await git(root, "remote", "add", "origin", "git@example.invalid:team/project.git");
		await expect(service.action({ type: "fetch", remote: "origin", branch: "main" })).rejects.toThrow(
			"CUSTOM_SSH_TRANSPORT"
		);
	});

	it("reports unresolved conflicts and handles staged renames without deleting files", async () => {
		const { root, service } = await repository();
		await commit(service, root, "base\n");
		await git(root, "checkout", "-b", "other");
		await commit(service, root, "other\n");
		await git(root, "checkout", "main");
		await commit(service, root, "main\n");
		await expect(git(root, "merge", "other")).rejects.toThrow();
		expect(await service.details()).toMatchObject({ conflicts: 1 });
		await expect(service.action({ type: "commit", message: "Unresolved" })).rejects.toThrow("未解决的冲突");
		await writeFile(join(root, "note.txt"), "resolved\n");
		await service.action({ type: "stage", paths: ["note.txt"] });
		await service.action({ type: "commit", message: "Resolve conflict" });
		expect(await service.details()).toMatchObject({ conflicts: 0 });
		await git(root, "mv", "note.txt", "renamed file.txt");
		await service.action({ type: "unstage", paths: ["renamed file.txt", "note.txt"] });
		expect(await readFile(join(root, "renamed file.txt"), "utf8")).toBe("resolved\n");
		await service.action({ type: "stage", paths: ["renamed file.txt", "note.txt"] });
		await service.action({ type: "commit", message: "Rename" });
		expect((await git(root, "ls-files")).stdout.trim()).toBe("renamed file.txt");
	}, 30000);

	it("times out subprocesses without leaving the mutation lock held", async () => {
		const { root } = await repository();
		const service = new WorkspaceGit(root, { timeoutMs: 1 });
		await expect(service.action({ type: "commit", message: "Timeout" })).rejects.toThrow("超时");
		await expect(new WorkspaceGit(root).action({ type: "commit", message: "Retry" })).rejects.toThrow("没有已暂存");
	}, 30000);
	it("stages literal filenames, unstages before the first commit, and never deletes working files", async () => {
		const { root, service } = await repository();
		await writeFile(join(root, "[draft].txt"), "first");
		await writeFile(join(root, "d.txt"), "untouched");
		await service.action({ type: "stage", paths: ["[draft].txt"] });
		let status = await (await WorkspaceInspector.create(root)).gitStatus();
		expect(status.entries.find((entry) => entry.path === "d.txt")?.indexStatus).toBe("?");
		await service.action({ type: "unstage", paths: ["[draft].txt"] });
		expect(await readFile(join(root, "[draft].txt"), "utf8")).toBe("first");
		await service.action({ type: "stage", paths: ["[draft].txt"] });
		await service.action({ type: "commit", message: "Initial commit" });
		await writeFile(join(root, "[draft].txt"), "second");
		await service.action({ type: "stage", paths: ["[draft].txt"] });
		await service.action({ type: "unstage", paths: ["[draft].txt"] });
		status = await (await WorkspaceInspector.create(root)).gitStatus();
		expect(status.entries.find((entry) => entry.path === "[draft].txt")).toMatchObject({
			indexStatus: " ",
			worktreeStatus: "M",
		});
		expect(await readFile(join(root, "[draft].txt"), "utf8")).toBe("second");
	}, 30000);

	it("pushes to a bare remote, tracks ahead/behind, fetches and fast-forwards", async () => {
		const { root, service } = await repository();
		const remote = await mkdtemp(join(tmpdir(), "wuming-git-remote-"));
		roots.push(remote);
		await git(remote, "init", "--bare", "--initial-branch=main");
		await service.action({ type: "remote.save", name: "origin", url: remote });
		await commit(service, root, "first");
		await service.action({ type: "push", remote: "origin", branch: "main" });
		expect(await service.details()).toMatchObject({
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
			upstreamBranch: "main",
			upstreamRemote: "origin",
		});
		const peer = await mkdtemp(join(tmpdir(), "wuming-git-peer-"));
		roots.push(peer);
		await git(peer, "clone", remote, ".");
		await git(peer, "config", "user.name", "Peer");
		await git(peer, "config", "user.email", "peer@example.invalid");
		await git(peer, "config", "commit.gpgsign", "false");
		await writeFile(join(peer, "note.txt"), "remote update");
		await git(peer, "add", "note.txt");
		await git(peer, "commit", "-m", "Peer update");
		await git(peer, "push");
		await service.action({ type: "fetch", remote: "origin", branch: "main" });
		expect(await service.details()).toMatchObject({ ahead: 0, behind: 1 });
		expect(await readFile(join(root, "note.txt"), "utf8")).toBe("first");
		await service.action({ type: "pull", remote: "origin", branch: "main" });
		expect(await readFile(join(root, "note.txt"), "utf8")).toBe("remote update");
		await commit(service, root, "local divergence");
		expect(await service.details()).toMatchObject({ ahead: 1, behind: 0 });
		await writeFile(join(peer, "note.txt"), "peer divergence");
		await git(peer, "add", "note.txt");
		await git(peer, "commit", "-m", "Diverge");
		await git(peer, "push");
		const before = (await git(root, "rev-parse", "HEAD")).stdout;
		await expect(service.action({ type: "push", remote: "origin", branch: "main" })).rejects.toThrow("未执行强制覆盖");
		await expect(service.action({ type: "pull", remote: "origin", branch: "main" })).rejects.toThrow("未执行强制覆盖");
		expect((await git(root, "rev-parse", "HEAD")).stdout).toBe(before);
		expect(await readFile(join(root, "note.txt"), "utf8")).toBe("local divergence");
	}, 60000);

	it("rejects unsafe paths, nested workspaces, empty commits and detached pushes", async () => {
		const { root, service } = await repository();
		await writeFile(join(root, "note.txt"), "first");
		for (const path of ["../outside", ".", ".git/config", ":(glob)*"])
			await expect(service.action({ type: "stage", paths: [path] })).rejects.toThrow("路径无效");
		await expect(service.action({ type: "commit", message: "   " })).rejects.toThrow("提交说明");
		await expect(service.action({ type: "commit", message: "Empty" })).rejects.toThrow("没有已暂存");
		await mkdir(join(root, "nested"));
		const nested = new WorkspaceGit(join(root, "nested"));
		expect(await nested.details()).toMatchObject({ writable: false });
		await expect(nested.action({ type: "init" })).rejects.toThrow("仓库根目录");
		await commit(service, root, "first");
		await service.action({ type: "remote.save", name: "origin", url: "https://example.invalid/repo.git" });
		await git(root, "checkout", "--detach");
		await expect(service.action({ type: "push", remote: "origin", branch: "main" })).rejects.toThrow("分离 HEAD");
	}, 30000);

	it("accepts hosting platforms without storing URL credentials and blocks dangerous transports", async () => {
		const { root } = await repository();
		const service = new WorkspaceGit(root);
		for (const [name, url] of [
			["github", "https://github.com/owner/repo.git"],
			["gitee", "git@gitee.com:owner/repo.git"],
			["gitlab", "ssh://git@gitlab.com/owner/repo.git"],
		])
			await service.action({ type: "remote.save", name: name!, url: url! });
		for (const url of [
			"ext::sh -c whoami",
			"file:///tmp/repo",
			"https://secret@github.com/a/b",
			"https://user:secret@github.com/a/b",
			"https://github.com/a/b?token=secret",
		])
			await expect(service.action({ type: "remote.save", name: "bad", url })).rejects.toThrow();
		await expect(service.action({ type: "remote.save", name: "--bad", url: "https://github.com/a/b" })).rejects.toThrow(
			"远程名称"
		);
		await git(root, "remote", "add", "legacy", "https://user:super-secret@example.invalid/repo.git");
		expect(JSON.stringify(await service.details())).not.toContain("super-secret");
		await service.action({ type: "remote.remove", name: "legacy" });
		expect((await service.details()).remotes).toHaveLength(3);
		await git(root, "config", "remote.github.pushurl", "https://example.invalid/other.git");
		await expect(
			service.action({ type: "remote.save", name: "github", url: "https://github.com/owner/new.git" })
		).rejects.toThrow("独立推送地址");
	}, 30000);

	it("blocks dirty pulls and concurrent mutations without overwriting files", async () => {
		const { root, service } = await repository();
		await commit(service, root, "first");
		await service.action({ type: "remote.save", name: "origin", url: "https://example.invalid/repo.git" });
		await writeFile(join(root, "note.txt"), "uncommitted");
		await expect(service.action({ type: "pull", remote: "origin", branch: "main" })).rejects.toThrow("未提交更改");
		const results = await Promise.allSettled([
			service.action({ type: "stage", paths: ["note.txt"] }),
			service.action({ type: "stage", paths: ["note.txt"] }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(await readFile(join(root, "note.txt"), "utf8")).toBe("uncommitted");
	}, 30000);
});

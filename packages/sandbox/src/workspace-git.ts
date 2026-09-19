import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitAction, GitActionResult, GitDetails } from "@wuming/protocol";
import { WorkspaceInspector } from "./workspace-inspector.js";
import { gitRepositoryFound, isGitOwnershipError, redactGitOutput as redact } from "./git-diagnostics.js";

const activeRoots = new Set<string>();
const fail = (message: string, httpStatus = 400): Error => Object.assign(new Error(message), { httpStatus });

/** Repository inspection plus explicit Git mutations, which must remain local-device-only. */
export class WorkspaceGit {
	constructor(
		readonly root: string,
		private readonly options: { allowLocalRemotes?: boolean; timeoutMs?: number } = {}
	) {}

	async details(): Promise<GitDetails> {
		const workspaceRoot = await realpath(this.root);
		const top = await this.run(["rev-parse", "--show-toplevel"], true);
		if (top.code !== 0 && isGitOwnershipError(top.stderr) && (await this.hasGitMarker())) {
			return {
				writable: false,
				isRepository: true,
				workspaceRoot,
				trustRequired: { path: workspaceRoot },
				hasCommits: false,
				ahead: 0,
				behind: 0,
				conflicts: 0,
				remotes: [],
				blockedReason: "Git 因目录所有者不同而拒绝访问，请确认仓库来源后再信任。",
			};
		}
		if (!gitRepositoryFound(top.code, top.stderr))
			return {
				writable: true,
				isRepository: false,
				workspaceRoot,
				hasCommits: false,
				ahead: 0,
				behind: 0,
				conflicts: 0,
				remotes: [],
			};
		const repositoryRoot = await realpath(top.output.trim());
		const writable = await this.isRoot(top.output.trim());
		const branch = (await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], true)).output.trim();
		const hasCommits = (await this.run(["rev-parse", "--verify", "HEAD"], true)).code === 0;
		const upstreamResult = await this.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true);
		const upstream = upstreamResult.code === 0 ? upstreamResult.output.trim() : "";
		const tracking = upstream
			? (await this.run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).output
					.trim()
					.split(/\s+/)
					.map(Number)
			: [0, 0];
		const upstreamRemote = branch
			? (await this.run(["config", "--get", "branch." + branch + ".remote"], true)).output.trim()
			: "";
		const merge = branch
			? (await this.run(["config", "--get", "branch." + branch + ".merge"], true)).output.trim()
			: "";
		const names = (await this.run(["remote"])).output.trim().split("\n").filter(Boolean);
		const remotes: GitDetails["remotes"] = [];
		for (const name of names) {
			const url = (await this.run(["remote", "get-url", name])).output.trim();
			const pushUrl = (await this.run(["remote", "get-url", "--push", name])).output.trim();
			remotes.push({ name, url: redact(url), pushUrl: redact(pushUrl) });
		}
		const conflicts = new Set(
			(await this.run(["diff", "--name-only", "--diff-filter=U", "-z"])).output.split("\0").filter(Boolean)
		).size;
		return {
			writable,
			isRepository: true,
			workspaceRoot,
			repositoryRoot,
			hasCommits,
			...(branch ? { branch } : {}),
			...(upstream ? { upstream } : {}),
			...(upstreamRemote ? { upstreamRemote } : {}),
			...(merge.startsWith("refs/heads/") ? { upstreamBranch: merge.slice(11) } : {}),
			ahead: tracking[0] ?? 0,
			behind: tracking[1] ?? 0,
			conflicts,
			remotes,
			...(!writable ? { blockedReason: "当前工作区不是仓库根目录，请打开仓库根目录后操作。" } : {}),
		};
	}

	async action(action: GitAction): Promise<GitActionResult> {
		const root = await realpath(this.root);
		const key = process.platform === "win32" ? root.toLowerCase() : root;
		if (activeRoots.has(key)) throw fail("另一个 Git 操作正在进行，请稍后重试。", 409);
		activeRoots.add(key);
		try {
			return await this.perform(action);
		} finally {
			activeRoots.delete(key);
		}
	}

	private async perform(action: GitAction): Promise<GitActionResult> {
		if (action.type === "trust") {
			const root = await realpath(this.root);
			// Only the exact project root shown in the confirmation may be trusted, never an ancestor or wildcard.
			if (action.path !== root || root.includes("*") || !(await this.hasGitMarker()))
				throw fail("仓库路径已变化或不是仓库根目录，请刷新后重新确认。", 409);
			const probe = await this.run(["rev-parse", "--show-toplevel"], true);
			if (probe.code === 0) return { message: "此仓库已可访问。" };
			if (!isGitOwnershipError(probe.stderr)) {
				gitRepositoryFound(probe.code, probe.stderr);
				throw fail("当前目录不需要添加信任配置。", 409);
			}
			await this.run(["config", "--global", "--add", "safe.directory", root.split(sep).join("/")]);
			return { message: "已信任此仓库，未修改项目文件或远程配置。" };
		}
		const info = await this.details();
		if (!info.writable) throw fail(info.blockedReason!, 409);
		if (action.type === "init") {
			if (info.isRepository) throw fail("当前目录已经是 Git 仓库。", 409);
			await this.run(["init", "--initial-branch=main"]);
			return { message: "已初始化本地 Git 仓库。" };
		}
		if (!info.isRepository) throw fail("请先初始化 Git 仓库。", 409);
		if (action.type === "stage" || action.type === "unstage") {
			const status = await (await WorkspaceInspector.create(this.root)).gitStatus();
			if (status.truncated) throw fail("更改列表过大，暂存操作请在终端完成。");
			const known = new Set(
				status.entries.flatMap((entry) => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])])
			);
			for (const path of action.paths) {
				const rel = relative(this.root, resolve(this.root, path));
				if (
					!path ||
					path.includes("\0") ||
					path.includes("\\") ||
					isAbsolute(path) ||
					!rel ||
					rel === ".." ||
					rel.startsWith(".." + sep) ||
					path.split("/").includes(".git") ||
					!known.has(path)
				)
					throw fail("文件路径无效或更改已经变化，请刷新后重试。");
			}
			const input = [...new Set(action.paths)].join("\0") + "\0";
			const args =
				action.type === "stage"
					? ["add", "--pathspec-from-file=-", "--pathspec-file-nul"]
					: info.hasCommits
						? ["reset", "-q", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"]
						: ["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"];
			await this.run(args, false, input);
			return { message: action.type === "stage" ? "已暂存所选更改。" : "已取消暂存，工作区文件保持不变。" };
		}
		if (action.type === "commit") {
			if (!action.message.trim() || action.message.includes("\0")) throw fail("请输入有效的提交说明。");
			if (info.conflicts) throw fail("存在未解决的冲突，请处理并暂存后再提交。", 409);
			if ((await this.run(["diff", "--cached", "--quiet"], true)).code === 0) throw fail("没有已暂存的更改。", 409);
			await this.run(["commit", "--file=-"], false, action.message.trim());
			return { message: "已提交到本地仓库。" };
		}
		if (action.type === "remote.save" || action.type === "remote.remove") {
			this.remoteName(action.name);
			const existing = info.remotes.find((remote) => remote.name === action.name);
			if (action.type === "remote.remove") {
				if (!existing) throw fail("远程仓库不存在。");
				await this.run(["remote", "remove", action.name]);
				return { message: "已移除本地远程配置，平台上的仓库未删除。" };
			}
			this.validateUrl(action.url);
			if (existing) {
				const pushes = await this.run(["config", "--get-all", "remote." + action.name + ".pushurl"], true);
				if (pushes.code === 0) throw fail("该远程配置了独立推送地址，请在终端调整，或移除配置后重新添加。");
				await this.run(["remote", "set-url", action.name, action.url]);
			} else await this.run(["remote", "add", action.name, action.url]);
			return { message: "远程仓库配置已保存。" };
		}
		if (action.type !== "fetch" && action.type !== "push" && action.type !== "pull") throw fail("不支持的 Git 操作。");
		this.remoteName(action.remote);
		if (!info.remotes.some((remote) => remote.name === action.remote)) throw fail("请选择已配置的远程仓库。");
		if (
			action.branch.startsWith("-") ||
			(await this.run(["check-ref-format", "refs/heads/" + action.branch], true)).code !== 0
		)
			throw fail("远程分支名称无效。");
		const urls = (
			await this.run(["remote", "get-url", ...(action.type === "push" ? ["--push"] : []), "--all", action.remote])
		).output
			.trim()
			.split("\n");
		if (urls.length !== 1) throw fail("该远程包含多个地址，请在终端确认推送目标。");
		urls.forEach((url) => this.validateUrl(url));
		const protocol = [
			"-c",
			"protocol.ext.allow=never",
			"-c",
			"protocol.file.allow=" + (this.options.allowLocalRemotes ? "always" : "never"),
		];
		if (action.type === "fetch") {
			await this.run([...protocol, "fetch", "--no-recurse-submodules", action.remote], false, undefined, true);
			return { message: "已获取远程更新，工作区文件未改变。" };
		}
		if (!info.branch || !info.hasCommits) throw fail("请先在本地分支创建提交；分离 HEAD 状态不能推送或拉取。", 409);
		if (info.conflicts) throw fail("存在未解决的冲突，请先处理。", 409);
		if (action.type === "push") {
			if (
				(await this.run(["config", "--bool", "--get", "remote." + action.remote + ".mirror"], true)).output.trim() ===
				"true"
			)
				throw fail("不允许通过界面推送镜像远程仓库。");
			await this.run(
				[
					...protocol,
					"-c",
					"push.followTags=false",
					"push",
					"--porcelain",
					"--set-upstream",
					"--recurse-submodules=no",
					action.remote,
					"refs/heads/" + info.branch + ":refs/heads/" + action.branch,
				],
				false,
				undefined,
				true
			);
			return { message: "已推送到 " + action.remote + "/" + action.branch + "。" };
		}
		const dirty = (await this.run(["status", "--porcelain", "--untracked-files=all"])).output.trim();
		if (dirty) throw fail("工作区有未提交更改，请先提交或在终端妥善保存后再拉取。", 409);
		await this.run(
			[
				...protocol,
				"pull",
				"--ff-only",
				"--no-rebase",
				"--no-autostash",
				"--no-recurse-submodules",
				action.remote,
				action.branch,
			],
			false,
			undefined,
			true
		);
		return { message: "已快进拉取远程分支。" };
	}

	private remoteName(name: string): void {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw fail("远程名称只能包含字母、数字、点、下划线和连字符。");
	}

	private validateUrl(value: string): void {
		if (!value || /[\s\0]/.test(value) || value.startsWith("-")) throw fail("远程地址无效。");
		if (this.options.allowLocalRemotes && isAbsolute(value)) return;
		if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return;
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw fail("请输入 HTTPS 或 SSH 仓库地址。");
		}
		if (
			!["https:", "ssh:"].includes(url.protocol) ||
			!url.hostname ||
			url.password ||
			(url.protocol === "https:" && url.username) ||
			url.search ||
			url.hash ||
			url.pathname.length < 2
		)
			throw fail("仅支持不含密码或令牌的 HTTPS / SSH 仓库地址，请使用系统 Git 凭据。");
	}

	private async isRoot(top: string): Promise<boolean> {
		return relative(await realpath(this.root), await realpath(top)) === "";
	}

	private async hasGitMarker(): Promise<boolean> {
		try {
			const marker = await lstat(join(this.root, ".git"));
			return !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile());
		} catch {
			return false;
		}
	}

	private async run(
		args: string[],
		allowFailure = false,
		input?: string,
		network = false
	): Promise<{ code: number | null; output: string; stderr: string }> {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			LC_ALL: "C",
			LANG: "C",
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "Never",
			GIT_EDITOR: "true",
			GIT_MERGE_AUTOEDIT: "no",
		};
		if (network && !env.GIT_SSH_COMMAND && !env.GIT_SSH) {
			const configured = await this.run(["config", "--get", "core.sshCommand"], true);
			if (configured.code !== 0) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
		}
		return new Promise((resolveResult, reject) => {
			const child = spawn("git", ["--literal-pathspecs", "-c", "core.quotepath=false", ...args], {
				cwd: this.root,
				shell: false,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
				env,
			});
			const out: Buffer[] = [],
				err: Buffer[] = [];
			let bytes = 0,
				timedOut = false,
				overflow = false;
			const kill = () => {
				if (process.platform === "win32" && child.pid) {
					const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
						windowsHide: true,
						stdio: "ignore",
					});
					killer.on("error", () => child.kill());
				} else child.kill("SIGKILL");
			};
			const timer = setTimeout(
				() => {
					timedOut = true;
					kill();
				},
				this.options.timeoutMs ?? (network ? 120_000 : 30_000)
			);
			const collect = (target: Buffer[]) => (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > 2 * 1024 * 1024) {
					overflow = true;
					kill();
				} else target.push(chunk);
			};
			child.stdout.on("data", collect(out));
			child.stderr.on("data", collect(err));
			child.stdin.on("error", () => {});
			child.stdin.end(input);
			child.on("error", () => {
				clearTimeout(timer);
				reject(fail("无法运行 Git，请确认已安装 Git 并加入 PATH。", 503));
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (timedOut || overflow)
					return reject(
						fail(
							timedOut ? "Git 操作超时，请刷新状态确认结果后重试。" : "Git 输出过大，操作已停止，请在终端检查。",
							409
						)
					);
				const output = Buffer.concat(out).toString("utf8");
				const stderr = Buffer.concat(err).toString("utf8");
				if (code === 0 || allowFailure) return resolveResult({ code, output, stderr });
				const error = redact(stderr + "\n" + output).trim();
				let hint = "Git 操作失败。";
				if (
					/Authentication failed|Permission denied|could not read Username|terminal prompts disabled|Host key verification failed|repository not found/i.test(
						error
					)
				)
					hint = "远程认证失败：请先在网关所在电脑配置 SSH 密钥或 Git 凭据，并确认仓库写入权限。";
				else if (/non-fast-forward|rejected|Not possible to fast-forward|divergent/i.test(error))
					hint = "本地与远程分支不同步，请获取更新并在终端处理分歧；未执行强制覆盖。";
				else if (/identity unknown|unable to auto-detect email/i.test(error))
					hint = "请先在终端配置 git config user.name 和 git config user.email。";
				else if (/index.lock|another git process/i.test(error)) hint = "仓库被另一个 Git 进程占用，请等待该操作完成。";
				reject(fail(hint + "\n" + error.slice(0, 6000), 409));
			});
		});
	}
}

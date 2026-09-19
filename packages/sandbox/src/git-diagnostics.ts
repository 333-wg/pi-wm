import { SandboxError } from "./errors.js";

export function redactGitOutput(text: string): string {
	return text
		.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
		.replace(/(ssh:\/\/[^\s/:@]+:)[^\s@]+@/gi, "$1[redacted]@")
		.replace(/([?&](?:token|access_token|private_token|password)=)[^\s&]+/gi, "$1[redacted]");
}

export function isGitOwnershipError(stderr: string): boolean {
	return /detected dubious ownership/i.test(stderr);
}

/** A failed probe is not evidence that a repository needs initialization. */
export function gitRepositoryFound(exitCode: number | null, stderr: string): boolean {
	if (exitCode === 0) return true;
	if (/^fatal: not a git repository(?:\s|\()/im.test(stderr)) return false;
	const hint = isGitOwnershipError(stderr)
		? "Git 拒绝访问此仓库：目录所有者与当前系统账号不同。确认信任该目录后，请在本机终端执行下方 safe.directory 命令，再刷新。无需重新初始化仓库。"
		: "无法读取 Git 仓库，请检查目录权限和 Git 配置后重试。";
	throw Object.assign(new SandboxError("process_failed", hint + "\n" + redactGitOutput(stderr).trim().slice(0, 6000)), {
		httpStatus: 409,
	});
}

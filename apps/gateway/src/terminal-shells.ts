import { statSync } from "node:fs";
import { basename, posix, win32 } from "node:path";

export interface TerminalShell {
	id: string;
	label: string;
	file: string;
	args: string[];
}

export function discoverTerminalShells(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	isFile: (path: string) => boolean = (path) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	}
): TerminalShell[] {
	const shells: TerminalShell[] = [];
	const paths = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
	const path = platform === "win32" ? win32 : posix;
	const add = (id: string, label: string, candidates: string[], args: string[]) => {
		const file = candidates.find((candidate) => candidate && isFile(candidate));
		if (file) shells.push({ id, label, file, args });
	};
	if (platform === "win32") {
		const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
		add(
			"pwsh",
			"PowerShell 7",
			[
				...paths.map((dir) => path.join(dir, "pwsh.exe")),
				path.join(env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
			],
			["-NoLogo"]
		);
		add(
			"powershell",
			"Windows PowerShell",
			[
				path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				...paths.map((dir) => path.join(dir, "powershell.exe")),
			],
			["-NoLogo"]
		);
		add("cmd", "CMD", [env.ComSpec ?? env.COMSPEC ?? "", path.join(systemRoot, "System32", "cmd.exe")], ["/d"]);
		add(
			"git-bash",
			"Git Bash",
			[
				...[
					env.ProgramFiles,
					env["ProgramFiles(x86)"],
					env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : undefined,
				]
					.filter((dir): dir is string => Boolean(dir))
					.map((dir) => path.join(dir, "Git", "bin", "bash.exe")),
				...paths
					.map((dir) => path.join(dir, "bash.exe"))
					.filter((file) => !/\\Windows\\(System32|Sysnative)\\bash\.exe$/i.test(file)),
			],
			["--login", "-i"]
		);
	} else {
		if (env.SHELL && path.isAbsolute(env.SHELL)) add("login", basename(env.SHELL), [env.SHELL], ["-l"]);
		add("bash", "Bash", ["/bin/bash", ...paths.map((dir) => path.join(dir, "bash"))], ["-l"]);
		add("zsh", "Zsh", ["/bin/zsh", ...paths.map((dir) => path.join(dir, "zsh"))], ["-l"]);
		add("sh", "sh", ["/bin/sh"], ["-l"]);
	}
	return shells.filter((shell, index) => shells.findIndex((other) => other.file === shell.file) === index);
}

import { describe, expect, it } from "vitest";
import { discoverTerminalShells } from "../src/terminal-shells.js";

describe("terminal shell discovery", () => {
	it("prefers PowerShell 7 and exposes only installed Windows executables", () => {
		const files = new Set([
			"C:\\tools\\pwsh.exe",
			"C:\\Windows\\System32\\cmd.exe",
			"C:\\Programs\\Git\\bin\\bash.exe",
		]);
		const shells = discoverTerminalShells("win32", { PATH: "C:\\tools", ProgramFiles: "C:\\Programs" }, (path) =>
			files.has(path)
		);
		expect(shells.map((shell) => shell.id)).toEqual(["pwsh", "cmd", "git-bash"]);
	});
	it("falls back to installed PowerShell and never advertises the legacy WSL launcher as Git Bash", () => {
		const files = new Set([
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			"C:\\Windows\\System32\\bash.exe",
		]);
		expect(
			discoverTerminalShells("win32", { PATH: "C:\\Windows\\System32" }, (path) => files.has(path)).map(
				(shell) => shell.id
			)
		).toEqual(["powershell"]);
	});
	it("prefers the POSIX login shell and deduplicates executables", () => {
		const shells = discoverTerminalShells("linux", { SHELL: "/bin/bash" }, (path) =>
			["/bin/bash", "/bin/sh"].includes(path)
		);
		expect(shells.map((shell) => shell.id)).toEqual(["login", "sh"]);
	});
});

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";

export async function openLocalFolder(path: string): Promise<void> {
	let directory: string;
	try {
		directory = await realpath(path);
		if (!(await stat(directory)).isDirectory()) throw new Error("Not a directory");
	} catch {
		throw Object.assign(new Error("项目目录不存在或无法访问。"), { httpStatus: 404 });
	}
	const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
	await new Promise<void>((resolve, reject) => {
		// Pass the registered directory as one argument, never as a shell command.
		// This is a user-requested GUI window, so it must not inherit hidden startup.
		const child = spawn(command, [directory], { detached: true, stdio: "ignore", windowsHide: false });
		child.once("error", () => reject(Object.assign(new Error("无法启动系统文件管理器。"), { httpStatus: 503 })));
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

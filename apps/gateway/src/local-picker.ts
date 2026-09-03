import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function pickerError(message: string, httpStatus: number): Error {
	return Object.assign(new Error(message), { httpStatus });
}

async function pickOnWindows(kind: "file" | "directory"): Promise<string> {
	const script = kind === "directory"
		? [
			"Add-Type -AssemblyName System.Windows.Forms",
			"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
			"$dialog.Description = 'Select a project folder'",
			"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }",
		].join("; ")
		: [
			"Add-Type -AssemblyName System.Windows.Forms",
			"$dialog = New-Object System.Windows.Forms.OpenFileDialog",
			"$dialog.Title = 'Select a project file'",
			"$dialog.CheckFileExists = $true",
			"$dialog.Multiselect = $false",
			"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.FileName }",
		].join("; ");
	const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
		windowsHide: true,
		encoding: "utf8",
		maxBuffer: 16 * 1024,
	});
	return stdout.trim();
}

async function pickOnMac(kind: "file" | "directory"): Promise<string> {
	const command = kind === "directory"
		? "POSIX path of (choose folder with prompt \"Select a project folder\")"
		: "POSIX path of (choose file with prompt \"Select a project file\")";
	const { stdout } = await execFileAsync("osascript", ["-e", command], { encoding: "utf8", maxBuffer: 16 * 1024 });
	return stdout.trim();
}

async function pickOnLinux(kind: "file" | "directory"): Promise<string> {
	const args = ["--file-selection", "--title", kind === "directory" ? "Select a project folder" : "Select a project file"];
	if (kind === "directory") args.push("--directory");
	const { stdout } = await execFileAsync("zenity", args, { encoding: "utf8", maxBuffer: 16 * 1024 });
	return stdout.trim();
}

export async function showLocalProjectPicker(kind: "file" | "directory"): Promise<string> {
	let selected = "";
	try {
		selected = process.platform === "win32"
			? await pickOnWindows(kind)
			: process.platform === "darwin"
				? await pickOnMac(kind)
				: await pickOnLinux(kind);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw pickerError("This system does not provide a supported file picker", 501);
		throw pickerError("Project selection was cancelled", 400);
	}
	if (!selected) throw pickerError("Project selection was cancelled", 400);
	return selected;
}

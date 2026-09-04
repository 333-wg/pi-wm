import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type ProjectSelectionKind = "file" | "directory";

export interface LocalProjectSelection {
	path: string;
	kind: ProjectSelectionKind;
}

function pickerError(message: string, httpStatus: number): Error {
	return Object.assign(new Error(message), { httpStatus });
}

async function pickOnWindows(kind?: ProjectSelectionKind): Promise<string> {
	const script = kind === undefined
		? [
			"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class WumingNativeWindow { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); }'",
			"$owner = [WumingNativeWindow]::GetForegroundWindow()",
			"$ownerHandle = if ($owner -eq [IntPtr]::Zero) { 0 } else { $owner.ToInt32() }",
			"$shell = New-Object -ComObject Shell.Application",
			"$dialog = $shell.BrowseForFolder($ownerHandle, 'Select a project file or folder', 0x4050)",
			"if ($null -ne $dialog) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.Self.Path }",
		].join("; ")
		: kind === "directory"
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
		windowsHide: false,
		encoding: "utf8",
		maxBuffer: 16 * 1024,
	});
	return stdout.trim();
}

async function pickOnMac(kind: ProjectSelectionKind): Promise<string> {
	const command = kind === "directory"
		? "POSIX path of (choose folder with prompt \"Select a project folder\")"
		: "POSIX path of (choose file with prompt \"Select a project file\")";
	const { stdout } = await execFileAsync("osascript", ["-e", command], { encoding: "utf8", maxBuffer: 16 * 1024 });
	return stdout.trim();
}

async function pickOnLinux(kind: ProjectSelectionKind): Promise<string> {
	const args = ["--file-selection", "--title", kind === "directory" ? "Select a project folder" : "Select a project file"];
	if (kind === "directory") args.push("--directory");
	const { stdout } = await execFileAsync("zenity", args, { encoding: "utf8", maxBuffer: 16 * 1024 });
	return stdout.trim();
}

export async function showLocalProjectPicker(kind?: ProjectSelectionKind): Promise<LocalProjectSelection> {
	let selected = "";
	try {
		selected = process.platform === "win32"
			? await pickOnWindows(kind)
			: process.platform === "darwin"
				? await pickOnMac(kind ?? "file")
				: await pickOnLinux(kind ?? "file");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw pickerError("This system does not provide a supported file picker", 501);
		throw pickerError("Project selection was cancelled", 400);
	}
	if (!selected) throw pickerError("Project selection was cancelled", 400);
	const info = await stat(selected);
	const selectedKind = info.isDirectory() ? "directory" : info.isFile() ? "file" : undefined;
	if (!selectedKind) throw pickerError("Selected project must be a file or directory", 400);
	if (kind !== undefined && kind !== selectedKind) throw pickerError(`Selected path is not a ${kind}`, 400);
	return { path: selected, kind: selectedKind };
}

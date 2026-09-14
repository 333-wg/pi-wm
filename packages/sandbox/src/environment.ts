import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, delimiter, extname, isAbsolute, join } from "node:path";

export interface EnvironmentTool {
	name: string;
	available: boolean;
	path?: string;
	version?: string;
	suggestion?: string;
}

export interface ProjectEnvironment {
	kinds: string[];
	packageManager?: string;
	nodeRequirement?: string;
	pythonRequirement?: string;
	nodeDependenciesInstalled?: boolean;
	pythonVirtualEnvironmentPresent?: boolean;
	envExamplePresent: boolean;
	envFilePresent: boolean;
}

export interface EnvironmentInspection {
	platform: NodeJS.Platform;
	shell: string;
	tools: EnvironmentTool[];
	project: ProjectEnvironment;
	inspectedAt: number;
}

export interface EnvironmentInspector {
	inspect(options?: { probeVersions?: boolean }): Promise<EnvironmentInspection>;
}

export interface EnvironmentIssue {
	code: "tool_missing";
	tool: string;
	requiredBy: string;
	message: string;
	suggestions: string[];
}

interface ToolSpec {
	name: string;
	executable?: string;
	args: string[];
}

const outputLimit = 4000;

function installationSuggestion(tool: string, platform: NodeJS.Platform): string {
	const normalized = basename(tool)
		.replace(/\.exe$/i, "")
		.toLowerCase();
	if (normalized === "npm" || normalized === "npx" || normalized === "node")
		return "安装 Node.js LTS（npm/npx 会随 Node.js 安装），然后重启应用或刷新 PATH。";
	if (normalized === "pnpm") return "先安装 Node.js，再通过 Corepack 启用 pnpm，或按项目文档安装指定版本。";
	if (normalized === "yarn") return "先安装 Node.js，再通过 Corepack 启用 Yarn，或按项目文档安装指定版本。";
	if (normalized === "python" || normalized === "python3" || normalized === "pip")
		return platform === "win32"
			? "安装 Python 3，并确认安装器中的“Add Python to PATH”已启用；安装后重启应用。"
			: "安装 Python 3，并确认 python3 可通过 PATH 访问。";
	if (normalized === "docker") return "安装并启动 Docker Desktop/Engine，或将执行后端切换为本机环境。";
	if (normalized === "git") return "安装 Git，并确认 git 已加入 PATH。";
	return `安装 ${tool}，确认它已加入 PATH，然后重新检测环境。`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function capture(executable: string, args: string[], timeoutMs = 3000) {
	return new Promise<{ available: boolean; output: string; exitCode: number | null }>((resolve) => {
		const commandScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
		const child = spawn(
			commandScript ? (process.env.ComSpec ?? "cmd.exe") : executable,
			commandScript ? ["/d", "/c", executable, ...args] : args,
			{
				windowsHide: true,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			}
		);
		let output = "";
		let settled = false;
		const append = (chunk: Buffer) => {
			if (output.length < outputLimit) output += chunk.toString("utf8");
		};
		const finish = (available: boolean, exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ available, output: output.trim().slice(0, outputLimit), exitCode });
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(true, null);
		}, timeoutMs);
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ENOENT", null));
		child.once("close", (exitCode) => finish(true, exitCode));
	});
}

async function executablePath(executable: string): Promise<string | undefined> {
	const direct = isAbsolute(executable) || /[\\/]/.test(executable);
	const directories = direct
		? [""]
		: (process.env.PATH ?? process.env.Path ?? "")
				.split(delimiter)
				.map((entry) => entry.trim().replace(/^"|"$/g, ""))
				.filter(Boolean);
	const extensions =
		process.platform === "win32" && !extname(executable)
			? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
			: [""];
	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = direct ? executable : join(directory, `${executable}${extension}`);
			try {
				await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
				return candidate;
			} catch {
				// Continue through PATH in order.
			}
		}
	}
	return undefined;
}

async function probeTool(spec: ToolSpec, probeVersions: boolean): Promise<EnvironmentTool> {
	const executable = spec.executable ?? spec.name;
	const path = await executablePath(executable);
	if (!path)
		return {
			name: spec.name,
			available: false,
			suggestion: installationSuggestion(executable, process.platform),
		};
	if (!probeVersions) return { name: spec.name, available: true, path };
	const result = await capture(path, spec.args);
	return {
		name: spec.name,
		available: true,
		path,
		...(result.exitCode === 0 && result.output ? { version: result.output.split(/\r?\n/)[0]!.slice(0, 300) } : {}),
	};
}

async function inspectProject(root: string): Promise<ProjectEnvironment> {
	const packageJsonPath = join(root, "package.json");
	const pyprojectPath = join(root, "pyproject.toml");
	const requirementsPath = join(root, "requirements.txt");
	const cargoPath = join(root, "Cargo.toml");
	const goPath = join(root, "go.mod");
	const kinds: string[] = [];
	let packageManager: string | undefined;
	let nodeRequirement: string | undefined;
	let pythonRequirement: string | undefined;
	if (await exists(packageJsonPath)) {
		kinds.push("node");
		try {
			const value = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
				packageManager?: unknown;
				engines?: { node?: unknown };
			};
			if (typeof value.packageManager === "string") packageManager = value.packageManager;
			if (typeof value.engines?.node === "string") nodeRequirement = value.engines.node;
		} catch {
			// The environment report remains useful even when package.json is invalid.
		}
		if (!packageManager) {
			if (await exists(join(root, "pnpm-lock.yaml"))) packageManager = "pnpm";
			else if (await exists(join(root, "yarn.lock"))) packageManager = "yarn";
			else if (await exists(join(root, "package-lock.json"))) packageManager = "npm";
		}
	}
	if ((await exists(pyprojectPath)) || (await exists(requirementsPath))) {
		kinds.push("python");
		if (await exists(join(root, ".python-version")))
			pythonRequirement = (await readFile(join(root, ".python-version"), "utf8")).trim().slice(0, 100);
	}
	if (await exists(cargoPath)) kinds.push("rust");
	if (await exists(goPath)) kinds.push("go");
	return {
		kinds,
		...(packageManager ? { packageManager } : {}),
		...(nodeRequirement ? { nodeRequirement } : {}),
		...(pythonRequirement ? { pythonRequirement } : {}),
		...(kinds.includes("node") ? { nodeDependenciesInstalled: await exists(join(root, "node_modules")) } : {}),
		...(kinds.includes("python")
			? {
					pythonVirtualEnvironmentPresent: (await exists(join(root, ".venv"))) || (await exists(join(root, "venv"))),
				}
			: {}),
		envExamplePresent: await exists(join(root, ".env.example")),
		envFilePresent: await exists(join(root, ".env")),
	};
}

export interface WorkspaceEnvironmentInspectorOptions {
	workspaceRoot: string;
	pythonExecutable?: string;
	cacheTtlMs?: number;
}

export class WorkspaceEnvironmentInspector implements EnvironmentInspector {
	readonly #workspaceRoot: string;
	readonly #pythonExecutable: string;
	readonly #cacheTtlMs: number;
	#cachedBasic: EnvironmentInspection | undefined;
	#cachedVersions: EnvironmentInspection | undefined;

	constructor(options: WorkspaceEnvironmentInspectorOptions) {
		this.#workspaceRoot = options.workspaceRoot;
		this.#pythonExecutable = options.pythonExecutable ?? (process.platform === "win32" ? "python" : "python3");
		this.#cacheTtlMs = options.cacheTtlMs ?? 15_000;
	}

	async inspect(options: { probeVersions?: boolean } = {}): Promise<EnvironmentInspection> {
		const probeVersions = options.probeVersions ?? true;
		const cached = probeVersions ? this.#cachedVersions : (this.#cachedBasic ?? this.#cachedVersions);
		if (cached && Date.now() - cached.inspectedAt < this.#cacheTtlMs) return cached;
		const specs: ToolSpec[] = [
			{ name: "git", args: ["--version"] },
			{ name: "node", args: ["--version"] },
			{ name: "npm", args: ["--version"] },
			{ name: "pnpm", args: ["--version"] },
			{ name: "yarn", args: ["--version"] },
			{ name: "python", executable: this.#pythonExecutable, args: ["--version"] },
			{ name: "pip", args: ["--version"] },
			{ name: "docker", args: ["--version"] },
			{ name: "java", args: ["-version"] },
			{ name: "go", args: ["version"] },
			{ name: "cargo", args: ["--version"] },
			{ name: "uv", args: ["--version"] },
		];
		const inspection: EnvironmentInspection = {
			platform: process.platform,
			shell: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
			tools: await Promise.all(specs.map((spec) => probeTool(spec, probeVersions))),
			project: await inspectProject(this.#workspaceRoot),
			inspectedAt: Date.now(),
		};
		if (probeVersions) this.#cachedVersions = inspection;
		else this.#cachedBasic = inspection;
		return inspection;
	}
}

function commandFromOutput(output: string): string | undefined {
	const windows = output.match(/['"]([^'"\r\n]+)['"]\s+is not recognized as an internal or external command/i);
	if (windows?.[1]) return windows[1].trim();
	const windowsChinese = output.match(/['"]([^'"\r\n]+)['"]\s+不是内部或外部命令(?:，|,)/i);
	if (windowsChinese?.[1]) return windowsChinese[1].trim();
	const posix = output.match(/(?:^|\n)(?:[^\n]*?:\s*)?(?:\d+:\s*)?([^\s:]+):\s+(?:command\s+)?not found/i);
	return posix?.[1]?.trim();
}

function firstCommandToken(command: string): string | undefined {
	const trimmed = command.trim();
	const match = trimmed.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function diagnoseMissingExecutable(
	command: string,
	output: string,
	exitCode: number | null
): EnvironmentIssue | undefined {
	const detected = commandFromOutput(output);
	const tool = detected ?? (exitCode === 127 ? firstCommandToken(command) : undefined);
	if (!tool) return undefined;
	const suggestions = [
		installationSuggestion(tool, process.platform),
		"如果已经安装，请重启应用或终端后重新检测 PATH。",
		"不要原样重复执行；先修复环境，或选择当前机器已有的替代工具。",
	];
	return {
		code: "tool_missing",
		tool,
		requiredBy: command.slice(0, 500),
		message: `当前用户环境中未找到可执行工具 ${tool}。`,
		suggestions,
	};
}

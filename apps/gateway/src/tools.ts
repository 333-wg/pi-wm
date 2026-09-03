import type { ToolStatus } from "@wuming/protocol";

export type GatewayRuntimeMode = "pi" | "demo";

export interface BuiltinToolCatalogOptions {
	runtime: GatewayRuntimeMode;
	dockerImage?: string;
	searchProvider: "bing" | "duckduckgo" | "brave" | "searxng";
}

export interface GatewayToolCatalog {
	readonly runtime: GatewayRuntimeMode;
	list(workspaceId: string): ToolStatus[] | Promise<ToolStatus[]>;
}

const allModes = ["read_only", "workspace_write", "unrestricted"] as const;
const writeModes = ["workspace_write", "unrestricted"] as const;

export function createBuiltinToolCatalog(options: BuiltinToolCatalogOptions): GatewayToolCatalog {
	const enabled = options.runtime === "pi";
	const disabledReason = "当前使用 Demo 运行时；切换到 Pi 运行时后会向模型注册此工具";
	const status = (available: boolean): ToolStatus["status"] => enabled && available ? "ready" : enabled ? "requires_configuration" : "disabled";
	const reason = (available: boolean, configurationReason?: string) => enabled
		? available ? {} : { reason: configurationReason ?? "缺少运行配置" }
		: { reason: disabledReason };

	const tools: ToolStatus[] = [
		{ name: "read_file", label: "读取文件", description: "读取工作区内的文本文件", category: "filesystem", status: status(true), backend: "WorkspaceFileExecutor", risk: "low", sandboxModes: [...allModes], ...reason(true) },
		{ name: "grep", label: "搜索内容", description: "按正则表达式检索工作区文件内容，自动跳过 .gitignore 忽略项与二进制文件", category: "filesystem", status: status(true), backend: "WorkspaceSearcher", risk: "low", sandboxModes: [...allModes], ...reason(true) },
		{ name: "glob", label: "匹配路径", description: "按 glob 模式查找工作区文件，按修改时间倒序返回", category: "filesystem", status: status(true), backend: "WorkspaceSearcher", risk: "low", sandboxModes: [...allModes], ...reason(true) },
		{ name: "ls", label: "列出目录", description: "列出工作区目录内容，可按层级展开", category: "filesystem", status: status(true), backend: "WorkspaceSearcher", risk: "low", sandboxModes: [...allModes], ...reason(true) },
		{ name: "write_file", label: "写入文件", description: "在工作区内创建或覆盖文件", category: "filesystem", status: status(true), backend: "WorkspaceFileExecutor", risk: "medium", sandboxModes: [...writeModes], ...reason(true) },
		{ name: "edit", label: "编辑文件", description: "按精确文本匹配修改工作区文件", category: "filesystem", status: status(true), backend: "WorkspaceFileExecutor", risk: "medium", sandboxModes: [...writeModes], ...reason(true) },
		{ name: "exec", label: "执行命令", description: "在隔离容器中执行命令", category: "process", status: status(Boolean(options.dockerImage)), backend: "DockerProcessSandbox", risk: "high", sandboxModes: [...writeModes], ...reason(Boolean(options.dockerImage), "需要配置 WUMING_DOCKER_IMAGE") },
		{ name: "run_python", label: "运行 Python", description: "在隔离容器中运行 Python 代码", category: "process", status: status(Boolean(options.dockerImage)), backend: "DockerProcessSandbox", risk: "high", sandboxModes: [...writeModes], ...reason(Boolean(options.dockerImage), "需要配置 WUMING_DOCKER_IMAGE") },
		{ name: "web_search", label: "网络搜索", description: "搜索公开网页与天气等实时信息，并返回结构化结果", category: "network", status: status(true), backend: `${options.searchProvider} via SafeWebClient`, risk: "low", sandboxModes: [...allModes], ...reason(true) },
		{ name: "web_fetch", label: "获取网页", description: "抓取并提取公开网页正文", category: "network", status: status(true), backend: "SafeWebClient", risk: "low", sandboxModes: [...allModes], ...reason(true) },
		{ name: "update_plan", label: "更新计划", description: "记录并更新多步任务的执行计划，替换上一次的计划内容", category: "agent", status: status(true), backend: "GatewayAgency", risk: "low", sandboxModes: [...allModes], ...reason(true) },
		{ name: "subagent", label: "派发子代理", description: "把自成一体的调查任务交给独立子会话并等待报告，开销计入本会话预算", category: "agent", status: status(true), backend: "SessionOrchestrator", risk: "medium", sandboxModes: [...allModes], ...reason(true) },
	];

	return { runtime: options.runtime, list: () => tools.map((tool) => ({ ...tool, sandboxModes: [...tool.sandboxModes] })) };
}

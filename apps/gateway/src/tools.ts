import type { ComputerUseStatus, ToolStatus } from "@wuming/protocol";
import type { EnvironmentInspection } from "@wuming/sandbox";

export type GatewayRuntimeMode = "pi" | "demo";

export interface BuiltinToolCatalogOptions {
	runtime: GatewayRuntimeMode;
	executionPlacement?: "local_device" | "server";
	processMode?: "local" | "docker" | "disabled";
	dockerImage?: string;
	browserEnabled?: boolean;
	computerStatus?: () => ComputerUseStatus;
	previewEnabled?: boolean;
	inspectEnvironment?: (workspaceId: string) => Promise<EnvironmentInspection | undefined>;
	searchProvider: "bing" | "duckduckgo" | "brave" | "searxng";
	mediaModels?: () => Array<{ kind: "image" | "video"; model: string }>;
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
	const status = (available: boolean): ToolStatus["status"] =>
		enabled && available ? "ready" : enabled ? "requires_configuration" : "disabled";
	const processAvailable =
		options.processMode === undefined ||
		options.processMode === "local" ||
		(options.processMode === "docker" && Boolean(options.dockerImage));
	const localUserCapabilities = options.executionPlacement !== "server";
	const reason = (available: boolean, configurationReason?: string) =>
		enabled ? (available ? {} : { reason: configurationReason ?? "缺少运行配置" }) : { reason: disabledReason };

	const tools: ToolStatus[] = [
		{
			name: "skill_list",
			label: "发现技能",
			description: "分页查看可由模型主动调用的技能摘要",
			category: "agent",
			status: status(true),
			backend: "ManagedSkillCatalog",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(true),
		},
		{
			name: "skill_load",
			label: "加载技能",
			description: "按需加载技能指令或文本参考，不执行脚本或授予权限",
			category: "agent",
			status: status(true),
			backend: "ManagedSkillCatalog",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(true),
		},
		{
			name: "skill_install",
			label: "安装本地技能",
			description: "从用户本地工作区安装用户拥有的技能包",
			category: "agent",
			status: status(localUserCapabilities),
			backend: "用户电脑 .wuming/skills",
			risk: "high",
			sandboxModes: [...writeModes],
			...reason(localUserCapabilities, "仅 local_device 模式可管理用户技能"),
		},
		{
			name: "skill_set_enabled",
			label: "启停本地技能",
			description: "启用或停用用户电脑上的自定义技能",
			category: "agent",
			status: status(localUserCapabilities),
			backend: "用户电脑 .wuming/skills.json",
			risk: "high",
			sandboxModes: [...writeModes],
			...reason(localUserCapabilities, "仅 local_device 模式可管理用户技能"),
		},
		{
			name: "skill_uninstall",
			label: "卸载本地技能",
			description: "删除用户电脑上的自定义技能，系统内置技能不可删除",
			category: "agent",
			status: status(localUserCapabilities),
			backend: "用户电脑 .wuming/skills",
			risk: "high",
			sandboxModes: [...writeModes],
			...reason(localUserCapabilities, "仅 local_device 模式可管理用户技能"),
		},
		{
			name: "mcp_list",
			label: "查看本地 MCP",
			description: "查看用户当前工作区中的本地 MCP 配置和状态",
			category: "agent",
			status: status(localUserCapabilities),
			backend: "用户电脑 .wuming/mcp.json",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(localUserCapabilities, "仅 local_device 模式提供用户 MCP"),
		},
		{
			name: "mcp_configure",
			label: "配置本地 MCP",
			description: "在用户电脑上创建或更新 MCP 配置并进行本地授权",
			category: "agent",
			status: status(localUserCapabilities),
			backend: "用户电脑 MCP 管理器",
			risk: "high",
			sandboxModes: [...writeModes],
			...reason(localUserCapabilities, "仅 local_device 模式可配置用户 MCP"),
		},
		{
			name: "mcp_trust",
			label: "授权本地 MCP",
			description: "在用户电脑上授权并验证一个已配置的 MCP Server",
			category: "agent",
			status: status(localUserCapabilities),
			backend: "用户电脑 MCP 权限文件",
			risk: "high",
			sandboxModes: [...writeModes],
			...reason(localUserCapabilities, "仅 local_device 模式可授权用户 MCP"),
		},
		{
			name: "mcp_untrust",
			label: "停用本地 MCP",
			description: "撤销本地 MCP 权限并关闭对应连接或进程",
			category: "agent",
			status: status(localUserCapabilities),
			backend: "用户电脑 MCP 权限文件",
			risk: "high",
			sandboxModes: [...writeModes],
			...reason(localUserCapabilities, "仅 local_device 模式可停用用户 MCP"),
		},
		{
			name: "read_file",
			label: "读取文件",
			description: "读取工作区内的文本文件",
			category: "filesystem",
			status: status(true),
			backend: "WorkspaceFileExecutor",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(true),
		},
		{
			name: "environment_status",
			label: "环境诊断",
			description: "检查用户本机开发工具、版本与项目依赖标记，不读取凭证或环境变量值",
			category: "process",
			status: status(true),
			backend: "WorkspaceEnvironmentInspector",
			risk: "medium",
			sandboxModes: [...writeModes],
			...reason(true),
		},
		{
			name: "grep",
			label: "搜索内容",
			description: "按正则表达式检索工作区文件内容，自动跳过 .gitignore 忽略项与二进制文件",
			category: "filesystem",
			status: status(true),
			backend: "WorkspaceSearcher",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(true),
		},
		{
			name: "glob",
			label: "匹配路径",
			description: "按 glob 模式查找工作区文件，按修改时间倒序返回",
			category: "filesystem",
			status: status(true),
			backend: "WorkspaceSearcher",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(true),
		},
		{
			name: "ls",
			label: "列出目录",
			description: "列出工作区目录内容，可按层级展开",
			category: "filesystem",
			status: status(true),
			backend: "WorkspaceSearcher",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(true),
		},
		{
			name: "write_file",
			label: "写入文件",
			description: "在工作区内创建或覆盖文件",
			category: "filesystem",
			status: status(true),
			backend: "WorkspaceFileExecutor",
			risk: "medium",
			sandboxModes: [...writeModes],
			...reason(true),
		},
		{
			name: "edit",
			label: "编辑文件",
			description: "按精确文本匹配修改工作区文件",
			category: "filesystem",
			status: status(true),
			backend: "WorkspaceFileExecutor",
			risk: "medium",
			sandboxModes: [...writeModes],
			...reason(true),
		},
		{
			name: "exec",
			label: "执行命令",
			description:
				options.executionPlacement === "server"
					? "使用显式配置的服务器隔离环境执行工作区命令"
					: "直接使用用户电脑上的 Shell、PATH 和项目环境执行工作区命令",
			category: "process",
			status: status(processAvailable),
			backend:
				options.processMode === "docker"
					? "Docker Sandbox"
					: options.processMode === "disabled"
						? "未连接执行端"
						: "用户电脑 Shell",
			risk: "high",
			sandboxModes: [...writeModes],
			...reason(
				processAvailable,
				options.processMode === "docker" ? "需要配置 WUMING_DOCKER_IMAGE" : "未启用进程执行后端"
			),
		},
		{
			name: "run_python",
			label: "运行 Python",
			description:
				options.processMode === "docker"
					? "使用显式配置的 Docker 镜像运行 Python 代码"
					: "使用用户电脑上已经安装并加入 PATH 的 Python 运行代码",
			category: "process",
			status: status(processAvailable),
			backend:
				options.processMode === "docker"
					? "Docker Sandbox"
					: options.processMode === "disabled"
						? "未连接执行端"
						: "用户电脑 Python",
			risk: "high",
			sandboxModes: [...writeModes],
			...reason(
				processAvailable,
				options.processMode === "docker" ? "需要配置 WUMING_DOCKER_IMAGE" : "未启用进程执行后端"
			),
		},
		{
			name: "preview_start",
			label: "启动预览",
			description: "在用户电脑的工作区启动长期运行的开发服务并等待就绪",
			category: "process",
			status: status(options.previewEnabled ?? false),
			backend: options.executionPlacement === "server" ? "未连接用户设备" : "用户电脑预览进程",
			risk: "high",
			sandboxModes: [...writeModes],
			...reason(options.previewEnabled ?? false, "当前执行端未启用本地预览"),
		},
		{
			name: "preview_status",
			label: "预览状态",
			description: "读取当前会话开发服务的状态和最近日志",
			category: "process",
			status: status(options.previewEnabled ?? false),
			backend: options.executionPlacement === "server" ? "未连接用户设备" : "用户电脑预览进程",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(options.previewEnabled ?? false, "当前执行端未启用本地预览"),
		},
		{
			name: "preview_stop",
			label: "停止预览",
			description: "停止当前会话的开发服务及其子进程",
			category: "process",
			status: status(options.previewEnabled ?? false),
			backend: options.executionPlacement === "server" ? "未连接用户设备" : "用户电脑预览进程",
			risk: "medium",
			sandboxModes: [...writeModes],
			...reason(options.previewEnabled ?? false, "当前执行端未启用本地预览"),
		},
		{
			name: "web_search",
			label: "网络搜索",
			description: "搜索公开网页与天气等实时信息，并返回结构化结果",
			category: "network",
			status: status(true),
			backend: `${options.searchProvider} via SafeWebClient`,
			risk: "low",
			sandboxModes: [...allModes],
			...reason(true),
		},
		{
			name: "web_fetch",
			label: "获取网页",
			description: "抓取并提取公开网页正文",
			category: "network",
			status: status(true),
			backend: "SafeWebClient",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(true),
		},
		{
			name: "browser_search",
			label: "浏览器搜索",
			description: "通过用户设备上的浏览器和网络搜索公开信息，并返回结构化结果",
			category: "network",
			status: status(options.browserEnabled ?? true),
			backend: "用户设备浏览器",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(options.browserEnabled ?? true, "WUMING_BROWSER_ENABLED 未启用，或当前不是 local_device 模式"),
		},
		{
			name: "browser_download",
			label: "浏览器下载",
			description: "通过用户设备上的浏览器将资源下载到当前本地工作区",
			category: "network",
			status: status(options.browserEnabled ?? true),
			backend: "用户设备浏览器/本地工作区",
			risk: "medium",
			sandboxModes: [...writeModes],
			...reason(options.browserEnabled ?? true, "WUMING_BROWSER_ENABLED 未启用，或当前不是 local_device 模式"),
		},
		{
			name: "browser_open",
			label: "打开浏览器",
			description: "在隔离 Chromium 会话中打开公开网站或本机开发服务并读取语义快照",
			category: "network",
			status: status(options.browserEnabled ?? true),
			backend: "Playwright Chromium",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(options.browserEnabled ?? true, "浏览器自动化已被 WUMING_BROWSER_ENABLED 禁用"),
		},
		{
			name: "browser_snapshot",
			label: "页面快照",
			description: "读取当前页面的可访问性树和可交互元素引用",
			category: "network",
			status: status(options.browserEnabled ?? true),
			backend: "Playwright Chromium",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(options.browserEnabled ?? true, "浏览器自动化已被 WUMING_BROWSER_ENABLED 禁用"),
		},
		{
			name: "browser_screenshot",
			label: "页面截图",
			description: "截取当前视口或完整页面，用于视觉与响应式检查",
			category: "network",
			status: status(options.browserEnabled ?? true),
			backend: "Playwright Chromium",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(options.browserEnabled ?? true, "浏览器自动化已被 WUMING_BROWSER_ENABLED 禁用"),
		},
		{
			name: "browser_diagnostics",
			label: "浏览器诊断",
			description: "读取控制台错误、页面异常、失败请求和 HTTP 错误响应",
			category: "network",
			status: status(options.browserEnabled ?? true),
			backend: "Playwright Chromium",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(options.browserEnabled ?? true, "浏览器自动化已被 WUMING_BROWSER_ENABLED 禁用"),
		},
		{
			name: "browser_tabs",
			label: "浏览器标签页",
			description: "列出当前浏览器会话中的标签页与弹窗并标记活动页",
			category: "network",
			status: status(options.browserEnabled ?? true),
			backend: "Playwright Chromium",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(options.browserEnabled ?? true, "浏览器自动化已被 WUMING_BROWSER_ENABLED 禁用"),
		},
		{
			name: "browser_close",
			label: "关闭浏览器",
			description: "关闭当前会话的浏览器上下文并清除登录态",
			category: "network",
			status: status(options.browserEnabled ?? true),
			backend: "Playwright Chromium",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(options.browserEnabled ?? true, "浏览器自动化已被 WUMING_BROWSER_ENABLED 禁用"),
		},
		{
			name: "browser_action",
			label: "操控页面",
			description: "点击、输入、选择、滚动、导航或等待页面状态",
			category: "network",
			status: status(options.browserEnabled ?? true),
			backend: "Playwright Chromium",
			risk: "medium",
			sandboxModes: [...writeModes],
			...reason(options.browserEnabled ?? true, "浏览器自动化已被 WUMING_BROWSER_ENABLED 禁用"),
		},
		{
			name: "update_plan",
			label: "更新计划",
			description: "记录并更新多步任务的执行计划，替换上一次的计划内容",
			category: "agent",
			status: status(true),
			backend: "GatewayAgency",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(true),
		},
		{
			name: "memory_search",
			label: "检索会话记忆",
			description: "按关键词检索当前会话中有效的压缩记忆与来源引用",
			category: "agent",
			status: status(true),
			backend: "SessionMemory",
			risk: "low",
			sandboxModes: [...allModes],
			...reason(true),
		},
		{
			name: "subagent",
			label: "派发子代理",
			description: "把自成一体的调查任务交给独立子会话并等待报告，开销计入本会话预算",
			category: "agent",
			status: status(true),
			backend: "SessionOrchestrator",
			risk: "medium",
			sandboxModes: [...allModes],
			...reason(true),
		},
	];

	for (const [name, label, description] of [
		["TeamCreate", "创建团队", "创建持久化协作团队和共享任务板"],
		["Agent", "创建常驻成员", "启动可多轮执行、接收队友消息的团队成员"],
		["TaskCreate", "创建共享任务", "登记负责人、依赖和写入范围"],
		["TaskList", "读取任务板", "读取当前团队的任务与成员状态"],
		["TaskGet", "读取团队任务", "读取任务详情、依赖和结果"],
		["TaskUpdate", "更新团队任务", "原子认领任务、更新进度并提交验证结果"],
		["SendMessage", "发送队友消息", "持久化点对点或广播消息并唤醒空闲成员"],
		["TeamFinish", "团队验收", "负责人验证所有任务后结束团队"],
	] as const)
		tools.push({
			name,
			label,
			description,
			category: "agent",
			status: status(true),
			backend: "AgentTeamService",
			risk: name === "TaskList" || name === "TaskGet" ? "low" : "medium",
			sandboxModes: [...allModes],
			...reason(true),
		});

	return {
		runtime: options.runtime,
		list: async (workspaceId) => {
			const listed = tools.map((tool) => ({ ...tool, sandboxModes: [...tool.sandboxModes] }));
			const computer = localUserCapabilities ? options.computerStatus?.() : undefined;
			for (const [name, label, description] of [
				["computer_screenshot", "桌面截图", "开启 Computer Use 后截取 Windows 显示器并向模型返回图片"],
				["computer_action", "桌面操作", "开启 Computer Use 后切换目标窗口并执行点击、输入、快捷键或滚动"],
				["computer_release", "释放桌面控制", "释放当前会话持有的桌面控制权"],
				["computer_control", "授权连续桌面操作", "为当前任务申请限时前台控制，需要明确确认"],
				["computer_apps", "列出已安装应用", "读取开始菜单应用列表"],
				["computer_open", "打开应用", "通过已观察的应用快捷方式直接启动应用"],
				["computer_windows", "列出桌面窗口", "读取窗口列表，不截图、不移动鼠标"],
				["computer_inspect", "读取窗口控件", "读取指定窗口的控件名称、内容和支持的操作"],
				["computer_element_action", "操作窗口控件", "通过 UI Automation 操作控件，不主动切换前台或使用真实鼠标"],
			] as const) {
				const available = Boolean(
					computer?.supported && (name === "computer_release" || (computer.enabled && computer.ready))
				);
				listed.push({
					name,
					label,
					description,
					category: "process",
					status: status(available),
					backend: "Windows desktop helper",
					risk: ["computer_action", "computer_element_action", "computer_control", "computer_open"].includes(name)
						? "high"
						: name === "computer_release"
							? "low"
							: "medium",
					sandboxModes: ["computer_action", "computer_element_action", "computer_control", "computer_open"].includes(
						name
					)
						? [...writeModes]
						: [...allModes],
					...reason(
						available,
						computer?.error ??
							(computer?.supported
								? "请在设置 > Computer Use 中开启，缺少依赖时会自动准备"
								: "仅支持 Windows 本地设备的 Pi 运行时")
					),
				});
			}
			listed.push({
				name: "media_model_status",
				label: "查看生成模型配置",
				description: "检查已有生图和生视频默认配置，不返回密钥、不调用模型",
				category: "agent",
				status: status(true),
				backend: "Host media settings",
				risk: "low",
				sandboxModes: [...allModes],
				...reason(true),
			});
			for (const [name, kind, label] of [
				["generate_image", "image", "生成图片"],
				["get_generated_image", "image", "取回已生成图片"],
				["generate_video", "video", "生成视频"],
				["get_generated_video", "video", "获取生成视频"],
			] as const) {
				const configured = options.mediaModels?.().find((model) => model.kind === kind);
				listed.push({
					name,
					label,
					description: "使用设置中的默认生成模型，结果保存为对话附件",
					category: "network",
					status: status(Boolean(configured)),
					backend: configured?.model ?? "OpenAI-compatible media API",
					risk: "medium",
					sandboxModes: [...writeModes],
					...reason(Boolean(configured), "请在设置中配置默认生成模型"),
				});
			}
			if (!enabled || !options.inspectEnvironment) return listed;
			const environment = await options.inspectEnvironment(workspaceId).catch(() => undefined);
			if (!environment) return listed;
			const dependency =
				options.processMode === "docker"
					? environment.tools.find((tool) => tool.name === "docker")
					: environment.tools.find((tool) => tool.name === "python");
			if (dependency?.available !== false) return listed;
			const affected = options.processMode === "docker" ? new Set(["exec", "run_python"]) : new Set(["run_python"]);
			return listed.map((tool) =>
				affected.has(tool.name)
					? {
							...tool,
							status: "requires_configuration" as const,
							reason: dependency.suggestion ?? `未检测到 ${dependency.name}；请安装、修复 PATH 后刷新工具状态。`,
						}
					: tool
			);
		},
	};
}

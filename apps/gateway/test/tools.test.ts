import { describe, expect, it } from "vitest";
import { createBuiltinToolCatalog } from "../src/tools.js";

describe("built-in tool catalog", () => {
	it("refreshes Computer Use availability without rebuilding the catalog", async () => {
		let enabled = false;
		const catalog = createBuiltinToolCatalog({
			runtime: "pi",
			searchProvider: "bing",
			executionPlacement: "local_device",
			computerStatus: () => ({
				supported: true,
				enabled,
				ready: true,
				installing: false,
				platform: "win32",
				python: "python",
			}),
		});
		expect((await catalog.list("w1")).find((tool) => tool.name === "computer_action")?.status).toBe(
			"requires_configuration"
		);
		enabled = true;
		expect((await catalog.list("w1")).find((tool) => tool.name === "computer_control")).toMatchObject({
			status: "ready",
			risk: "high",
			sandboxModes: ["workspace_write", "unrestricted"],
		});
		expect((await catalog.list("w1")).find((tool) => tool.name === "computer_action")).toMatchObject({
			status: "ready",
			risk: "high",
			sandboxModes: ["workspace_write", "unrestricted"],
		});
		const remote = createBuiltinToolCatalog({
			runtime: "pi",
			searchProvider: "bing",
			executionPlacement: "server",
			computerStatus: () => ({
				supported: true,
				enabled: true,
				ready: true,
				installing: false,
				platform: "win32",
				python: "python",
			}),
		});
		expect((await remote.list("w1")).find((tool) => tool.name === "computer_action")?.status).toBe(
			"requires_configuration"
		);
	});
	it("reports Pi tools and local process tools accurately", async () => {
		const catalog = createBuiltinToolCatalog({
			runtime: "pi",
			processMode: "local",
			previewEnabled: true,
			searchProvider: "bing",
		});
		const tools = await catalog.list("workspace-1");

		expect(tools).toHaveLength(57);
		for (const name of [
			"TeamCreate",
			"Agent",
			"TaskCreate",
			"TaskList",
			"TaskGet",
			"TaskUpdate",
			"SendMessage",
			"TeamFinish",
		])
			expect(tools.find((tool) => tool.name === name)).toMatchObject({ backend: "AgentTeamService", status: "ready" });
		for (const name of ["skill_list", "skill_load"])
			expect(tools.find((tool) => tool.name === name)).toMatchObject({
				category: "agent",
				status: "ready",
				sandboxModes: ["read_only", "workspace_write", "unrestricted"],
			});
		for (const name of [
			"skill_install",
			"skill_set_enabled",
			"skill_uninstall",
			"mcp_configure",
			"mcp_trust",
			"mcp_untrust",
		])
			expect(tools.find((tool) => tool.name === name)).toMatchObject({
				category: "agent",
				status: "ready",
				risk: "high",
				sandboxModes: ["workspace_write", "unrestricted"],
			});
		expect(tools.find((tool) => tool.name === "mcp_list")).toMatchObject({
			status: "ready",
			risk: "low",
			sandboxModes: ["read_only", "workspace_write", "unrestricted"],
		});
		expect(tools.find((tool) => tool.name === "web_search")).toMatchObject({
			status: "ready",
			backend: "bing via SafeWebClient",
			description: expect.stringContaining("天气"),
		});
		expect(tools.find((tool) => tool.name === "browser_search")).toMatchObject({
			status: "ready",
			backend: "用户设备浏览器",
			risk: "low",
		});
		expect(tools.find((tool) => tool.name === "browser_download")).toMatchObject({
			status: "ready",
			backend: "用户设备浏览器/本地工作区",
			risk: "medium",
			sandboxModes: ["workspace_write", "unrestricted"],
		});
		expect(tools.find((tool) => tool.name === "weather")).toBeUndefined();
		// Search is read-only, so it must be offered in every sandbox mode.
		for (const name of ["grep", "glob", "ls"]) {
			expect(tools.find((tool) => tool.name === name)).toMatchObject({
				status: "ready",
				backend: "WorkspaceSearcher",
				risk: "low",
				sandboxModes: ["read_only", "workspace_write", "unrestricted"],
			});
		}
		expect(tools.find((tool) => tool.name === "exec")).toMatchObject({
			status: "ready",
			backend: "用户电脑 Shell",
		});
		expect(tools.find((tool) => tool.name === "environment_status")).toMatchObject({
			status: "ready",
			backend: "WorkspaceEnvironmentInspector",
			risk: "medium",
			sandboxModes: ["workspace_write", "unrestricted"],
		});
		expect(tools.find((tool) => tool.name === "browser_open")).toMatchObject({
			status: "ready",
			backend: "Playwright Chromium",
			risk: "low",
		});
		expect(tools.find((tool) => tool.name === "browser_tabs")).toMatchObject({
			status: "ready",
			risk: "low",
		});
		expect(tools.find((tool) => tool.name === "browser_action")).toMatchObject({
			status: "ready",
			risk: "medium",
			sandboxModes: ["workspace_write", "unrestricted"],
		});
		// Planning and delegation need no host capability, so they are ready in every mode.
		expect(tools.find((tool) => tool.name === "update_plan")).toMatchObject({
			category: "agent",
			status: "ready",
			risk: "low",
		});
		expect(tools.find((tool) => tool.name === "memory_search")).toMatchObject({
			category: "agent",
			status: "ready",
			backend: "SessionMemory",
			risk: "low",
		});
		expect(tools.find((tool) => tool.name === "subagent")).toMatchObject({
			category: "agent",
			status: "ready",
			backend: "SessionOrchestrator",
			sandboxModes: ["read_only", "workspace_write", "unrestricted"],
		});
		expect(tools.find((tool) => tool.name === "preview_start")).toMatchObject({
			status: "ready",
			backend: "用户电脑预览进程",
			risk: "high",
			sandboxModes: ["workspace_write", "unrestricted"],
		});
		expect(tools.find((tool) => tool.name === "preview_status")).toMatchObject({
			status: "ready",
			risk: "low",
		});
	});

	it("can disable local preview commands explicitly", async () => {
		const tools = await createBuiltinToolCatalog({ runtime: "pi", searchProvider: "bing" }).list("workspace-1");
		for (const tool of tools.filter((candidate) => candidate.name.startsWith("preview_"))) {
			expect(tool).toMatchObject({
				status: "requires_configuration",
				reason: expect.stringContaining("未启用本地预览"),
			});
		}
	});

	it("reports browser tools as requiring configuration when automation is disabled", async () => {
		const tools = await createBuiltinToolCatalog({
			runtime: "pi",
			browserEnabled: false,
			searchProvider: "bing",
		}).list("workspace-1");
		for (const tool of tools.filter((candidate) => candidate.name.startsWith("browser_"))) {
			expect(tool).toMatchObject({
				status: "requires_configuration",
				reason: expect.stringContaining("WUMING_BROWSER_ENABLED"),
			});
		}
	});

	it("reports all tools disabled when the agent runtime is Demo", async () => {
		const catalog = createBuiltinToolCatalog({
			runtime: "demo",
			dockerImage: "python:3.12",
			searchProvider: "brave",
		});
		const tools = await catalog.list("workspace-1");

		expect(tools.every((tool) => tool.status === "disabled")).toBe(true);
		expect(tools.every((tool) => tool.reason?.includes("Demo"))).toBe(true);
	});

	it("does not expose user-owned skill or MCP management on a server host", async () => {
		const tools = await createBuiltinToolCatalog({
			runtime: "pi",
			executionPlacement: "server",
			processMode: "disabled",
			searchProvider: "bing",
		}).list("workspace-1");
		for (const name of [
			"skill_install",
			"skill_set_enabled",
			"skill_uninstall",
			"mcp_list",
			"mcp_configure",
			"mcp_trust",
			"mcp_untrust",
		]) {
			expect(tools.find((tool) => tool.name === name)).toMatchObject({
				status: "requires_configuration",
				reason: expect.stringContaining("local_device"),
			});
		}
	});

	it("enables process tools when a Docker image is explicitly selected", async () => {
		const catalog = createBuiltinToolCatalog({
			runtime: "pi",
			processMode: "docker",
			dockerImage: "python:3.12",
			searchProvider: "searxng",
		});
		const tools = await catalog.list("workspace-1");

		expect(tools.find((tool) => tool.name === "exec")?.status).toBe("ready");
		expect(tools.find((tool) => tool.name === "run_python")?.status).toBe("ready");
	});

	it("does not require Docker for the default process backend", async () => {
		const tools = await createBuiltinToolCatalog({ runtime: "pi", searchProvider: "bing" }).list("workspace-1");
		expect(tools.find((tool) => tool.name === "exec")).toMatchObject({
			status: "ready",
			backend: "用户电脑 Shell",
		});
	});

	it("reports a missing local Python with an actionable suggestion", async () => {
		const tools = await createBuiltinToolCatalog({
			runtime: "pi",
			processMode: "local",
			searchProvider: "bing",
			inspectEnvironment: async () => ({
				platform: "win32",
				shell: "cmd.exe",
				inspectedAt: 1,
				project: { kinds: ["python"], envExamplePresent: false, envFilePresent: false },
				tools: [
					{
						name: "python",
						available: false,
						suggestion: "安装 Python 3，并加入 PATH。",
					},
				],
			}),
		}).list("workspace-1");

		expect(tools.find((tool) => tool.name === "run_python")).toMatchObject({
			status: "requires_configuration",
			reason: "安装 Python 3，并加入 PATH。",
		});
		expect(tools.find((tool) => tool.name === "exec")?.status).toBe("ready");
	});
});

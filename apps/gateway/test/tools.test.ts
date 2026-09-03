import { describe, expect, it } from "vitest";
import { createBuiltinToolCatalog } from "../src/tools.js";

describe("built-in tool catalog", () => {
	it("reports Pi tools and Docker-dependent process tools accurately", async () => {
		const catalog = createBuiltinToolCatalog({ runtime: "pi", searchProvider: "bing" });
		const tools = await catalog.list("workspace-1");

		expect(tools).toHaveLength(12);
		expect(tools.find((tool) => tool.name === "web_search")).toMatchObject({
			status: "ready",
			backend: "bing via SafeWebClient",
			description: expect.stringContaining("天气"),
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
		expect(tools.find((tool) => tool.name === "exec")).toMatchObject({ status: "requires_configuration", reason: "需要配置 WUMING_DOCKER_IMAGE" });
		// Planning and delegation need no host capability, so they are ready in every mode.
		expect(tools.find((tool) => tool.name === "update_plan")).toMatchObject({ category: "agent", status: "ready", risk: "low" });
		expect(tools.find((tool) => tool.name === "subagent")).toMatchObject({
			category: "agent",
			status: "ready",
			backend: "SessionOrchestrator",
			sandboxModes: ["read_only", "workspace_write", "unrestricted"],
		});
	});

	it("reports all tools disabled when the agent runtime is Demo", async () => {
		const catalog = createBuiltinToolCatalog({ runtime: "demo", dockerImage: "python:3.12", searchProvider: "brave" });
		const tools = await catalog.list("workspace-1");

		expect(tools.every((tool) => tool.status === "disabled")).toBe(true);
		expect(tools.every((tool) => tool.reason?.includes("Demo"))).toBe(true);
	});

	it("enables process tools when a Docker image is configured", async () => {
		const catalog = createBuiltinToolCatalog({ runtime: "pi", dockerImage: "python:3.12", searchProvider: "searxng" });
		const tools = await catalog.list("workspace-1");

		expect(tools.find((tool) => tool.name === "exec")?.status).toBe("ready");
		expect(tools.find((tool) => tool.name === "run_python")?.status).toBe("ready");
	});
});

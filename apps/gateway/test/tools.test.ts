import { describe, expect, it } from "vitest";
import { createBuiltinToolCatalog } from "../src/tools.js";

describe("built-in tool catalog", () => {
	it("reports Pi tools and Docker-dependent process tools accurately", async () => {
		const catalog = createBuiltinToolCatalog({ runtime: "pi", searchProvider: "bing" });
		const tools = await catalog.list("workspace-1");

		expect(tools).toHaveLength(8);
		expect(tools.find((tool) => tool.name === "web_search")).toMatchObject({ status: "ready", backend: "bing via SafeWebClient" });
		expect(tools.find((tool) => tool.name === "weather")).toMatchObject({ status: "ready", backend: "Open-Meteo via SafeWebClient" });
		expect(tools.find((tool) => tool.name === "exec")).toMatchObject({ status: "requires_configuration", reason: "需要配置 WUMING_DOCKER_IMAGE" });
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

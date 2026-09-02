import type { ModelMetadata } from "@wuming/protocol";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configuredMcpTrust, configuredModels, configuredWebSearch, configuredWorkspaces } from "../src/configuration.js";

const fallbackModel: ModelMetadata = {
	model: { provider: "demo", id: "fallback" },
	name: "Fallback",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxOutputTokens: 100,
	authenticated: true,
};

describe("gateway configuration", () => {
	it("keeps the single-workspace and single-model defaults", () => {
		expect(configuredWorkspaces("D:\\workspace", {})).toEqual([
			{ id: "local-workspace", name: "Local workspace", path: "D:\\workspace" },
		]);
		expect(configuredModels(fallbackModel, {})).toEqual([fallbackModel]);
		expect([...configuredMcpTrust({})]).toEqual([]);
	});

	it("parses deployment-controlled MCP server trust", () => {
		const trusted = configuredMcpTrust({
			WUMING_MCP_TRUSTED_SERVERS_JSON: JSON.stringify([
				{ workspaceId: "workspace-1", serverId: "docs" },
				{ workspaceId: "workspace-2", serverId: "database" },
			]),
		});
		expect([...trusted]).toEqual(["workspace-1\0docs", "workspace-2\0database"]);
		expect(() => configuredMcpTrust({ WUMING_MCP_TRUSTED_SERVERS_JSON: "{}" })).toThrow(/JSON array/);
	});

	it("parses multiple workspaces and models", () => {
		const workspaces = configuredWorkspaces("D:\\fallback", {
			WUMING_WORKSPACES_JSON: JSON.stringify([
				{ id: "one", name: "One", path: "D:\\workspace-one" },
				{ id: "two", name: "Two", path: "." },
			]),
		});
		expect(workspaces).toHaveLength(2);
		expect(workspaces[1]?.path).toBe(resolve(process.cwd(), "."));

		const models = configuredModels(fallbackModel, {
			WUMING_MODELS_JSON: JSON.stringify([
				{ provider: "provider-a", id: "model-a", name: "Model A", input: ["text"], authenticated: true },
				{ provider: "provider-b", id: "model-b", name: "Model B", reasoning: true, authenticated: false },
			]),
		});
		expect(models).toMatchObject([
			{ model: { provider: "provider-a", id: "model-a" }, input: ["text"], reasoning: false, authenticated: true },
			{ model: { provider: "provider-b", id: "model-b" }, input: ["text", "image"], reasoning: true, authenticated: false },
		]);
	});

	it("rejects duplicate workspace and model identities", () => {
		expect(() => configuredWorkspaces("D:\\fallback", {
			WUMING_WORKSPACES_JSON: JSON.stringify([
				{ id: "same", name: "One", path: "D:\\one" },
				{ id: "same", name: "Two", path: "D:\\two" },
			]),
		})).toThrow(/workspace IDs must be unique/);
		expect(() => configuredModels(fallbackModel, {
			WUMING_MODELS_JSON: JSON.stringify([
				{ provider: "same", id: "same", name: "One" },
				{ provider: "same", id: "same", name: "Two" },
			]),
		})).toThrow(/provider\/model pairs must be unique/);
	});

	it("parses and validates web search providers", () => {
		expect(configuredWebSearch({})).toEqual({ provider: "bing" });
		expect(configuredWebSearch({ WUMING_WEB_SEARCH_PROVIDER: "bing" })).toEqual({ provider: "bing" });
		expect(configuredWebSearch({ WUMING_WEB_SEARCH_PROVIDER: "duckduckgo" })).toEqual({ provider: "duckduckgo" });
		expect(configuredWebSearch({ WUMING_WEB_SEARCH_PROVIDER: "brave", WUMING_WEB_SEARCH_API_KEY: "secret" })).toEqual({
			provider: "brave",
			apiKey: "secret",
		});
		expect(configuredWebSearch({ WUMING_WEB_SEARCH_PROVIDER: "searxng", WUMING_WEB_SEARCH_ENDPOINT: "https://search.example.com/search" })).toEqual({
			provider: "searxng",
			endpoint: "https://search.example.com/search",
		});
		expect(() => configuredWebSearch({ WUMING_WEB_SEARCH_API_KEY: "secret" })).toThrow(/PROVIDER is required/);
		expect(() => configuredWebSearch({ WUMING_WEB_SEARCH_PROVIDER: "brave" })).toThrow(/API_KEY is required/);
		expect(() => configuredWebSearch({ WUMING_WEB_SEARCH_PROVIDER: "searxng" })).toThrow(/ENDPOINT is required/);
		expect(() => configuredWebSearch({ WUMING_WEB_SEARCH_PROVIDER: "unknown" })).toThrow(/must be bing, duckduckgo, brave, or searxng/);
	});
});

import { describe, expect, it } from "vitest";
import { importMcpConfigurations } from "../src/lib/mcp-config.js";

describe("MCP configuration import", () => {
	it("normalizes common maps and lifecycle aliases without dropping credentials", () => {
		expect(
			importMcpConfigurations(
				JSON.stringify({
					mcp_servers: {
						docs: {
							type: "http",
							endpoint: "https://example.test/mcp",
							http_headers: { Authorization: "test-only" },
							enabled_tools: ["search"],
							tool_timeout_sec: 12,
							enabled: false,
						},
					},
				})
			)
		).toEqual([
			{
				id: "docs",
				transport: "streamable-http",
				url: "https://example.test/mcp",
				headers: { Authorization: "test-only" },
				enabledTools: ["search"],
				requestTimeoutMs: 12000,
				enabled: false,
			},
		]);
	});
	it("accepts server arrays and redacted edits", () => {
		const configs = importMcpConfigurations(
			JSON.stringify({ servers: [{ id: "docs", command: "node", args: ["a b.js"], env: { KEY: null } }] })
		);
		expect(configs[0]).toMatchObject({ transport: "stdio", env: { KEY: null } });
	});
	it.each([
		"invalid-json-secret",
		"null",
		"[]",
		'{"servers":[]}',
		JSON.stringify({ id: "bad id", command: "node" }),
		JSON.stringify({ id: "docs", command: "node", args: "not-an-array" }),
		JSON.stringify({ id: "docs", command: "node", env: { KEY: { secret: "private" } } }),
		JSON.stringify({
			servers: [
				{ id: "docs", command: "node" },
				{ id: "docs", command: "node" },
			],
		}),
	])("rejects malformed input without echoing its contents", (value) => {
		expect(() => importMcpConfigurations(value)).toThrow();
		try {
			importMcpConfigurations(value);
		} catch (error) {
			expect(String(error)).not.toContain("private");
		}
	});
});

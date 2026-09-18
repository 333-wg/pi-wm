import { access, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "@wuming/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpManagementTools, FileMcpCatalog } from "../src/mcp.js";

// MCP tools ignore Pi's fifth argument, so the tests pass what Pi passes for a
// context-free call rather than fabricating an extension context.
const noContext = undefined as unknown as Parameters<ToolDefinition["execute"]>[4];

const serverScript = `
const readline = require("node:readline");
if (process.argv[2] === "--mark-start" && process.argv[3]) require("node:fs").writeFileSync(process.argv[3], "started");
const rl = readline.createInterface({ input: process.stdin });
let listCalls = 0;
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "tools/list" && require("node:fs").existsSync("catalog-pages.json")) {
    const pages = JSON.parse(require("node:fs").readFileSync("catalog-pages.json", "utf8"));
    const page = pages[request.params.cursor ?? "$first"];
    const respond = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: page }) + String.fromCharCode(10));
    if (page?.delayMs) setTimeout(respond, page.delayMs); else respond();
    return;
  }
  if (request.method === "initialize" && require("node:fs").existsSync("hold-initialize")) {
    require("node:fs").writeFileSync("initializing", "ready");
    const timer = setInterval(() => {
      if (require("node:fs").existsSync("hold-initialize")) return;
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + String.fromCharCode(10));
    }, 10);
    return;
  }
  if (request.method === "tools/call") require("node:fs").appendFileSync("calls.txt", "called");
  if (request.method === "tools/call" && request.params.arguments.notify) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + String.fromCharCode(10));
  }
  if (request.method === "tools/call" && request.params.arguments.rich) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      content: [
        { type: "text", text: "rich text" },
        { type: "image", mimeType: "image/png", data: "AA==" },
        { type: "audio", mimeType: "audio/wav", data: "AA==" },
        { type: "resource_link", name: "report", uri: "https://example.test/report" },
        { type: "resource", resource: { uri: "file:///report" } },
      ],
      structuredContent: { ok: true },
    } }) + String.fromCharCode(10));
    return;
  }
  if (request.method === "tools/call" && request.params.arguments.splitUtf8) {
    const diagnostic = request.params.arguments.diagnostic;
    const bytes = Buffer.from(diagnostic ? request.params.arguments.text : JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: request.params.arguments.text }] } }) + String.fromCharCode(10));
    let offset = 0;
    const timer = setInterval(() => {
      const chunk = bytes.subarray(offset, ++offset);
      const last = offset === bytes.length;
      (diagnostic ? process.stderr : process.stdout).write(chunk, () => { if (diagnostic && last) process.exit(1); });
      if (offset === bytes.length) clearInterval(timer);
    }, 2);
    return;
  }
  if (request.method === "tools/call" && typeof request.params.arguments.wire === "string") {
    process.stdout.write(request.params.arguments.wire.replaceAll("$ID", String(request.id)) + String.fromCharCode(10));
    return;
  }
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }) + "\\n");
  else if (request.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "echo", description: "Echo input #" + (++listCalls), inputSchema: { type: "object", properties: { text: { type: "string" }, hang: { type: "boolean" } } } }] } }) + "\\n");
  else if (request.method === "tools/call" && !request.params.arguments.hang) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "MCP says hello" }] } }) + "\\n");
});
`;

const catalogs: FileMcpCatalog[] = [];

function createCatalog(options: ConstructorParameters<typeof FileMcpCatalog>[0]): FileMcpCatalog {
	const catalog = new FileMcpCatalog({ isTrusted: () => true, ...options });
	catalogs.push(catalog);
	return catalog;
}

function snapshot(): SessionSnapshot {
	return {
		session: {
			id: "session-1",
			workspaceId: "workspace-1",
			phase: "turn",
			createdAt: 1,
			updatedAt: 1,
		},
		revision: 1,
		model: { provider: "demo", id: "demo" },
		thinkingLevel: "medium",
		sandboxMode: "read_only",
		approvalPolicy: "on_risk",
		transcript: [],
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		pendingApprovals: [],
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			costUsd: 0,
		},
	};
}

async function fixtureWorkspace(): Promise<{ root: string; script: string }> {
	const root = await mkdtemp(join(tmpdir(), "wuming-mcp-"));
	await mkdir(join(root, ".wuming"), { recursive: true });
	const script = join(root, "server.cjs");
	await writeFile(script, serverScript, "utf8");
	await writeFile(
		join(root, ".wuming", "mcp.json"),
		JSON.stringify({
			servers: [
				{
					id: "fixture",
					name: "Fixture MCP",
					command: process.execPath,
					args: [script],
					readOnly: true,
				},
			],
		}),
		"utf8"
	);
	return { root, script };
}

afterEach(async () => {
	for (const catalog of catalogs.splice(0)) await catalog[Symbol.asyncDispose]();
});

describe("FileMcpCatalog", () => {
	it("preserves exact local trust across disable, restart and re-enable", async () => {
		const { root } = await fixtureWorkspace();
		const first = createCatalog({ resolveWorkspace: () => root, isTrusted: () => false });
		await first.trustServer("workspace-1", root, "fixture");
		const before = await first.configurationKey("workspace-1", root);
		await expect(first.setEnabled("workspace-1", root, "fixture", false)).resolves.toMatchObject({
			trusted: true,
			discoveryStatus: "disabled",
			tools: [],
		});
		expect(await first.configurationKey("workspace-1", root)).not.toBe(before);
		await first[Symbol.asyncDispose]();
		const second = createCatalog({ resolveWorkspace: () => root, isTrusted: () => false });
		await expect(second.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			trusted: true,
			discoveryStatus: "disabled",
		});
		await expect(second.setEnabled("workspace-1", root, "fixture", true)).resolves.toMatchObject({
			trusted: true,
			discoveryStatus: "ready",
			toolCount: 1,
		});
		expect(await second.configurationKey("workspace-1", root)).toBe(before);
	});

	it("never grants trust by enabling or after editing a disabled server", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ resolveWorkspace: () => root, isTrusted: () => false });
		await catalog.configureServer("workspace-1", root, {
			id: "untrusted-toggle",
			command: "missing-toggle-canary",
			enabled: false,
		});
		await expect(catalog.setEnabled("workspace-1", root, "untrusted-toggle", true)).resolves.toMatchObject({
			trusted: false,
			discoveryStatus: "untrusted",
			tools: [],
		});
		await catalog.trustServer("workspace-1", root, "fixture");
		await catalog.setEnabled("workspace-1", root, "fixture", false);
		const config = await catalog.getConfiguration(root, "fixture");
		await catalog.configureServer("workspace-1", root, { ...config, command: "edited-untrusted-canary" });
		await expect(catalog.setEnabled("workspace-1", root, "fixture", true)).resolves.toMatchObject({
			trusted: false,
			discoveryStatus: "untrusted",
		});
		await expect(catalog.setEnabled("workspace-1", root, "missing", true)).rejects.toMatchObject({
			protocolCode: "not_found",
		});
	});

	it("returns the persisted enabled state when tool discovery fails", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ resolveWorkspace: () => root, isTrusted: () => false });
		await catalog.trustServer("workspace-1", root, "fixture");
		await catalog.setEnabled("workspace-1", root, "fixture", false);
		await writeFile(join(root, "catalog-pages.json"), JSON.stringify({ $first: { invalid: true } }));
		await expect(catalog.setEnabled("workspace-1", root, "fixture", true)).resolves.toMatchObject({
			trusted: true,
			discoveryStatus: "failed",
			tools: [],
		});
		expect((await catalog.getConfiguration(root, "fixture")).enabled).toBe(true);
		await expect(catalog.setEnabled("workspace-1", root, "fixture", false)).resolves.toMatchObject({
			trusted: true,
			discoveryStatus: "disabled",
		});
	});

	it("redacts, preserves, replaces and removes stored credentials during edits", async () => {
		const { root, script } = await fixtureWorkspace();
		const catalog = new FileMcpCatalog({ resolveWorkspace: () => root });
		catalogs.push(catalog);
		await catalog.configureServer("workspace-1", root, {
			id: "fixture",
			command: process.execPath,
			args: [script],
			env: { KEY: "secret-canary", DROP: "old" },
		});
		const publicConfig = await catalog.getConfiguration(root, "fixture");
		expect(publicConfig.env).toEqual({ KEY: null, DROP: null });
		expect(JSON.stringify(publicConfig)).not.toContain("secret-canary");
		const before = await catalog.configurationKey("workspace-1", root);
		await catalog.configureServer("workspace-1", root, { ...publicConfig, name: "Edited", env: { KEY: null } });
		const stored = JSON.parse(await readFile(join(root, ".wuming", "mcp.json"), "utf8"));
		expect(stored.servers[0].env).toEqual({ KEY: "secret-canary" });
		expect(await catalog.configurationKey("workspace-1", root)).not.toBe(before);
		await catalog.configureServer("workspace-1", root, { ...publicConfig, env: { KEY: "replacement" } });
		expect(await readFile(join(root, ".wuming", "mcp.json"), "utf8")).toContain("replacement");
		await expect(
			catalog.configureServer("workspace-1", root, { ...publicConfig, env: { MISSING: null } })
		).rejects.toThrow("No saved value");
	});

	it("changes the session configuration key for trust, revocation and removal", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = new FileMcpCatalog({ resolveWorkspace: () => root });
		catalogs.push(catalog);
		const untrusted = await catalog.configurationKey("workspace-1", root);
		await catalog.trustServer("workspace-1", root, "fixture");
		const trusted = await catalog.configurationKey("workspace-1", root);
		expect(trusted).not.toBe(untrusted);
		await catalog.untrustServer("workspace-1", root, "fixture");
		expect(await catalog.configurationKey("workspace-1", root)).toBe(untrusted);
		await catalog.removeServer("workspace-1", root, "fixture");
		expect(await catalog.list("workspace-1", root)).toEqual([]);
		expect(await catalog.configurationKey("workspace-1", root)).not.toBe(untrusted);
		await expect(catalog.getConfiguration(root, "fixture")).rejects.toMatchObject({ protocolCode: "not_found" });
	});

	it("serializes concurrent configuration writes without losing another server", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = new FileMcpCatalog({ resolveWorkspace: () => root });
		catalogs.push(catalog);
		await Promise.all(
			["one", "two"].map((id) => catalog.configureServer("workspace-1", root, { id, command: "node", enabled: false }))
		);
		expect((await catalog.list("workspace-1", root)).map((server) => server.id).sort()).toEqual([
			"fixture",
			"one",
			"two",
		]);
	});

	it("disables a managed pre-trusted server instead of silently reauthorizing it", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ resolveWorkspace: () => root });
		await expect(catalog.untrustServer("workspace-1", root, "fixture")).resolves.toMatchObject({
			discoveryStatus: "disabled",
			toolCount: 0,
		});
	});
	it("discovers later pages with opaque cursors and executes a later-page tool", async () => {
		const { root } = await fixtureWorkspace();
		await writeFile(
			join(root, "catalog-pages.json"),
			JSON.stringify({
				$first: { tools: [{ name: "first" }], nextCursor: "opaque/+?=" },
				"opaque/+?=": { tools: [], nextCursor: "" },
				"": { tools: [{ name: "last" }] },
			}),
			"utf8"
		);
		const catalog = createCatalog({ resolveWorkspace: () => root });
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			toolCount: 2,
			tools: [{ name: "first" }, { name: "last" }],
		});
		const tools = await catalog.createTools(snapshot(), {
			authorize: async () => undefined,
		} as never);
		expect(tools.map((tool) => tool.name)).toEqual(["mcp__fixture__first", "mcp__fixture__last"]);
		await expect(
			tools[1]!.execute("later-page", {}, new AbortController().signal, undefined, noContext)
		).resolves.toMatchObject({ content: [{ text: "MCP says hello" }] });
	});

	it("creates stable collision-free names for normalized and truncated tool names", async () => {
		const { root } = await fixtureWorkspace();
		const longA = "a".repeat(200);
		const longB = `${"a".repeat(199)}b`;
		await writeFile(
			join(root, "catalog-pages.json"),
			JSON.stringify({
				$first: { tools: [{ name: "echo/x" }, { name: "echo?x" }, { name: longA }, { name: longB }] },
			}),
			"utf8"
		);
		const catalog = createCatalog({ resolveWorkspace: () => root });
		const tools = await catalog.createTools(snapshot(), { authorize: async () => undefined } as never);
		const names = tools.map((tool) => tool.name);
		expect(names).toHaveLength(4);
		expect(new Set(names).size).toBe(4);
		expect(names.every((name) => name.length <= 64)).toBe(true);
		expect(names.every((name) => name.startsWith("mcp__fixture__"))).toBe(true);
	});

	it("refreshes cached discovery after a tools/list_changed notification", async () => {
		const { root } = await fixtureWorkspace();
		await writeFile(
			join(root, "catalog-pages.json"),
			JSON.stringify({ $first: { tools: [{ name: "before" }] } }),
			"utf8"
		);
		const catalog = createCatalog({ resolveWorkspace: () => root });
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			tools: [{ name: "before" }],
		});
		const tools = await catalog.createTools(snapshot(), { authorize: async () => undefined } as never);
		await writeFile(
			join(root, "catalog-pages.json"),
			JSON.stringify({ $first: { tools: [{ name: "after" }] } }),
			"utf8"
		);
		await expect(
			tools[0]!.execute("notify-list-change", { notify: true }, new AbortController().signal, undefined, noContext)
		).resolves.toMatchObject({ content: [{ text: "MCP says hello" }] });
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			tools: [{ name: "after" }],
		});
	});

	it("keeps structured and non-text MCP result diagnostics bounded and visible", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ resolveWorkspace: () => root });
		const tools = await catalog.createTools(snapshot(), { authorize: async () => undefined } as never);
		await expect(
			tools[0]!.execute("rich-result", { rich: true }, new AbortController().signal, undefined, noContext)
		).resolves.toMatchObject({
			content: [
				{
					text: expect.stringContaining("rich text"),
				},
			],
		});
		const result = await tools[0]!.execute(
			"rich-result-2",
			{ rich: true },
			new AbortController().signal,
			undefined,
			noContext
		);
		const rendered = result.content
			.map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
			.join("\n");
		expect(rendered).toContain("MCP image result: image/png");
		expect(rendered).toContain("MCP audio result: audio/wav");
		expect(rendered).toContain("MCP resource link report: https://example.test/report");
		expect(rendered).toContain('Structured content: {"ok":true}');
	});

	it("applies enabled and disabled tool filters before exposing tools", async () => {
		const { root } = await fixtureWorkspace();
		await writeFile(
			join(root, "catalog-pages.json"),
			JSON.stringify({ $first: { tools: [{ name: "echo/x" }, { name: "echo?x" }] } }),
			"utf8"
		);
		await writeFile(
			join(root, ".wuming", "mcp.json"),
			JSON.stringify({
				servers: [
					{
						id: "fixture",
						command: process.execPath,
						args: [join(root, "server.cjs")],
						readOnly: true,
						enabledTools: ["echo/x"],
						disabledTools: ["echo?x"],
					},
				],
			}),
			"utf8"
		);
		const catalog = createCatalog({ resolveWorkspace: () => root });
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			toolCount: 1,
			tools: [{ name: "echo/x" }],
		});
		const tools = await catalog.createTools(snapshot(), { authorize: async () => undefined } as never);
		expect(tools).toHaveLength(1);
	});

	it("accepts mcpServers config maps and keeps disabled servers dormant", async () => {
		const { root, script } = await fixtureWorkspace();
		const marker = join(root, "started.txt");
		await writeFile(
			join(root, ".wuming", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					disabled: {
						type: "stdio",
						command: process.execPath,
						args: [script, "--mark-start", marker],
						enabled: false,
					},
				},
			}),
			"utf8"
		);
		const catalog = createCatalog({ resolveWorkspace: () => root });
		await expect(catalog.list("workspace-1", root)).resolves.toMatchObject([
			{
				id: "disabled",
				transport: "stdio",
				trusted: true,
				toolCount: 0,
				discoveryStatus: "disabled",
			},
		]);
		await expect(catalog.get("workspace-1", root, "disabled")).resolves.toMatchObject({
			discoveryStatus: "disabled",
			tools: [],
		});
		expect(
			await access(marker).then(
				() => true,
				() => false
			)
		).toBe(false);
	});

	it("discovers and calls a Streamable HTTP MCP server through the official SDK", async () => {
		const { root } = await fixtureWorkspace();
		const httpServer = createServer((request, response) => {
			if (request.method === "GET") {
				response.statusCode = 405;
				response.end();
				return;
			}
			if (request.method !== "POST") {
				response.statusCode = 404;
				response.end();
				return;
			}
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
					id?: number;
					method?: string;
				};
				if (request.headers["x-mcp-test"] !== "ok") {
					response.statusCode = 401;
					response.end();
					return;
				}
				if (message.id === undefined) {
					response.statusCode = 202;
					response.end();
					return;
				}
				const result =
					message.method === "initialize"
						? {
								protocolVersion: "2025-06-18",
								capabilities: {},
								serverInfo: { name: "http-fixture", version: "1" },
							}
						: message.method === "tools/list"
							? { tools: [{ name: "http_echo", inputSchema: { type: "object" } }] }
							: {
									content: [{ type: "text", text: "HTTP MCP says hello" }],
								};
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
			});
		});
		await new Promise<void>((resolvePromise, reject) => {
			httpServer.once("error", reject);
			httpServer.listen(0, "127.0.0.1", () => resolvePromise());
		});
		try {
			const address = httpServer.address() as AddressInfo;
			await writeFile(
				join(root, ".wuming", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						remote: {
							type: "streamable-http",
							url: `http://127.0.0.1:${address.port}/mcp`,
							headers: { "x-mcp-test": "ok" },
							readOnly: true,
						},
					},
				}),
				"utf8"
			);
			const catalog = createCatalog({ resolveWorkspace: () => root, requestTimeoutMs: 2_000 });
			await expect(catalog.list("workspace-1", root)).resolves.toMatchObject([
				{
					id: "remote",
					transport: "streamable-http",
					trusted: true,
					toolCount: 1,
					discoveryStatus: "ready",
				},
			]);
			const tools = await catalog.createTools(snapshot(), { authorize: async () => undefined } as never);
			await expect(
				tools[0]!.execute("http-call", {}, new AbortController().signal, undefined, noContext)
			).resolves.toMatchObject({ content: [{ text: "HTTP MCP says hello" }] });
		} finally {
			await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
		}
	});

	for (const [name, pages, error] of [
		[
			"cursor loop",
			{ $first: { tools: [], nextCursor: "same" }, same: { tools: [], nextCursor: "same" } },
			"repeated a cursor",
		],
		["bad cursor", { $first: { tools: [], nextCursor: 42 } }, "invalid cursor"],
		["long cursor", { $first: { tools: [], nextCursor: "x".repeat(4001) } }, "invalid cursor"],
		[
			"duplicate names",
			{
				$first: { tools: [{ name: "echo" }], nextCursor: "next" },
				next: { tools: [{ name: "echo" }] },
			},
			"duplicate or colliding",
		],
		["invalid page", { $first: { tools: "not-an-array" } }, "invalid page"],
		["invalid tool", { $first: { tools: [null] } }, "invalid tool"],
		[
			"tool bound",
			{ $first: { tools: Array.from({ length: 101 }, (_, index) => ({ name: "tool" + index })) } },
			"exceeds 100 tools",
		],
		[
			"page bound",
			Object.fromEntries(
				Array.from({ length: 21 }, (_, index) => [
					index === 0 ? "$first" : "page" + index,
					{ tools: [], nextCursor: "page" + (index + 1) },
				])
			),
			"exceeds 20 pages",
		],
	] as const) {
		it("rejects " + name + " without exposing a partial tool catalog", async () => {
			const { root } = await fixtureWorkspace();
			await writeFile(join(root, "catalog-pages.json"), JSON.stringify(pages), "utf8");
			const catalog = createCatalog({ resolveWorkspace: () => root });
			await expect(catalog.get("workspace-1", root, "fixture")).rejects.toThrow(error);
			await expect(catalog.list("workspace-1", root)).resolves.toMatchObject([
				{ discoveryStatus: "failed", toolCount: 0 },
			]);
			expect(await catalog.createTools(snapshot(), { authorize: async () => undefined } as never)).toEqual([]);
		});
	}

	it("applies one discovery time budget across pages", async () => {
		const { root } = await fixtureWorkspace();
		await writeFile(
			join(root, "catalog-pages.json"),
			JSON.stringify({
				$first: { tools: [], nextCursor: "next", delayMs: 600 },
				next: { tools: [{ name: "late" }], delayMs: 600 },
			}),
			"utf8"
		);
		const catalog = createCatalog({ resolveWorkspace: () => root, requestTimeoutMs: 1000 });
		await expect(catalog.get("workspace-1", root, "fixture")).rejects.toThrow("discovery timed out");
	});

	it("accepts exactly 100 tools across exactly 20 pages", async () => {
		const { root } = await fixtureWorkspace();
		const pages = Object.fromEntries(
			Array.from({ length: 20 }, (_, page) => [
				page === 0 ? "$first" : "page" + page,
				{
					tools: Array.from({ length: 5 }, (_, index) => ({ name: "tool" + (page * 5 + index) })),
					...(page < 19 ? { nextCursor: "page" + (page + 1) } : {}),
				},
			])
		);
		await writeFile(join(root, "catalog-pages.json"), JSON.stringify(pages), "utf8");
		const catalog = createCatalog({ resolveWorkspace: () => root });
		const result = await catalog.get("workspace-1", root, "fixture");
		expect(result.toolCount).toBe(100);
		expect(result.tools.at(-1)?.name).toBe("tool99");
	});

	it("preserves split UTF-8 stderr diagnostics on server exit", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ resolveWorkspace: () => root });
		const tools = await catalog.createTools(snapshot(), {
			authorize: async () => undefined,
		} as never);
		const text = "服务错误 🧪 café";
		await expect(
			tools[0]!.execute(
				"stderr-utf8",
				{ splitUtf8: true, diagnostic: true, text },
				new AbortController().signal,
				undefined,
				noContext
			)
		).rejects.toThrow(text);
	});

	it("preserves Chinese and emoji across single-byte stdout chunks", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ resolveWorkspace: () => root });
		const tools = await catalog.createTools(snapshot(), {
			authorize: async () => undefined,
		} as never);
		const text = "中文结果：工具执行成功 🧪🚀 café";
		await expect(
			tools[0]!.execute("utf8", { splitUtf8: true, text }, new AbortController().signal, undefined, noContext)
		).resolves.toMatchObject({ content: [{ text }] });
	});

	for (const wire of [
		"null",
		"[]",
		"42",
		"{not-json",
		'{"jsonrpc":"1.0","id":$ID,"result":{}}',
		'{"jsonrpc":"2.0","id":$ID}',
		'{"jsonrpc":"2.0","id":$ID,"result":{},"error":{"code":-1,"message":"both"}}',
		'{"jsonrpc":"2.0","id":$ID,"error":null}',
		'{"jsonrpc":"2.0","id":$ID,"error":"failed"}',
		'{"jsonrpc":"2.0","id":$ID,"error":{"code":"-1","message":"failed"}}',
		'{"jsonrpc":"2.0","id":$ID,"error":{"code":-1,"message":42}}',
	]) {
		it("rejects malformed wire response and reconnects: " + wire, async () => {
			const { root } = await fixtureWorkspace();
			const catalog = createCatalog({ resolveWorkspace: () => root });
			const tools = await catalog.createTools(snapshot(), {
				authorize: async () => undefined,
			} as never);
			await expect(
				tools[0]!.execute("malformed", { wire }, new AbortController().signal, undefined, noContext)
			).rejects.toThrow(/MCP server sent (an )?invalid/);
			await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
				tools: [{ description: "Echo input #1" }],
			});
		});
	}

	it("ignores notifications and server requests without settling a matching client ID", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ resolveWorkspace: () => root });
		const tools = await catalog.createTools(snapshot(), {
			authorize: async () => undefined,
		} as never);
		const wire = [
			'{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
			'{"jsonrpc":"2.0","id":$ID,"method":"server/request","params":{}}',
			'{"jsonrpc":"2.0","id":$ID,"result":{"content":[{"type":"text","text":"actual result"}]}}',
		].join("\n");
		await expect(
			tools[0]!.execute("notifications", { wire }, new AbortController().signal, undefined, noContext)
		).resolves.toMatchObject({ content: [{ text: "actual result" }] });
	});

	it("preserves valid remote errors without discarding the connection", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ resolveWorkspace: () => root });
		const tools = await catalog.createTools(snapshot(), {
			authorize: async () => undefined,
		} as never);
		const wire = '{"jsonrpc":"2.0","id":$ID,"error":{"code":-32000,"message":"fixture error"}}';
		await expect(
			tools[0]!.execute("error", { wire }, new AbortController().signal, undefined, noContext)
		).rejects.toThrow("fixture error");
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			tools: [{ description: "Echo input #2" }],
		});
		await expect(
			tools[0]!.execute("after-error", {}, new AbortController().signal, undefined, noContext)
		).resolves.toMatchObject({ content: [{ text: "MCP says hello" }] });
	});

	it("rechecks trust after a reconnect finishes initialization", async () => {
		const { root } = await fixtureWorkspace();
		let trusted = true;
		const catalog = createCatalog({ resolveWorkspace: () => root, isTrusted: () => trusted });
		const tools = await catalog.createTools(snapshot(), {
			authorize: async () => undefined,
		} as never);
		const first = new AbortController();
		const interrupted = tools[0]!
			.execute("disconnect", { hang: true }, first.signal, undefined, noContext)
			.catch((error: unknown) => error);
		await vi.waitFor(async () =>
			expect(
				await access(join(root, "calls.txt")).then(
					() => true,
					() => false
				)
			).toBe(true)
		);
		first.abort(new Error("disconnect fixture"));
		expect(await interrupted).toBeInstanceOf(Error);
		await unlink(join(root, "calls.txt"));
		await writeFile(join(root, "hold-initialize"), "hold", "utf8");
		const next = new AbortController();
		const attempt = tools[0]!
			.execute("reconnect", {}, next.signal, undefined, noContext)
			.catch((error: unknown) => error);
		try {
			await vi.waitFor(async () =>
				expect(
					await access(join(root, "initializing")).then(
						() => true,
						() => false
					)
				).toBe(true)
			);
			trusted = false;
			await unlink(join(root, "hold-initialize"));
			expect(await attempt).toMatchObject({
				message: expect.stringContaining("trust or configuration changed"),
			});
			expect(
				await access(join(root, "calls.txt")).then(
					() => true,
					() => false
				)
			).toBe(false);
		} finally {
			next.abort();
			await attempt;
		}
	});

	for (const timing of ["before approval", "during approval"] as const) {
		for (const change of [
			"revoke trust",
			"remove server",
			"change arguments",
			"change readOnly",
			"invalid config",
		] as const) {
			it("rejects stale tools when " + change + " happens " + timing, async () => {
				const { root, script } = await fixtureWorkspace();
				let trusted = true;
				const catalog = createCatalog({ resolveWorkspace: () => root, isTrusted: () => trusted });
				const mutate = async () => {
					if (change === "revoke trust") {
						trusted = false;
						return;
					}
					const servers =
						change === "remove server"
							? []
							: [
									{
										id: "fixture",
										name: "Fixture MCP",
										command: process.execPath,
										args: change === "change arguments" ? [script, "changed"] : [script],
										readOnly: change !== "change readOnly",
									},
								];
					await writeFile(
						join(root, ".wuming", "mcp.json"),
						change === "invalid config" ? "{" : JSON.stringify({ servers }),
						"utf8"
					);
				};
				const permit = { id: "test-permit" };
				const authorize = vi.fn(async () => {
					if (timing === "during approval") await mutate();
					return permit;
				});
				const completeAuthorization = vi.fn();
				const tools = await catalog.createTools(snapshot(), {
					authorize,
					completeAuthorization,
				} as never);
				expect(tools).toHaveLength(1);
				if (timing === "before approval") await mutate();
				await expect(
					tools[0]!.execute("stale-call", {}, new AbortController().signal, undefined, noContext)
				).rejects.toThrow(/changed|invalid JSON/);
				expect(authorize).toHaveBeenCalledTimes(timing === "before approval" ? 0 : 1);
				expect(completeAuthorization).toHaveBeenCalledTimes(timing === "before approval" ? 0 : 1);
				if (timing === "during approval") expect(completeAuthorization).toHaveBeenCalledWith(permit);
				expect(
					await access(join(root, "calls.txt")).then(
						() => true,
						() => false
					)
				).toBe(false);
			});
		}
	}

	it("lists untrusted workspace servers without starting their host process", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-mcp-untrusted-"));
		await mkdir(join(root, ".wuming"), { recursive: true });
		const marker = join(root, "started.txt");
		const script = join(root, "server.cjs");
		await writeFile(
			script,
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 1000);`,
			"utf8"
		);
		await writeFile(
			join(root, ".wuming", "mcp.json"),
			JSON.stringify({ servers: [{ id: "untrusted", command: process.execPath, args: [script] }] }),
			"utf8"
		);
		const catalog = createCatalog({ isTrusted: () => false });

		await expect(catalog.list("workspace-1", root)).resolves.toMatchObject([
			{ id: "untrusted", trusted: false, toolCount: 0 },
		]);
		await expect(catalog.get("workspace-1", root, "untrusted")).resolves.toMatchObject({
			trusted: false,
			tools: [],
		});
		expect(
			await access(marker).then(
				() => true,
				() => false
			)
		).toBe(false);
	});

	it("persists user trust in the local workspace and reuses it across catalog instances", async () => {
		const { root } = await fixtureWorkspace();
		const first = new FileMcpCatalog({ resolveWorkspace: () => root, requestTimeoutMs: 2_000 });
		catalogs.push(first);

		await expect(first.list("workspace-1", root)).resolves.toMatchObject([
			{ id: "fixture", trusted: false, discoveryStatus: "untrusted" },
		]);
		await expect(first.trustServer("workspace-1", root, "fixture")).resolves.toMatchObject({
			id: "fixture",
			trusted: true,
			toolCount: 1,
		});
		const persisted = JSON.parse(await readFile(join(root, ".wuming", "mcp-permissions.json"), "utf8"));
		expect(persisted).toMatchObject({
			trustedServers: [{ serverId: "fixture", configDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }],
		});

		const second = new FileMcpCatalog({ resolveWorkspace: () => root, requestTimeoutMs: 2_000 });
		catalogs.push(second);
		await expect(second.list("workspace-1", root)).resolves.toMatchObject([
			{ id: "fixture", trusted: true, discoveryStatus: "ready" },
		]);
		await expect(second.untrustServer("workspace-1", root, "fixture")).resolves.toMatchObject({
			id: "fixture",
			trusted: false,
			discoveryStatus: "untrusted",
		});
		expect(JSON.parse(await readFile(join(root, ".wuming", "mcp-permissions.json"), "utf8"))).toEqual({
			trustedServers: [],
		});
	});

	it("lets the agent configure and trust one MCP server using local-only management", async () => {
		const { root, script } = await fixtureWorkspace();
		const catalog = new FileMcpCatalog({ resolveWorkspace: () => root, requestTimeoutMs: 2_000 });
		catalogs.push(catalog);
		const authorize = vi.fn(async () => undefined);
		const tools = createMcpManagementTools(catalog, snapshot(), {
			authorize,
			completeAuthorization: vi.fn(),
		} as never);
		const configure = tools.find((tool) => tool.name === "mcp_configure")!;
		const result = await configure.execute(
			"configure-local",
			{
				config: JSON.stringify({
					id: "fixture",
					name: "Local fixture",
					transport: "stdio",
					command: process.execPath,
					args: [script],
					readOnly: true,
				}),
			},
			new AbortController().signal,
			undefined,
			noContext
		);

		expect(result).toMatchObject({ details: { localOnly: true, serverId: "fixture", configured: true } });
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				requireExplicitApproval: true,
				capabilities: [{ type: "mcp.manage", serverId: "fixture", action: "configure" }],
			})
		);
		expect(JSON.parse(await readFile(join(root, ".wuming", "mcp.json"), "utf8"))).toMatchObject({
			servers: [{ id: "fixture", name: "Local fixture", transport: "stdio" }],
		});
		expect(JSON.parse(await readFile(join(root, ".wuming", "mcp-permissions.json"), "utf8"))).toMatchObject({
			trustedServers: [{ serverId: "fixture", configDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }],
		});
	});

	it("requires local re-approval when a trusted MCP configuration changes", async () => {
		const { root, script } = await fixtureWorkspace();
		const catalog = new FileMcpCatalog({ resolveWorkspace: () => root, requestTimeoutMs: 2_000 });
		catalogs.push(catalog);
		await expect(catalog.trustServer("workspace-1", root, "fixture")).resolves.toMatchObject({ trusted: true });
		await writeFile(
			join(root, ".wuming", "mcp.json"),
			JSON.stringify({
				servers: [{ id: "fixture", command: process.execPath, args: [script, "changed"] }],
			}),
			"utf8"
		);
		await expect(catalog.list("workspace-1", root)).resolves.toMatchObject([
			{ id: "fixture", trusted: false, discoveryStatus: "untrusted" },
		]);
	});

	it("discovers stdio servers, lists tools, and executes a tool", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ requestTimeoutMs: 2_000, resolveWorkspace: () => root });

		expect(await catalog.list("workspace-1", root)).toMatchObject([
			{
				id: "fixture",
				name: "Fixture MCP",
				transport: "stdio",
				readOnly: true,
				trusted: true,
				toolCount: 1,
			},
		]);
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			tools: [{ name: "echo", description: "Echo input #2" }],
		});
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			tools: [{ name: "echo", description: "Echo input #3" }],
		});

		const tools = await catalog.createTools(snapshot(), {
			authorize: async () => undefined,
		} as never);
		expect(tools).toHaveLength(1);
		const result = await tools[0]!.execute(
			"call-1",
			{ text: "hello" },
			new AbortController().signal,
			undefined,
			noContext
		);
		expect(result).toMatchObject({
			content: [{ text: "MCP says hello" }],
			details: {
				mcpServerId: "fixture",
				mcpToolName: "echo",
				durationMs: expect.any(Number),
				mcpStatus: "complete",
			},
		});
	});

	it("terminates an in-flight server on abort and reconnects on the next request", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ requestTimeoutMs: 5_000, resolveWorkspace: () => root });
		const tools = await catalog.createTools(snapshot(), {
			authorize: async () => undefined,
		} as never);
		const controller = new AbortController();
		const startedAt = Date.now();
		setTimeout(() => controller.abort(new Error("cancelled by test")), 30);

		await expect(
			tools[0]!.execute("call-abort", { hang: true }, controller.signal, undefined, noContext)
		).rejects.toThrow("cancelled by test");
		expect(Date.now() - startedAt).toBeLessThan(1000);
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			tools: [{ description: "Echo input #1" }],
		});
	});

	it("releases a persistent connection when its server is removed from config", async () => {
		const { root, script } = await fixtureWorkspace();
		const configPath = join(root, ".wuming", "mcp.json");
		const catalog = createCatalog({ requestTimeoutMs: 2_000 });
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			tools: [{ description: "Echo input #1" }],
		});

		await writeFile(configPath, JSON.stringify({ servers: [] }), "utf8");
		await expect(catalog.list("workspace-1", root)).resolves.toEqual([]);
		await writeFile(
			configPath,
			JSON.stringify({
				servers: [{ id: "fixture", command: process.execPath, args: [script], readOnly: true }],
			}),
			"utf8"
		);
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({
			tools: [{ description: "Echo input #1" }],
		});
	});

	it("does not inherit gateway credentials into MCP child processes", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-mcp-env-"));
		await mkdir(join(root, ".wuming"), { recursive: true });
		const script = join(root, "server.cjs");
		await writeFile(
			script,
			`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
  if (request.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "env", description: process.env.WUMING_MCP_TEST_SECRET ? "leaked" : "clean" }] } }) + "\\n");
});`,
			"utf8"
		);
		await writeFile(
			join(root, ".wuming", "mcp.json"),
			JSON.stringify({ servers: [{ id: "env", command: process.execPath, args: [script] }] }),
			"utf8"
		);
		const previous = process.env.WUMING_MCP_TEST_SECRET;
		process.env.WUMING_MCP_TEST_SECRET = "provider-secret";
		try {
			const catalog = createCatalog({});
			await expect(catalog.get("workspace-1", root, "env")).resolves.toMatchObject({
				tools: [{ description: "clean" }],
			});
		} finally {
			if (previous === undefined) delete process.env.WUMING_MCP_TEST_SECRET;
			else process.env.WUMING_MCP_TEST_SECRET = previous;
		}
	});

	it("enforces a separate startup timeout", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-mcp-timeout-"));
		await mkdir(join(root, ".wuming"), { recursive: true });
		const script = join(root, "server.cjs");
		await writeFile(script, "setInterval(() => {}, 1000);", "utf8");
		await writeFile(
			join(root, ".wuming", "mcp.json"),
			JSON.stringify({ servers: [{ id: "slow", command: process.execPath, args: [script] }] }),
			"utf8"
		);
		const catalog = createCatalog({ requestTimeoutMs: 2_000, startupTimeoutMs: 50 });

		await expect(catalog.get("workspace-1", root, "slow")).rejects.toThrow("initialize timed out after 50ms");
	});

	it("rejects invalid server definitions instead of silently skipping them", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-mcp-invalid-"));
		await mkdir(join(root, ".wuming"), { recursive: true });
		await writeFile(
			join(root, ".wuming", "mcp.json"),
			JSON.stringify({
				servers: [
					{ id: "duplicate", command: "node" },
					{ id: "duplicate", command: "node" },
				],
			}),
			"utf8"
		);
		const catalog = createCatalog({});

		await expect(catalog.list("workspace-1", root)).rejects.toThrow("duplicate server id duplicate");
	});

	it("rejects a symbolic-link config file and config directory", async () => {
		const outside = await mkdtemp(join(tmpdir(), "wuming-mcp-outside-"));
		await writeFile(join(outside, "mcp.json"), JSON.stringify({ servers: [] }), "utf8");
		const fileRoot = await mkdtemp(join(tmpdir(), "wuming-mcp-link-file-"));
		await mkdir(join(fileRoot, ".wuming"));
		await symlink(join(outside, "mcp.json"), join(fileRoot, ".wuming", "mcp.json"), "file");
		const directoryRoot = await mkdtemp(join(tmpdir(), "wuming-mcp-link-dir-"));
		await symlink(outside, join(directoryRoot, ".wuming"), "junction");
		const catalog = createCatalog({});

		await expect(catalog.list("workspace-1", fileRoot)).rejects.toThrow("mcp.json cannot be a symbolic link");
		await expect(catalog.list("workspace-1", directoryRoot)).rejects.toThrow(".wuming cannot be a symbolic link");
	});
});

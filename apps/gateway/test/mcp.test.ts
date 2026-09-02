import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "@wuming/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FileMcpCatalog } from "../src/mcp.js";

const serverScript = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let listCalls = 0;
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
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
		session: { id: "session-1", workspaceId: "workspace-1", phase: "turn", createdAt: 1, updatedAt: 1 },
		revision: 1,
		model: { provider: "demo", id: "demo" },
		thinkingLevel: "medium",
		sandboxMode: "read_only",
		approvalPolicy: "on_risk",
		transcript: [],
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		pendingApprovals: [],
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
	};
}

async function fixtureWorkspace(): Promise<{ root: string; script: string }> {
	const root = await mkdtemp(join(tmpdir(), "wuming-mcp-"));
	await mkdir(join(root, ".wuming"), { recursive: true });
	const script = join(root, "server.cjs");
	await writeFile(script, serverScript, "utf8");
	await writeFile(join(root, ".wuming", "mcp.json"), JSON.stringify({ servers: [{ id: "fixture", name: "Fixture MCP", command: process.execPath, args: [script], readOnly: true }] }), "utf8");
	return { root, script };
}

afterEach(async () => {
	for (const catalog of catalogs.splice(0)) await catalog[Symbol.asyncDispose]();
});

describe("FileMcpCatalog", () => {
	it("lists untrusted workspace servers without starting their host process", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-mcp-untrusted-"));
		await mkdir(join(root, ".wuming"), { recursive: true });
		const marker = join(root, "started.txt");
		const script = join(root, "server.cjs");
		await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 1000);`, "utf8");
		await writeFile(join(root, ".wuming", "mcp.json"), JSON.stringify({ servers: [{ id: "untrusted", command: process.execPath, args: [script] }] }), "utf8");
		const catalog = createCatalog({ isTrusted: () => false });

		await expect(catalog.list("workspace-1", root)).resolves.toMatchObject([{ id: "untrusted", trusted: false, toolCount: 0 }]);
		await expect(catalog.get("workspace-1", root, "untrusted")).resolves.toMatchObject({ trusted: false, tools: [] });
		expect(await access(marker).then(() => true, () => false)).toBe(false);
	});

	it("discovers stdio servers, lists tools, and executes a tool", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ requestTimeoutMs: 2_000, resolveWorkspace: () => root });

		expect(await catalog.list("workspace-1", root)).toMatchObject([{ id: "fixture", name: "Fixture MCP", transport: "stdio", readOnly: true, trusted: true, toolCount: 1 }]);
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({ tools: [{ name: "echo", description: "Echo input #2" }] });
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({ tools: [{ name: "echo", description: "Echo input #3" }] });

		const tools = await catalog.createTools(snapshot(), { authorize: async () => undefined } as never);
		expect(tools).toHaveLength(1);
		const result = await tools[0]!.execute("call-1", { text: "hello" }, new AbortController().signal);
		expect(result).toMatchObject({ content: [{ text: "MCP says hello" }], details: { mcpServerId: "fixture", mcpToolName: "echo", durationMs: expect.any(Number), mcpStatus: "complete" } });
	});

	it("terminates an in-flight server on abort and reconnects on the next request", async () => {
		const { root } = await fixtureWorkspace();
		const catalog = createCatalog({ requestTimeoutMs: 5_000, resolveWorkspace: () => root });
		const tools = await catalog.createTools(snapshot(), { authorize: async () => undefined } as never);
		const controller = new AbortController();
		const startedAt = Date.now();
		setTimeout(() => controller.abort(new Error("cancelled by test")), 30);

		await expect(tools[0]!.execute("call-abort", { hang: true }, controller.signal)).rejects.toThrow("cancelled by test");
		expect(Date.now() - startedAt).toBeLessThan(1000);
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({ tools: [{ description: "Echo input #1" }] });
	});

	it("releases a persistent connection when its server is removed from config", async () => {
		const { root, script } = await fixtureWorkspace();
		const configPath = join(root, ".wuming", "mcp.json");
		const catalog = createCatalog({ requestTimeoutMs: 2_000 });
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({ tools: [{ description: "Echo input #1" }] });

		await writeFile(configPath, JSON.stringify({ servers: [] }), "utf8");
		await expect(catalog.list("workspace-1", root)).resolves.toEqual([]);
		await writeFile(configPath, JSON.stringify({ servers: [{ id: "fixture", command: process.execPath, args: [script], readOnly: true }] }), "utf8");
		await expect(catalog.get("workspace-1", root, "fixture")).resolves.toMatchObject({ tools: [{ description: "Echo input #1" }] });
	});

	it("does not inherit gateway credentials into MCP child processes", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-mcp-env-"));
		await mkdir(join(root, ".wuming"), { recursive: true });
		const script = join(root, "server.cjs");
		await writeFile(script, `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
  if (request.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "env", description: process.env.WUMING_MCP_TEST_SECRET ? "leaked" : "clean" }] } }) + "\\n");
});`, "utf8");
		await writeFile(join(root, ".wuming", "mcp.json"), JSON.stringify({ servers: [{ id: "env", command: process.execPath, args: [script] }] }), "utf8");
		const previous = process.env.WUMING_MCP_TEST_SECRET;
		process.env.WUMING_MCP_TEST_SECRET = "provider-secret";
		try {
			const catalog = createCatalog({});
			await expect(catalog.get("workspace-1", root, "env")).resolves.toMatchObject({ tools: [{ description: "clean" }] });
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
		await writeFile(join(root, ".wuming", "mcp.json"), JSON.stringify({ servers: [{ id: "slow", command: process.execPath, args: [script] }] }), "utf8");
		const catalog = createCatalog({ requestTimeoutMs: 2_000, startupTimeoutMs: 50 });

		await expect(catalog.get("workspace-1", root, "slow")).rejects.toThrow("initialize timed out after 50ms");
	});

	it("rejects invalid server definitions instead of silently skipping them", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-mcp-invalid-"));
		await mkdir(join(root, ".wuming"), { recursive: true });
		await writeFile(join(root, ".wuming", "mcp.json"), JSON.stringify({ servers: [
			{ id: "duplicate", command: "node" },
			{ id: "duplicate", command: "node" },
		] }), "utf8");
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

import type { AgentRuntime } from "@wuming/orchestrator";
import { ArtifactStore } from "@wuming/artifacts";
import { ContextEngine } from "@wuming/context-engine";
import { AttestationSigner, EvaluationStore, verifyEvaluationAttestation } from "@wuming/evaluation";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { ClientMessage, Command, ServerMessage, WorkspaceSummary } from "@wuming/protocol";
import { ApprovalBroker, WorkspaceInspector, WorkspaceGit } from "@wuming/sandbox";
import { TerminalManager } from "../src/terminal.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { generateKeyPairSync } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearerProtocol, GatewayServer, StaticTokenAuth } from "../src/index.js";
import { GatewayEvaluationManager } from "../src/evaluation.js";
import { ManagedSkillCatalog } from "../src/managed-skill-catalog.js";
import { StaticTokenMapAuth } from "../src/auth.js";
import { FileMcpCatalog } from "../src/mcp.js";
import { MediaModelRegistry } from "../src/media-models.js";

class GatewayRuntime implements AgentRuntime {
	calls = 0;
	readonly contextEngine = new ContextEngine();

	async resolveContext(input: Parameters<NonNullable<AgentRuntime["resolveContext"]>>[0]) {
		return this.contextEngine.assemble({
			workspaceId: input.snapshot.session.workspaceId,
			sessionId: input.snapshot.session.id,
			operationId: input.operation.id,
			model: input.snapshot.model,
			query: input.operation.payload.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
			baseSystemPrompt: "Gateway test system prompt",
			fragments: [],
			budget: {
				contextWindowTokens: 1000,
				userInputTokens: 10,
				reservedOutputTokens: 100,
				maxSystemTokens: 250,
			},
		}).plan;
	}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]) {
		this.calls += 1;
		input.onProgress({
			type: "assistant.delta",
			sessionId: input.operation.sessionId,
			itemId: `assistant-${this.calls}`,
			streamSeq: 0,
			contentIndex: 0,
			kind: "text",
			delta: "hello",
		});
		return {
			items: [
				{
					id: `assistant-${this.calls}`,
					type: "assistant" as const,
					createdAt: 101,
					status: "complete" as const,
					content: [{ type: "text" as const, text: "hello" }],
					model: input.snapshot.model,
				},
			],
			compactions: [
				{
					reason: "threshold" as const,
					summary: "Gateway runtime compacted memory.",
					tokensBefore: 900,
					estimatedTokensAfter: 200,
				},
			],
		};
	}
}

class BlockingGatewayRuntime implements AgentRuntime {
	readonly started: Promise<void>;
	#markStarted!: () => void;

	constructor() {
		this.started = new Promise((resolve) => {
			this.#markStarted = resolve;
		});
	}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]) {
		this.#markStarted();
		return new Promise<never>((_, reject) => {
			const abort = () => reject(input.signal.reason ?? new Error("aborted"));
			if (input.signal.aborted) abort();
			else input.signal.addEventListener("abort", abort, { once: true });
		});
	}
}

class MessageCollector {
	readonly messages: ServerMessage[] = [];
	readonly #waiters = new Set<() => void>();

	constructor(readonly ws: WebSocket) {
		ws.on("message", (data) => {
			this.messages.push(JSON.parse(data.toString()) as ServerMessage);
			for (const wake of this.#waiters) wake();
		});
	}

	async waitFor<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T): Promise<T>;
	async waitFor(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage>;
	async waitFor(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		const existing = this.messages.find(predicate);
		if (existing) return existing;
		return new Promise<ServerMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#waiters.delete(check);
				reject(new Error(`Timed out waiting for message; received ${JSON.stringify(this.messages)}`));
			}, 3000);
			const check = () => {
				const match = this.messages.find(predicate);
				if (!match) return;
				clearTimeout(timeout);
				this.#waiters.delete(check);
				resolve(match);
			};
			this.#waiters.add(check);
		});
	}
}

const workspace: WorkspaceSummary = {
	id: "workspace-1",
	name: "Workspace",
	status: "ready",
	createdAt: 1,
	updatedAt: 1,
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function openClient(url: string, token = "secret", origin?: string) {
	const ws = new WebSocket(url, ["wuming.v1", bearerProtocol(token)], origin ? { origin } : undefined);
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) return resolve();
				ws.once("close", () => resolve());
				ws.close();
			})
	);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return { ws, collector: new MessageCollector(ws) };
}

function send(ws: WebSocket, message: ClientMessage): void {
	ws.send(JSON.stringify(message));
}

describe("GatewayServer", () => {
	it("protects media defaults with owner permissions and keeps API keys out of RPC responses", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-media-rpc-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const mediaModels = new MediaModelRegistry({ filePath: join(root, "models.enc"), encryptionKey: "rpc-test-key" });
		const server = new GatewayServer({
			auth: new StaticTokenMapAuth([
				{ token: "owner", principal: { id: "owner", role: "owner", workspaces: [workspace] } },
				{ token: "viewer", principal: { id: "viewer", role: "viewer", workspaces: [workspace] } },
			]),
			store,
			orchestrator: new SessionOrchestrator(store, new GatewayRuntime()),
			mediaModels,
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const owner = await openClient(`ws://127.0.0.1:${address.port}/api/ws`, "owner");
		const viewer = await openClient(`ws://127.0.0.1:${address.port}/api/ws`, "viewer");
		for (const [index, client] of [owner, viewer].entries()) {
			send(client.ws, { type: "hello", protocolVersion: 1, clientId: `media-${index}`, capabilities: [] });
			await client.collector.waitFor((message) => message.type === "hello");
		}
		let sequence = 0;
		const call = async (client: typeof owner, command: Command) => {
			const requestId = `media-${++sequence}`;
			send(client.ws, { type: "request", requestId, idempotencyKey: requestId, command });
			return client.collector.waitFor((message) => message.type === "response" && message.requestId === requestId);
		};
		const config = {
			kind: "image" as const,
			baseUrl: "https://relay.example/v1",
			model: "image-id",
			apiKey: "never-return-this-key",
		};
		for (const command of [
			{ type: "model.media.list" },
			{ type: "model.media.set", config },
			{
				type: "model.media.discover",
				connection: { kind: "image", baseUrl: "https://relay.example/v1", apiKey: "test-key" },
			},
			{ type: "model.media.remove", kind: "image" },
		] as const)
			expect(await call(viewer, command)).toMatchObject({ ok: false, error: { code: "forbidden" } });
		const result = await call(owner, { type: "model.media.set", config });
		expect(result).toMatchObject({
			ok: true,
			result: { type: "model.media.settings", settings: [{ kind: "image", model: "image-id", authenticated: true }] },
		});
		expect(JSON.stringify(result)).not.toContain("never-return-this-key");
		expect(await call(owner, { type: "model.media.remove", kind: "image" })).toMatchObject({
			ok: true,
			result: { settings: [] },
		});
	});

	it("validates Git actions and enforces authentication, workspace and write permissions", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-gateway-git-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		const inspector = await WorkspaceInspector.create(root);
		const git = new WorkspaceGit(root);
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const server = new GatewayServer({
			auth: new StaticTokenMapAuth([
				{ token: "writer", principal: { id: "writer", role: "member", workspaces: [workspace] } },
				{ token: "reader", principal: { id: "reader", role: "viewer", workspaces: [workspace] } },
			]),
			orchestrator: new SessionOrchestrator(store, new GatewayRuntime()),
			store,
			workspace: {
				listDirectory: (_id, path) => inspector.listDirectory(path),
				searchFiles: (_id, query, limit) => inspector.searchFiles(query, limit),
				readFile: (_id, path) => inspector.readFile(path),
				gitStatus: () => inspector.gitStatus(),
				gitDiff: (_id, path, staged) => inspector.gitDiff(path, staged),
				gitDetails: () => git.details(),
				gitAction: (_id, action) => git.action(action),
			},
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const base = "http://127.0.0.1:" + address.port;
		const sendAction = (token: string, body: string, id = workspace.id, origin?: string) =>
			fetch(base + "/api/workspaces/" + id + "/git/action", {
				method: "POST",
				headers: {
					Authorization: "Bearer " + token,
					"Content-Type": "application/json",
					...(origin ? { Origin: origin } : {}),
				},
				body,
			});
		expect((await sendAction("bad", '{"type":"init"}')).status).toBe(401);
		expect((await sendAction("reader", '{"type":"init"}')).status).toBe(403);
		expect((await sendAction("writer", '{"type":"init"}', "other")).status).toBe(403);
		expect((await sendAction("writer", '{"type":"init"}', workspace.id, "https://evil.invalid")).status).toBe(403);
		for (const body of [
			"bad-json",
			'{"type":"push","remote":"origin","branch":"main","force":true}',
			'{"type":"stage","paths":[]}',
			'{"type":"shell","command":"whoami"}',
		])
			expect((await sendAction("writer", body)).status).toBe(400);
		expect((await sendAction("writer", '{"type":"init"}')).status).toBe(200);
		await writeFile(join(root, "note.txt"), "test");
		expect((await sendAction("writer", '{"type":"stage","paths":["note.txt"]}')).status).toBe(200);
		expect((await inspector.gitStatus()).entries[0]?.indexStatus).toBe("A");
		const reader = await fetch(base + "/api/workspaces/" + workspace.id + "/git/details", {
			headers: { Authorization: "Bearer reader" },
		});
		expect(await reader.json()).toMatchObject({ writable: false, isRepository: true });
		const wrongMethod = await fetch(base + "/api/workspaces/" + workspace.id + "/git/action", {
			headers: { Authorization: "Bearer writer" },
		});
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get("allow")).toBe("POST");
	}, 30000);
	it("enforces workspace and role boundaries for skill management and disabled loads", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-skill-rpc-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		await mkdir(join(root, "package"));
		await writeFile(
			join(root, "package", "SKILL.md"),
			"---\nname: RPC Skill\ndescription: Check RPC wiring\n---\nInspect actual output."
		);
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const catalog = new ManagedSkillCatalog();
		const server = new GatewayServer({
			auth: new StaticTokenMapAuth([
				{ token: "owner", principal: { id: "owner", role: "owner", workspaces: [workspace] } },
				{ token: "viewer", principal: { id: "viewer", role: "viewer", workspaces: [workspace] } },
			]),
			store,
			orchestrator: new SessionOrchestrator(store, new GatewayRuntime()),
			skills: catalog,
			skillManagement: () => catalog.manager(root),
			workspacePath: () => root,
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const owner = await openClient(`ws://127.0.0.1:${address.port}/api/ws`, "owner");
		const viewer = await openClient(`ws://127.0.0.1:${address.port}/api/ws`, "viewer");
		for (const [index, client] of [owner, viewer].entries()) {
			send(client.ws, {
				type: "hello",
				protocolVersion: 1,
				clientId: `skills-${index}`,
				capabilities: [],
			});
			await client.collector.waitFor((message) => message.type === "hello");
		}
		let seq = 0;
		const call = async (client: typeof owner, command: Command) => {
			const requestId = `skills-${++seq}`;
			send(client.ws, { type: "request", requestId, idempotencyKey: requestId, command });
			return client.collector.waitFor(
				(message): message is Extract<ServerMessage, { type: "response" }> =>
					message.type === "response" && message.requestId === requestId
			);
		};
		expect(await call(viewer, { type: "skill.installed.list", workspaceId: workspace.id })).toMatchObject({ ok: true });
		for (const command of [
			{
				type: "skill.install",
				workspaceId: workspace.id,
				sourcePath: "package",
				skillId: "rpc-skill",
			},
			{ type: "skill.set_enabled", workspaceId: workspace.id, skillId: "debug", enabled: false },
			{ type: "skill.uninstall", workspaceId: workspace.id, skillId: "debug" },
		] as const)
			expect(await call(viewer, command)).toMatchObject({
				ok: false,
				error: { code: "forbidden" },
			});
		expect(await call(owner, { type: "skill.installed.list", workspaceId: "other" })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(
			await call(owner, {
				type: "skill.install",
				workspaceId: workspace.id,
				sourcePath: "../outside",
				skillId: "outside",
			})
		).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(
			await call(owner, {
				type: "skill.install",
				workspaceId: workspace.id,
				sourcePath: "package",
				skillId: "rpc-skill",
			})
		).toMatchObject({
			ok: true,
			result: { type: "skill.updated", skill: { id: "rpc-skill", enabled: true } },
		});
		expect(
			await call(owner, {
				type: "skill.set_enabled",
				workspaceId: workspace.id,
				skillId: "rpc-skill",
				enabled: false,
			})
		).toMatchObject({ ok: true });
		expect(await call(owner, { type: "skill.get", workspaceId: workspace.id, skillId: "rpc-skill" })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(
			await call(viewer, { type: "skill.preview", workspaceId: workspace.id, skillId: "rpc-skill" })
		).toMatchObject({ ok: true, result: { type: "skill.preview", skill: { id: "rpc-skill" } } });
		expect(await call(owner, { type: "skill.uninstall", workspaceId: workspace.id, skillId: "debug" })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(
			await call(owner, {
				type: "skill.uninstall",
				workspaceId: workspace.id,
				skillId: "rpc-skill",
			})
		).toMatchObject({ ok: true, result: { type: "skill.uninstalled" } });
		expect(await call(owner, { type: "skill.get", workspaceId: workspace.id, skillId: "rpc-skill" })).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});

	it("manages local MCP configuration and trust through WebSocket RPC", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-mcp-rpc-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		const marker = join(root, "started.txt");
		const script = join(root, "server.cjs");
		await writeFile(
			script,
			`
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(marker)}, "started");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "rpc", version: "1" } } }) + "\\n");
  else if (request.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "echo", description: "Echo" }] } }) + "\\n");
});
`,
			"utf8"
		);
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const mcp = new FileMcpCatalog({ resolveWorkspace: () => root, requestTimeoutMs: 2_000 });
		cleanup.push(() => mcp[Symbol.asyncDispose]());
		const server = new GatewayServer({
			auth: new StaticTokenMapAuth([
				{ token: "owner", principal: { id: "owner", role: "owner", workspaces: [workspace] } },
				{ token: "viewer", principal: { id: "viewer", role: "viewer", workspaces: [workspace] } },
			]),
			store,
			orchestrator: new SessionOrchestrator(store, new GatewayRuntime()),
			mcp,
			workspacePath: () => root,
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const owner = await openClient(`ws://127.0.0.1:${address.port}/api/ws`, "owner");
		const viewer = await openClient(`ws://127.0.0.1:${address.port}/api/ws`, "viewer");
		for (const [index, client] of [owner, viewer].entries()) {
			send(client.ws, {
				type: "hello",
				protocolVersion: 1,
				clientId: `mcp-${index}`,
				capabilities: [],
			});
			await client.collector.waitFor((message) => message.type === "hello");
		}
		let seq = 0;
		const call = async (client: typeof owner, command: import("@wuming/protocol").Command) => {
			const requestId = `mcp-${++seq}`;
			send(client.ws, { type: "request", requestId, idempotencyKey: requestId, command });
			return client.collector.waitFor(
				(message): message is Extract<ServerMessage, { type: "response" }> =>
					message.type === "response" && message.requestId === requestId
			);
		};
		const configureCommand: Command = {
			type: "mcp.configure",
			workspaceId: workspace.id,
			config: {
				id: "docs",
				transport: "stdio",
				command: process.execPath,
				args: [script],
				readOnly: true,
				env: { RPC_TEST_KEY: "rpc-private-canary" },
			},
		};

		expect(await call(viewer, { type: "mcp.list", workspaceId: workspace.id })).toMatchObject({ ok: true });
		expect(await call(viewer, configureCommand)).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(
			await call(viewer, { type: "mcp.configuration.get", workspaceId: workspace.id, serverId: "docs" })
		).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await call(viewer, { type: "mcp.remove", workspaceId: workspace.id, serverId: "docs" })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(await call(owner, configureCommand)).toMatchObject({
			ok: true,
			result: { type: "mcp.updated", server: { id: "docs", trusted: false, discoveryStatus: "untrusted" } },
		});
		expect(await readFile(join(root, ".wuming", "mcp.json"), "utf8")).toContain('"id": "docs"');
		const settings = await call(owner, { type: "mcp.configuration.get", workspaceId: workspace.id, serverId: "docs" });
		expect(settings).toMatchObject({
			ok: true,
			result: { type: "mcp.configuration", config: { env: { RPC_TEST_KEY: null } } },
		});
		expect(JSON.stringify(settings)).not.toContain("rpc-private-canary");
		expect(
			await access(marker).then(
				() => true,
				() => false
			)
		).toBe(false);
		expect(await call(owner, { type: "mcp.trust", workspaceId: workspace.id, serverId: "docs" })).toMatchObject({
			ok: true,
			result: { type: "mcp.updated", server: { id: "docs", trusted: true, toolCount: 1 } },
		});
		expect(
			await access(marker).then(
				() => true,
				() => false
			)
		).toBe(true);
		expect(await call(owner, { type: "mcp.untrust", workspaceId: workspace.id, serverId: "docs" })).toMatchObject({
			ok: true,
			result: { type: "mcp.updated", server: { id: "docs", trusted: false, discoveryStatus: "untrusted" } },
		});
		expect(await call(owner, { type: "mcp.remove", workspaceId: workspace.id, serverId: "docs" })).toMatchObject({
			ok: true,
			result: { type: "mcp.removed", serverId: "docs" },
		});
		expect(await call(owner, { type: "mcp.list", workspaceId: workspace.id })).toMatchObject({
			ok: true,
			result: { servers: [] },
		});
	});

	it("allows viewer reads but rejects WebSocket writes", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const orchestrator = new SessionOrchestrator(store, new GatewayRuntime(), { clock: () => 100 });
		const server = new GatewayServer({
			auth: new StaticTokenAuth("viewer-secret", {
				id: "viewer",
				role: "viewer",
				workspaces: [workspace],
			}),
			orchestrator,
			store,
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const { ws, collector } = await openClient("ws://127.0.0.1:" + address.port + "/api/ws", "viewer-secret");
		send(ws, { type: "hello", protocolVersion: 1, clientId: "viewer-client", capabilities: [] });
		await collector.waitFor((message) => message.type === "hello");
		send(ws, {
			type: "request",
			requestId: "viewer-list",
			idempotencyKey: "viewer-list",
			command: { type: "workspace.list" },
		});
		await expect(
			collector.waitFor((message) => message.type === "response" && message.requestId === "viewer-list" && message.ok)
		).resolves.toBeDefined();
		send(ws, {
			type: "request",
			requestId: "viewer-create",
			idempotencyKey: "viewer-create",
			command: {
				type: "session.create",
				workspaceId: workspace.id,
				model: { provider: "openai", id: "gpt-test" },
				thinkingLevel: "off",
				sandboxMode: "read_only",
				approvalPolicy: "never",
			},
		});
		const denied = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: false }> =>
				message.type === "response" && message.requestId === "viewer-create" && !message.ok
		);
		expect(denied.error.code).toBe("forbidden");
	});

	it("routes session fork and idle configuration commands", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const orchestrator = new SessionOrchestrator(store, new GatewayRuntime(), { clock: () => 100 });
		const created = await orchestrator.createSession({
			principalId: "user-1",
			idempotencyKey: "gateway-config-create",
			workspaceId: workspace.id,
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "medium",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		});
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces: [workspace] }),
			orchestrator,
			store,
			models: [
				{
					model: { provider: "openai", id: "gpt-test" },
					name: "GPT Test",
					reasoning: true,
					input: ["text"],
					contextWindow: 1000,
					maxOutputTokens: 100,
					authenticated: true,
				},
			],
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const { ws, collector } = await openClient(`ws://127.0.0.1:${address.port}/api/ws`);
		send(ws, { type: "hello", protocolVersion: 1, clientId: "config-client", capabilities: [] });
		const hello = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "hello" }> => message.type === "hello"
		);
		expect(hello.capabilities).toContain("session.fork");
		expect(hello.capabilities).toContain("subagents");
		expect(hello.capabilities).toContain("goals");
		expect(hello.capabilities).toContain("automations");
		expect(hello.executionEnvironment).toMatchObject({
			placement: "server",
			processMode: "disabled",
		});
		send(ws, {
			type: "request",
			requestId: "attach-config",
			idempotencyKey: "attach-config",
			command: { type: "session.attach", sessionId: created.snapshot.session.id },
		});
		await collector.waitFor(
			(message) => message.type === "response" && message.requestId === "attach-config" && message.ok
		);
		send(ws, {
			type: "request",
			requestId: "set-model",
			idempotencyKey: "set-model",
			command: {
				type: "session.model.set",
				sessionId: created.snapshot.session.id,
				model: { provider: "openai", id: "gpt-test" },
			},
		});
		const modelResult = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "set-model" && message.ok
		);
		expect(modelResult.result.type).toBe("session.configured");
		send(ws, {
			type: "request",
			requestId: "set-thinking",
			idempotencyKey: "set-thinking",
			command: {
				type: "session.thinking.set",
				sessionId: created.snapshot.session.id,
				thinkingLevel: "high",
			},
		});
		const thinkingResult = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "set-thinking" && message.ok
		);
		expect(thinkingResult.result.type).toBe("session.configured");
		send(ws, {
			type: "request",
			requestId: "set-policy",
			idempotencyKey: "set-policy",
			command: {
				type: "session.policy.set",
				sessionId: created.snapshot.session.id,
				sandboxMode: "unrestricted",
				approvalPolicy: "never",
			},
		});
		const policyResult = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "set-policy" && message.ok
		);
		expect(policyResult.result).toMatchObject({
			type: "session.configured",
			snapshot: { sandboxMode: "unrestricted", approvalPolicy: "never" },
		});
		send(ws, {
			type: "request",
			requestId: "set-budget",
			idempotencyKey: "set-budget",
			command: {
				type: "session.budget.set",
				sessionId: created.snapshot.session.id,
				costBudgetUsd: 1.5,
				tokenBudget: 20_000,
				budgetWarningThreshold: 0.75,
			},
		});
		const budgetResult = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "set-budget" && message.ok
		);
		expect(budgetResult.result).toMatchObject({
			type: "session.configured",
			snapshot: { costBudgetUsd: 1.5, tokenBudget: 20_000, budgetWarningThreshold: 0.75 },
		});
		send(ws, {
			type: "request",
			requestId: "fork",
			idempotencyKey: "fork",
			command: { type: "session.fork", sessionId: created.snapshot.session.id },
		});
		const forkResult = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "fork" && message.ok
		);
		expect(forkResult.result.type).toBe("session.forked");
		if (forkResult.result.type !== "session.forked") throw new Error("Expected forked session");
		// A fork attaches the connection that asked for it, the way a creation does.
		// Without that the caller holds the forked snapshot but never receives its
		// events, so the first turn it starts there renders nothing.
		const forkedSessionId = forkResult.result.snapshot.session.id;
		send(ws, {
			type: "request",
			requestId: "fork-prompt",
			idempotencyKey: "fork-prompt",
			command: {
				type: "turn.prompt",
				sessionId: forkedSessionId,
				content: [{ type: "text", text: "continue in the fork" }],
			},
		});
		await collector.waitFor(
			(message) =>
				message.type === "event" &&
				message.event.type === "session.item.upserted" &&
				message.event.sessionId === forkedSessionId &&
				message.event.item.type === "assistant"
		);
		send(ws, {
			type: "request",
			requestId: "subagent-create",
			idempotencyKey: "subagent-create",
			command: {
				type: "subagent.create",
				sessionId: created.snapshot.session.id,
				task: "Inspect the configured session",
				wait: true,
			},
		});
		const subagentCreated = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "subagent-create" && message.ok
		);
		expect(subagentCreated.result).toMatchObject({
			type: "subagent.created",
			subagent: {
				parentSessionId: created.snapshot.session.id,
				status: "completed",
				result: "hello",
			},
		});
		send(ws, {
			type: "request",
			requestId: "subagent-list",
			idempotencyKey: "subagent-list",
			command: { type: "subagent.list", sessionId: created.snapshot.session.id },
		});
		const subagentList = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "subagent-list" && message.ok
		);
		expect(subagentList.result).toMatchObject({
			type: "subagent.list",
			subagents: [{ status: "completed" }],
		});
		expect(store.loadSnapshot(created.snapshot.session.id)?.transcript.at(-1)).toMatchObject({
			type: "tool",
			toolName: "subagent",
			status: "complete",
		});
		send(ws, {
			type: "request",
			requestId: "goal-create",
			idempotencyKey: "goal-create",
			command: {
				type: "goal.create",
				sessionId: created.snapshot.session.id,
				title: "Gateway goal",
				objective: "Complete in the background",
			},
		});
		const goalCreated = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "goal-create" && message.ok
		);
		expect(goalCreated.result).toMatchObject({
			type: "goal.created",
			goal: { status: "pending", title: "Gateway goal" },
		});
		if (goalCreated.result.type !== "goal.created") throw new Error("Expected created goal");
		send(ws, {
			type: "request",
			requestId: "goal-start",
			idempotencyKey: "goal-start",
			command: {
				type: "goal.start",
				sessionId: created.snapshot.session.id,
				goalId: goalCreated.result.goal.id,
			},
		});
		const goalStarted = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "goal-start" && message.ok
		);
		expect(goalStarted.result).toMatchObject({
			type: "goal.started",
			goal: { status: "queued", runSessionId: expect.any(String) },
		});
		if (goalStarted.result.type !== "goal.started" || !goalStarted.result.goal.runSessionId)
			throw new Error("Expected started goal");
		// Narrowing a property path does not survive into a callback, so the id the
		// predicate compares against is read out here rather than inside it.
		const runSessionId = goalStarted.result.goal.runSessionId;
		await collector.waitFor(
			(message) =>
				message.type === "event" &&
				message.event.type === "session.item.upserted" &&
				message.event.item.type === "tool" &&
				message.event.item.toolCallId === runSessionId
		);
		send(ws, {
			type: "request",
			requestId: "goal-list",
			idempotencyKey: "goal-list",
			command: { type: "goal.list", sessionId: created.snapshot.session.id },
		});
		const goalList = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "goal-list" && message.ok
		);
		expect(goalList.result).toMatchObject({
			type: "goal.list",
			goals: [{ status: "completed", result: "hello" }],
		});

		send(ws, {
			type: "request",
			requestId: "automation-create",
			idempotencyKey: "automation-create",
			command: {
				type: "automation.create",
				sessionId: created.snapshot.session.id,
				title: "Gateway automation",
				objective: "Run the durable gateway check",
				schedule: { kind: "interval", startsAt: 10_000, everyMinutes: 60 },
			},
		});
		const automationCreated = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "automation-create" && message.ok
		);
		expect(automationCreated.result).toMatchObject({
			type: "automation.created",
			automation: { status: "active", title: "Gateway automation", nextRunAt: 10_000 },
		});
		if (automationCreated.result.type !== "automation.created") throw new Error("Expected created automation");
		const automationId = automationCreated.result.automation.id;
		send(ws, {
			type: "request",
			requestId: "automation-pause",
			idempotencyKey: "automation-pause",
			command: {
				type: "automation.set_enabled",
				sessionId: created.snapshot.session.id,
				automationId,
				enabled: false,
			},
		});
		const automationPaused = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "automation-pause" && message.ok
		);
		expect(automationPaused.result).toMatchObject({
			type: "automation.configured",
			automation: { status: "paused" },
		});
		send(ws, {
			type: "request",
			requestId: "automation-trigger",
			idempotencyKey: "automation-trigger",
			command: { type: "automation.trigger", sessionId: created.snapshot.session.id, automationId },
		});
		const automationTriggered = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "automation-trigger" && message.ok
		);
		expect(automationTriggered.result).toMatchObject({
			type: "automation.triggered",
			run: { status: "dispatching", trigger: "manual" },
		});
		if (automationTriggered.result.type !== "automation.triggered") throw new Error("Expected triggered automation");
		await orchestrator.dispatchAutomationRun(automationTriggered.result.run.id);
		send(ws, {
			type: "request",
			requestId: "automation-list",
			idempotencyKey: "automation-list",
			command: { type: "automation.list", sessionId: created.snapshot.session.id },
		});
		const automationList = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "automation-list" && message.ok
		);
		expect(automationList.result).toMatchObject({
			type: "automation.list",
			automations: [{ id: automationId, status: "paused", lastRunAt: 100 }],
		});
		send(ws, {
			type: "request",
			requestId: "automation-runs",
			idempotencyKey: "automation-runs",
			command: {
				type: "automation.run.list",
				sessionId: created.snapshot.session.id,
				automationId,
			},
		});
		const automationRuns = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "automation-runs" && message.ok
		);
		expect(automationRuns.result).toMatchObject({
			type: "automation.run.list",
			runs: [{ trigger: "manual", status: "completed", result: "hello" }],
		});
	});

	it("returns the authenticated workspace tool catalog", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const orchestrator = new SessionOrchestrator(store, new GatewayRuntime(), { clock: () => 100 });
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces: [workspace] }),
			orchestrator,
			store,
			tools: {
				runtime: "pi",
				list: () => [
					{
						name: "web_search",
						label: "网络搜索",
						description: "搜索公开网页",
						category: "network",
						status: "ready",
						backend: "Bing",
						risk: "low",
						sandboxModes: ["read_only", "workspace_write", "unrestricted"],
					},
				],
			},
			capabilities: ["tools"],
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const { ws, collector } = await openClient(`ws://127.0.0.1:${address.port}/api/ws`);
		send(ws, { type: "hello", protocolVersion: 1, clientId: "tools-client", capabilities: [] });
		const hello = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "hello" }> => message.type === "hello"
		);
		expect(hello.capabilities).toContain("tools");
		send(ws, {
			type: "request",
			requestId: "tools",
			idempotencyKey: "tools",
			command: { type: "tool.list", workspaceId: workspace.id },
		});
		const response = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.requestId === "tools" && message.ok
		);
		expect(response.result).toMatchObject({
			type: "tool.list",
			runtime: "pi",
			tools: [{ name: "web_search", status: "ready" }],
		});
	});

	it("runs the authenticated create, prompt, progress, durable event, and replay flow", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const runtime = new GatewayRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => 100 });
		const evaluationStore = new EvaluationStore(":memory:");
		cleanup.push(() => evaluationStore.close());
		const evaluation = new GatewayEvaluationManager({
			store: evaluationStore,
			signer: new AttestationSigner(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })),
			artifacts: {
				read: async () => {
					throw new Error("No artifact is configured for this test");
				},
				resolve: async () => {
					throw new Error("No artifact is configured for this test");
				},
			},
			resolveProcess: () => undefined,
		});
		const errors: unknown[] = [];
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces: [workspace] }),
			orchestrator,
			store,
			models: [
				{
					model: { provider: "anthropic", id: "claude" },
					name: "Claude",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 200000,
					maxOutputTokens: 32000,
					authenticated: true,
				},
			],
			evaluation,
			onError: (error) => errors.push(error),
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const url = `ws://127.0.0.1:${address.port}/api/ws`;
		const { ws, collector } = await openClient(url, "secret", `http://127.0.0.1:${address.port}`);
		send(ws, { type: "hello", protocolVersion: 1, clientId: "client-1", capabilities: [] });
		const hello = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "hello" }> => message.type === "hello"
		);
		expect(hello.capabilities).toContain("evaluation");

		send(ws, {
			type: "request",
			requestId: "create-request",
			idempotencyKey: "create-key",
			command: {
				type: "session.create",
				workspaceId: workspace.id,
				model: { provider: "anthropic", id: "claude" },
				thinkingLevel: "medium",
				sandboxMode: "workspace_write",
				approvalPolicy: "on_risk",
			},
		});
		const created = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "create-request"
		);
		expect(created.result.type).toBe("session.created");
		if (created.result.type !== "session.created") throw new Error("Unexpected result");
		const sessionId = created.result.snapshot.session.id;

		send(ws, {
			type: "request",
			requestId: "turn-request",
			idempotencyKey: "turn-key",
			command: { type: "turn.prompt", sessionId, content: [{ type: "text", text: "hello" }] },
		});
		await collector.waitFor(
			(message) => message.type === "response" && message.requestId === "turn-request" && message.ok
		);
		await collector.waitFor((message) => message.type === "progress" && message.event.type === "assistant.delta");
		const completedEvent = await collector.waitFor(
			(message) =>
				message.type === "event" &&
				message.event.type === "session.item.upserted" &&
				message.event.item.type === "assistant"
		);
		expect(runtime.calls).toBe(1);
		expect(errors).toEqual([]);
		if (completedEvent.type !== "event") throw new Error("Expected event");
		const completedOperation = store.listOperations(sessionId, 1)[0];
		if (!completedOperation) throw new Error("Expected completed operation");
		store.appendHookAuditRecords(completedOperation.id, [
			{
				hookId: "hook:gateway-audit",
				hookVersion: "1",
				point: "operation.after_execute",
				mode: "observe",
				outcome: "completed",
				startedAt: 100,
				finishedAt: 101,
				durationMs: 1,
				reason: "internal detail",
				annotations: { private: true },
			},
		]);

		send(ws, {
			type: "request",
			requestId: "runs-request",
			idempotencyKey: "runs-key",
			command: { type: "session.run.list", sessionId, limit: 10 },
		});
		const runs = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "runs-request"
		);
		expect(runs.result).toMatchObject({
			type: "session.run.list",
			sessionId,
			runs: [
				{
					mode: "prompt",
					status: "completed",
					attempt: 1,
					contextPlan: {
						estimatedSystemTokens: expect.any(Number),
						availableSystemTokens: 250,
						fragmentCount: 1,
						omittedCount: 0,
						fragments: [
							{
								id: "system:base",
								kind: "system",
								source: "pi:system-prompt",
								cacheScope: "stable",
								truncated: false,
							},
						],
					},
					hookEvents: [
						{
							hookId: "hook:gateway-audit",
							hookVersion: "1",
							point: "operation.after_execute",
							mode: "observe",
							outcome: "completed",
							durationMs: 1,
						},
					],
				},
			],
		});
		if (runs.result.type !== "session.run.list") throw new Error("Expected run list");
		expect(runs.result.runs[0]?.hookEvents?.[0]).not.toHaveProperty("reason");
		expect(runs.result.runs[0]?.hookEvents?.[0]).not.toHaveProperty("annotations");
		expect(runs.result.runs[0]?.trajectory).toMatchObject({
			integrity: true,
			eventCount: expect.any(Number),
			evaluation: {
				algorithm: "structural-v1",
				verdict: "pass",
				semanticCorrectness: "not_evaluated",
			},
		});
		expect(runs.result.runs[0]?.memoryCount).toBe(1);

		send(ws, {
			type: "request",
			requestId: "trajectory-request",
			idempotencyKey: "trajectory-key",
			command: { type: "session.run.trajectory.get", sessionId, runId: completedOperation.id },
		});
		const trajectory = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "trajectory-request"
		);
		expect(trajectory.result).toMatchObject({
			type: "session.run.trajectory",
			sessionId,
			runId: completedOperation.id,
			report: {
				replay: { integrity: true },
				evaluation: { algorithm: "structural-v1", semanticCorrectness: "not_evaluated" },
			},
		});
		if (trajectory.result.type !== "session.run.trajectory") throw new Error("Expected trajectory report");
		expect(trajectory.result.report.replay.events.map((event) => event.data.type)).toEqual([
			"operation.accepted",
			"operation.started",
			"context.resolved",
			"compaction.completed",
			"operation.finished",
			"hook.executed",
		]);

		send(ws, {
			type: "request",
			requestId: "evaluation-dataset-create",
			idempotencyKey: "evaluation-dataset-create-key",
			command: {
				type: "evaluation.dataset.create",
				workspaceId: workspace.id,
				name: "Structural regression",
				graders: [
					{
						id: "trajectory-integrity",
						label: "Trajectory integrity",
						type: "trajectory",
						requireIntegrity: true,
						minStructuralScore: 50,
					},
				],
			},
		});
		const datasetCreated = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "evaluation-dataset-create"
		);
		expect(datasetCreated.result).toMatchObject({
			type: "evaluation.dataset.created",
			dataset: { workspaceId: workspace.id, name: "Structural regression" },
		});
		if (datasetCreated.result.type !== "evaluation.dataset.created") throw new Error("Expected evaluation dataset");

		send(ws, {
			type: "request",
			requestId: "run-evaluate",
			idempotencyKey: "run-evaluate-key",
			command: {
				type: "session.run.evaluate",
				sessionId,
				runId: completedOperation.id,
				datasetId: datasetCreated.result.dataset.id,
			},
		});
		const evaluated = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "run-evaluate"
		);
		expect(evaluated.result).toMatchObject({
			type: "session.run.evaluated",
			evaluation: {
				sessionId,
				runId: completedOperation.id,
				status: "pass",
				checks: [{ status: "pass", type: "trajectory" }],
			},
		});
		if (evaluated.result.type !== "session.run.evaluated") throw new Error("Expected run evaluation");

		send(ws, {
			type: "request",
			requestId: "run-evaluations",
			idempotencyKey: "run-evaluations-key",
			command: { type: "session.run.evaluation.list", sessionId, runId: completedOperation.id },
		});
		const evaluations = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "run-evaluations"
		);
		expect(evaluations.result).toMatchObject({
			type: "session.run.evaluation.list",
			evaluations: [{ id: evaluated.result.evaluation.id, status: "pass" }],
		});

		send(ws, {
			type: "request",
			requestId: "run-attest",
			idempotencyKey: "run-attest-key",
			command: {
				type: "session.run.attestation.create",
				sessionId,
				runId: completedOperation.id,
				evaluationId: evaluated.result.evaluation.id,
			},
		});
		const attested = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "run-attest"
		);
		expect(attested.result).toMatchObject({
			type: "session.run.attested",
			attestation: { evaluationId: evaluated.result.evaluation.id, algorithm: "ed25519" },
		});
		if (attested.result.type !== "session.run.attested") throw new Error("Expected evaluation attestation");
		expect(verifyEvaluationAttestation(attested.result.attestation)).toBe(true);

		send(ws, {
			type: "request",
			requestId: "memory-request",
			idempotencyKey: "memory-key",
			command: { type: "session.memory.list", sessionId, limit: 10 },
		});
		const memories = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "memory-request"
		);
		expect(memories.result).toMatchObject({
			type: "session.memory.list",
			sessionId,
			memories: [
				{
					status: "active",
					retention: "automatic",
					memory: {
						operationId: completedOperation.id,
						reason: "threshold",
						summary: "Gateway runtime compacted memory.",
						source: { fromItemId: expect.any(String), throughItemId: expect.any(String) },
					},
				},
			],
		});
		if (memories.result.type !== "session.memory.list") throw new Error("Expected memory list");
		const memoryId = memories.result.memories[0]!.memory.id;

		send(ws, {
			type: "request",
			requestId: "memory-search",
			idempotencyKey: "memory-search-key",
			command: { type: "session.memory.search", sessionId, query: "gateway compacted", limit: 5 },
		});
		const memorySearch = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "memory-search"
		);
		expect(memorySearch.result).toMatchObject({
			type: "session.memory.search",
			query: "gateway compacted",
			matches: [
				{
					memory: { memory: { id: memoryId }, status: "active" },
					matchedTerms: expect.arrayContaining(["gateway", "compacted"]),
				},
			],
		});

		send(ws, {
			type: "request",
			requestId: "memory-promote",
			idempotencyKey: "memory-promote-key",
			command: { type: "session.memory.manage", sessionId, memoryId, action: "promote" },
		});
		const promoted = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "memory-promote"
		);
		expect(promoted.result).toMatchObject({
			type: "session.memory.managed",
			action: "promote",
			retention: "retained",
			status: "active",
		});

		send(ws, {
			type: "request",
			requestId: "memory-forget",
			idempotencyKey: "memory-forget-key",
			command: { type: "session.memory.manage", sessionId, memoryId, action: "forget" },
		});
		const forgotten = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "memory-forget"
		);
		expect(forgotten.result).toMatchObject({
			type: "session.memory.managed",
			action: "forget",
			retention: "automatic",
			status: "forgotten",
		});
		expect(store.searchMemories(sessionId, "gateway compacted")).toEqual([]);

		send(ws, {
			type: "request",
			requestId: "rename-request",
			idempotencyKey: "rename-key",
			command: { type: "session.rename", sessionId, name: "Gateway release review" },
		});
		await collector.waitFor(
			(message) => message.type === "response" && message.ok && message.requestId === "rename-request"
		);
		send(ws, {
			type: "request",
			requestId: "search-request",
			idempotencyKey: "search-key",
			command: {
				type: "session.list",
				workspaceId: workspace.id,
				query: "release",
				archived: false,
			},
		});
		const search = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "search-request"
		);
		expect(search.result).toMatchObject({
			type: "session.list",
			sessions: [{ id: sessionId, name: "Gateway release review" }],
		});

		send(ws, {
			type: "request",
			requestId: "archive-request",
			idempotencyKey: "archive-key",
			command: { type: "session.archive", sessionId, archived: true },
		});
		await collector.waitFor(
			(message) => message.type === "response" && message.ok && message.requestId === "archive-request"
		);
		send(ws, {
			type: "request",
			requestId: "archived-list-request",
			idempotencyKey: "archived-list-key",
			command: {
				type: "session.list",
				workspaceId: workspace.id,
				query: "release",
				archived: true,
			},
		});
		const archivedList = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "archived-list-request"
		);
		expect(archivedList.result).toMatchObject({
			type: "session.list",
			sessions: [{ id: sessionId, archivedAt: 100 }],
		});

		const replayClient = await openClient(url);
		send(replayClient.ws, {
			type: "hello",
			protocolVersion: 1,
			clientId: "client-2",
			capabilities: [],
			resumeCursor: "0",
		});
		await replayClient.collector.waitFor((message) => message.type === "hello");
		const replayed = await replayClient.collector.waitFor((message) => message.type === "event");
		expect(Number(replayed.type === "event" ? replayed.cursor : 0)).toBeGreaterThan(0);
	});

	it("rejects a browser origin that does not match the gateway authority", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces: [workspace] }),
			orchestrator: new SessionOrchestrator(store, new GatewayRuntime()),
			store,
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, ["wuming.v1", bearerProtocol("secret")], {
			origin: "https://evil.example",
		});
		const status = await new Promise<number>((resolve, reject) => {
			ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
			ws.once("open", () => reject(new Error("Cross-origin connection unexpectedly opened")));
			ws.once("error", () => {});
		});
		expect(status).toBe(403);
	});

	it("authorizes and forwards an approval decision for an attached session", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const orchestrator = new SessionOrchestrator(store, new GatewayRuntime(), { clock: () => 100 });
		const created = await orchestrator.createSession({
			principalId: "user-1",
			idempotencyKey: "create-approval-session",
			workspaceId: workspace.id,
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "medium",
			sandboxMode: "workspace_write",
			approvalPolicy: "always",
		});
		let approvalId = 0;
		const approvals = new ApprovalBroker({
			store,
			clock: () => 200,
			idFactory: () => `approval-${++approvalId}`,
		});
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces: [workspace] }),
			orchestrator,
			store,
			approvals,
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const { ws, collector } = await openClient(`ws://127.0.0.1:${address.port}/api/ws`);
		send(ws, {
			type: "hello",
			protocolVersion: 1,
			clientId: "approval-client",
			capabilities: ["approval"],
		});
		const hello = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "hello" }> => message.type === "hello"
		);
		expect(hello.capabilities).toContain("approval");
		send(ws, {
			type: "request",
			requestId: "attach-approval",
			idempotencyKey: "attach-approval",
			command: { type: "session.attach", sessionId: created.snapshot.session.id },
		});
		await collector.waitFor(
			(message) => message.type === "response" && message.requestId === "attach-approval" && message.ok
		);

		const authorization = approvals.authorize({
			sessionId: created.snapshot.session.id,
			toolCallId: "write-tool",
			risk: "medium",
			summary: "Write src/index.ts",
			capabilities: [{ type: "filesystem.write", paths: ["src/index.ts"] }],
		});
		const requested = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "event" }> =>
				message.type === "event" && message.event.type === "approval.requested"
		);
		if (requested.event.type !== "approval.requested") throw new Error("Expected approval request");
		send(ws, {
			type: "request",
			requestId: "approve-request",
			idempotencyKey: "approve-key",
			command: {
				type: "approval.respond",
				sessionId: created.snapshot.session.id,
				approvalId: requested.event.approval.id,
				decision: "approve",
			},
		});
		const accepted = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "approve-request"
		);
		expect(accepted.result).toMatchObject({
			type: "approval.accepted",
			approval: { status: "approved" },
		});
		const permit = await authorization;
		expect(permit).toEqual({ approvalId: requested.event.approval.id });
		approvals.completeAuthorization(permit!);
	});

	it("forwards a durable abort request and settles the active turn", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const runtime = new BlockingGatewayRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime);
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces: [workspace] }),
			orchestrator,
			store,
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const { ws, collector } = await openClient(`ws://127.0.0.1:${address.port}/api/ws`);
		send(ws, { type: "hello", protocolVersion: 1, clientId: "abort-client", capabilities: [] });
		await collector.waitFor((message) => message.type === "hello");
		send(ws, {
			type: "request",
			requestId: "create-abort",
			idempotencyKey: "create-abort",
			command: {
				type: "session.create",
				workspaceId: workspace.id,
				model: { provider: "test", id: "model" },
				thinkingLevel: "off",
				sandboxMode: "workspace_write",
				approvalPolicy: "on_risk",
			},
		});
		const created = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "create-abort"
		);
		if (created.result.type !== "session.created") throw new Error("Expected created session");
		const sessionId = created.result.snapshot.session.id;
		send(ws, {
			type: "request",
			requestId: "start-blocking",
			idempotencyKey: "start-blocking",
			command: { type: "turn.prompt", sessionId, content: [{ type: "text", text: "block" }] },
		});
		await collector.waitFor(
			(message) => message.type === "response" && message.ok && message.requestId === "start-blocking"
		);
		await runtime.started;
		send(ws, {
			type: "request",
			requestId: "abort-active",
			idempotencyKey: "abort-active",
			command: { type: "turn.abort", sessionId },
		});
		const abortResponse = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "abort-active"
		);
		expect(abortResponse.result).toMatchObject({ type: "turn.abort_requested", sessionId });
		await collector.waitFor(
			(message) =>
				message.type === "event" &&
				message.event.type === "session.item.upserted" &&
				message.event.item.type === "assistant" &&
				message.event.item.status === "aborted"
		);
		await collector.waitFor(
			(message) =>
				message.type === "event" && message.event.type === "session.phase.changed" && message.event.phase === "idle"
		);
	});

	it("authenticates artifact upload/download and rejects tampered prompt references", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-gateway-artifacts-"));
		const artifacts = await ArtifactStore.open(":memory:", join(directory, "objects"));
		cleanup.push(async () => {
			artifacts.close();
			await rm(directory, { recursive: true, force: true });
		});
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const orchestrator = new SessionOrchestrator(store, new GatewayRuntime());
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces: [workspace] }),
			orchestrator,
			store,
			artifacts,
			maxArtifactBytes: 1024,
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const base = `http://127.0.0.1:${address.port}`;
		const unauthorized = await fetch(`${base}/api/workspaces/${workspace.id}/artifacts`, {
			method: "POST",
			headers: {
				"Content-Type": "text/plain",
				"X-Wuming-File-Name": encodeURIComponent("notes.txt"),
			},
			body: "hello",
		});
		expect(unauthorized.status).toBe(401);
		const uploaded = await fetch(`${base}/api/workspaces/${workspace.id}/artifacts`, {
			method: "POST",
			headers: {
				Authorization: "Bearer secret",
				"Content-Type": "text/plain",
				"X-Wuming-File-Name": encodeURIComponent("notes.txt"),
			},
			body: "hello artifact",
		});
		expect(uploaded.status).toBe(201);
		const payload = (await uploaded.json()) as {
			artifact: { id: string; name: string; mimeType: string; size: number };
		};
		expect(payload.artifact).toMatchObject({ name: "notes.txt", mimeType: "text/plain", size: 14 });
		const downloaded = await fetch(`${base}/api/artifacts/${payload.artifact.id}`, {
			headers: { Authorization: "Bearer secret" },
		});
		expect(downloaded.status).toBe(200);
		expect(await downloaded.text()).toBe("hello artifact");
		expect(downloaded.headers.get("content-disposition")).toContain("notes.txt");

		const { ws, collector } = await openClient(`${base.replace("http", "ws")}/api/ws`);
		send(ws, {
			type: "hello",
			protocolVersion: 1,
			clientId: "artifact-client",
			capabilities: ["artifact"],
		});
		await collector.waitFor((message) => message.type === "hello");
		send(ws, {
			type: "request",
			requestId: "artifact-session",
			idempotencyKey: "artifact-session",
			command: {
				type: "session.create",
				workspaceId: workspace.id,
				model: { provider: "test", id: "model" },
				thinkingLevel: "off",
				sandboxMode: "workspace_write",
				approvalPolicy: "on_risk",
			},
		});
		const created = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "artifact-session"
		);
		if (created.result.type !== "session.created") throw new Error("Expected session");
		const sessionId = created.result.snapshot.session.id;
		send(ws, {
			type: "request",
			requestId: "artifact-prompt",
			idempotencyKey: "artifact-prompt",
			command: {
				type: "turn.prompt",
				sessionId,
				content: [{ type: "artifact", artifact: payload.artifact }],
			},
		});
		await collector.waitFor(
			(message) => message.type === "response" && message.ok && message.requestId === "artifact-prompt"
		);
		send(ws, {
			type: "request",
			requestId: "tampered-artifact",
			idempotencyKey: "tampered-artifact",
			command: {
				type: "turn.steer",
				sessionId,
				content: [{ type: "artifact", artifact: { ...payload.artifact, size: payload.artifact.size + 1 } }],
			},
		});
		const rejected = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: false }> =>
				message.type === "response" && !message.ok && message.requestId === "tampered-artifact"
		);
		expect(rejected.error.code).toBe("invalid_request");
	});

	it("authenticates workspace browsing and rejects escaping paths", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-gateway-workspace-"));
		await mkdir(join(directory, "src"));
		await writeFile(join(directory, "src", "index.ts"), "export const answer = 42;\n", "utf8");
		const inspector = await WorkspaceInspector.create(directory);
		cleanup.push(() => rm(directory, { recursive: true, force: true }));
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces: [workspace] }),
			orchestrator: new SessionOrchestrator(store, new GatewayRuntime()),
			store,
			workspace: {
				listDirectory: (_workspaceId, path) => inspector.listDirectory(path),
				searchFiles: (_workspaceId, query, limit) => inspector.searchFiles(query, limit),
				readFile: (_workspaceId, path) => inspector.readFile(path),
				gitStatus: () => inspector.gitStatus(),
				gitDiff: (_workspaceId, path, staged) => inspector.gitDiff(path, staged),
			},
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const base = `http://127.0.0.1:${address.port}`;
		const unauthorized = await fetch(`${base}/api/workspaces/${workspace.id}/tree?path=.`);
		expect(unauthorized.status).toBe(401);
		const tree = await fetch(`${base}/api/workspaces/${workspace.id}/tree?path=.`, {
			headers: { Authorization: "Bearer secret" },
		});
		expect(tree.status).toBe(200);
		expect(await tree.json()).toMatchObject({ entries: [{ path: "src", kind: "directory" }] });
		const file = await fetch(`${base}/api/workspaces/${workspace.id}/file?path=${encodeURIComponent("src/index.ts")}`, {
			headers: { Authorization: "Bearer secret" },
		});
		expect(await file.json()).toMatchObject({
			path: "src/index.ts",
			content: "export const answer = 42;\n",
		});
		const search = await fetch(`${base}/api/workspaces/${workspace.id}/search?query=idx&limit=5`, {
			headers: { Authorization: "Bearer secret" },
		});
		expect(search.status).toBe(200);
		expect(await search.json()).toMatchObject({
			query: "idx",
			entries: [{ path: "src/index.ts", kind: "file" }],
		});
		const escaped = await fetch(
			`${base}/api/workspaces/${workspace.id}/file?path=${encodeURIComponent("../secret.txt")}`,
			{
				headers: { Authorization: "Bearer secret" },
			}
		);
		expect(escaped.status).toBe(400);
		const forbidden = await fetch(`${base}/api/workspaces/other/tree?path=.`, {
			headers: { Authorization: "Bearer secret" },
		});
		expect(forbidden.status).toBe(403);
	});

	it("imports a project and exposes it to the existing websocket connection", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const workspaces = [workspace];
		const imported: WorkspaceSummary = {
			id: "project-imported",
			name: "Imported app",
			status: "ready",
			createdAt: 10,
			updatedAt: 11,
		};
		let uploaded: { path: string; content: string } | undefined;
		let removedProjectId: string | undefined;
		let pickedKind: "file" | "directory" | undefined;
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces }),
			orchestrator: new SessionOrchestrator(store, new GatewayRuntime()),
			store,
			projects: {
				pick: async (_ownerId, kind) => {
					pickedKind = kind;
					return imported;
				},
				create: async (_ownerId, name) => ({ ...imported, name, status: "provisioning" }),
				writeFile: async (_ownerId, projectId, path, content) => {
					expect(projectId).toBe(imported.id);
					uploaded = { path, content: content.toString("utf8") };
				},
				complete: async () => imported,
				rename: async (_ownerId, projectId, name) => ({ ...imported, id: projectId, name }),
				remove: async (_ownerId, projectId) => {
					removedProjectId = projectId;
				},
			},
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const base = `http://127.0.0.1:${address.port}`;
		const { ws, collector } = await openClient(`ws://127.0.0.1:${address.port}/api/ws`);
		send(ws, { type: "hello", protocolVersion: 1, clientId: "project-client", capabilities: [] });
		await collector.waitFor((message) => message.type === "hello");
		const picked = await fetch(`${base}/api/projects/pick`, {
			method: "POST",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: "{}",
		});
		expect(picked.status).toBe(200);
		expect(await picked.json()).toMatchObject({ project: { id: imported.id } });
		expect(pickedKind).toBeUndefined();

		const created = await fetch(`${base}/api/projects`, {
			method: "POST",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Imported app" }),
		});
		expect(created.status).toBe(201);
		const uploadedResponse = await fetch(`${base}/api/projects/${imported.id}/files`, {
			method: "PUT",
			headers: {
				Authorization: "Bearer secret",
				"X-Wuming-Project-Path": encodeURIComponent("src/index.ts"),
			},
			body: "export const imported = true;\n",
		});
		expect(uploadedResponse.status).toBe(204);
		expect(uploaded).toEqual({ path: "src/index.ts", content: "export const imported = true;\n" });
		const completed = await fetch(`${base}/api/projects/${imported.id}/complete`, {
			method: "POST",
			headers: { Authorization: "Bearer secret" },
		});
		expect(completed.status).toBe(200);
		const renamed = await fetch(`${base}/api/projects/${imported.id}`, {
			method: "PATCH",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Renamed app" }),
		});
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toMatchObject({
			project: { id: imported.id, name: "Renamed app" },
		});

		send(ws, {
			type: "request",
			requestId: "project-list",
			idempotencyKey: "project-list",
			command: { type: "workspace.list" },
		});
		const listed = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "project-list"
		);
		expect(listed.result).toMatchObject({
			type: "workspace.list",
			workspaces: [{ id: workspace.id }, { id: imported.id, name: "Renamed app" }],
		});

		send(ws, {
			type: "request",
			requestId: "project-session",
			idempotencyKey: "project-session",
			command: {
				type: "session.create",
				workspaceId: imported.id,
				model: { provider: "test", id: "test" },
				thinkingLevel: "off",
				sandboxMode: "workspace_write",
				approvalPolicy: "on_risk",
			},
		});
		const session = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "project-session"
		);
		expect(session.result).toMatchObject({
			type: "session.created",
			snapshot: { session: { workspaceId: imported.id } },
		});

		const removed = await fetch(`${base}/api/projects/${imported.id}`, {
			method: "DELETE",
			headers: { Authorization: "Bearer secret" },
		});
		expect(removed.status).toBe(204);
		expect(removedProjectId).toBe(imported.id);
		send(ws, {
			type: "request",
			requestId: "project-list-after-remove",
			idempotencyKey: "project-list-after-remove",
			command: { type: "workspace.list" },
		});
		const afterRemove = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "project-list-after-remove"
		);
		expect(afterRemove.result).toMatchObject({
			type: "workspace.list",
			workspaces: [{ id: workspace.id }],
		});
	});

	it("routes an authenticated terminal PTY over the protocol", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-gateway-terminal-"));
		const terminal = new TerminalManager({
			workspaceRoot: directory,
			mode: "host",
			assertWorkspace: (workspaceId) => {
				if (workspaceId !== workspace.id) throw new Error("Unknown workspace");
				return directory;
			},
		});
		cleanup.push(async () => {
			await terminal[Symbol.asyncDispose]();
			await rm(directory, { recursive: true, force: true });
		});
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces: [workspace] }),
			orchestrator: new SessionOrchestrator(store, new GatewayRuntime()),
			store,
			terminal,
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const { ws, collector } = await openClient(`ws://127.0.0.1:${address.port}/api/ws`);
		send(ws, {
			type: "hello",
			protocolVersion: 1,
			clientId: "terminal-client",
			capabilities: ["terminal"],
		});
		const hello = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "hello" }> => message.type === "hello"
		);
		expect(hello.capabilities).toContain("terminal");
		ws.send(
			JSON.stringify({
				type: "terminal.create",
				requestId: "terminal-create",
				terminalId: "terminal-1",
				workspaceId: workspace.id,
				cols: 80,
				rows: 24,
			})
		);
		await collector.waitFor((message) => message.type === "terminal.ready" && message.requestId === "terminal-create");
		ws.send(
			JSON.stringify({
				type: "terminal.input",
				terminalId: "terminal-1",
				data: "echo GATEWAY_TERMINAL\r",
			})
		);
		const beforeDisconnect = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "terminal.output" }> =>
				message.type === "terminal.output" && message.data.includes("GATEWAY_TERMINAL")
		);

		await new Promise<void>((resolve) => {
			ws.once("close", () => resolve());
			ws.close();
		});

		const { ws: reconnected, collector: reconnectedCollector } = await openClient(
			`ws://127.0.0.1:${address.port}/api/ws`
		);
		send(reconnected, {
			type: "hello",
			protocolVersion: 1,
			clientId: "terminal-client",
			capabilities: ["terminal"],
		});
		await reconnectedCollector.waitFor((message) => message.type === "hello");
		reconnected.send(
			JSON.stringify({
				type: "terminal.attach",
				requestId: "terminal-attach",
				terminalId: "terminal-1",
				sinceSeq: beforeDisconnect.seq,
				cols: 100,
				rows: 30,
			})
		);
		const replay = await reconnectedCollector.waitFor(
			(message): message is Extract<ServerMessage, { type: "terminal.reset" }> =>
				message.type === "terminal.reset" && message.terminalId === "terminal-1"
		);
		expect(replay.data).toContain("GATEWAY_TERMINAL");
		expect(replay.seq).toBeGreaterThanOrEqual(beforeDisconnect.seq);
		await reconnectedCollector.waitFor(
			(message) => message.type === "terminal.ready" && message.requestId === "terminal-attach"
		);

		reconnected.send(
			JSON.stringify({
				type: "terminal.input",
				terminalId: "terminal-1",
				data: "echo GATEWAY_AFTER_ATTACH\r",
			})
		);
		await reconnectedCollector.waitFor(
			(message) => message.type === "terminal.output" && message.data.includes("GATEWAY_AFTER_ATTACH")
		);
		reconnected.send(
			JSON.stringify({
				type: "terminal.close",
				requestId: "terminal-close",
				terminalId: "terminal-1",
			})
		);
		await reconnectedCollector.waitFor(
			(message) => message.type === "terminal.closed" && message.requestId === "terminal-close"
		);
	});
});

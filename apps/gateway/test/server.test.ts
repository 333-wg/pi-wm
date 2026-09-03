import type { AgentRuntime } from "@wuming/orchestrator";
import { ArtifactStore } from "@wuming/artifacts";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { ClientMessage, ServerMessage, WorkspaceSummary } from "@wuming/protocol";
import { ApprovalBroker, WorkspaceInspector } from "@wuming/sandbox";
import { TerminalManager } from "../src/terminal.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearerProtocol, GatewayServer, StaticTokenAuth } from "../src/index.js";

class GatewayRuntime implements AgentRuntime {
	calls = 0;

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
			}),
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
			models: [{
				model: { provider: "openai", id: "gpt-test" },
				name: "GPT Test",
				reasoning: true,
				input: ["text"],
				contextWindow: 1000,
				maxOutputTokens: 100,
				authenticated: true,
			}],
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const { ws, collector } = await openClient(`ws://127.0.0.1:${address.port}/api/ws`);
		send(ws, { type: "hello", protocolVersion: 1, clientId: "config-client", capabilities: [] });
		const hello = await collector.waitFor((message): message is Extract<ServerMessage, { type: "hello" }> => message.type === "hello");
		expect(hello.capabilities).toContain("session.fork");
		expect(hello.capabilities).toContain("subagents");
		expect(hello.capabilities).toContain("goals");
		send(ws, { type: "request", requestId: "attach-config", idempotencyKey: "attach-config", command: { type: "session.attach", sessionId: created.snapshot.session.id } });
		await collector.waitFor((message) => message.type === "response" && message.requestId === "attach-config" && message.ok);
		send(ws, { type: "request", requestId: "set-model", idempotencyKey: "set-model", command: { type: "session.model.set", sessionId: created.snapshot.session.id, model: { provider: "openai", id: "gpt-test" } } });
		const modelResult = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "set-model" && message.ok);
		expect(modelResult.result.type).toBe("session.configured");
		send(ws, { type: "request", requestId: "set-thinking", idempotencyKey: "set-thinking", command: { type: "session.thinking.set", sessionId: created.snapshot.session.id, thinkingLevel: "high" } });
		const thinkingResult = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "set-thinking" && message.ok);
		expect(thinkingResult.result.type).toBe("session.configured");
		send(ws, { type: "request", requestId: "set-policy", idempotencyKey: "set-policy", command: { type: "session.policy.set", sessionId: created.snapshot.session.id, sandboxMode: "unrestricted", approvalPolicy: "never" } });
		const policyResult = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "set-policy" && message.ok);
		expect(policyResult.result).toMatchObject({ type: "session.configured", snapshot: { sandboxMode: "unrestricted", approvalPolicy: "never" } });
		send(ws, { type: "request", requestId: "set-budget", idempotencyKey: "set-budget", command: { type: "session.budget.set", sessionId: created.snapshot.session.id, costBudgetUsd: 1.5, tokenBudget: 20_000, budgetWarningThreshold: 0.75 } });
		const budgetResult = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "set-budget" && message.ok);
		expect(budgetResult.result).toMatchObject({ type: "session.configured", snapshot: { costBudgetUsd: 1.5, tokenBudget: 20_000, budgetWarningThreshold: 0.75 } });
		send(ws, { type: "request", requestId: "fork", idempotencyKey: "fork", command: { type: "session.fork", sessionId: created.snapshot.session.id } });
		const forkResult = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "fork" && message.ok);
		expect(forkResult.result.type).toBe("session.forked");
		if (forkResult.result.type !== "session.forked") throw new Error("Expected forked session");
		// A fork attaches the connection that asked for it, the way a creation does.
		// Without that the caller holds the forked snapshot but never receives its
		// events, so the first turn it starts there renders nothing.
		const forkedSessionId = forkResult.result.snapshot.session.id;
		send(ws, { type: "request", requestId: "fork-prompt", idempotencyKey: "fork-prompt", command: { type: "turn.prompt", sessionId: forkedSessionId, content: [{ type: "text", text: "continue in the fork" }] } });
		await collector.waitFor((message) => message.type === "event" && message.event.sessionId === forkedSessionId && message.event.type === "session.item.upserted" && message.event.item.type === "assistant");
		send(ws, { type: "request", requestId: "subagent-create", idempotencyKey: "subagent-create", command: { type: "subagent.create", sessionId: created.snapshot.session.id, task: "Inspect the configured session", wait: true } });
		const subagentCreated = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "subagent-create" && message.ok);
		expect(subagentCreated.result).toMatchObject({ type: "subagent.created", subagent: { parentSessionId: created.snapshot.session.id, status: "completed", result: "hello" } });
		send(ws, { type: "request", requestId: "subagent-list", idempotencyKey: "subagent-list", command: { type: "subagent.list", sessionId: created.snapshot.session.id } });
		const subagentList = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "subagent-list" && message.ok);
		expect(subagentList.result).toMatchObject({ type: "subagent.list", subagents: [{ status: "completed" }] });
		expect(store.loadSnapshot(created.snapshot.session.id)?.transcript.at(-1)).toMatchObject({ type: "tool", toolName: "subagent", status: "complete" });
		send(ws, { type: "request", requestId: "goal-create", idempotencyKey: "goal-create", command: { type: "goal.create", sessionId: created.snapshot.session.id, title: "Gateway goal", objective: "Complete in the background" } });
		const goalCreated = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "goal-create" && message.ok);
		expect(goalCreated.result).toMatchObject({ type: "goal.created", goal: { status: "pending", title: "Gateway goal" } });
		if (goalCreated.result.type !== "goal.created") throw new Error("Expected created goal");
		send(ws, { type: "request", requestId: "goal-start", idempotencyKey: "goal-start", command: { type: "goal.start", sessionId: created.snapshot.session.id, goalId: goalCreated.result.goal.id } });
		const goalStarted = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "goal-start" && message.ok);
		expect(goalStarted.result).toMatchObject({ type: "goal.started", goal: { status: "queued", runSessionId: expect.any(String) } });
		if (goalStarted.result.type !== "goal.started" || !goalStarted.result.goal.runSessionId) throw new Error("Expected started goal");
		await collector.waitFor((message) => message.type === "event" && message.event.type === "session.item.upserted" && message.event.item.type === "tool" && message.event.item.toolCallId === goalStarted.result.goal.runSessionId);
		send(ws, { type: "request", requestId: "goal-list", idempotencyKey: "goal-list", command: { type: "goal.list", sessionId: created.snapshot.session.id } });
		const goalList = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "goal-list" && message.ok);
		expect(goalList.result).toMatchObject({ type: "goal.list", goals: [{ status: "completed", result: "hello" }] });
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
				list: () => [{ name: "web_search", label: "网络搜索", description: "搜索公开网页", category: "network", status: "ready", backend: "Bing", risk: "low", sandboxModes: ["read_only", "workspace_write", "unrestricted"] }],
			},
			capabilities: ["tools"],
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const { ws, collector } = await openClient(`ws://127.0.0.1:${address.port}/api/ws`);
		send(ws, { type: "hello", protocolVersion: 1, clientId: "tools-client", capabilities: [] });
		const hello = await collector.waitFor((message): message is Extract<ServerMessage, { type: "hello" }> => message.type === "hello");
		expect(hello.capabilities).toContain("tools");
		send(ws, { type: "request", requestId: "tools", idempotencyKey: "tools", command: { type: "tool.list", workspaceId: workspace.id } });
		const response = await collector.waitFor((message): message is Extract<ServerMessage, { type: "response"; ok: true }> => message.type === "response" && message.requestId === "tools" && message.ok);
		expect(response.result).toMatchObject({ type: "tool.list", runtime: "pi", tools: [{ name: "web_search", status: "ready" }] });
	});

	it("runs the authenticated create, prompt, progress, durable event, and replay flow", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(() => store.close());
		const runtime = new GatewayRuntime();
		const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => 100 });
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
			onError: (error) => errors.push(error),
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const url = `ws://127.0.0.1:${address.port}/api/ws`;
		const { ws, collector } = await openClient(url, "secret", `http://127.0.0.1:${address.port}`);
		send(ws, { type: "hello", protocolVersion: 1, clientId: "client-1", capabilities: [] });
		await collector.waitFor((message) => message.type === "hello");

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
				message.type === "response" && message.ok && message.requestId === "create-request",
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
			(message) => message.type === "response" && message.requestId === "turn-request" && message.ok,
		);
		await collector.waitFor((message) => message.type === "progress" && message.event.type === "assistant.delta");
		const completedEvent = await collector.waitFor(
			(message) =>
				message.type === "event" &&
				message.event.type === "session.item.upserted" &&
				message.event.item.type === "assistant",
		);
		expect(runtime.calls).toBe(1);
		expect(errors).toEqual([]);
		if (completedEvent.type !== "event") throw new Error("Expected event");

		send(ws, {
			type: "request",
			requestId: "runs-request",
			idempotencyKey: "runs-key",
			command: { type: "session.run.list", sessionId, limit: 10 },
		});
		const runs = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "runs-request",
		);
		expect(runs.result).toMatchObject({
			type: "session.run.list",
			sessionId,
			runs: [{ mode: "prompt", status: "completed", attempt: 1 }],
		});

		send(ws, {
			type: "request",
			requestId: "rename-request",
			idempotencyKey: "rename-key",
			command: { type: "session.rename", sessionId, name: "Gateway release review" },
		});
		await collector.waitFor((message) => message.type === "response" && message.ok && message.requestId === "rename-request");
		send(ws, {
			type: "request",
			requestId: "search-request",
			idempotencyKey: "search-key",
			command: { type: "session.list", workspaceId: workspace.id, query: "release", archived: false },
		});
		const search = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "search-request",
		);
		expect(search.result).toMatchObject({ type: "session.list", sessions: [{ id: sessionId, name: "Gateway release review" }] });

		send(ws, {
			type: "request",
			requestId: "archive-request",
			idempotencyKey: "archive-key",
			command: { type: "session.archive", sessionId, archived: true },
		});
		await collector.waitFor((message) => message.type === "response" && message.ok && message.requestId === "archive-request");
		send(ws, {
			type: "request",
			requestId: "archived-list-request",
			idempotencyKey: "archived-list-key",
			command: { type: "session.list", workspaceId: workspace.id, query: "release", archived: true },
		});
		const archivedList = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "archived-list-request",
		);
		expect(archivedList.result).toMatchObject({ type: "session.list", sessions: [{ id: sessionId, archivedAt: 100 }] });

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
		const approvals = new ApprovalBroker({ store, clock: () => 200, idFactory: () => `approval-${++approvalId}` });
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces: [workspace] }),
			orchestrator,
			store,
			approvals,
		});
		const address = await server.listen();
		cleanup.push(() => server.close());
		const { ws, collector } = await openClient(`ws://127.0.0.1:${address.port}/api/ws`);
		send(ws, { type: "hello", protocolVersion: 1, clientId: "approval-client", capabilities: ["approval"] });
		const hello = await collector.waitFor((message): message is Extract<ServerMessage, { type: "hello" }> => message.type === "hello");
		expect(hello.capabilities).toContain("approval");
		send(ws, {
			type: "request",
			requestId: "attach-approval",
			idempotencyKey: "attach-approval",
			command: { type: "session.attach", sessionId: created.snapshot.session.id },
		});
		await collector.waitFor((message) => message.type === "response" && message.requestId === "attach-approval" && message.ok);

		const authorization = approvals.authorize({
			sessionId: created.snapshot.session.id,
			toolCallId: "write-tool",
			risk: "medium",
			summary: "Write src/index.ts",
			capabilities: [{ type: "filesystem.write", paths: ["src/index.ts"] }],
		});
		const requested = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "event" }> =>
				message.type === "event" && message.event.type === "approval.requested",
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
				message.type === "response" && message.ok && message.requestId === "approve-request",
		);
		expect(accepted.result).toMatchObject({ type: "approval.accepted", approval: { status: "approved" } });
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
				message.type === "response" && message.ok && message.requestId === "create-abort",
		);
		if (created.result.type !== "session.created") throw new Error("Expected created session");
		const sessionId = created.result.snapshot.session.id;
		send(ws, {
			type: "request",
			requestId: "start-blocking",
			idempotencyKey: "start-blocking",
			command: { type: "turn.prompt", sessionId, content: [{ type: "text", text: "block" }] },
		});
		await collector.waitFor((message) => message.type === "response" && message.ok && message.requestId === "start-blocking");
		await runtime.started;
		send(ws, {
			type: "request",
			requestId: "abort-active",
			idempotencyKey: "abort-active",
			command: { type: "turn.abort", sessionId },
		});
		const abortResponse = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "abort-active",
		);
		expect(abortResponse.result).toMatchObject({ type: "turn.abort_requested", sessionId });
		await collector.waitFor(
			(message) =>
				message.type === "event" &&
				message.event.type === "session.item.upserted" &&
				message.event.item.type === "assistant" &&
				message.event.item.status === "aborted",
		);
		await collector.waitFor(
			(message) => message.type === "event" && message.event.type === "session.phase.changed" && message.event.phase === "idle",
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
			headers: { "Content-Type": "text/plain", "X-Wuming-File-Name": encodeURIComponent("notes.txt") },
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
		const payload = await uploaded.json() as { artifact: { id: string; name: string; mimeType: string; size: number } };
		expect(payload.artifact).toMatchObject({ name: "notes.txt", mimeType: "text/plain", size: 14 });
		const downloaded = await fetch(`${base}/api/artifacts/${payload.artifact.id}`, {
			headers: { Authorization: "Bearer secret" },
		});
		expect(downloaded.status).toBe(200);
		expect(await downloaded.text()).toBe("hello artifact");
		expect(downloaded.headers.get("content-disposition")).toContain("notes.txt");

		const { ws, collector } = await openClient(`${base.replace("http", "ws")}/api/ws`);
		send(ws, { type: "hello", protocolVersion: 1, clientId: "artifact-client", capabilities: ["artifact"] });
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
				message.type === "response" && message.ok && message.requestId === "artifact-session",
		);
		if (created.result.type !== "session.created") throw new Error("Expected session");
		const sessionId = created.result.snapshot.session.id;
		send(ws, {
			type: "request",
			requestId: "artifact-prompt",
			idempotencyKey: "artifact-prompt",
			command: { type: "turn.prompt", sessionId, content: [{ type: "artifact", artifact: payload.artifact }] },
		});
		await collector.waitFor((message) => message.type === "response" && message.ok && message.requestId === "artifact-prompt");
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
				message.type === "response" && !message.ok && message.requestId === "tampered-artifact",
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
		expect(await file.json()).toMatchObject({ path: "src/index.ts", content: "export const answer = 42;\n" });
		const search = await fetch(`${base}/api/workspaces/${workspace.id}/search?query=idx&limit=5`, {
			headers: { Authorization: "Bearer secret" },
		});
		expect(search.status).toBe(200);
		expect(await search.json()).toMatchObject({ query: "idx", entries: [{ path: "src/index.ts", kind: "file" }] });
		const escaped = await fetch(`${base}/api/workspaces/${workspace.id}/file?path=${encodeURIComponent("../secret.txt")}`, {
			headers: { Authorization: "Bearer secret" },
		});
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
		const server = new GatewayServer({
			auth: new StaticTokenAuth("secret", { id: "user-1", workspaces }),
			orchestrator: new SessionOrchestrator(store, new GatewayRuntime()),
			store,
			projects: {
				pick: async () => imported,
				create: async (_ownerId, name) => ({ ...imported, name, status: "provisioning" }),
				writeFile: async (_ownerId, projectId, path, content) => {
					expect(projectId).toBe(imported.id);
					uploaded = { path, content: content.toString("utf8") };
				},
				complete: async () => imported,
				rename: async (_ownerId, projectId, name) => ({ ...imported, id: projectId, name }),
				remove: async (_ownerId, projectId) => { removedProjectId = projectId; },
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
			body: JSON.stringify({ kind: "directory" }),
		});
		expect(picked.status).toBe(200);
		expect(await picked.json()).toMatchObject({ project: { id: imported.id } });

		const created = await fetch(`${base}/api/projects`, {
			method: "POST",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Imported app" }),
		});
		expect(created.status).toBe(201);
		const uploadedResponse = await fetch(`${base}/api/projects/${imported.id}/files`, {
			method: "PUT",
			headers: { Authorization: "Bearer secret", "X-Wuming-Project-Path": encodeURIComponent("src/index.ts") },
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
		expect(await renamed.json()).toMatchObject({ project: { id: imported.id, name: "Renamed app" } });

		send(ws, { type: "request", requestId: "project-list", idempotencyKey: "project-list", command: { type: "workspace.list" } });
		const listed = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "project-list",
		);
		expect(listed.result).toMatchObject({ type: "workspace.list", workspaces: [{ id: workspace.id }, { id: imported.id, name: "Renamed app" }] });

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
				message.type === "response" && message.ok && message.requestId === "project-session",
		);
		expect(session.result).toMatchObject({ type: "session.created", snapshot: { session: { workspaceId: imported.id } } });

		const removed = await fetch(`${base}/api/projects/${imported.id}`, {
			method: "DELETE",
			headers: { Authorization: "Bearer secret" },
		});
		expect(removed.status).toBe(204);
		expect(removedProjectId).toBe(imported.id);
		send(ws, { type: "request", requestId: "project-list-after-remove", idempotencyKey: "project-list-after-remove", command: { type: "workspace.list" } });
		const afterRemove = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "response"; ok: true }> =>
				message.type === "response" && message.ok && message.requestId === "project-list-after-remove",
		);
		expect(afterRemove.result).toMatchObject({ type: "workspace.list", workspaces: [{ id: workspace.id }] });
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
		cleanup.push(async () => { await terminal[Symbol.asyncDispose](); await rm(directory, { recursive: true, force: true }); });
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
		send(ws, { type: "hello", protocolVersion: 1, clientId: "terminal-client", capabilities: ["terminal"] });
		const hello = await collector.waitFor((message): message is Extract<ServerMessage, { type: "hello" }> => message.type === "hello");
		expect(hello.capabilities).toContain("terminal");
		ws.send(JSON.stringify({ type: "terminal.create", requestId: "terminal-create", terminalId: "terminal-1", workspaceId: workspace.id, cols: 80, rows: 24 }));
		await collector.waitFor((message) => message.type === "terminal.ready" && message.requestId === "terminal-create");
		ws.send(JSON.stringify({ type: "terminal.input", terminalId: "terminal-1", data: "echo GATEWAY_TERMINAL\r" }));
		const beforeDisconnect = await collector.waitFor(
			(message): message is Extract<ServerMessage, { type: "terminal.output" }> =>
				message.type === "terminal.output" && message.data.includes("GATEWAY_TERMINAL"),
		);

		await new Promise<void>((resolve) => {
			ws.once("close", () => resolve());
			ws.close();
		});

		const { ws: reconnected, collector: reconnectedCollector } = await openClient(`ws://127.0.0.1:${address.port}/api/ws`);
		send(reconnected, { type: "hello", protocolVersion: 1, clientId: "terminal-client", capabilities: ["terminal"] });
		await reconnectedCollector.waitFor((message) => message.type === "hello");
		reconnected.send(JSON.stringify({
			type: "terminal.attach",
			requestId: "terminal-attach",
			terminalId: "terminal-1",
			sinceSeq: beforeDisconnect.seq,
			cols: 100,
			rows: 30,
		}));
		const replay = await reconnectedCollector.waitFor(
			(message): message is Extract<ServerMessage, { type: "terminal.reset" }> =>
				message.type === "terminal.reset" && message.terminalId === "terminal-1",
		);
		expect(replay.data).toContain("GATEWAY_TERMINAL");
		expect(replay.seq).toBeGreaterThanOrEqual(beforeDisconnect.seq);
		await reconnectedCollector.waitFor((message) => message.type === "terminal.ready" && message.requestId === "terminal-attach");

		reconnected.send(JSON.stringify({ type: "terminal.input", terminalId: "terminal-1", data: "echo GATEWAY_AFTER_ATTACH\r" }));
		await reconnectedCollector.waitFor(
			(message) => message.type === "terminal.output" && message.data.includes("GATEWAY_AFTER_ATTACH"),
		);
		reconnected.send(JSON.stringify({ type: "terminal.close", requestId: "terminal-close", terminalId: "terminal-1" }));
		await reconnectedCollector.waitFor((message) => message.type === "terminal.closed" && message.requestId === "terminal-close");
	});
});

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Socket } from "node:net";
import type { ClientMessage, Command, CommandResult, RunSummary, ServerMessage } from "../packages/protocol/src/index.js";
import { CustomModelRegistry } from "../apps/gateway/src/custom-models.js";
import WebSocket from "ws";

const token = `pi-fault-gate-${randomUUID()}`;
const provider = "fault-openai";
const modelId = "fault-model";
const encryptionKey = `fault-key-${randomUUID()}-${randomUUID()}`;
const requestTimeoutMs = 30_000;
const children = new Set<ChildProcess>();

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function bearerProtocol(value: string): string {
	return `wuming.bearer.${Buffer.from(value, "utf8").toString("base64url")}`;
}

function requestText(body: unknown): string {
	if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) return "";
	return body.messages.map((message) => {
		if (!message || typeof message !== "object" || !("content" in message)) return "";
		const content = message.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content.map((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join(" ");
	}).join("\n");
}

function markerFor(text: string): string {
	for (const marker of ["FAULT_RATE_LIMIT", "FAULT_DISCONNECT", "FAULT_TIMEOUT", "FAULT_RESTART"]) {
		if (text.includes(marker)) return marker;
	}
	return "NORMAL";
}

class MockOpenAiServer {
	readonly attempts = new Map<string, number>();
	readonly #server = createServer((request, response) => void this.#handle(request, response));
	readonly #sockets = new Set<Socket>();
	readonly #restartWaiters = new Set<() => void>();
	port = 0;

	constructor() {
		this.#server.on("connection", (socket) => {
			this.#sockets.add(socket);
			socket.once("close", () => this.#sockets.delete(socket));
		});
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.#server.once("error", reject);
			this.#server.listen(0, "127.0.0.1", () => resolve());
		});
		this.port = (this.#server.address() as AddressInfo).port;
	}

	async close(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}

	async waitForRestartRequest(): Promise<void> {
		if ((this.attempts.get("FAULT_RESTART") ?? 0) > 0) return;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#restartWaiters.delete(done);
				reject(new Error("Timed out waiting for the restart fault request"));
			}, requestTimeoutMs);
			const done = () => {
				clearTimeout(timeout);
				this.#restartWaiters.delete(done);
				resolve();
			};
			this.#restartWaiters.add(done);
		});
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method === "GET" && request.url?.endsWith("/models")) {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model", owned_by: "wuming-test" }] }));
			return;
		}
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.statusCode = 404;
			response.end("not found");
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		let body: unknown;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			response.statusCode = 400;
			response.end(JSON.stringify({ error: { message: "invalid JSON" } }));
			return;
		}
		const marker = markerFor(requestText(body));
		const attempt = (this.attempts.get(marker) ?? 0) + 1;
		this.attempts.set(marker, attempt);

		if (marker === "FAULT_RATE_LIMIT" && attempt === 1) {
			response.statusCode = 429;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ error: { message: "Injected rate limit", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
			return;
		}
		if (marker === "FAULT_TIMEOUT") {
			request.once("close", () => response.destroy());
			return;
		}
		if (marker === "FAULT_RESTART" && attempt === 1) {
			this.#beginStream(response, "partial-before-restart ");
			for (const done of this.#restartWaiters) done();
			return;
		}
		if (marker === "FAULT_DISCONNECT" && attempt === 1) {
			this.#beginStream(response, "partial-before-disconnect ");
			setTimeout(() => response.destroy(new Error("Injected connection reset")), 25);
			return;
		}
		this.#completeStream(response, `${marker} recovered on attempt ${attempt}`);
	}

	#beginStream(response: ServerResponse, content: string): void {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		response.write(`data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
	}

	#completeStream(response: ServerResponse, content: string): void {
		this.#beginStream(response, content);
		response.write(`data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
		response.end("data: [DONE]\n\n");
	}
}

async function startGateway(dataDir: string, workspace: string, agentDir: string): Promise<{ child: ChildProcess; port: number; logs: () => string }> {
	const child = spawn(process.execPath, ["--import", "tsx", "apps/gateway/src/main.ts"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			WUMING_HOST: "127.0.0.1",
			WUMING_PORT: "0",
			WUMING_TOKEN: token,
			WUMING_RUNTIME: "pi",
			WUMING_WORKSPACE: workspace,
			WUMING_DATA_DIR: dataDir,
			WUMING_AGENT_DIR: agentDir,
			WUMING_MODEL_CONFIG_KEY: encryptionKey,
			WUMING_MODEL_PROVIDER: provider,
			WUMING_MODEL_ID: modelId,
			WUMING_TERMINAL_MODE: "disabled",
			WUMING_MAX_RETRIES: "1",
			WUMING_RETRY_BASE_DELAY_MS: "50",
			WUMING_TURN_TIMEOUT_MS: "1200",
			WUMING_ABORT_GRACE_MS: "100",
			WUMING_FORCE_TERMINATE_TIMEOUT_MS: "100",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	let output = "";
	let errors = "";
	child.stdout?.on("data", (chunk) => { output += String(chunk); });
	child.stderr?.on("data", (chunk) => { errors += String(chunk); });
	const port = await new Promise<number>((resolvePort, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Gateway startup timed out\n${output}\n${errors}`)), 20_000);
		const inspect = () => {
			const match = output.match(/Wuming gateway listening on http:\/\/127\.0\.0\.1:(\d+)/);
			if (!match) return;
			clearTimeout(timeout);
			resolvePort(Number(match[1]));
		};
		child.stdout?.on("data", inspect);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Gateway exited during startup with code ${code}\n${output}\n${errors}`));
		});
	});
	return { child, port, logs: () => `${output}\n${errors}` };
}

async function stopGateway(child: ChildProcess): Promise<void> {
	if (!children.delete(child) || child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 5_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
		child.kill("SIGTERM");
	});
}

class Client {
	readonly #messages: ServerMessage[] = [];
	readonly #waiters = new Set<() => void>();
	constructor(readonly ws: WebSocket) {
		ws.on("message", (data) => {
			this.#messages.push(JSON.parse(data.toString()) as ServerMessage);
			for (const wake of this.#waiters) wake();
		});
	}

	async waitFor(predicate: (message: ServerMessage) => boolean, label: string): Promise<ServerMessage> {
		const existing = this.#messages.find(predicate);
		if (existing) return existing;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#waiters.delete(check);
				reject(new Error(`Timed out waiting for ${label}`));
			}, requestTimeoutMs);
			const check = () => {
				const message = this.#messages.find(predicate);
				if (!message) return;
				clearTimeout(timeout);
				this.#waiters.delete(check);
				resolve(message);
			};
			this.#waiters.add(check);
		});
	}

	async request(command: Command): Promise<CommandResult> {
		const requestId = randomUUID();
		this.ws.send(JSON.stringify({ type: "request", requestId, idempotencyKey: requestId, command } satisfies ClientMessage));
		const response = await this.waitFor((message) => message.type === "response" && message.requestId === requestId, command.type);
		assert(response.type === "response", "Expected command response");
		if (!response.ok) throw new Error(`${command.type}: ${response.error.code}: ${response.error.message}`);
		return response.result;
	}
}

async function openClient(port: number, clientId: string): Promise<Client> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, ["wuming.v1", bearerProtocol(token)]);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const client = new Client(ws);
	ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId, capabilities: ["session.resume"] } satisfies ClientMessage));
	await client.waitFor((message) => message.type === "hello", "gateway hello");
	return client;
}

async function createSession(client: Client): Promise<string> {
	const result = await client.request({ type: "session.create", workspaceId: "local-workspace", model: { provider, id: modelId }, thinkingLevel: "off", sandboxMode: "workspace_write", approvalPolicy: "on_risk" });
	assert(result.type === "session.created", "Session creation failed");
	return result.snapshot.session.id;
}

async function waitForTerminalRun(client: Client, sessionId: string): Promise<RunSummary> {
	const deadline = Date.now() + requestTimeoutMs;
	while (Date.now() < deadline) {
		const result = await client.request({ type: "session.run.list", sessionId, limit: 1 });
		assert(result.type === "session.run.list", "Run query failed");
		const run = result.runs[0];
		if (run && ["completed", "failed", "interrupted"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for session ${sessionId}`);
}

async function runFault(client: Client, marker: string): Promise<{ sessionId: string; run: RunSummary }> {
	const sessionId = await createSession(client);
	const accepted = await client.request({ type: "turn.prompt", sessionId, content: [{ type: "text", text: `${marker}: reply briefly` }] });
	assert(accepted.type === "turn.accepted", `${marker} turn was not accepted`);
	return { sessionId, run: await waitForTerminalRun(client, sessionId) };
}

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "wuming-pi-fault-gate-"));
	const dataDir = join(root, "data");
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	const mock = new MockOpenAiServer();
	let client: Client | undefined;
	let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
	try {
		await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(agentDir, { recursive: true }), mock.start()]);
		const registry = new CustomModelRegistry({ filePath: join(dataDir, "custom-models.enc"), encryptionKey });
		await registry.set({
			provider,
			id: modelId,
			name: "Pi fault-injection model",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${mock.port}/v1`,
			apiKey: "local-fault-test-key",
			reasoning: false,
			input: ["text"],
			contextWindow: 16_384,
			maxOutputTokens: 1_024,
		});

		gateway = await startGateway(dataDir, workspace, agentDir);
		client = await openClient(gateway.port, "pi-fault-gate-1");

		const rateLimit = await runFault(client, "FAULT_RATE_LIMIT");
		assert(rateLimit.run.status === "completed" && rateLimit.run.attempt === 2, `Rate-limit recovery failed: ${JSON.stringify(rateLimit.run)}`);
		assert(rateLimit.run.traceId, "Rate-limit run did not retain a trace ID");

		const disconnect = await runFault(client, "FAULT_DISCONNECT");
		assert(disconnect.run.status === "completed" && disconnect.run.attempt === 2, `Disconnect recovery failed: ${JSON.stringify(disconnect.run)}`);

		const timeout = await runFault(client, "FAULT_TIMEOUT");
		assert(timeout.run.status === "failed" && timeout.run.failureKind === "provider_timeout", `Timeout classification failed: ${JSON.stringify(timeout.run)}`);

		const restartSessionId = await createSession(client);
		const accepted = await client.request({ type: "turn.prompt", sessionId: restartSessionId, content: [{ type: "text", text: "FAULT_RESTART: reply briefly" }] });
		assert(accepted.type === "turn.accepted", "Restart turn was not accepted");
		await mock.waitForRestartRequest();
		const firstGateway = gateway;
		client.ws.close();
		client = undefined;
		await stopGateway(firstGateway.child);
		gateway = await startGateway(dataDir, workspace, agentDir);
		client = await openClient(gateway.port, "pi-fault-gate-2");
		const attached = await client.request({ type: "session.attach", sessionId: restartSessionId });
		assert(attached.type === "session.attached", "Restarted session could not be attached");
		const restartRun = await waitForTerminalRun(client, restartSessionId);
		assert(restartRun.status === "interrupted" && restartRun.failureKind === "runtime_restart", `Restart reconciliation failed: ${JSON.stringify(restartRun)}`);
		assert(restartRun.traceId, "Restarted run lost its trace ID");
		const reconciled = await client.request({ type: "session.snapshot.get", sessionId: restartSessionId });
		assert(reconciled.type === "session.snapshot", "Restarted snapshot query failed");
		assert(reconciled.snapshot.session.phase === "idle", "Restarted session did not reconcile to idle");
		assert(reconciled.snapshot.transcript.filter((item) => item.type === "user").length === 1, "Restart duplicated the user message");
		assert(reconciled.snapshot.transcript.filter((item) => item.type === "assistant").length === 1, "Restart did not record exactly one interrupted assistant item");
		const continued = await client.request({ type: "turn.prompt", sessionId: restartSessionId, content: [{ type: "text", text: "NORMAL_AFTER_RESTART: reply briefly" }] });
		assert(continued.type === "turn.accepted", "Restarted session did not accept a new turn");
		const continuedRun = await waitForTerminalRun(client, restartSessionId);
		assert(continuedRun.status === "completed", `Restarted session could not continue: ${JSON.stringify(continuedRun)}`);

		process.stdout.write(`${JSON.stringify({
			ok: true,
			scenarios: {
				rateLimit: { status: rateLimit.run.status, attempts: rateLimit.run.attempt, traceId: rateLimit.run.traceId },
				disconnect: { status: disconnect.run.status, attempts: disconnect.run.attempt, traceId: disconnect.run.traceId },
				timeout: { status: timeout.run.status, failureKind: timeout.run.failureKind, traceId: timeout.run.traceId },
				restart: { status: restartRun.status, failureKind: restartRun.failureKind, traceId: restartRun.traceId, continuedStatus: continuedRun.status },
			},
		}, null, 2)}\n`);
	} catch (error) {
		if (gateway) process.stderr.write(gateway.logs());
		throw error;
	} finally {
		client?.ws.close();
		if (gateway) await stopGateway(gateway.child);
		for (const child of children) await stopGateway(child);
		await mock.close();
		await rm(root, { recursive: true, force: true });
	}
}

await main();

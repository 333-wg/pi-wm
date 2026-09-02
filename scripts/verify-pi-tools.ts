import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ClientMessage, ServerMessage, SessionSnapshot, TranscriptItem } from "../packages/protocol/src/index.js";
import WebSocket from "ws";

const token = `pi-tools-${randomUUID()}`;
const requestTimeoutMs = 120_000;

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function bearerProtocol(value: string): string {
	return `wuming.bearer.${Buffer.from(value, "utf8").toString("base64url")}`;
}

function send(ws: WebSocket, message: ClientMessage): void {
	ws.send(JSON.stringify(message));
}

function describe(message: ServerMessage): string {
	if (message.type === "response") return `response:${message.requestId}:${message.ok ? message.result.type : message.error.code}`;
	if (message.type === "event") {
		if (message.event.type === "session.phase.changed") return `phase:${message.event.sessionId}:${message.event.phase}`;
		if (message.event.type === "session.item.upserted") return `item:${message.event.item.type}`;
		return `event:${message.event.type}`;
	}
	return message.type;
}

class Collector {
	readonly messages: ServerMessage[] = [];
	readonly #waiters = new Set<() => void>();

	constructor(readonly ws: WebSocket) {
		ws.on("message", (data) => {
			this.messages.push(JSON.parse(data.toString()) as ServerMessage);
			for (const wake of this.#waiters) wake();
		});
	}

	async waitFor(predicate: (message: ServerMessage) => boolean, label: string): Promise<ServerMessage> {
		const existing = this.messages.find(predicate);
		if (existing) return existing;
		return new Promise((resolveMessage, reject) => {
			const timeout = setTimeout(() => {
				this.#waiters.delete(check);
				reject(new Error(`Timed out waiting for ${label}; recent messages: ${this.messages.slice(-20).map(describe).join(", ")}`));
			}, requestTimeoutMs);
			const check = () => {
				const match = this.messages.find(predicate);
				if (!match) return;
				clearTimeout(timeout);
				this.#waiters.delete(check);
				resolveMessage(match);
			};
			this.#waiters.add(check);
		});
	}
}

async function startGateway(workspace: string, dataDir: string): Promise<{ child: ChildProcess; port: number }> {
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
			WUMING_TERMINAL_MODE: "disabled",
			WUMING_MAX_RETRIES: "0",
			WUMING_TURN_TIMEOUT_MS: String(requestTimeoutMs),
			WUMING_PI_INITIAL_TOOL_CHOICE: "required",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let errors = "";
	child.stdout?.on("data", (chunk) => { output += String(chunk); });
	child.stderr?.on("data", (chunk) => { errors += String(chunk); });
	const port = await new Promise<number>((resolvePort, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Gateway startup timed out\n${output}\n${errors}`)), 30_000);
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
	return { child, port };
}

async function stopGateway(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveStop) => {
		const timeout = setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 5_000);
		child.once("exit", () => { clearTimeout(timeout); resolveStop(); });
		child.kill("SIGTERM");
	});
}

async function openClient(port: number): Promise<{ ws: WebSocket; collector: Collector }> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, ["wuming.v1", bearerProtocol(token)]);
	await new Promise<void>((resolveOpen, reject) => {
		ws.once("open", resolveOpen);
		ws.once("error", reject);
	});
	const collector = new Collector(ws);
	send(ws, { type: "hello", protocolVersion: 1, clientId: `pi-tools-${randomUUID()}`, capabilities: ["tools"] });
	await collector.waitFor((message) => message.type === "hello", "gateway hello");
	return { ws, collector };
}

function toolText(item: Extract<TranscriptItem, { type: "tool" }>): string {
	return item.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

interface ToolCase {
	name: string;
	prompt: string;
	verify?: (item: Extract<TranscriptItem, { type: "tool" }>) => void | Promise<void>;
}

async function runCase(ws: WebSocket, collector: Collector, provider: string, modelId: string, test: ToolCase): Promise<{ name: string; usage: SessionSnapshot["usage"] }> {
	const suffix = randomUUID();
	const createRequestId = `create-${suffix}`;
	send(ws, {
		type: "request",
		requestId: createRequestId,
		idempotencyKey: createRequestId,
		command: {
			type: "session.create",
			workspaceId: "local-workspace",
			name: `Tool acceptance: ${test.name}`,
			model: { provider, id: modelId },
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "never",
			tokenBudget: 20_000,
		},
	});
	const created = await collector.waitFor((message) => message.type === "response" && message.requestId === createRequestId, `${test.name} session creation`);
	assert(created.type === "response" && created.ok && created.result.type === "session.created", `${test.name}: session creation failed`);
	const sessionId = created.result.snapshot.session.id;
	const promptRequestId = `prompt-${suffix}`;
	send(ws, { type: "request", requestId: promptRequestId, idempotencyKey: promptRequestId, command: { type: "turn.prompt", sessionId, content: [{ type: "text", text: test.prompt }] } });
	const accepted = await collector.waitFor((message) => message.type === "response" && message.requestId === promptRequestId, `${test.name} turn acceptance`);
	assert(accepted.type === "response" && accepted.ok, `${test.name}: turn was rejected`);
	await collector.waitFor(
		(message) => message.type === "event" && message.event.type === "session.phase.changed" && message.event.sessionId === sessionId && message.event.phase === "idle",
		`${test.name} completion`,
	);
	const snapshotRequestId = `snapshot-${suffix}`;
	send(ws, { type: "request", requestId: snapshotRequestId, idempotencyKey: snapshotRequestId, command: { type: "session.snapshot.get", sessionId } });
	const response = await collector.waitFor((message) => message.type === "response" && message.requestId === snapshotRequestId, `${test.name} snapshot`);
	assert(response.type === "response" && response.ok && response.result.type === "session.snapshot", `${test.name}: snapshot query failed`);
	const calls = response.result.snapshot.transcript.filter((item): item is Extract<TranscriptItem, { type: "tool" }> => item.type === "tool" && item.toolName === test.name);
	assert(calls.length === 1, `${test.name}: expected exactly one call, received ${calls.length}`);
	const call = calls[0]!;
	assert(call.status === "complete" && !call.isError, `${test.name}: tool ended with status=${call.status}, isError=${call.isError}`);
	await test.verify?.(call);
	console.log(`[PASS] ${test.name}`);
	return { name: test.name, usage: response.result.snapshot.usage };
}

async function main(): Promise<void> {
	process.env.WUMING_AGENT_DIR = resolve(required("WUMING_AGENT_DIR"));
	const provider = required("WUMING_MODEL_PROVIDER");
	const modelId = required("WUMING_MODEL_ID");
	const temporary = await mkdtemp(join(tmpdir(), "wuming-pi-tools-"));
	const workspace = join(temporary, "workspace");
	const dataDir = join(temporary, "data");
	await mkdir(workspace, { recursive: true });
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(workspace, "read-proof.txt"), "READ_FILE_OK\n", "utf8");
	await writeFile(join(workspace, "edit-proof.txt"), "EDIT_BEFORE\n", "utf8");

	const cases: ToolCase[] = [
		{ name: "read_file", prompt: "Call read_file exactly once with path read-proof.txt. Do not call another tool.", verify: (item) => assert(toolText(item).includes("READ_FILE_OK"), "read_file: proof content missing") },
		{ name: "write_file", prompt: "Call write_file exactly once to write WRITE_FILE_OK followed by a newline to write-proof.txt. Do not call another tool.", verify: async () => assert(await readFile(join(workspace, "write-proof.txt"), "utf8") === "WRITE_FILE_OK\n", "write_file: file content mismatch") },
		{ name: "edit", prompt: "Call edit exactly once on edit-proof.txt, replacing EDIT_BEFORE with EDIT_AFTER. Do not call another tool.", verify: async () => assert(await readFile(join(workspace, "edit-proof.txt"), "utf8") === "EDIT_AFTER\n", "edit: file content mismatch") },
		{ name: "web_search", prompt: "Call web_search exactly once with query OpenAI official website and count 3. Do not call another tool.", verify: (item) => assert(!toolText(item).includes("No search results found"), "web_search: no results returned") },
		{ name: "web_fetch", prompt: "Call web_fetch exactly once with URL https://example.com and max_chars 4000. Do not call another tool.", verify: (item) => assert(toolText(item).includes("Example Domain"), "web_fetch: expected page content missing") },
		{ name: "weather", prompt: "Call weather exactly once for Shanghai with days 1. Do not call another tool.", verify: (item) => assert(toolText(item).includes("Shanghai"), "weather: expected location missing") },
	];
	if (process.env.WUMING_DOCKER_IMAGE?.trim()) {
		cases.push(
			{ name: "exec", prompt: "Call exec exactly once with command printf EXEC_TOOL_OK and timeout 30. Do not call another tool.", verify: (item) => assert(toolText(item).includes("EXEC_TOOL_OK"), "exec: proof output missing") },
			{ name: "run_python", prompt: "Call run_python exactly once with code print('PYTHON_TOOL_OK') and timeout 30. Do not call another tool.", verify: (item) => assert(toolText(item).includes("PYTHON_TOOL_OK"), "run_python: proof output missing") },
		);
	}
	const selectedNames = process.env.WUMING_PI_TOOL_CASES?.split(",").map((name) => name.trim()).filter(Boolean);
	const selected = selectedNames?.length ? cases.filter((test) => selectedNames.includes(test.name)) : cases;
	if (selectedNames?.length) {
		const unknown = selectedNames.filter((name) => !cases.some((test) => test.name === name));
		if (unknown.length) throw new Error(`Unknown or unavailable WUMING_PI_TOOL_CASES: ${unknown.join(", ")}`);
	}
	assert(selected.length > 0, "No tool cases selected");

	let child: ChildProcess | undefined;
	let ws: WebSocket | undefined;
	try {
		const gateway = await startGateway(workspace, dataDir);
		child = gateway.child;
		const client = await openClient(gateway.port);
		ws = client.ws;
		const results = [];
		for (const test of selected) results.push(await runCase(ws, client.collector, provider, modelId, test));
		console.log(JSON.stringify({ ok: true, provider, modelId, tools: results, skipped: process.env.WUMING_DOCKER_IMAGE?.trim() ? [] : ["exec", "run_python"] }, null, 2));
	} finally {
		ws?.close();
		if (child) await stopGateway(child);
		await rm(temporary, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ClientMessage, ServerMessage, SessionSnapshot } from "../packages/protocol/src/index.js";
import WebSocket from "ws";

const token = `pi-approval-gate-${randomUUID()}`;
const proofName = "approval-restart-proof.txt";
const proofContent = "PI_APPROVAL_RESTART_OK\n";
const requestTimeoutMs = 90_000;
const children = new Set<ChildProcess>();

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

async function startGateway(dataDir: string, workspace: string): Promise<{ child: ChildProcess; port: number }> {
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
	return { child, port };
}

async function stopGateway(child: ChildProcess): Promise<void> {
	if (!children.delete(child) || child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveStop) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolveStop();
		}, 5_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStop();
		});
		child.kill("SIGTERM");
	});
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
				const recent = this.messages.slice(-20).map(describe).join(", ");
				reject(new Error(`Timed out waiting for ${label}; received ${this.messages.length} message(s); recent: ${recent}`));
			}, requestTimeoutMs);
			const check = () => {
				const message = this.messages.find(predicate);
				if (!message) return;
				clearTimeout(timeout);
				this.#waiters.delete(check);
				resolveMessage(message);
			};
			this.#waiters.add(check);
		});
	}
}

async function openClient(port: number, clientId: string): Promise<{ ws: WebSocket; collector: Collector }> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, ["wuming.v1", bearerProtocol(token)]);
	await new Promise<void>((resolveOpen, reject) => {
		ws.once("open", resolveOpen);
		ws.once("error", reject);
	});
	const collector = new Collector(ws);
	send(ws, { type: "hello", protocolVersion: 1, clientId, capabilities: ["session.resume", "approval"] });
	await collector.waitFor((message) => message.type === "hello", "gateway hello");
	return { ws, collector };
}

function send(ws: WebSocket, message: ClientMessage): void {
	ws.send(JSON.stringify(message));
}

function describe(message: ServerMessage): string {
	if (message.type === "response") return `response:${message.requestId}:${message.ok ? message.result.type : message.error.code}`;
	if (message.type === "event") {
		if (message.event.type === "session.phase.changed") return `event:phase:${message.event.phase}`;
		if (message.event.type === "session.item.upserted") {
			const item = message.event.item;
			return `event:item:${item.type}:${"status" in item ? item.status : "stored"}${item.type === "tool" ? `:${item.toolName}` : ""}`;
		}
		return `event:${message.event.type}`;
	}
	if (message.type === "progress") {
		return message.event.type === "assistant.delta"
			? `progress:assistant.delta:${message.event.kind}`
			: `progress:${message.event.type}`;
	}
	return message.type;
}

async function main(): Promise<void> {
	const agentDir = resolve(required("WUMING_AGENT_DIR"));
	const provider = required("WUMING_MODEL_PROVIDER");
	const modelId = required("WUMING_MODEL_ID");
	const temporary = await mkdtemp(join(tmpdir(), "wuming-pi-approval-gate-"));
	const workspace = join(temporary, "workspace");
	const dataDir = join(temporary, "data");
	const proofPath = join(workspace, proofName);
	process.env.WUMING_AGENT_DIR = agentDir;
	process.env.WUMING_MODEL_PROVIDER = provider;
	process.env.WUMING_MODEL_ID = modelId;
	let firstClient: WebSocket | undefined;
	let secondClient: WebSocket | undefined;

	try {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(workspace, { recursive: true });
		await mkdir(dataDir, { recursive: true });

		const first = await startGateway(dataDir, workspace);
		const connected = await openClient(first.port, "pi-approval-gate-before-restart");
		firstClient = connected.ws;
		send(firstClient, {
			type: "request",
			requestId: "create",
			idempotencyKey: "create",
			command: {
				type: "session.create",
				workspaceId: "local-workspace",
				model: { provider, id: modelId },
				thinkingLevel: "off",
				sandboxMode: "workspace_write",
				approvalPolicy: "on_risk",
				tokenBudget: 10_000,
				budgetWarningThreshold: 0.8,
			},
		});
		const created = await connected.collector.waitFor(
			(message) => message.type === "response" && message.requestId === "create",
			"session creation",
		);
		assert(created.type === "response" && created.ok && created.result.type === "session.created", "Session creation failed");
		const sessionId = created.result.snapshot.session.id;

		send(firstClient, {
			type: "request",
			requestId: "write-proof",
			idempotencyKey: "write-proof",
			command: {
				type: "turn.prompt",
				sessionId,
				content: [{
					type: "text",
					text: `This is an automated recovery gate. Call the write_file tool exactly once to create ${proofName} with the exact content ${JSON.stringify(proofContent)}. Do not call read_file or edit, and do not answer until write_file succeeds.`,
				}],
			},
		});
		const accepted = await connected.collector.waitFor(
			(message) => message.type === "response" && message.requestId === "write-proof",
			"turn acceptance",
		);
		assert(accepted.type === "response" && accepted.ok, "Turn was not accepted");
		const requested = await connected.collector.waitFor(
			(message) => message.type === "event" && message.event.type === "approval.requested" && message.event.sessionId === sessionId,
			"real Pi write_file approval",
		);
		assert(requested.type === "event" && requested.event.type === "approval.requested", "Approval request missing");
		const approval = requested.event.approval;
		assert(approval.status === "pending", "Approval was not pending before restart");
		assert(approval.capabilities.some((capability) => capability.type === "filesystem.write" && capability.paths.includes(proofName)), "Approval did not cover the expected write");
		await access(proofPath).then(
			() => { throw new Error("Proof file was written before approval"); },
			() => undefined,
		);

		firstClient.close();
		await stopGateway(first.child);

		const second = await startGateway(dataDir, workspace);
		const reconnected = await openClient(second.port, "pi-approval-gate-after-restart");
		secondClient = reconnected.ws;
		send(secondClient, {
			type: "request",
			requestId: "attach",
			idempotencyKey: "attach",
			command: { type: "session.attach", sessionId },
		});
		const attached = await reconnected.collector.waitFor(
			(message) => message.type === "response" && message.requestId === "attach",
			"session attach after restart",
		);
		assert(attached.type === "response" && attached.ok && attached.result.type === "session.attached", "Session attach failed after restart");
		assert(attached.result.snapshot.session.phase === "awaiting_approval", "Session did not recover in awaiting_approval");
		assert(attached.result.snapshot.pendingApprovals.length === 1, "Recovered session did not contain exactly one pending approval");
		assert(attached.result.snapshot.pendingApprovals[0]?.id === approval.id, "Recovered approval ID changed");

		send(secondClient, {
			type: "request",
			requestId: "approve",
			idempotencyKey: "approve",
			command: { type: "approval.respond", sessionId, approvalId: approval.id, decision: "approve" },
		});
		const approved = await reconnected.collector.waitFor(
			(message) => message.type === "response" && message.requestId === "approve",
			"approval response",
		);
		assert(approved.type === "response" && approved.ok, "Recovered approval was rejected");
		await reconnected.collector.waitFor(
			(message) => message.type === "event" && message.event.type === "session.phase.changed" && message.event.sessionId === sessionId && message.event.phase === "idle",
			"completed turn after approval",
		);

		send(secondClient, {
			type: "request",
			requestId: "snapshot",
			idempotencyKey: "snapshot",
			command: { type: "session.snapshot.get", sessionId },
		});
		const snapshot = await reconnected.collector.waitFor(
			(message) => message.type === "response" && message.requestId === "snapshot",
			"final snapshot",
		);
		assert(snapshot.type === "response" && snapshot.ok && snapshot.result.type === "session.snapshot", "Final snapshot query failed");
		assert(snapshot.result.snapshot.pendingApprovals.length === 0, "Approval remained pending after completion");
		const matchingTools = snapshot.result.snapshot.transcript.filter(
			(item): item is Extract<SessionSnapshot["transcript"][number], { type: "tool" }> =>
				item.type === "tool" && item.toolCallId === approval.toolCallId,
		);
		assert(matchingTools.length === 1 && matchingTools[0]?.status === "complete", "Recovered tool call did not complete exactly once");
		assert(snapshot.result.snapshot.transcript.some((item) => item.type === "assistant" && item.status === "complete"), "Provider returned no final assistant message");

		send(secondClient, {
			type: "request",
			requestId: "runs",
			idempotencyKey: "runs",
			command: { type: "session.run.list", sessionId },
		});
		const runs = await reconnected.collector.waitFor(
			(message) => message.type === "response" && message.requestId === "runs",
			"run history",
		);
		assert(runs.type === "response" && runs.ok && runs.result.type === "session.run.list", "Run history query failed");
		assert(runs.result.runs.length === 1, "Expected exactly one durable run");
		assert(runs.result.runs[0]?.status === "completed" && runs.result.runs[0]?.attempt === 2, "Recovered run did not complete on attempt 2");
		assert((runs.result.runs[0]?.usage?.totalTokens ?? 0) > 0, "Recovered run did not record provider usage");

		const content = await readFile(proofPath, "utf8");
		assert(content === proofContent, "Proof file content did not match the requested value");
		console.log(JSON.stringify({
			ok: true,
			provider,
			modelId,
			approvalRecovered: true,
			approvalIdPreserved: true,
			toolExecutions: matchingTools.length,
			runAttempt: runs.result.runs[0]?.attempt,
			usage: runs.result.runs[0]?.usage,
			proof: { path: proofName, content },
		}, null, 2));

		secondClient.close();
		await stopGateway(second.child);
	} finally {
		firstClient?.close();
		secondClient?.close();
		for (const child of [...children]) await stopGateway(child);
		await rm(temporary, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

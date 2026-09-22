import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage } from "@wuming/protocol";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";

const children = new Set<ChildProcess>();
const directories: string[] = [];

afterEach(async () => {
	for (const child of children) await stopGateway(child);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function bearerProtocol(token: string): string {
	return `wuming.bearer.${Buffer.from(token, "utf8").toString("base64url")}`;
}

async function startGateway(
	dataDir: string,
	workspace: string,
	environment: Record<string, string> = {}
): Promise<{ child: ChildProcess; port: number }> {
	const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			WUMING_HOST: "127.0.0.1",
			WUMING_PORT: "0",
			WUMING_TOKEN: "process-test-token",
			WUMING_RUNTIME: "demo",
			WUMING_WORKSPACE: workspace,
			WUMING_DATA_DIR: dataDir,
			WUMING_TERMINAL_MODE: "disabled",
			...environment,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	let output = "";
	let errors = "";
	child.stdout?.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		errors += String(chunk);
	});
	const port = await new Promise<number>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Gateway startup timed out\n${output}\n${errors}`)), 10_000);
		const inspect = () => {
			const match = output.match(/Wuming gateway listening on http:\/\/127\.0\.0\.1:(\d+)/);
			if (!match) return;
			clearTimeout(timeout);
			resolve(Number(match[1]));
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
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 3000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
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

	async waitFor(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		const existing = this.messages.find(predicate);
		if (existing) return existing;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#waiters.delete(check);
				reject(new Error(`Timed out waiting for message; received ${JSON.stringify(this.messages)}`));
			}, 5000);
			const check = () => {
				const message = this.messages.find(predicate);
				if (!message) return;
				clearTimeout(timeout);
				this.#waiters.delete(check);
				resolve(message);
			};
			this.#waiters.add(check);
		});
	}
}

async function openClient(port: number): Promise<{ ws: WebSocket; collector: Collector }> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, ["wuming.v1", bearerProtocol("process-test-token")]);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	return { ws, collector: new Collector(ws) };
}

function send(ws: WebSocket, message: ClientMessage): void {
	ws.send(JSON.stringify(message));
}

it("reconciles a running turn after the gateway process is terminated and restarted", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-process-recovery-"));
	directories.push(root);
	const dataDir = join(root, "data");
	const workspace = join(root, "workspace");
	await mkdir(workspace);

	const first = await startGateway(dataDir, workspace);
	const firstClient = await openClient(first.port);
	send(firstClient.ws, {
		type: "hello",
		protocolVersion: 1,
		clientId: "process-client-1",
		capabilities: ["session.resume"],
	});
	await firstClient.collector.waitFor((message) => message.type === "hello");
	send(firstClient.ws, {
		type: "request",
		requestId: "create",
		idempotencyKey: "create",
		command: {
			type: "session.create",
			workspaceId: "local-workspace",
			model: { provider: "demo", id: "wuming-demo" },
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		},
	});
	const created = await firstClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "create"
	);
	if (created.type !== "response" || !created.ok || created.result.type !== "session.created")
		throw new Error("Session creation failed");
	const sessionId = created.result.snapshot.session.id;
	send(firstClient.ws, {
		type: "request",
		requestId: "long-turn",
		idempotencyKey: "long-turn",
		command: { type: "turn.prompt", sessionId, content: [{ type: "text", text: "/long" }] },
	});
	await firstClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "long-turn"
	);
	await firstClient.collector.waitFor(
		(message) => message.type === "progress" && message.event.sessionId === sessionId
	);
	await stopGateway(first.child);

	const second = await startGateway(dataDir, workspace);
	const secondClient = await openClient(second.port);
	send(secondClient.ws, {
		type: "hello",
		protocolVersion: 1,
		clientId: "process-client-2",
		capabilities: ["session.resume"],
	});
	await secondClient.collector.waitFor((message) => message.type === "hello");
	send(secondClient.ws, {
		type: "request",
		requestId: "attach",
		idempotencyKey: "attach",
		command: { type: "session.attach", sessionId },
	});
	const attached = await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "attach"
	);
	if (attached.type !== "response" || !attached.ok || attached.result.type !== "session.attached")
		throw new Error("Session attach failed");
	expect(attached.result.snapshot.session.phase).toBe("idle");
	expect(attached.result.snapshot.transcript.at(-1)).toMatchObject({
		type: "assistant",
		status: "aborted",
	});

	send(secondClient.ws, {
		type: "request",
		requestId: "runs",
		idempotencyKey: "runs",
		command: { type: "session.run.list", sessionId },
	});
	const runs = await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "runs"
	);
	if (runs.type !== "response" || !runs.ok || runs.result.type !== "session.run.list")
		throw new Error("Run query failed");
	expect(runs.result.runs[0]).toMatchObject({
		status: "interrupted",
		attempt: 1,
		abortRequested: false,
		failureKind: "runtime_restart",
	});
	expect(runs.result.runs[0]?.startedAt).toBeTypeOf("number");
	expect(runs.result.runs[0]?.finishedAt).toBeTypeOf("number");
	expect(runs.result.runs[0]?.error).toMatch(/gateway restart/);

	secondClient.ws.close();
	await stopGateway(second.child);
}, 20_000);

it("publishes an interrupted subagent result to its parent after restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-subagent-recovery-"));
	directories.push(root);
	const dataDir = join(root, "data");
	const workspace = join(root, "workspace");
	await mkdir(workspace);

	const first = await startGateway(dataDir, workspace);
	const firstClient = await openClient(first.port);
	send(firstClient.ws, {
		type: "hello",
		protocolVersion: 1,
		clientId: "subagent-recovery-1",
		capabilities: ["session.resume", "subagents"],
	});
	await firstClient.collector.waitFor((message) => message.type === "hello");
	send(firstClient.ws, {
		type: "request",
		requestId: "create-subagent-parent",
		idempotencyKey: "create-subagent-parent",
		command: {
			type: "session.create",
			workspaceId: "local-workspace",
			model: { provider: "demo", id: "wuming-demo" },
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		},
	});
	const created = await firstClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "create-subagent-parent"
	);
	if (created.type !== "response" || !created.ok || created.result.type !== "session.created")
		throw new Error("Parent session creation failed");
	const parentSessionId = created.result.snapshot.session.id;
	send(firstClient.ws, {
		type: "request",
		requestId: "create-long-subagent",
		idempotencyKey: "create-long-subagent",
		command: {
			type: "subagent.create",
			sessionId: parentSessionId,
			task: "/long",
			name: "Interrupted child",
		},
	});
	const childCreated = await firstClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "create-long-subagent"
	);
	if (childCreated.type !== "response" || !childCreated.ok || childCreated.result.type !== "subagent.created")
		throw new Error("Subagent creation failed");
	const childSessionId = childCreated.result.subagent.sessionId;

	let running = false;
	for (let attempt = 0; attempt < 20 && !running; attempt += 1) {
		const requestId = `list-running-subagent-${attempt}`;
		send(firstClient.ws, {
			type: "request",
			requestId,
			idempotencyKey: requestId,
			command: { type: "subagent.list", sessionId: parentSessionId },
		});
		const listed = await firstClient.collector.waitFor(
			(message) => message.type === "response" && message.ok && message.requestId === requestId
		);
		if (listed.type === "response" && listed.ok && listed.result.type === "subagent.list") {
			running = listed.result.subagents[0]?.status === "running";
		}
		if (!running) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	expect(running).toBe(true);
	await stopGateway(first.child);

	const second = await startGateway(dataDir, workspace);
	const secondClient = await openClient(second.port);
	send(secondClient.ws, {
		type: "hello",
		protocolVersion: 1,
		clientId: "subagent-recovery-2",
		capabilities: ["session.resume", "subagents"],
	});
	await secondClient.collector.waitFor((message) => message.type === "hello");
	send(secondClient.ws, {
		type: "request",
		requestId: "list-recovered-subagent",
		idempotencyKey: "list-recovered-subagent",
		command: { type: "subagent.list", sessionId: parentSessionId },
	});
	const listed = await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "list-recovered-subagent"
	);
	if (listed.type !== "response" || !listed.ok || listed.result.type !== "subagent.list")
		throw new Error("Recovered subagent list failed");
	expect(listed.result.subagents).toEqual([
		expect.objectContaining({
			id: childSessionId,
			status: "cancelled",
			error: "Turn interrupted by gateway restart",
		}),
	]);

	send(secondClient.ws, {
		type: "request",
		requestId: "attach-subagent-parent",
		idempotencyKey: "attach-subagent-parent",
		command: { type: "session.attach", sessionId: parentSessionId },
	});
	const attached = await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "attach-subagent-parent"
	);
	if (attached.type !== "response" || !attached.ok || attached.result.type !== "session.attached")
		throw new Error("Parent attach failed");
	expect(attached.result.snapshot.transcript.filter((item) => item.id === `subagent:${childSessionId}`)).toEqual([
		expect.objectContaining({
			type: "tool",
			toolCallId: childSessionId,
			toolName: "subagent",
			status: "aborted",
			isError: true,
		}),
	]);

	secondClient.ws.close();
	await stopGateway(second.child);
}, 20_000);

it("preserves provider retry backoff and accounting across a gateway restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-retry-recovery-"));
	directories.push(root);
	const dataDir = join(root, "data");
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const retryEnvironment = { WUMING_MAX_RETRIES: "1", WUMING_RETRY_BASE_DELAY_MS: "3000" };

	const first = await startGateway(dataDir, workspace, retryEnvironment);
	const firstClient = await openClient(first.port);
	send(firstClient.ws, {
		type: "hello",
		protocolVersion: 1,
		clientId: "retry-client-1",
		capabilities: ["session.resume"],
	});
	await firstClient.collector.waitFor((message) => message.type === "hello");
	send(firstClient.ws, {
		type: "request",
		requestId: "create-retry",
		idempotencyKey: "create-retry",
		command: {
			type: "session.create",
			workspaceId: "local-workspace",
			model: { provider: "demo", id: "wuming-demo" },
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		},
	});
	const created = await firstClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "create-retry"
	);
	if (created.type !== "response" || !created.ok || created.result.type !== "session.created")
		throw new Error("Session creation failed");
	const sessionId = created.result.snapshot.session.id;
	send(firstClient.ws, {
		type: "request",
		requestId: "retry-turn",
		idempotencyKey: "retry-turn",
		command: { type: "turn.prompt", sessionId, content: [{ type: "text", text: "/retry-once" }] },
	});
	await firstClient.collector.waitFor(
		(message) =>
			message.type === "event" &&
			message.event.type === "session.phase.changed" &&
			message.event.sessionId === sessionId &&
			message.event.phase === "retry"
	);
	await stopGateway(first.child);

	const second = await startGateway(dataDir, workspace, retryEnvironment);
	const secondClient = await openClient(second.port);
	send(secondClient.ws, {
		type: "hello",
		protocolVersion: 1,
		clientId: "retry-client-2",
		capabilities: ["session.resume"],
	});
	await secondClient.collector.waitFor((message) => message.type === "hello");
	send(secondClient.ws, {
		type: "request",
		requestId: "attach-retry",
		idempotencyKey: "attach-retry",
		command: { type: "session.attach", sessionId },
	});
	const attached = await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "attach-retry"
	);
	if (attached.type !== "response" || !attached.ok || attached.result.type !== "session.attached")
		throw new Error("Session attach failed");
	expect(attached.result.snapshot.session.phase).toBe("retry");
	await secondClient.collector.waitFor(
		(message) =>
			message.type === "event" &&
			message.event.type === "session.phase.changed" &&
			message.event.sessionId === sessionId &&
			message.event.phase === "idle"
	);

	send(secondClient.ws, {
		type: "request",
		requestId: "retry-runs",
		idempotencyKey: "retry-runs",
		command: { type: "session.run.list", sessionId },
	});
	const runs = await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "retry-runs"
	);
	if (runs.type !== "response" || !runs.ok || runs.result.type !== "session.run.list")
		throw new Error("Run query failed");
	expect(runs.result.runs[0]).toMatchObject({
		status: "completed",
		attempt: 2,
		usage: { totalTokens: 17, costUsd: 0.02 },
		traceId: expect.any(String),
	});
	expect(runs.result.runs[0]?.retryHistory).toEqual([
		expect.objectContaining({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 3000,
			error: "Upstream HTTP/2 stream failed",
		}),
	]);

	send(secondClient.ws, {
		type: "request",
		requestId: "retry-snapshot",
		idempotencyKey: "retry-snapshot",
		command: { type: "session.snapshot.get", sessionId },
	});
	const snapshot = await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "retry-snapshot"
	);
	if (snapshot.type !== "response" || !snapshot.ok || snapshot.result.type !== "session.snapshot")
		throw new Error("Snapshot query failed");
	expect(snapshot.result.snapshot.usage).toMatchObject({ totalTokens: 17, costUsd: 0.02 });
	expect(snapshot.result.snapshot.transcript.filter((item) => item.type === "assistant")).toHaveLength(1);

	secondClient.ws.close();
	await stopGateway(second.child);
}, 20_000);

it("keeps a preflight approval pending across restart and resumes it exactly once after approval", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-approval-recovery-"));
	directories.push(root);
	const dataDir = join(root, "data");
	const workspace = join(root, "workspace");
	await mkdir(workspace);

	const first = await startGateway(dataDir, workspace);
	const firstClient = await openClient(first.port);
	send(firstClient.ws, {
		type: "hello",
		protocolVersion: 1,
		clientId: "approval-recovery-1",
		capabilities: ["session.resume", "approval"],
	});
	await firstClient.collector.waitFor((message) => message.type === "hello");
	send(firstClient.ws, {
		type: "request",
		requestId: "create-approval-recovery",
		idempotencyKey: "create-approval-recovery",
		command: {
			type: "session.create",
			workspaceId: "local-workspace",
			model: { provider: "demo", id: "wuming-demo" },
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		},
	});
	const created = await firstClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "create-approval-recovery"
	);
	if (created.type !== "response" || !created.ok || created.result.type !== "session.created")
		throw new Error("Session creation failed");
	const sessionId = created.result.snapshot.session.id;
	send(firstClient.ws, {
		type: "request",
		requestId: "approval-turn",
		idempotencyKey: "approval-turn",
		command: { type: "turn.prompt", sessionId, content: [{ type: "text", text: "/approval" }] },
	});
	await firstClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "approval-turn"
	);
	const requested = await firstClient.collector.waitFor(
		(message) =>
			message.type === "event" && message.event.type === "approval.requested" && message.event.sessionId === sessionId
	);
	if (requested.type !== "event" || requested.event.type !== "approval.requested")
		throw new Error("Approval request missing");
	const approvalId = requested.event.approval.id;
	await stopGateway(first.child);

	const second = await startGateway(dataDir, workspace);
	const secondClient = await openClient(second.port);
	send(secondClient.ws, {
		type: "hello",
		protocolVersion: 1,
		clientId: "approval-recovery-2",
		capabilities: ["session.resume", "approval"],
	});
	await secondClient.collector.waitFor((message) => message.type === "hello");
	send(secondClient.ws, {
		type: "request",
		requestId: "attach-approval-recovery",
		idempotencyKey: "attach-approval-recovery",
		command: { type: "session.attach", sessionId },
	});
	const attached = await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "attach-approval-recovery"
	);
	if (attached.type !== "response" || !attached.ok || attached.result.type !== "session.attached")
		throw new Error("Session attach failed");
	expect(attached.result.snapshot.session.phase).toBe("awaiting_approval");
	expect(attached.result.snapshot.pendingApprovals).toHaveLength(1);
	expect(attached.result.snapshot.pendingApprovals[0]?.id).toBe(approvalId);

	send(secondClient.ws, {
		type: "request",
		requestId: "approve-after-restart",
		idempotencyKey: "approve-after-restart",
		command: { type: "approval.respond", sessionId, approvalId, decision: "approve" },
	});
	await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "approve-after-restart"
	);
	await secondClient.collector.waitFor(
		(message) =>
			message.type === "event" &&
			message.event.type === "session.phase.changed" &&
			message.event.sessionId === sessionId &&
			message.event.phase === "idle"
	);

	send(secondClient.ws, {
		type: "request",
		requestId: "approval-recovery-snapshot",
		idempotencyKey: "approval-recovery-snapshot",
		command: { type: "session.snapshot.get", sessionId },
	});
	const snapshot = await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "approval-recovery-snapshot"
	);
	if (snapshot.type !== "response" || !snapshot.ok || snapshot.result.type !== "session.snapshot")
		throw new Error("Snapshot query failed");
	expect(snapshot.result.snapshot.pendingApprovals).toEqual([]);
	expect(snapshot.result.snapshot.transcript.filter((item) => item.type === "assistant")).toEqual([
		expect.objectContaining({
			status: "complete",
			content: [
				{
					type: "text",
					text: "Demo approval was granted. No filesystem or process action was executed.",
				},
			],
		}),
	]);

	send(secondClient.ws, {
		type: "request",
		requestId: "approval-recovery-runs",
		idempotencyKey: "approval-recovery-runs",
		command: { type: "session.run.list", sessionId },
	});
	const runs = await secondClient.collector.waitFor(
		(message) => message.type === "response" && message.ok && message.requestId === "approval-recovery-runs"
	);
	if (runs.type !== "response" || !runs.ok || runs.result.type !== "session.run.list")
		throw new Error("Run query failed");
	expect(runs.result.runs[0]).toMatchObject({ status: "completed", attempt: 2 });

	secondClient.ws.close();
	await stopGateway(second.child);
}, 20_000);

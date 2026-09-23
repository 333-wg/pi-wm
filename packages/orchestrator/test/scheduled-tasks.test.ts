import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { ScheduledTaskInput, SessionSnapshot } from "@wuming/protocol";
import type { AgentRuntime } from "../src/types.js";
import WebSocket from "ws";
import type { Command, ServerMessage, WorkspaceSummary } from "@wuming/protocol";

const stores: SqliteOrchestratorStore[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const input: ScheduledTaskInput = {
	title: "Daily review",
	objective: "Review changes",
	schedule: { kind: "calendar", frequency: "daily", timeZone: "UTC", hour: 9, minute: 0 },
	execution: {
		description: "Review yesterday's commits",
		workspaceId: "project-a",
		model: { provider: "test", id: "scheduled" },
		permission: "full_access",
		missedRuns: "skip",
	},
};

function fixture(path = ":memory:") {
	let now = Date.parse("2026-09-23T08:00:00Z"),
		sequence = 0;
	const store = new SqliteOrchestratorStore(path);
	stores.push(store);
	const executed: SessionSnapshot[] = [];
	const runtime: AgentRuntime = {
		async executeTurn({ snapshot }) {
			executed.push(snapshot);
			return {
				items: [
					{
						id: "answer-" + ++sequence,
						type: "assistant",
						createdAt: now,
						status: "complete",
						content: [{ type: "text", text: "Complete" }],
						model: snapshot.model,
					},
				],
			};
		},
		async compact() {
			return { summary: "Summary" };
		},
	};
	const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => now });
	return {
		store,
		orchestrator,
		runtime,
		executed,
		now: () => now,
		setNow: (value: string) => {
			now = Date.parse(value);
		},
		create: () => orchestrator.createScheduledTask({ ...input, principalId: "owner", idempotencyKey: "create" }),
	};
}

describe("standalone scheduled tasks", () => {
	it("does not block later ticks while another task is still running", async () => {
		const f = fixture();
		let release!: () => void, entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const original = f.runtime.executeTurn;
		let calls = 0;
		f.runtime.executeTurn = async (request) => {
			if (++calls === 1) {
				entered();
				await waiting;
			}
			return original(request);
		};
		await f.create();
		await f.orchestrator.createScheduledTask({
			...input,
			title: "Second",
			schedule: { ...input.schedule, kind: "calendar", frequency: "daily", timeZone: "UTC", hour: 9, minute: 1 },
			principalId: "owner",
			idempotencyKey: "second",
		});
		try {
			f.setNow("2026-09-23T09:00:00Z");
			expect(await f.orchestrator.runDueAutomations(undefined, 20, false)).toBe(1);
			await started;
			expect(f.orchestrator.hasAutomationDispatches).toBe(true);
			f.setNow("2026-09-23T09:01:00Z");
			expect(await f.orchestrator.runDueAutomations()).toBe(1);
			expect(calls).toBe(2);
		} finally {
			release();
			await f.orchestrator.settleAutomationDispatches();
		}
		expect(f.orchestrator.hasAutomationDispatches).toBe(false);
	});
	it("blocks concurrent manual runs and skips overlapping scheduled occurrences", async () => {
		const f = fixture();
		const { automation } = await f.create();
		const command = {
			principalId: "owner",
			sessionId: automation.parentSessionId,
			automationId: automation.id,
			idempotencyKey: "manual",
		};
		const run = await f.orchestrator.triggerAutomation(command);
		await expect(f.orchestrator.triggerAutomation({ ...command, idempotencyKey: "duplicate" })).rejects.toMatchObject({
			code: "conflict",
		});
		f.setNow("2026-09-23T09:00:00Z");
		expect(await f.orchestrator.runDueAutomations()).toBe(0);
		expect(f.store.listAutomationRuns(automation.id)).toHaveLength(1);
		expect(f.store.loadAutomation(automation.id)?.nextRunAt).toBe(Date.parse("2026-09-24T09:00:00Z"));
		await f.orchestrator.dispatchAutomationRun(run.run.id);
		await expect(
			f.orchestrator.triggerAutomation({ ...command, idempotencyKey: "after-completion" })
		).resolves.toMatchObject({ type: "automation.triggered" });
	});

	it("checks workspace and role access and hides execution anchors from chat lists", async () => {
		const { GatewayServer, StaticTokenMapAuth, bearerProtocol } = await import("@wuming/gateway");
		const f = fixture();
		const workspace: WorkspaceSummary = {
			id: "project-a",
			name: "Project A",
			status: "ready",
			createdAt: 1,
			updatedAt: 1,
		};
		const server = new GatewayServer({
			store: f.store,
			orchestrator: f.orchestrator,
			models: [
				{
					model: input.execution.model,
					name: "Scheduled model",
					reasoning: false,
					input: ["text"],
					contextWindow: 10000,
					maxOutputTokens: 1000,
					authenticated: true,
				},
			],
			auth: new StaticTokenMapAuth([
				{ token: "owner", principal: { id: "owner", role: "owner", workspaces: [workspace] } },
				{ token: "viewer", principal: { id: "viewer", role: "viewer", workspaces: [workspace] } },
				{ token: "outside", principal: { id: "outside", role: "owner", workspaces: [] } },
			]),
		});
		const sockets: WebSocket[] = [];
		try {
			const address = await server.listen();
			const request = async (
				token: string,
				command: Command
			): Promise<Extract<ServerMessage, { type: "response" }>> => {
				const socket = new WebSocket("ws://127.0.0.1:" + address.port + "/api/ws", [
					"wuming.v1",
					bearerProtocol(token),
				]);
				sockets.push(socket);
				return new Promise((resolve, reject) => {
					const requestId = crypto.randomUUID();
					const timer = setTimeout(() => reject(new Error("Gateway response timed out")), 3000);
					socket.on("error", (error) => {
						clearTimeout(timer);
						reject(error);
					});
					socket.on("open", () =>
						socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: requestId, capabilities: [] }))
					);
					socket.on("message", (raw) => {
						const message = JSON.parse(raw.toString()) as ServerMessage;
						if (message.type === "hello")
							socket.send(JSON.stringify({ type: "request", requestId, idempotencyKey: requestId, command }));
						if (message.type === "response" && message.requestId === requestId) {
							clearTimeout(timer);
							resolve(message);
						}
					});
				});
			};
			for (const token of ["viewer", "outside"])
				expect(await request(token, { type: "scheduled.create", input })).toMatchObject({
					ok: false,
					error: { code: "forbidden" },
				});
			const created = await request("owner", { type: "scheduled.create", input });
			expect(created).toMatchObject({ ok: true, result: { type: "automation.created" } });
			if (!created.ok || created.result.type !== "automation.created") throw new Error("No task");
			const task = created.result.automation;
			expect(await request("outside", { type: "scheduled.list" })).toMatchObject({
				ok: true,
				result: { tasks: [], total: 0 },
			});
			expect(await request("owner", { type: "session.list", workspaceId: workspace.id })).toMatchObject({
				ok: true,
				result: { sessions: [] },
			});
			for (const type of ["scheduled.trigger", "scheduled.run.list"] as const)
				expect(await request("outside", { type, automationId: task.id })).toMatchObject({
					ok: false,
					error: { code: "forbidden" },
				});
			expect(await request("viewer", { type: "scheduled.trigger", automationId: task.id })).toMatchObject({
				ok: false,
				error: { code: "forbidden" },
			});
			expect(
				await request("owner", { type: "session.archive", sessionId: task.parentSessionId, archived: true })
			).toMatchObject({ ok: false, error: { code: "conflict" } });
			expect(
				await request("owner", {
					type: "scheduled.update",
					automationId: task.id,
					expectedUpdatedAt: task.updatedAt,
					input: { ...input, execution: { ...input.execution, workspaceId: "forbidden-project" } },
				})
			).toMatchObject({ ok: false, error: { code: "forbidden" } });
			expect(
				await request("owner", { type: "scheduled.delete", automationId: task.id, expectedUpdatedAt: task.updatedAt })
			).toMatchObject({ ok: true });
			expect(await request("owner", { type: "session.list", workspaceId: workspace.id })).toMatchObject({
				ok: true,
				result: { sessions: [] },
			});
		} finally {
			for (const socket of sockets) socket.terminate();
			await server.close();
		}
	});
	it("owns its configuration, replays creation, and filters projects before pagination", async () => {
		const f = fixture();
		const first = await f.create();
		expect(await f.create()).toEqual(first);
		expect(first.automation.execution).toEqual(input.execution);
		expect(f.orchestrator.listScheduledTasks(["project-a"]).total).toBe(1);
		expect(f.orchestrator.listScheduledTasks(["project-b"])).toEqual({ tasks: [], total: 0 });
		expect(f.orchestrator.listScheduledTasks(["project-a"], 1).tasks).toEqual([]);
		await expect(
			f.orchestrator.createScheduledTask({ ...input, title: "Changed", principalId: "owner", idempotencyKey: "create" })
		).rejects.toMatchObject({ code: "idempotency_conflict" });
	});

	it("skips missed days but runs within the due minute exactly once", async () => {
		const f = fixture();
		const { automation } = await f.create();
		f.setNow("2026-09-26T08:59:59Z");
		expect(await f.orchestrator.runDueAutomations()).toBe(0);
		expect(f.store.loadAutomation(automation.id)?.nextRunAt).toBe(Date.parse("2026-09-26T09:00:00Z"));
		f.setNow("2026-09-26T09:00:35Z");
		expect(await f.orchestrator.runDueAutomations()).toBe(1);
		expect(await f.orchestrator.runDueAutomations()).toBe(0);
		expect(f.executed).toHaveLength(1);
		expect(f.executed[0]).toMatchObject({
			model: input.execution.model,
			sandboxMode: "unrestricted",
			approvalPolicy: "never",
			session: { workspaceId: "project-a" },
		});
		expect(f.orchestrator.listAutomationRuns(automation.parentSessionId, automation.id)).toEqual([
			expect.objectContaining({ status: "completed", scheduledFor: Date.parse("2026-09-26T09:00:00Z") }),
		]);
	});

	it.each([
		{ kind: "interval", everyMinutes: 60, startsAt: Date.parse("2026-09-23T09:00:00Z") },
		{ kind: "once", runAt: Date.parse("2026-09-23T09:00:00Z") },
	] as const)("does not catch up missed %j runs", async (schedule) => {
		const f = fixture();
		const { automation } = await f.orchestrator.createScheduledTask({
			...input,
			schedule,
			principalId: "owner",
			idempotencyKey: "create",
		});
		f.setNow("2026-09-26T09:01:00Z");
		expect(await f.orchestrator.runDueAutomations()).toBe(0);
		expect(f.store.listAutomationRuns(automation.id)).toHaveLength(0);
		expect(f.store.loadAutomation(automation.id)?.nextRunAt).toBe(
			schedule.kind === "once" ? undefined : Date.parse("2026-09-26T10:00:00Z")
		);
	});

	it("snapshots configuration at claim so editing cannot change an already queued run", async () => {
		const f = fixture();
		const { automation } = await f.create();
		const run = await f.orchestrator.triggerAutomation({
			principalId: "owner",
			sessionId: automation.parentSessionId,
			automationId: automation.id,
			idempotencyKey: "run",
		});
		const current = f.store.loadAutomation(automation.id)!;
		await f.orchestrator.updateAutomation({
			...input,
			execution: { ...input.execution, workspaceId: "project-b", model: { provider: "test", id: "edited" } },
			principalId: "owner",
			sessionId: automation.parentSessionId,
			automationId: automation.id,
			expectedUpdatedAt: current.updatedAt,
			idempotencyKey: "edit",
		});
		await f.orchestrator.dispatchAutomationRun(run.run.id);
		expect(f.executed[0]).toMatchObject({ model: input.execution.model, session: { workspaceId: "project-a" } });
		const next = await f.orchestrator.triggerAutomation({
			principalId: "owner",
			sessionId: automation.parentSessionId,
			automationId: automation.id,
			idempotencyKey: "run-next",
		});
		await f.orchestrator.dispatchAutomationRun(next.run.id);
		expect(f.executed[1]).toMatchObject({
			model: { provider: "test", id: "edited" },
			session: { workspaceId: "project-b" },
			approvalPolicy: "never",
		});
	});

	it("persists tasks across restart without replaying missed triggers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-scheduled-test-"));
		directories.push(directory);
		const path = join(directory, "store.sqlite");
		const f = fixture(path);
		const { automation } = await f.create();
		const reopened = new SqliteOrchestratorStore(path);
		stores.push(reopened);
		const restarted = new SessionOrchestrator(reopened, f.runtime, { clock: () => Date.parse("2026-09-29T12:00:00Z") });
		expect(await restarted.runDueAutomations()).toBe(0);
		expect(restarted.listScheduledTasks(["project-a"]).tasks[0]).toMatchObject({
			id: automation.id,
			execution: input.execution,
			nextRunAt: Date.parse("2026-09-30T09:00:00Z"),
		});
	});
});

import { afterEach, describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import {
	AutomationScheduleSchema,
	CommandSchema,
	CommandResultSchema,
	nextCalendarRun,
	type Command,
	type ServerMessage,
	type WorkspaceSummary,
	type AutomationSchedule,
	type CalendarSchedule,
	type GoalPlanSpec,
} from "@wuming/protocol";
import { SessionOrchestrator, SqliteOrchestratorStore, OrchestratorError } from "@wuming/orchestrator";
import type { AgentRuntime } from "../src/types.js";
import WebSocket from "ws";

const stores: SqliteOrchestratorStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
const daily: CalendarSchedule = {
	kind: "calendar",
	frequency: "daily",
	timeZone: "Asia/Shanghai",
	hour: 9,
	minute: 30,
};
const plan: GoalPlanSpec = { steps: [{ id: "check", title: "Check", objective: "Check locally", dependsOn: [] }] };

async function fixture() {
	let now = Date.parse("2026-01-01T00:00:00Z");
	let id = 0;
	const store = new SqliteOrchestratorStore(":memory:");
	stores.push(store);
	const runtime: AgentRuntime = {
		async executeTurn(input) {
			return {
				items: [
					{
						id: `answer-${++id}`,
						type: "assistant",
						createdAt: now,
						status: "complete",
						content: [{ type: "text", text: "Local result" }],
						model: input.snapshot.model,
					},
				],
			};
		},
		async compact() {
			return { summary: "Local summary" };
		},
	};
	const orchestrator = new SessionOrchestrator(store, runtime, { clock: () => now, idFactory: () => `id-${++id}` });
	const createSession = async () =>
		(
			await orchestrator.createSession({
				principalId: "user",
				idempotencyKey: `session-${++id}`,
				workspaceId: "workspace",
				model: { provider: "test", id: "local" },
				thinkingLevel: "off",
				sandboxMode: "workspace_write",
				approvalPolicy: "never",
			})
		).snapshot.session.id;
	const sessionId = await createSession();
	const base = { principalId: "user", sessionId };
	const create = async (
		schedule: AutomationSchedule = daily,
		config: { successCriteria?: string; maxRounds?: number; plan?: GoalPlanSpec } = {}
	) =>
		(
			await orchestrator.createAutomation({
				...base,
				idempotencyKey: `create-${++id}`,
				title: "Original",
				objective: "Original objective",
				schedule,
				...config,
			})
		).automation;
	return {
		store,
		orchestrator,
		base,
		create,
		createSession,
		setNow: (value: number) => {
			now = value;
		},
	};
}

describe("calendar automation contracts and scheduling", () => {
	it("exposes strict schemas for calendar/update/delete and the deleted result", () => {
		const check = Compile(AutomationScheduleSchema);
		expect(check.Check(daily)).toBe(true);
		for (const bad of [
			{ ...daily, extra: true },
			{ ...daily, hour: 24 },
			{ ...daily, minute: -1 },
			{ ...daily, frequency: "yearly" },
			{ ...daily, weekdays: [1, 1] },
		])
			expect(check.Check(bad)).toBe(false);
		const commands = Compile(CommandSchema);
		const update = {
			type: "automation.update",
			sessionId: "s",
			automationId: "a",
			expectedUpdatedAt: 1,
			objective: "New",
			schedule: daily,
		};
		const deletion = { type: "automation.delete", sessionId: "s", automationId: "a", expectedUpdatedAt: 1 };
		expect(commands.Check(update)).toBe(true);
		expect(commands.Check(deletion)).toBe(true);
		const { expectedUpdatedAt: _version, ...withoutVersion } = update;
		expect(commands.Check(withoutVersion)).toBe(false);
		expect(commands.Check({ ...deletion, expectedUpdatedAt: -1 })).toBe(false);
		expect(commands.Check({ ...update, enabled: false })).toBe(false);
		expect(Compile(CommandResultSchema).Check({ type: "automation.deleted", automationId: "a" })).toBe(true);
	});

	it.each([
		[daily, "2026-01-01T01:30:00Z", "2026-04-02T01:30:00Z"],
		[{ ...daily, frequency: "weekly", weekdays: [1, 5] }, "2026-01-02T01:30:00Z", "2026-04-03T01:30:00Z"],
		[{ ...daily, frequency: "monthly", dayOfMonth: 31 }, "2026-01-31T01:30:00Z", "2026-05-31T01:30:00Z"],
	] as [CalendarSchedule, string, string][])(
		"claims %j and coalesces missed occurrences once",
		async (schedule, first, next) => {
			const f = await fixture();
			const automation = await f.create(schedule);
			expect(automation.nextRunAt).toBe(Date.parse(first));
			expect(await f.orchestrator.runDueAutomations(Date.parse(first) - 1)).toBe(0);
			f.setNow(Date.parse("2026-04-01T12:00:00Z"));
			expect(await f.orchestrator.runDueAutomations()).toBe(1);
			expect(await f.orchestrator.runDueAutomations()).toBe(0);
			expect(f.store.loadAutomation(automation.id)?.nextRunAt).toBe(Date.parse(next));
			expect(f.orchestrator.listAutomationRuns(f.base.sessionId, automation.id)).toEqual([
				expect.objectContaining({ scheduledFor: Date.parse(first), status: "completed" }),
			]);
		}
	);

	it.each([
		{ ...daily, timeZone: "Not/A_Zone" },
		{ ...daily, timeZone: "+08:00" },
		{ ...daily, frequency: "weekly" },
		{ ...daily, frequency: "weekly", weekdays: [7] },
		{ ...daily, frequency: "weekly", weekdays: [1, 1] },
		{ ...daily, frequency: "monthly" },
		{ ...daily, frequency: "monthly", dayOfMonth: 32 },
		{ ...daily, weekdays: [1] },
		{ ...daily, dayOfMonth: 2 },
		{ ...daily, frequency: "weekly", weekdays: [1], dayOfMonth: 2 },
	])("rejects invalid calendar %j without persisting", async (schedule) => {
		const f = await fixture();
		await expect(f.create(schedule as CalendarSchedule)).rejects.toBeInstanceOf(OrchestratorError);
		expect(f.orchestrator.listAutomations(f.base.sessionId)).toEqual([]);
		const automation = await f.create();
		await expect(
			f.orchestrator.updateAutomation({
				...f.base,
				idempotencyKey: "invalid-update",
				automationId: automation.id,
				expectedUpdatedAt: automation.updatedAt,
				objective: "Invalid",
				schedule: schedule as CalendarSchedule,
			})
		).rejects.toMatchObject({ code: "conflict" });
		expect(f.store.loadAutomation(automation.id)?.schedule).toEqual(daily);
	});

	it("validates calendar cross-fields in store commits and rolls back", async () => {
		const f = await fixture();
		const automation = await f.create();
		const stored = f.store.loadAutomation(automation.id)!;
		expect(() =>
			f.store.commitAutomationMutation({
				automation: { ...stored, updatedAt: stored.updatedAt + 1, schedule: { ...daily, frequency: "monthly" } },
				expectedUpdatedAt: stored.updatedAt,
				idempotency: {
					principalId: "user",
					key: "bad-store",
					commandHash: "hash",
					expiresAt: stored.updatedAt + 100,
					result: { type: "automation.configured", automation },
				},
			})
		).toThrow(OrchestratorError);
		expect(f.store.loadAutomation(automation.id)).toEqual(stored);
	});

	it("retains once and interval semantics and does not revive completed once on text edits", async () => {
		const f = await fixture();
		const once = await f.create({ kind: "once", runAt: 1000 });
		const interval = await f.create({ kind: "interval", startsAt: 1000, everyMinutes: 10 });
		f.setNow(2_000_000);
		expect(await f.orchestrator.runDueAutomations()).toBe(2);
		expect(f.store.loadAutomation(interval.id)?.nextRunAt).toBe(2_401_000);
		const completed = f.store.loadAutomation(once.id)!;
		const edited = await f.orchestrator.updateAutomation({
			...f.base,
			automationId: once.id,
			expectedUpdatedAt: completed.updatedAt,
			idempotencyKey: "text-only",
			objective: "Edited",
			schedule: once.schedule,
		});
		expect(edited.automation.status).toBe("completed");
		expect(edited.automation.nextRunAt).toBeUndefined();
		expect(await f.orchestrator.runDueAutomations()).toBe(0);
		await expect(
			f.orchestrator.setAutomationEnabled({
				...f.base,
				automationId: once.id,
				idempotencyKey: "reenable",
				enabled: true,
			})
		).rejects.toMatchObject({ code: "conflict" });
	});
});

describe("automation configuration replacement", () => {
	it("preserves claimed specs, replaces review/plan, preserves pause and next time, and deduplicates", async () => {
		const f = await fixture();
		const automation = await f.create(daily, { successCriteria: "Original criteria", maxRounds: 2 });
		const run = await f.orchestrator.triggerAutomation({
			...f.base,
			automationId: automation.id,
			idempotencyKey: "trigger",
		});
		const oldSpec = f.store.loadAutomationRun(run.run.id)!.spec;
		const paused = await f.orchestrator.setAutomationEnabled({
			...f.base,
			automationId: automation.id,
			idempotencyKey: "pause",
			enabled: false,
		});
		const update = {
			...f.base,
			automationId: automation.id,
			idempotencyKey: "replace",
			expectedUpdatedAt: paused.automation.updatedAt,
			objective: "Replacement",
			schedule: daily,
			plan,
		};
		const updated = await f.orchestrator.updateAutomation(update);
		expect(await f.orchestrator.updateAutomation(update)).toEqual(updated);
		expect(updated.automation).toMatchObject({
			title: "Replacement",
			status: "paused",
			nextRunAt: automation.nextRunAt,
			plan,
		});
		expect(updated.automation.successCriteria).toBeUndefined();
		expect(updated.automation.maxRounds).toBeUndefined();
		expect(f.store.loadAutomationRun(run.run.id)!.spec).toEqual(oldSpec);
		const newRun = await f.orchestrator.triggerAutomation({
			...f.base,
			automationId: automation.id,
			idempotencyKey: "new-run",
		});
		expect(f.store.loadAutomationRun(newRun.run.id)?.spec).toMatchObject({ objective: "Replacement", plan });
		const { plan: _plan, ...withoutPlan } = update;
		const cleared = await f.orchestrator.updateAutomation({
			...withoutPlan,
			idempotencyKey: "clear-plan",
			expectedUpdatedAt: f.store.loadAutomation(automation.id)!.updatedAt,
		});
		expect(cleared.automation.plan).toBeUndefined();
		expect(f.store.loadAutomationRun(newRun.run.id)?.spec.plan).toMatchObject(plan);
		await expect(f.orchestrator.updateAutomation({ ...update, objective: "Different" })).rejects.toMatchObject({
			code: "idempotency_conflict",
		});
		await expect(f.orchestrator.updateAutomation({ ...update, idempotencyKey: "stale" })).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it("recalculates only changed schedules and keeps enabled state", async () => {
		const f = await fixture();
		const automation = await f.create();
		const now = Date.parse("2026-04-01T12:00:00Z");
		f.setNow(now);
		const textOnly = await f.orchestrator.updateAutomation({
			...f.base,
			automationId: automation.id,
			idempotencyKey: "same",
			expectedUpdatedAt: automation.updatedAt,
			objective: "New text",
			schedule: { ...daily },
		});
		expect(textOnly.automation.nextRunAt).toBe(automation.nextRunAt);
		const schedule = { ...daily, hour: 10 };
		const changed = await f.orchestrator.updateAutomation({
			...f.base,
			automationId: automation.id,
			idempotencyKey: "changed",
			expectedUpdatedAt: textOnly.automation.updatedAt,
			objective: "New text",
			schedule,
		});
		expect(changed.automation.nextRunAt).toBe(nextCalendarRun(schedule, now));
		expect(changed.automation.status).toBe("active");
	});

	it("rejects cross-session and archived edits/deletions and stale deletes", async () => {
		const f = await fixture();
		const automation = await f.create();
		const command = {
			...f.base,
			automationId: automation.id,
			expectedUpdatedAt: automation.updatedAt,
			idempotencyKey: "command",
		};
		const other = await f.createSession();
		await expect(
			f.orchestrator.updateAutomation({ ...command, sessionId: other, objective: "Other", schedule: daily })
		).rejects.toMatchObject({ code: "not_found" });
		await expect(f.orchestrator.deleteAutomation({ ...command, sessionId: other })).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(
			f.orchestrator.deleteAutomation({ ...command, expectedUpdatedAt: automation.updatedAt - 1 })
		).rejects.toMatchObject({ code: "conflict" });
		await f.orchestrator.archiveSession({ ...f.base, idempotencyKey: "archive", archived: true });
		await expect(
			f.orchestrator.updateAutomation({ ...command, objective: "Archived", schedule: daily })
		).rejects.toMatchObject({ code: "conflict" });
		await expect(f.orchestrator.deleteAutomation(command)).rejects.toMatchObject({ code: "conflict" });
		expect(f.store.loadAutomation(automation.id)?.updatedAt).toBe(automation.updatedAt);
	});

	it("allows only one concurrent editor for the same version", async () => {
		const f = await fixture();
		const automation = await f.create();
		const results = await Promise.allSettled(
			["one", "two"].map((idempotencyKey) =>
				f.orchestrator.updateAutomation({
					...f.base,
					automationId: automation.id,
					expectedUpdatedAt: automation.updatedAt,
					objective: idempotencyKey,
					schedule: daily,
					idempotencyKey,
				})
			)
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
	});
});

describe("Gateway automation command authorization", () => {
	it("routes update/delete and denies viewers and principals outside the workspace", async () => {
		// Use the compiled gateway boundary so this package's test root stays local.
		const { GatewayServer, StaticTokenMapAuth, bearerProtocol } = await import("@wuming/gateway");
		const f = await fixture();
		const workspace: WorkspaceSummary = { id: "workspace", name: "Local", status: "ready", createdAt: 1, updatedAt: 1 };
		const server = new GatewayServer({
			store: f.store,
			orchestrator: f.orchestrator,
			auth: new StaticTokenMapAuth([
				{ token: "owner-test", principal: { id: "owner", role: "owner", workspaces: [workspace] } },
				{ token: "viewer-test", principal: { id: "viewer", role: "viewer", workspaces: [workspace] } },
				{ token: "outside-test", principal: { id: "outside", role: "owner", workspaces: [] } },
			]),
		});
		const clients: WebSocket[] = [];
		try {
			const address = await server.listen();
			let requestId = 0;
			const request = async (
				token: string,
				command: Command
			): Promise<Extract<ServerMessage, { type: "response" }>> => {
				const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, ["wuming.v1", bearerProtocol(token)]);
				clients.push(ws);
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("Local gateway response timed out")), 3000);
					const id = `request-${++requestId}`;
					ws.on("error", (error) => {
						clearTimeout(timer);
						reject(error);
					});
					ws.on("open", () =>
						ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: id, capabilities: [] }))
					);
					ws.on("message", (data) => {
						const message = JSON.parse(data.toString()) as ServerMessage;
						if (message.type === "hello")
							ws.send(JSON.stringify({ type: "request", requestId: id, idempotencyKey: id, command }));
						if (message.type === "response" && message.requestId === id) {
							clearTimeout(timer);
							resolve(message);
						}
					});
				});
			};
			const automation = await f.create();
			const update: Command = {
				type: "automation.update",
				sessionId: f.base.sessionId,
				automationId: automation.id,
				expectedUpdatedAt: automation.updatedAt,
				objective: "Gateway replacement",
				schedule: daily,
			};
			const deletion: Command = {
				type: "automation.delete",
				sessionId: f.base.sessionId,
				automationId: automation.id,
				expectedUpdatedAt: automation.updatedAt,
			};
			for (const token of ["viewer-test", "outside-test"]) {
				for (const command of [update, deletion])
					expect(await request(token, command)).toMatchObject({ ok: false, error: { code: "forbidden" } });
			}
			expect(await request("owner-test", update)).toMatchObject({
				ok: true,
				result: { type: "automation.configured", automation: { objective: "Gateway replacement" } },
			});
			expect(
				await request("owner-test", {
					...deletion,
					expectedUpdatedAt: f.store.loadAutomation(automation.id)!.updatedAt,
				})
			).toMatchObject({ ok: true, result: { type: "automation.deleted", automationId: automation.id } });
		} finally {
			for (const ws of clients) ws.terminate();
			await server.close();
		}
	});
});

describe("transactional automation deletion", () => {
	it("blocks dispatching and queued/paused runs, then retains completed Goal/session history and replays deletion", async () => {
		const f = await fixture();
		const automation = await f.create();
		const triggered = await f.orchestrator.triggerAutomation({
			...f.base,
			automationId: automation.id,
			idempotencyKey: "trigger",
		});
		const command = {
			...f.base,
			automationId: automation.id,
			expectedUpdatedAt: f.store.loadAutomation(automation.id)!.updatedAt,
			idempotencyKey: "delete",
		};
		await expect(f.orchestrator.deleteAutomation(command)).rejects.toMatchObject({ code: "conflict" });
		expect(f.store.loadAutomationRun(triggered.run.id)).toBeDefined();
		const goal = {
			id: "attached-goal",
			parentSessionId: f.base.sessionId,
			title: "History",
			objective: "History objective",
			createdAt: command.expectedUpdatedAt,
			updatedAt: command.expectedUpdatedAt,
		};
		f.store.attachAutomationRunGoal(triggered.run.id, goal, command.expectedUpdatedAt);
		await expect(f.orchestrator.deleteAutomation(command)).rejects.toMatchObject({ code: "conflict" });
		const started = await f.orchestrator.startGoal({ ...f.base, goalId: goal.id, idempotencyKey: "start" });
		await expect(f.orchestrator.deleteAutomation(command)).rejects.toMatchObject({ code: "conflict" });
		await f.orchestrator.pauseGoal({ ...f.base, goalId: goal.id, idempotencyKey: "pause-goal" });
		await expect(f.orchestrator.deleteAutomation(command)).rejects.toMatchObject({ code: "conflict" });
		await f.orchestrator.resumeGoal({ ...f.base, goalId: goal.id, idempotencyKey: "resume-goal" });
		await f.orchestrator.dispatchAutomationRun(triggered.run.id);
		expect(f.orchestrator.listAutomationRuns(f.base.sessionId, automation.id)[0]?.status).toBe("completed");
		const deleted = await f.orchestrator.deleteAutomation(command);
		expect(deleted).toEqual({ type: "automation.deleted", automationId: automation.id });
		expect(await f.orchestrator.deleteAutomation(command)).toEqual(deleted);
		await expect(f.orchestrator.deleteAutomation({ ...command, expectedUpdatedAt: 0 })).rejects.toMatchObject({
			code: "idempotency_conflict",
		});
		expect(f.store.loadAutomation(automation.id)).toBeUndefined();
		expect(f.store.loadAutomationRun(triggered.run.id)).toBeUndefined();
		expect(f.store.loadGoal(goal.id)).toBeDefined();
		expect(f.store.loadSnapshot(started.goal.runSessionId!)).toBeDefined();
		expect(f.store.loadSnapshot(f.base.sessionId)).toBeDefined();
	});

	it("checks unfinished runs beyond the 50-record list limit and accepts terminal dispatch failures", async () => {
		const f = await fixture();
		const automation = await f.create();
		let oldest = "";
		for (let index = 0; index < 52; index++) {
			const triggered = await f.orchestrator.triggerAutomation({
				...f.base,
				automationId: automation.id,
				idempotencyKey: `trigger-${index}`,
			});
			f.setNow(automation.updatedAt + index + 1);
			if (index === 0) oldest = triggered.run.id;
			else f.store.setAutomationRunDispatchError(triggered.run.id, "Local failure", automation.updatedAt + index);
		}
		const command = {
			...f.base,
			automationId: automation.id,
			expectedUpdatedAt: f.store.loadAutomation(automation.id)!.updatedAt,
			idempotencyKey: "delete",
		};
		expect(f.store.listAutomationRuns(automation.id).some((run) => run.id === oldest)).toBe(false);
		await expect(f.orchestrator.deleteAutomation(command)).rejects.toMatchObject({ code: "conflict" });
		f.store.setAutomationRunDispatchError(oldest, "Local failure", command.expectedUpdatedAt);
		expect(await f.orchestrator.deleteAutomation(command)).toMatchObject({ type: "automation.deleted" });
		expect(f.store.listAutomationRuns(automation.id)).toEqual([]);
	});

	it("does not mistake cancelled Goals with queued workers for finished runs", async () => {
		const f = await fixture();
		const automation = await f.create();
		const run = await f.orchestrator.triggerAutomation({
			...f.base,
			automationId: automation.id,
			idempotencyKey: "trigger",
		});
		const now = f.store.loadAutomation(automation.id)!.updatedAt;
		f.store.attachAutomationRunGoal(
			run.run.id,
			{
				id: "cancelled-goal",
				parentSessionId: f.base.sessionId,
				title: "Cancel",
				objective: "Cancel",
				createdAt: now,
				updatedAt: now,
			},
			now
		);
		await f.orchestrator.startGoal({ ...f.base, goalId: "cancelled-goal", idempotencyKey: "start" });
		const goal = f.store.loadGoal("cancelled-goal")!;
		f.store.commitGoalMutation({
			goal: { ...goal, cancelledAt: now, updatedAt: goal.updatedAt + 1 },
			expectedUpdatedAt: goal.updatedAt,
			idempotency: {
				principalId: "user",
				key: "fixture-cancel",
				commandHash: "fixture-cancel",
				expiresAt: now + 60_000,
				result: { type: "goal.deleted", goalId: goal.id },
			},
		});
		expect(f.orchestrator.listAutomationRuns(f.base.sessionId, automation.id)[0]?.status).toBe("cancelled");
		await expect(
			f.orchestrator.deleteAutomation({
				...f.base,
				automationId: automation.id,
				expectedUpdatedAt: now,
				idempotencyKey: "delete",
			})
		).rejects.toMatchObject({ code: "conflict" });
	});

	it("projects plan runs inside the deletion transaction", async () => {
		const f = await fixture();
		const automation = await f.create(daily, { plan });
		const run = await f.orchestrator.triggerAutomation({
			...f.base,
			automationId: automation.id,
			idempotencyKey: "trigger-plan",
		});
		await f.orchestrator.dispatchAutomationRun(run.run.id);
		expect(f.orchestrator.listAutomationRuns(f.base.sessionId, automation.id)[0]?.status).toBe("completed");
		await expect(
			f.orchestrator.deleteAutomation({
				...f.base,
				automationId: automation.id,
				expectedUpdatedAt: f.store.loadAutomation(automation.id)!.updatedAt,
				idempotencyKey: "delete-plan",
			})
		).resolves.toMatchObject({ type: "automation.deleted" });
	});
});

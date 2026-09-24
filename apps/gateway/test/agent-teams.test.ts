import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore, type AgentRuntime } from "@wuming/orchestrator";
import type { AgentTeamMember, AgentTemplateConfig, ModelMetadata, Command, ServerMessage } from "@wuming/protocol";
import { AgentTeamStore } from "../src/agent-team-store.js";
import { AgentTeamService } from "../src/agent-teams.js";
import { createAgentTeamTools } from "../src/agent-team-tools.js";
import { withTeamLaunch } from "../src/team-launch-runtime.js";
import { ManagedSkillCatalog } from "../src/managed-skill-catalog.js";
import { GatewayServer } from "../src/server.js";
import { bearerProtocol, StaticTokenMapAuth } from "../src/auth.js";
import { createDefaultPiSessionFactory, type PiSessionLike } from "@wuming/pi-adapter";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(script?: (sessionId: string, content: string, signal: AbortSignal) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "wuming-agent-team-"));
	const sessions = new SqliteOrchestratorStore(join(directory, "sessions.db"));
	const store = new AgentTeamStore(join(directory, "teams.db"));
	const calls: Array<{ sessionId: string; content: string; runtimeContent: string }> = [];
	const runtime: AgentRuntime = {
		async executeTurn(input) {
			const content = input.operation.payload.content
				.filter((value) => value.type === "text")
				.map((value) => value.text)
				.join("\n");
			const runtimeContent = (input.operation.payload.runtimeContent ?? input.operation.payload.content)
				.filter((value) => value.type === "text")
				.map((value) => value.text)
				.join("\n");
			calls.push({ sessionId: input.operation.sessionId, content, runtimeContent });
			await script?.(input.operation.sessionId, content, input.signal);
			return {
				items: [
					{
						id: randomUUID(),
						type: "assistant",
						createdAt: Date.now(),
						status: "complete",
						content: [{ type: "text", text: "turn complete" }],
						model: input.snapshot.model,
					},
				],
				usage: {
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 2,
					costUsd: 0.01,
				},
			};
		},
	};
	let service: AgentTeamService;
	const runner = new SessionOrchestrator(
		sessions,
		withTeamLaunch(
			runtime,
			() => service,
			async () => {}
		),
		{
			maxRetries: 0,
			abortGraceMs: 20,
			forceTerminateTimeoutMs: 20,
		}
	);
	const errors: unknown[] = [];
	service = new AgentTeamService(store, runner, (error) => errors.push(error));
	const created = await runner.createSession({
		principalId: "test",
		idempotencyKey: randomUUID(),
		workspaceId: "workspace",
		model: { provider: "test", id: "scripted" },
		thinkingLevel: "off",
		sandboxMode: "read_only",
		approvalPolicy: "on_risk",
	});
	const source = created.snapshot.session.id;
	const lead = (await service.start(source, "Build and verify a small feature", "Test team", false)).sessionId;
	cleanups.push(async () => {
		service.pause();
		await service.settled();
		store.close();
		sessions.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return { service, store, sessions, runner, calls, lead, source, errors, directory };
}
async function rounds(service: AgentTeamService, count = 1) {
	for (let i = 0; i < count; i++) {
		service.tick();
		await service.settled();
	}
}
const taskInput = (owner?: string) => ({
	title: "Implement",
	description: "Implement and verify the assigned change",
	...(owner ? { owner } : {}),
});

describe("persistent Agent Teams", () => {
	it("gives an empty launch one durable staffing reminder, then exposes a retryable lead error without polling", async () => {
		const f = await fixture();
		const team = await f.service.start(f.source, "Build a library manager", "Startup");
		await rounds(f.service, 2);
		expect(f.calls.filter((call) => call.sessionId === team.sessionId)).toHaveLength(2);
		expect(f.service.get(team.id)?.startup).toEqual({ reminders: 1 });
		f.service.pause();
		const recovered = new AgentTeamService(f.store, f.runner);
		cleanups.push(async () => {
			recovered.pause();
			await recovered.settled();
		});
		await recovered.recover();
		await rounds(recovered, 8);
		expect(f.calls.filter((call) => call.sessionId === team.sessionId)).toHaveLength(2);
		expect(recovered.get(team.id)?.members[0]).toMatchObject({
			state: "error",
			error: expect.stringContaining("startup incomplete"),
		});
		expect(recovered.get(team.id)?.messages.filter((message) => message.from === "scheduler")).toHaveLength(1);
		recovered.retry(team.sessionId, "lead", "retry-startup");
		await rounds(recovered, 5);
		expect(f.calls.filter((call) => call.sessionId === team.sessionId)).toHaveLength(4);
		expect(recovered.get(team.id)?.members[0]?.state).toBe("error");
	});

	it.each(["members-only", "unowned", "blocked"])("does not confuse %s with executable team work", async (scenario) => {
		const f = await fixture();
		const team = await f.service.start(f.source, "Start real delegated work");
		const member = await f.service.addMember(team.sessionId, "worker", "Implement feature", "worker");
		if (scenario === "unowned") f.service.createTask(team.sessionId, taskInput(), "unowned");
		if (scenario === "blocked") {
			const dependency = f.service.createTask(team.sessionId, taskInput(), "dependency");
			f.service.createTask(team.sessionId, { ...taskInput(member.id), dependsOn: [dependency.id] }, "blocked");
		}
		await rounds(f.service, 8);
		expect(f.service.get(team.id)?.members[0]?.state).toBe("error");
		expect(f.calls.filter((call) => call.sessionId === member.sessionId)).toHaveLength(0);
		expect(f.calls.filter((call) => call.sessionId === team.sessionId)).toHaveLength(2);
	});

	it("lets the lead repair startup with an existing member and actually starts its first task", async () => {
		let f: Awaited<ReturnType<typeof fixture>>;
		f = await fixture(async (sessionId, content) => {
			if (!content.includes("only automatic startup reminder")) return;
			const team = f.service.get(sessionId)!;
			const member = team.members.find((candidate) => !candidate.lead)!;
			f.service.createTask(sessionId, taskInput(member.id), "first-task");
		});
		const team = await f.service.start(f.source, "Build library search");
		const member = await f.service.addMember(team.sessionId, "search", "Implement catalog search", "search");
		await rounds(f.service, 8);
		expect(f.service.get(team.id)?.startup).toBeUndefined();
		expect(f.service.get(team.id)?.members).toHaveLength(2);
		expect(f.service.get(team.id)?.members[0]?.state).toBe("idle");
		expect(f.service.get(team.id)?.tasks[0]).toMatchObject({ owner: member.id, status: "in_progress" });
		expect(f.calls.filter((call) => call.sessionId === member.sessionId)).toHaveLength(1);
		expect(f.calls.filter((call) => call.sessionId === team.sessionId)).toHaveLength(2);
	});

	it("does not add startup retries after provider failure or stop", async () => {
		const f = await fixture(async () => {
			throw new Error("provider unavailable");
		});
		const team = await f.service.start(f.source, "Build library search");
		await rounds(f.service, 8);
		expect(f.calls).toHaveLength(1);
		expect(f.service.get(team.id)?.startup?.reminders).toBe(0);
		expect(f.service.get(team.id)?.members[0]?.state).toBe("error");
		await f.service.stop(team.id);
		await rounds(f.service, 3);
		expect(f.calls).toHaveLength(1);
		expect(f.service.get(team.id)?.status).toBe("stopped");
	});

	it("rejects lead-only acceptance even if the lead completed its own task", async () => {
		const f = await fixture();
		const task = f.service.createTask(f.lead, taskInput("lead"), "solo");
		f.service.updateTask(f.lead, { taskId: task.id, status: "in_progress" }, "claim");
		f.service.updateTask(f.lead, { taskId: task.id, status: "completed", result: "Lead finished alone" }, "done");
		expect(() => f.service.finish(f.lead, "Done", "finish")).toThrow(/actual delegated work/);
	});

	it("provides staffing policy even without a loaded skill and preserves explicit-assignment constraints", async () => {
		const f = await fixture();
		const context = f.service.context(f.lead);
		for (const rule of [
			"candidates, not a mandatory roster",
			"without templateName",
			"Do not ask the user to configure",
			"Explicit user assignments override",
			"only these members",
			"never silently substitute",
			"Add further members",
			"at least one teammate task executable now",
			"Continuous delegation policy",
			"do not use teammates only for preliminary research",
			"Proactively call Agent",
			"additional capacity or expertise, even after startup",
			"edit files directly",
			"assign repairs back to the owner",
			"For research-only objectives",
		])
			expect(context).toContain(rule);
		const team = await f.service.start(
			f.source,
			"Only use reviewer for API review; do not add other members",
			"Review"
		);
		expect(f.service.context(team.sessionId)).toContain(team.objective);
		await expect(
			f.service.addMember(team.sessionId, "missing", "Review", "missing", { templateName: "missing" })
		).rejects.toThrow(/Unknown Agent template/);
		expect(f.service.get(team.id)?.members).toHaveLength(1);
	});

	it("refreshes lead workload and ready tasks without treating idle owners or blocked scopes as available", async () => {
		const f = await fixture();
		const stablePolicy = f.service.context(f.lead, "policy");
		const previousState = f.service.context(f.lead, "state");
		const a = await f.service.addMember(f.lead, "developer", "Implement feature", "developer");
		const b = await f.service.addMember(f.lead, "tester", "Verify feature", "tester");
		const active = f.service.createTask(f.lead, { ...taskInput(a.id), writePaths: ["src"] }, "active");
		f.service.updateTask(a.sessionId, { taskId: active.id, status: "in_progress" }, "claim");
		const conflict = f.service.createTask(f.lead, { ...taskInput(b.id), writePaths: ["src/file.ts"] }, "conflict");
		const dependent = f.service.createTask(f.lead, { ...taskInput(b.id), dependsOn: [active.id] }, "dependent");
		const ready = f.service.createTask(f.lead, { ...taskInput(a.id), writePaths: ["docs"] }, "ready");
		const context = f.service.context(f.lead);
		const workload = JSON.parse(
			context
				.split("\n")
				.find((line) => line.startsWith("Collaboration workload"))!
				.split(": ")
				.slice(1)
				.join(": ")
		);
		expect(workload).toContainEqual({ id: a.id, state: "idle", activeTasks: [active.id], pendingTasks: [ready.id] });
		expect(workload).toContainEqual({
			id: b.id,
			state: "idle",
			activeTasks: [],
			pendingTasks: [conflict.id, dependent.id],
		});
		const readiness = context.split("\n").find((line) => line.startsWith("Dependency/scope-ready pending tasks"))!;
		expect(readiness).toContain(ready.id);
		expect(readiness).not.toContain(conflict.id);
		expect(readiness).not.toContain(dependent.id);
		expect(context).not.toContain("All currently recorded tasks are completed");
		expect(f.service.context(a.sessionId)).not.toContain("Continuous delegation policy");
		f.service.updateTask(
			a.sessionId,
			{ taskId: active.id, status: "completed", result: "Scripted implementation verified" },
			"done"
		);
		const refreshed = f.service
			.context(f.lead)
			.split("\n")
			.find((line) => line.startsWith("Dependency/scope-ready pending tasks"))!;
		expect(refreshed).toContain(conflict.id);
		expect(refreshed).toContain(dependent.id);
		expect(f.service.context(f.lead, "policy")).toBe(stablePolicy);
		expect(f.service.context(f.lead, "policy")).not.toContain("Board:");
		expect(f.service.context(f.lead, "state")).not.toBe(previousState);
		expect(f.service.context(f.lead, "state")).toContain('"status":"completed"');
		expect(f.service.context(f.lead, "state")).not.toContain("Continuous delegation policy");
	});

	it.each(["completed", "failed"] as const)(
		"persists one bounded %s delegation checkpoint on result replay",
		async (status) => {
			const f = await fixture();
			const member = await f.service.addMember(f.lead, "developer", "Implement feature", "developer");
			const task = f.service.createTask(f.lead, taskInput(member.id), "task");
			await rounds(f.service);
			const input = { taskId: task.id, status, result: "x".repeat(20_000) };
			f.service.updateTask(member.sessionId, input, "result");
			f.service.updateTask(member.sessionId, input, "result");
			const results = f.service.get(f.lead)!.messages.filter((message) => message.kind === "result");
			expect(results).toHaveLength(1);
			expect(results[0]!.text.length).toBeLessThanOrEqual(20_000);
			expect(results[0]!.text).toContain("Collaboration checkpoint");
			expect(results[0]!.text).toContain(
				status === "failed" ? "Route diagnosis and repair" : "Research completion is not project completion"
			);
			expect(f.service.get(f.lead)!.tasks[0]!.result).toHaveLength(20_000);
			f.service.pause();
			const recovered = new AgentTeamService(f.store, f.runner);
			cleanups.push(async () => {
				recovered.pause();
				await recovered.settled();
			});
			await recovered.recover();
			await rounds(recovered, 8);
			expect(f.calls.filter((call) => call.sessionId === f.lead)).toHaveLength(1);
			expect(f.calls.find((call) => call.sessionId === f.lead)!.runtimeContent).toContain(
				"Continuous delegation policy"
			);
			expect(recovered.get(f.lead)!.messages.filter((message) => message.kind === "result")).toHaveLength(1);
			expect(f.errors).toEqual([]);
		}
	);

	it.each(["no-custom", "irrelevant", "suitable", "explicit-only"])(
		"executes scripted staffing decisions with %s templates through the real tools",
		async (scenario) => {
			let f: Awaited<ReturnType<typeof fixture>>;
			let planned = false;
			const invoke = async (sessionId: string, name: string, args: Record<string, unknown>, id: string) => {
				const tool = createAgentTeamTools(sessionId, f.service).find((candidate) => candidate.name === name)!;
				const output = await tool.execute(id, args, new AbortController().signal, undefined, undefined as never);
				return JSON.parse((output.content[0] as { text: string }).text);
			};
			f = await fixture(async (sessionId) => {
				const team = f.service.get(sessionId)!;
				if (sessionId === team.sessionId && !planned) {
					planned = true;
					const templates = await invoke(sessionId, "AgentTemplates", {}, "templates");
					expect(templates.filter((item: { name: string }) => item.name === "reviewer")).toHaveLength(1);
					const templateName =
						scenario === "suitable" ? "api-developer" : scenario === "explicit-only" ? "reviewer" : undefined;
					const member = await invoke(
						sessionId,
						"Agent",
						{ name: "project-worker", role: "Handle assigned API work", ...(templateName ? { templateName } : {}) },
						"worker"
					);
					await invoke(sessionId, "TaskCreate", { ...taskInput(member.id), writePaths: ["api"] }, "work");
				} else if (sessionId !== team.sessionId) {
					const member = team.members.find((candidate) => candidate.sessionId === sessionId)!;
					const task = team.tasks.find(
						(candidate) => candidate.owner === member.id && candidate.status === "in_progress"
					);
					if (task)
						await invoke(
							sessionId,
							"TaskUpdate",
							{ taskId: task.id, status: "completed", result: "Scripted member output" },
							`done:${task.id}`
						);
				}
			});
			if (scenario !== "no-custom")
				f.service.templates.save(
					"workspace",
					"user",
					{
						name: scenario === "suitable" ? "api-developer" : scenario === "explicit-only" ? "reviewer" : "copywriter",
						description: scenario === "suitable" ? "API implementation" : "Editorial review",
						systemPrompt: "Complete only the assigned responsibility",
						tools: { mode: scenario === "suitable" ? "all" : "none" },
						color: "blue",
					},
					0
				);
			const team = await f.service.start(
				f.source,
				scenario === "explicit-only" ? "Only use reviewer to review the API" : "Build the API"
			);
			await rounds(f.service, 6);
			const current = f.service.get(team.id)!;
			expect(current.startup).toBeUndefined();
			expect(current.members).toHaveLength(2);
			expect(current.tasks[0]?.status).toBe("completed");
			expect(current.messages.some((message) => message.text.includes("only automatic startup reminder"))).toBe(false);
			if (scenario === "suitable" || scenario === "explicit-only")
				expect(current.members[1]?.template?.scope).toBe("user");
			else expect(current.members[1]?.template).toBeUndefined();
			if (scenario !== "explicit-only") {
				const extra = await invoke(
					team.sessionId,
					"Agent",
					{ name: "integration", role: "Verify new integration requirement" },
					"extra"
				);
				await invoke(team.sessionId, "TaskCreate", { ...taskInput(extra.id), writePaths: ["checks"] }, "extra-task");
				await rounds(f.service, 4);
				expect(f.service.get(team.id)?.members).toHaveLength(3);
				expect(f.service.get(team.id)?.tasks[1]?.status).toBe("completed");
			}
			expect(f.errors).toEqual([]);
		}
	);

	it("launches a selected team without querying the source model and replays without duplicate teams", async () => {
		const f = await fixture();
		await f.runner.acceptTurn({
			principalId: "test",
			idempotencyKey: "launch",
			sessionId: f.source,
			mode: "prompt",
			content: [{ type: "text", text: "Build a library manager" }],
			skills: ["team"],
		});
		await f.runner.drainSession(f.source);
		expect(f.calls).toHaveLength(0);
		const team = f.service.list("workspace").find((value) => value.name === "Build a library manager")!;
		expect(team).toBeDefined();
		expect(team.sessionId).not.toBe(f.source);
		const snapshot = f.sessions.loadSnapshot(f.source)!;
		expect(snapshot.session.phase).toBe("idle");
		const receipt = snapshot.transcript.find((item) => item.type === "tool" && item.toolName === "team_start")!;
		expect(receipt).toMatchObject({ status: "complete", isError: false });
		expect(JSON.stringify(receipt)).toContain(team.id);
		const operation = f.sessions.findTurnDelivery(f.source, "Build a library manager")!;
		await f.runner.runtime.executeTurn({
			operation,
			snapshot,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		expect(f.service.list("workspace")).toHaveLength(2);
		await rounds(f.service);
		expect(f.calls).toEqual([
			expect.objectContaining({
				sessionId: team.sessionId,
				content: expect.stringContaining("Build a library manager"),
			}),
		]);
	});

	it("hands prior requirements and attachments to an independent lead", async () => {
		const f = await fixture();
		await f.runner.acceptTurn({
			principalId: "test",
			idempotencyKey: "context",
			sessionId: f.source,
			mode: "prompt",
			content: [{ type: "text", text: "Do not modify the authentication module" }],
		});
		await f.runner.drainSession(f.source);
		const artifact = { id: "reference", name: "requirements.png", mimeType: "image/png", size: 12 };
		await f.runner.acceptTurn({
			principalId: "test",
			idempotencyKey: "team",
			sessionId: f.source,
			mode: "prompt",
			content: [
				{ type: "text", text: "/team Implement the requested change" },
				{ type: "artifact", artifact },
			],
		});
		await f.runner.drainSession(f.source);
		const team = f.store.list().find((value) => value.name === "Implement the requested change")!;
		expect(team.objective).toContain("Do not modify the authentication module");
		expect(team.messages[0]?.artifacts).toEqual([artifact]);
		await f.runner.archiveSession({
			principalId: "test",
			idempotencyKey: "archive",
			sessionId: f.source,
			archived: true,
		});
		await rounds(f.service);
		expect(f.sessions.loadSnapshot(team.sessionId)?.transcript).toContainEqual(
			expect.objectContaining({
				type: "user",
				content: expect.arrayContaining([{ type: "artifact", artifact }]),
			})
		);
		expect(f.calls).toHaveLength(2);
	});

	it("does not silently run solo on unavailable or empty team launches", async () => {
		const f = await fixture();
		await f.runner.acceptTurn({
			principalId: "test",
			idempotencyKey: "empty-team",
			sessionId: f.source,
			mode: "prompt",
			content: [{ type: "text", text: "/team" }],
		});
		await f.runner.drainSession(f.source);
		expect(f.calls).toHaveLength(0);
		expect(f.store.list()).toHaveLength(1);
		expect(f.sessions.loadSnapshot(f.source)?.transcript).toContainEqual(
			expect.objectContaining({
				toolName: "team_start",
				status: "error",
				isError: true,
			})
		);
		const operation = f.sessions.findTurnDelivery(f.source, "/team")!;
		const unavailable = withTeamLaunch(
			{
				executeTurn: async () => {
					throw new Error("Unexpected model call");
				},
			},
			() => undefined,
			async () => {}
		);
		expect(
			await unavailable.executeTurn({
				operation,
				snapshot: f.sessions.loadSnapshot(f.source)!,
				signal: new AbortController().signal,
				onProgress: () => {},
			})
		).toMatchObject({ failure: { retryable: false } });
	});

	it("registers only the frozen template tool set in a real Pi session", async () => {
		const f = await fixture();
		const member = await f.service.addMember(f.lead, "reviewer", "Review files", "pi-tools", {
			templateName: "reviewer",
		});
		const agentDir = join(f.directory, "pi");
		mkdirSync(agentDir);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					test: {
						baseUrl: "https://example.invalid/v1",
						api: "openai-completions",
						apiKey: "test-only",
						models: [{ id: "scripted", input: ["text"], contextWindow: 32000 }],
					},
				},
			})
		);
		const tools: ToolDefinition[] = ["read_file", "exec", "subagent", "Agent", "TaskList", "SendMessage"].map(
			(name) => ({
				name,
				label: name,
				description: `Test ${name}`,
				promptSnippet: `Test ${name}`,
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
			})
		);
		const factory = createDefaultPiSessionFactory({
			agentDir,
			sessionDataDir: join(f.directory, "pi-sessions"),
			resolveWorkspace: () => f.directory,
			createCustomTools: (snapshot) => f.service.filterTools(snapshot.session.id, tools),
		});
		const session = await factory(f.sessions.loadSnapshot(member.sessionId)!);
		try {
			const active = (session as PiSessionLike & { agent: { state: { tools: Array<{ name: string }> } } }).agent.state
				.tools;
			expect(active.map((tool) => tool.name).sort()).toEqual(["read_file", "TaskList", "SendMessage"].sort());
			expect(
				session
					.getCapabilityManifests?.()
					.map((manifest) => manifest.id)
					.sort()
			).toEqual(["tool:read_file", "tool:TaskList", "tool:SendMessage"].sort());
			expect(session.getSystemPrompt?.()).not.toContain("Test exec");
		} finally {
			session.dispose();
		}
	});

	it("instantiates configured templates through Agent tools and freezes prompt, tools and model across edits/restart", async () => {
		const f = await fixture();
		const config: AgentTemplateConfig = {
			name: "api-reviewer",
			description: "Inspect APIs",
			systemPrompt: "Return defects with file evidence",
			tools: { mode: "custom", names: ["read_file"] },
			color: "cyan",
			model: { provider: "test", id: "review" },
			thinkingLevel: "high",
		};
		f.service.templates.save("workspace", "project", config, 0);
		const catalog = createAgentTeamTools(f.lead, f.service).find((tool) => tool.name === "AgentTemplates")!;
		const listed = await catalog.execute("list", {}, new AbortController().signal, undefined, undefined as never);
		expect(JSON.parse((listed.content[0] as { text: string }).text)).toContainEqual(
			expect.objectContaining({ name: config.name })
		);
		const agent = createAgentTeamTools(f.lead, f.service).find((tool) => tool.name === "Agent")!;
		const response = await agent.execute(
			"configured-member",
			{ name: "API reviewer", role: "Review endpoints", templateName: config.name },
			new AbortController().signal,
			undefined,
			undefined as never
		);
		const member = JSON.parse((response.content[0] as { text: string }).text) as AgentTeamMember;
		expect(member).toMatchObject({ template: { ...config, revision: 1 }, model: config.model, thinkingLevel: "high" });
		expect(f.sessions.loadSnapshot(member.sessionId)).toMatchObject({
			model: config.model,
			thinkingLevel: "high",
			sandboxMode: "read_only",
			approvalPolicy: "on_risk",
		});
		expect(f.service.context(member.sessionId)).toContain(config.systemPrompt);
		const tools = ["read_file", "exec", "subagent", "TaskUpdate", "SendMessage"].map((name) => ({ name }));
		expect(f.service.filterTools(member.sessionId, tools).map((tool) => tool.name)).toEqual([
			"read_file",
			"TaskUpdate",
			"SendMessage",
		]);
		f.service.templates.save(
			"workspace",
			"project",
			{ ...config, systemPrompt: "New instructions", tools: { mode: "all" } },
			1
		);
		expect(f.service.context(member.sessionId)).toContain(config.systemPrompt);
		expect(f.service.context(member.sessionId)).not.toContain("New instructions");
		f.service.templates.delete("workspace", "project", config.name, 2);
		const reopened = new AgentTeamStore(join(f.directory, "teams.db"));
		const recovered = new AgentTeamService(reopened, f.runner);
		cleanups.push(async () => {
			recovered.pause();
			await recovered.settled();
			reopened.close();
		});
		expect(recovered.filterTools(member.sessionId, tools)).toEqual(f.service.filterTools(member.sessionId, tools));
		expect(recovered.context(member.sessionId)).toContain(config.systemPrompt);
		expect(
			await recovered.addMember(f.lead, "API reviewer", "Review endpoints", `tool:${f.lead}:configured-member`, {
				templateName: config.name,
			})
		).toEqual(member);
		await expect(
			recovered.addMember(f.lead, "missing", "task", "missing", { templateName: config.name })
		).rejects.toThrow(/Unknown Agent/);
	});

	it("validates model availability, explicit overrides and supported effort at member creation", async () => {
		const f = await fixture();
		const available = [
			{
				model: { provider: "test", id: "review" },
				authenticated: true,
				reasoning: true,
				thinkingLevels: ["off", "high"],
			},
		] as ModelMetadata[];
		const service = new AgentTeamService(
			f.store,
			f.runner,
			() => {},
			() => available
		);
		service.templates.save(
			"workspace",
			"user",
			{
				name: "worker",
				description: "Review",
				systemPrompt: "Review changes",
				tools: { mode: "none" },
				color: "blue",
				model: { provider: "test", id: "missing" },
				thinkingLevel: "max",
			},
			0
		);
		await expect(
			service.addMember(f.lead, "unavailable", "review", "unavailable", { templateName: "worker" })
		).rejects.toThrow(/unavailable/);
		const member = await service.addMember(f.lead, "valid", "review", "valid", {
			templateName: "worker",
			model: available[0]!.model,
			thinkingLevel: "low",
		});
		expect(member).toMatchObject({ model: available[0]!.model, thinkingLevel: "high" });
		expect(f.sessions.loadSnapshot(member.sessionId)?.thinkingLevel).toBe("high");
		expect(service.filterTools(member.sessionId, [{ name: "exec" }, { name: "SendMessage" }])).toEqual([
			{ name: "SendMessage" },
		]);
		service.pause();
		await service.settled();
	});

	it("launches from an active model turn without turning the source chat into the lead", async () => {
		let f: Awaited<ReturnType<typeof fixture>>;
		let launched = "";
		f = await fixture(async (sessionId) => {
			if (sessionId !== f.source) return;
			const tool = createAgentTeamTools(sessionId, f.service).find((entry) => entry.name === "TeamCreate")!;
			const result = await tool.execute(
				"launch-in-turn",
				{ objective: "Implement in the current project", name: "Private lead" },
				new AbortController().signal,
				undefined,
				undefined as never
			);
			launched = JSON.parse((result.content[0] as { text: string }).text).id;
		});
		await f.runner.acceptTurn({
			principalId: "test",
			idempotencyKey: "user-request",
			sessionId: f.source,
			mode: "prompt",
			content: [{ type: "text", text: "Use the team skill" }],
		});
		await f.runner.drainSession(f.source);
		const team = f.service.get(launched)!;
		expect(team.sessionId).not.toBe(f.source);
		expect(team.messages[0]?.delivery).toBe("pending");
		const execution = f.sessions.loadSnapshot(team.sessionId)!;
		const source = f.sessions.loadSnapshot(f.source)!;
		expect(execution).toMatchObject({
			model: source.model,
			sandboxMode: source.sandboxMode,
			approvalPolicy: source.approvalPolicy,
			thinkingLevel: source.thinkingLevel,
		});
		expect(execution.session.parentSessionId).toBeUndefined();
		expect(execution.transcript).toHaveLength(0);
		await rounds(f.service, 2);
		expect(f.calls.map((call) => call.sessionId)).toEqual([f.source, team.sessionId, team.sessionId]);
		expect(f.calls[2]?.content).toContain("only automatic startup reminder");
		expect(f.service.get(launched)!.members[0]?.costUsd).toBe(0.01);
		expect(f.service.context(f.source)).toBe("");
	});

	it.each(["running", "stopped"] as const)(
		"fences legacy lead deliveries while migrating a %s team",
		async (status) => {
			const f = await fixture();
			const id = f.service.get(f.lead)!.id;
			f.store.change(id, (team) => {
				delete team.sourceSessionId;
				team.sessionId = f.source;
				team.members[0]!.sessionId = f.source;
				team.status = status;
			});
			await f.runner.acceptTurn({
				principalId: "test",
				idempotencyKey: "old-delivery",
				sessionId: f.source,
				mode: "prompt",
				content: [{ type: "text", text: "[team-delivery:old]\nOld team work" }],
			});
			await f.service.recover();
			await f.runner.resumeQueuedSessions();
			await rounds(f.service, 2);
			expect(f.calls.some((call) => call.sessionId === f.source)).toBe(false);
			expect(f.service.get(id)?.status).toBe(status);
			expect(f.calls).toHaveLength(status === "running" ? 1 : 0);
		}
	);

	it("launches independent teams from the same chat, deduplicates launches and survives source archival", async () => {
		const f = await fixture();
		const tool = createAgentTeamTools(f.source, f.service).find((entry) => entry.name === "TeamCreate")!;
		const launch = (id: string, objective: string) =>
			tool.execute(id, { objective, name: "Independent" }, new AbortController().signal, undefined, undefined as never);
		const [first, replay] = await Promise.all([
			launch("launch-a", "First objective"),
			launch("launch-a", "First objective"),
		]);
		expect(replay).toEqual(first);
		await launch("launch-b", "Second objective");
		const teams = f.service.list("workspace");
		expect(teams).toHaveLength(3);
		expect(new Set(teams.map((team) => team.sessionId)).size).toBe(3);
		expect(teams.every((team) => team.sourceSessionId === f.source && team.sessionId !== f.source)).toBe(true);
		expect(f.service.get(f.source)).toBeUndefined();
		expect(f.service.context(f.source)).toBe("");
		expect(() => f.service.createTask(f.source, taskInput(), "impersonate")).toThrow(/Create a team/);
		await f.runner.archiveSession({
			principalId: "test",
			idempotencyKey: "archive",
			sessionId: f.source,
			archived: true,
		});
		await rounds(f.service, 2);
		expect(f.calls).toHaveLength(4);
		expect(f.calls.every((call) => call.sessionId !== f.source)).toBe(true);
		expect(f.service.list("workspace").every((team) => team.status === "running" && !team.archived)).toBe(true);
		const reopened = new AgentTeamStore(join(f.directory, "teams.db"));
		const recovered = new AgentTeamService(reopened, f.runner);
		cleanups.push(async () => {
			recovered.pause();
			await recovered.settled();
			reopened.close();
		});
		await recovered.recover();
		await rounds(recovered, 2);
		expect(f.calls).toHaveLength(4);
		expect((await recovered.start(f.source, "First objective", "Independent", true, "tool:launch-a")).id).toBe(
			JSON.parse((first.content[0] as { text: string }).text).id
		);
		await recovered.stop(teams[0]!.id);
		expect(recovered.list("workspace").filter((team) => team.status === "running")).toHaveLength(2);
	});

	it("migrates legacy chat-owned teams once while retaining tasks, mail and immutable history", async () => {
		const f = await fixture();
		const member = await f.service.addMember(f.lead, "worker", "implementation", "member");
		f.service.createTask(f.lead, taskInput(member.id), "task");
		const id = f.service.get(f.lead)!.id;
		f.store.change(id, (team) => {
			delete team.sourceSessionId;
			delete team.workspaceId;
			delete team.launchId;
			team.sessionId = f.source;
			team.members.find((entry) => entry.lead)!.sessionId = f.source;
		});
		const before = f.store.get(id)!;
		await f.runner.archiveSession({
			principalId: "test",
			idempotencyKey: "archive",
			sessionId: f.source,
			archived: true,
		});
		await f.service.recover();
		const after = f.service.get(id)!;
		expect(after.sessionId).not.toBe(f.source);
		expect(after.sourceSessionId).toBe(f.source);
		expect(after.tasks).toEqual(before.tasks);
		expect(after.members.find((entry) => entry.id === member.id)?.sessionId).toBe(member.sessionId);
		expect(f.service.get(id, before.revision)).toEqual(before);
		await f.service.recover();
		expect(f.service.get(id)!.revision).toBe(after.revision);
		await rounds(f.service, 2);
		expect(f.service.get(id)!.status).toBe("running");
		expect(f.calls.some((call) => call.sessionId === after.sessionId)).toBe(true);
		expect(f.calls.some((call) => call.sessionId === f.source)).toBe(false);
	});

	it("keeps idle members asleep until their first explicit task assignment, then reuses the same session", async () => {
		const f = await fixture();
		const member = await f.service.addMember(f.lead, "worker", "implementation", "member");
		const free = f.service.createTask(f.lead, taskInput(), "free");
		await rounds(f.service, 3);
		expect(f.calls).toHaveLength(0);
		expect(f.service.get(f.lead)!.tasks[0]!.owner).toBeUndefined();
		const first = f.service.createTask(f.lead, taskInput(member.id), "first");
		await rounds(f.service);
		expect(f.calls.map((call) => call.sessionId)).toEqual([member.sessionId]);
		f.service.updateTask(
			member.sessionId,
			{ taskId: first.id, status: "completed", result: "Unit checks passed" },
			"complete"
		);
		await rounds(f.service, 2);
		expect(f.service.get(f.lead)!.tasks.find((task) => task.id === free.id)?.owner).toBe(member.id);
		expect(f.calls.filter((call) => call.sessionId === member.sessionId)).toHaveLength(2);
		expect(f.service.get(f.lead)!.members).toHaveLength(2);
		expect(f.errors).toEqual([]);
	});

	it("runs teammates concurrently, delivers peer mail, releases dependencies, and requires lead acceptance", async () => {
		let f: Awaited<ReturnType<typeof fixture>>;
		let first: AgentTeamMember;
		let second: AgentTeamMember;
		let parallel = 0;
		let peak = 0;
		let release!: () => void;
		const bothStarted = new Promise<void>((resolve) => {
			release = resolve;
		});
		f = await fixture(async (sessionId, content) => {
			if (sessionId === f.lead) return;
			const member = sessionId === first.sessionId ? first : second;
			const task = f.service
				.get(f.lead)!
				.tasks.find((value) => value.owner === member.id && value.status === "in_progress");
			if (!task) return;
			if (task.title !== "integration") {
				parallel += 1;
				peak = Math.max(peak, parallel);
				if (parallel === 2) release();
				await bothStarted;
				parallel -= 1;
			}
			if (member.id === first.id && !content.includes("(message)"))
				f.service.send(sessionId, second.id, "The API contract is ready", `peer:${task.id}`);
			f.service.updateTask(
				sessionId,
				{ taskId: task.id, status: "completed", result: `${task.title}: scripted checks passed` },
				`done:${task.id}`
			);
		});
		first = await f.service.addMember(f.lead, "backend", "backend", "backend");
		second = await f.service.addMember(f.lead, "frontend", "frontend", "frontend");
		const a = f.service.createTask(f.lead, { ...taskInput(first.id), title: "backend", writePaths: ["server"] }, "a");
		const b = f.service.createTask(f.lead, { ...taskInput(second.id), title: "frontend", writePaths: ["web"] }, "b");
		f.service.createTask(f.lead, { ...taskInput(), title: "integration", dependsOn: [a.id, b.id] }, "c");
		expect(() => f.service.finish(f.lead, "premature", "finish")).toThrow(/All tasks/);
		await rounds(f.service, 8);
		expect(peak).toBe(2);
		expect(
			f.calls.some((call) => call.sessionId === second.sessionId && call.content.includes("The API contract is ready"))
		).toBe(true);
		expect(f.service.get(f.lead)!.tasks.every((task) => task.status === "completed")).toBe(true);
		expect(f.service.get(f.lead)!.status).toBe("running");
		expect(() => f.service.finish(first.sessionId, "not lead", "finish")).toThrow(/Only the team lead/);
		f.service.finish(f.lead, "All three changes inspected; scripted integration checks passed", "finish");
		expect(f.service.get(f.lead)!.status).toBe("completed");
		expect(f.errors).toEqual([]);
	});

	it("serializes competing claims and overlapping write scopes; rejects cycles and foreign owners", async () => {
		const f = await fixture();
		const a = await f.service.addMember(f.lead, "a", "a", "a");
		const b = await f.service.addMember(f.lead, "b", "b", "b");
		const first = f.service.createTask(f.lead, { ...taskInput(a.id), writePaths: ["src"] }, "first");
		const next = f.service.createTask(f.lead, { ...taskInput(b.id), writePaths: ["src/file.ts"] }, "next");
		await rounds(f.service);
		expect(f.calls).toHaveLength(1);
		expect(() =>
			f.service.updateTask(b.sessionId, { taskId: first.id, status: "completed", result: "bad" }, "bad")
		).toThrow(/owner/);
		expect(() => f.service.updateTask(f.lead, { taskId: next.id, status: "in_progress" }, "conflict")).toThrow(
			/blocked/
		);
		f.service.updateTask(a.sessionId, { taskId: first.id, status: "completed", result: "verified" }, "done");
		await rounds(f.service, 2);
		expect(f.service.get(f.lead)!.tasks.find((task) => task.id === next.id)?.status).toBe("in_progress");
		const x = f.service.createTask(f.lead, taskInput(), "x");
		const y = f.service.createTask(f.lead, { ...taskInput(), dependsOn: [x.id] }, "y");
		expect(() => f.service.updateTask(f.lead, { taskId: x.id, dependsOn: [y.id] }, "cycle")).toThrow(/cycle/);
		expect(f.service.get(f.lead)!.tasks.find((task) => task.id === x.id)?.dependsOn).toEqual([]);
		expect(() => f.service.send(a.sessionId, "foreign-member", "data", "foreign")).toThrow(/Unknown/);
		expect(() => f.service.send(a.sessionId, "lead", "pretend user", "forge", true)).toThrow(/Only the team lead/);
	});

	it("deduplicates tools and mailbox delivery across scheduler restart, retaining immutable replay", async () => {
		const f = await fixture();
		const a = await f.service.addMember(f.lead, "a", "a", "a");
		expect(await f.service.addMember(f.lead, "a", "a", "a")).toEqual(a);
		const first = f.service.createTask(f.lead, taskInput(a.id), "task");
		expect(f.service.createTask(f.lead, taskInput(a.id), "task").id).toBe(first.id);
		await rounds(f.service);
		const initial = f.service.get(f.lead)!;
		const assignment = initial.messages[0]!;
		// Crash window: acceptTurn committed but the mailbox acknowledgement did not.
		f.store.change(initial.id, (team) => {
			team.messages[0]!.delivery = "pending";
		});
		f.service.pause();
		await f.service.settled();
		const reopened = new AgentTeamStore(join(f.directory, "teams.db"));
		const recovered = new AgentTeamService(reopened, f.runner);
		cleanups.push(async () => {
			recovered.pause();
			await recovered.settled();
			reopened.close();
		});
		recovered.send(f.lead, a.id, "New mail after the crash", "new-mail", true);
		await rounds(recovered, 3);
		expect(f.calls.filter((call) => call.content.includes(`[team-delivery:${assignment.id}]`))).toHaveLength(1);
		expect(f.calls.filter((call) => call.content.includes("New mail after the crash"))).toHaveLength(1);
		expect(recovered.get(f.lead, initial.revision)?.messages).toEqual(initial.messages);
		expect(recovered.get(f.lead)!.messages.every((message) => message.delivery === "delivered")).toBe(true);
	});

	it("stops all members, cancels pending mail and fences subsequent model actions", async () => {
		const f = await fixture();
		const a = await f.service.addMember(f.lead, "a", "a", "a");
		f.service.createTask(f.lead, taskInput(a.id), "task");
		f.service.send(f.lead, a.id, "queued", "mail", true);
		await f.service.stop(f.lead);
		await rounds(f.service, 3);
		expect(f.calls).toHaveLength(0);
		expect(f.service.get(f.lead)!.messages[0]!.delivery).toBe("cancelled");
		expect(() => f.service.send(a.sessionId, "lead", "late", "late")).toThrow(/no longer running/);
		expect(() => f.service.createTask(a.sessionId, taskInput(), "late-task")).toThrow(/no longer running/);
	});

	it("does not poll models while idle and records a failure without claiming task success", async () => {
		const f = await fixture(async () => {
			throw new Error("provider unavailable");
		});
		const a = await f.service.addMember(f.lead, "a", "a", "a");
		f.service.createTask(f.lead, taskInput(a.id), "task");
		await rounds(f.service, 6);
		expect(f.calls.filter((call) => call.sessionId === a.sessionId)).toHaveLength(1);
		expect(f.service.get(f.lead)!.members.find((member) => member.id === a.id)?.state).toBe("error");
		expect(f.service.get(f.lead)!.tasks[0]!.status).toBe("in_progress");
		f.service.retry(f.lead, a.id, "retry");
		await rounds(f.service);
		expect(f.calls.filter((call) => call.sessionId === a.sessionId)).toHaveLength(2);
	});

	it("lists project teams without creating teams for ordinary conversations", async () => {
		const f = await fixture();
		const create = async (workspaceId: string) =>
			(
				await f.runner.createSession({
					principalId: "test",
					idempotencyKey: randomUUID(),
					workspaceId,
					model: { provider: "test", id: "scripted" },
					thinkingLevel: "off",
					sandboxMode: "read_only",
					approvalPolicy: "on_risk",
				})
			).snapshot.session.id;
		const ordinary = await create("workspace");
		expect(f.service.get(ordinary)).toBeUndefined();
		expect(f.service.list("workspace")).toHaveLength(1);
		const other = await create("other");
		const otherTeam = await f.service.start(other, "Other project", "Other team", false);
		expect(f.service.list("workspace")).toEqual([expect.objectContaining({ sessionId: f.lead, archived: false })]);
		expect(f.service.list("other")).toEqual([
			expect.objectContaining({ sessionId: otherTeam.sessionId, sourceSessionId: other }),
		]);
		expect(f.service.list("empty")).toEqual([]);
		const tool = createAgentTeamTools(ordinary, f.service).find((value) => value.name === "TeamCreate")!;
		await tool.execute(
			"explicit-team-request",
			{ objective: "Requested team work", name: "Second team" },
			new AbortController().signal,
			undefined,
			undefined as never
		);
		expect(f.service.list("workspace")).toHaveLength(2);
		expect(f.service.list("workspace")).toContainEqual(
			expect.objectContaining({ sourceSessionId: ordinary, name: "Second team" })
		);
		expect(f.calls).toHaveLength(0);
	});

	it("registers real team tools separately from one-shot subagent", async () => {
		const f = await fixture();
		const names = createAgentTeamTools(f.lead, f.service).map((tool) => tool.name);
		expect(names).toEqual([
			"AgentTemplates",
			"TeamCreate",
			"Agent",
			"TaskCreate",
			"TaskList",
			"TaskGet",
			"TaskUpdate",
			"SendMessage",
			"TeamFinish",
		]);
		expect(names).not.toContain("subagent");
	});

	it("executes the model-facing tools end to end: lead plans, two agents execute and communicate, lead accepts", async () => {
		let f: Awaited<ReturnType<typeof fixture>>;
		let planned = false;
		const invoke = async (sessionId: string, name: string, args: Record<string, unknown>, key: string) => {
			const tool = createAgentTeamTools(sessionId, f.service).find((value) => value.name === name)!;
			const result = await tool.execute(key, args, new AbortController().signal, undefined, undefined as never);
			return JSON.parse((result.content[0] as { text: string }).text) as Record<string, string>;
		};
		f = await fixture(async (sessionId) => {
			if (sessionId === f.lead && !planned) {
				planned = true;
				const a = await invoke(sessionId, "Agent", { name: "backend", role: "implement API" }, "a");
				const b = await invoke(sessionId, "Agent", { name: "frontend", role: "implement UI" }, "b");
				const first = await invoke(
					sessionId,
					"TaskCreate",
					{ title: "API", description: "Implement API", owner: a.id, writePaths: ["api"] },
					"first"
				);
				const second = await invoke(
					sessionId,
					"TaskCreate",
					{ title: "UI", description: "Implement UI", owner: b.id, writePaths: ["ui"] },
					"second"
				);
				await invoke(
					sessionId,
					"TaskCreate",
					{ title: "integration", description: "Verify API and UI", dependsOn: [first.id, second.id] },
					"integration"
				);
				return;
			}
			const team = f.service.get(f.lead)!;
			if (sessionId === f.lead) {
				if (
					team.tasks.every((task) => task.status === "completed") &&
					!team.messages.some((message) => message.delivery === "pending")
				)
					await invoke(
						sessionId,
						"TeamFinish",
						{ result: "Scripted integration runtime: all task outputs inspected and accepted" },
						"accept"
					);
				return;
			}
			await invoke(sessionId, "TaskList", {}, randomUUID());
			const member = team.members.find((value) => value.sessionId === sessionId)!;
			const task = team.tasks.find((value) => value.owner === member.id && value.status === "in_progress");
			if (!task) return;
			await invoke(sessionId, "TaskGet", { taskId: task.id }, `get:${task.id}`);
			if (task.title === "API")
				await invoke(
					sessionId,
					"SendMessage",
					{
						recipient: team.members.find((value) => value.name === "frontend")!.id,
						text: "API contract: GET /health returns status",
					},
					"contract"
				);
			await invoke(
				sessionId,
				"TaskUpdate",
				{ taskId: task.id, status: "completed", result: "Scripted check passed" },
				`complete:${task.id}`
			);
		});
		f.service.send(f.lead, "lead", "Start the requested team", "start", true);
		await rounds(f.service, 12);
		expect(f.service.get(f.lead)!.status).toBe("completed");
		expect(f.service.get(f.lead)!.members).toHaveLength(3);
		expect(f.service.get(f.lead)!.tasks).toHaveLength(3);
		expect(
			f.service
				.get(f.lead)!
				.messages.some(
					(message) => message.from !== "lead" && message.to !== "lead" && message.text.startsWith("API contract")
				)
		).toBe(true);
		expect(f.errors).toEqual([]);
	});

	it("continues delegation from research through implementation, late staffing, repair and acceptance", async () => {
		let f: Awaited<ReturnType<typeof fixture>>;
		let stage = 0;
		let developer: Record<string, string>;
		let reviewer: Record<string, string>;
		let verificationId: string;
		const invoke = async (sessionId: string, name: string, args: Record<string, unknown>, key: string) => {
			const tool = createAgentTeamTools(sessionId, f.service).find((value) => value.name === name)!;
			const result = await tool.execute(key, args, new AbortController().signal, undefined, undefined as never);
			return JSON.parse((result.content[0] as { text: string }).text) as Record<string, string>;
		};
		const assign = (sessionId: string, owner: string, title: string, writePaths: string[], dependsOn: string[] = []) =>
			invoke(
				sessionId,
				"TaskCreate",
				{ owner, title, description: title + ": produce changes and check evidence", writePaths, dependsOn },
				title
			);
		f = await fixture(async (sessionId, content) => {
			const team = f.service.get(f.lead)!;
			if (sessionId === f.lead) {
				await invoke(sessionId, "TaskList", {}, "board-" + stage);
				if (stage === 0) {
					developer = await invoke(
						sessionId,
						"Agent",
						{ name: "developer", role: "Research, implement and repair src/feature.ts; report paths and checks" },
						"developer"
					);
					await assign(sessionId, developer.id!, "Research", []);
				} else {
					expect(content).toContain("Collaboration checkpoint");
					if (stage === 1) {
						expect(f.service.context(sessionId)).toContain("a research-only board does not satisfy a build request");
						await assign(sessionId, developer.id!, "Implementation", ["src/feature.ts"], [team.tasks[0]!.id]);
					} else if (stage === 2) {
						reviewer = await invoke(
							sessionId,
							"Agent",
							{ name: "verifier", role: "Independently verify the feature; own test/feature.test.ts" },
							"verifier"
						);
						verificationId = (
							await assign(sessionId, reviewer.id!, "Verification", ["test/feature.test.ts"], [team.tasks[1]!.id])
						).id!;
					} else if (stage === 3) {
						expect(content).toContain("Route diagnosis and repair");
						await assign(sessionId, developer.id!, "Repair", ["src/feature.ts"], [team.tasks[1]!.id]);
					} else if (stage === 4) {
						await invoke(sessionId, "TaskUpdate", { taskId: verificationId, status: "pending" }, "reverify");
					} else {
						await invoke(
							sessionId,
							"TeamFinish",
							{ result: "Scripted acceptance: implementation, repair and independent re-verification inspected" },
							"accept"
						);
					}
				}
				stage += 1;
				return;
			}
			const member = team.members.find((value) => value.sessionId === sessionId)!;
			const task = team.tasks.find((value) => value.owner === member.id && value.status === "in_progress")!;
			await invoke(sessionId, "TaskGet", { taskId: task.id }, "get-" + stage);
			const failed = task.title === "Verification" && !team.tasks.some((value) => value.title === "Repair");
			await invoke(
				sessionId,
				"TaskUpdate",
				{
					taskId: task.id,
					status: failed ? "failed" : "completed",
					result: failed
						? "Scripted validation found an edge case; return to developer"
						: task.title + ": scripted output and checks",
				},
				"done-" + stage
			);
		});
		f.service.send(f.lead, "lead", "Build the requested feature with the team", "start", true);
		await rounds(f.service, 20);
		const team = f.service.get(f.lead)!;
		expect(team.members.map((member) => ({ name: member.name, error: member.error }))).toEqual([
			{ name: team.members[0]!.name, error: undefined },
			{ name: "developer", error: undefined },
			{ name: "verifier", error: undefined },
		]);
		expect(team.status).toBe("completed");
		expect(team.members).toHaveLength(3);
		expect(team.tasks).toHaveLength(4);
		expect(team.tasks.every((task) => task.status === "completed" && task.owner !== "lead")).toBe(true);
		expect(f.calls.filter((call) => call.sessionId === developer.sessionId)).toHaveLength(3);
		expect(f.calls.filter((call) => call.sessionId === reviewer.sessionId)).toHaveLength(2);
		expect(
			f.calls
				.filter((call) => call.sessionId === f.lead)
				.every((call) => call.runtimeContent.includes("Continuous delegation policy"))
		).toBe(true);
		const turns = f.calls.length;
		await rounds(f.service, 5);
		expect(f.calls).toHaveLength(turns);
		expect(f.errors).toEqual([]);
	});

	it("cancels executing teammates without waking queued peer mail", async () => {
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const f = await fixture(async (_sessionId, _content, signal) => {
			started();
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
			);
		});
		const member = await f.service.addMember(f.lead, "worker", "implementation", "worker");
		f.service.createTask(f.lead, taskInput(member.id), "task");
		f.service.tick();
		await entered;
		f.service.send(f.lead, member.id, "late message", "late", true);
		await f.service.stop(f.lead);
		await f.service.settled();
		await rounds(f.service, 2);
		expect(f.calls).toHaveLength(1);
		expect(f.service.get(f.lead)!.status).toBe("stopped");
		expect(f.service.get(f.lead)!.messages.at(-1)?.delivery).toBe("cancelled");
		expect(f.service.get(f.lead)!.tasks[0]!.status).not.toBe("completed");
	});

	it("enforces workspace and viewer permissions on team RPCs, including history", async () => {
		const f = await fixture();
		const skills = new ManagedSkillCatalog();
		const workspace = { id: "workspace", name: "Test", status: "ready" as const, createdAt: 1, updatedAt: 1 };
		const server = new GatewayServer({
			orchestrator: f.runner,
			store: f.sessions,
			teams: f.service,
			skills,
			workspacePath: () => f.directory,
			autoRouteSkills: true,
			auth: new StaticTokenMapAuth([
				{ token: "owner", principal: { id: "owner", role: "owner", workspaces: [workspace] } },
				{ token: "viewer", principal: { id: "viewer", role: "viewer", workspaces: [workspace] } },
				{ token: "member", principal: { id: "member", role: "member", workspaces: [workspace] } },
				{
					token: "outsider",
					principal: { id: "outsider", role: "owner", workspaces: [{ ...workspace, id: "other" }] },
				},
			]),
		});
		const address = await server.listen();
		cleanups.push(() => server.close());
		const connect = async (token: string) => {
			const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, ["wuming.v1", bearerProtocol(token)]);
			await once(ws, "open");
			cleanups.push(async () => {
				ws.terminate();
			});
			const hello = once(ws, "message");
			ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: token, capabilities: ["agent.teams"] }));
			await hello;
			return (command: Command) =>
				new Promise<Extract<ServerMessage, { type: "response" }>>((resolve, reject) => {
					const requestId = randomUUID();
					const timer = setTimeout(() => {
						ws.off("message", listener);
						reject(new Error("RPC timeout"));
					}, 3000);
					const listener = (data: WebSocket.RawData) => {
						const message = JSON.parse(data.toString()) as ServerMessage;
						if (message.type === "response" && message.requestId === requestId) {
							clearTimeout(timer);
							ws.off("message", listener);
							resolve(message);
						}
					};
					ws.on("message", listener);
					ws.send(JSON.stringify({ type: "request", requestId, idempotencyKey: requestId, command }));
				});
		};
		const viewer = await connect("viewer");
		const template: AgentTemplateConfig = {
			name: "test-role",
			description: "Test role",
			systemPrompt: "Inspect changes",
			tools: { mode: "none" },
			color: "blue",
		};
		expect(await viewer({ type: "agent.template.list", workspaceId: "workspace" })).toMatchObject({
			ok: true,
			result: { type: "agent.templates", canEditUser: false, canEditProject: false },
		});
		expect(
			await viewer({
				type: "agent.template.save",
				workspaceId: "workspace",
				scope: "project",
				template,
				expectedRevision: 0,
			})
		).toMatchObject({ ok: false, error: { code: "forbidden" } });
		const memberAccount = await connect("member");
		expect(
			await memberAccount({
				type: "agent.template.save",
				workspaceId: "workspace",
				scope: "user",
				template,
				expectedRevision: 0,
			})
		).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(
			await memberAccount({
				type: "agent.template.save",
				workspaceId: "workspace",
				scope: "project",
				template,
				expectedRevision: 0,
			})
		).toMatchObject({ ok: true });
		const teamId = f.service.get(f.lead)!.id;
		expect(await viewer({ type: "team.get", teamId })).toMatchObject({ ok: true, result: { team: { id: teamId } } });
		expect(await viewer({ type: "team.get", teamId, sessionId: f.lead })).toMatchObject({ ok: false });
		expect(await viewer({ type: "team.get" })).toMatchObject({ ok: false });
		expect(await viewer({ type: "team.stop", teamId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await viewer({ type: "session.list", workspaceId: "workspace" })).toMatchObject({
			ok: true,
			result: { sessions: [{ id: f.source }] },
		});
		expect(await viewer({ type: "team.list", workspaceId: "workspace" })).toMatchObject({
			ok: true,
			result: { type: "team.list", teams: [{ sessionId: f.lead }] },
		});
		expect(await viewer({ type: "team.get", sessionId: f.lead, revision: 1 })).toMatchObject({
			ok: true,
			result: { type: "team.snapshot", team: { revision: 1 } },
		});
		for (const command of [
			{ type: "team.stop", sessionId: f.lead },
			{ type: "team.message", sessionId: f.lead, recipient: "lead", text: "unauthorized" },
			{ type: "team.retry", sessionId: f.lead, memberId: "lead" },
		] satisfies Command[])
			expect(await viewer(command)).toMatchObject({ ok: false, error: { code: "forbidden" } });
		const outsider = await connect("outsider");
		expect(await outsider({ type: "agent.template.list", workspaceId: "workspace" })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		const outsideCatalog = await outsider({ type: "agent.template.list", workspaceId: "other" });
		expect(JSON.stringify(outsideCatalog)).not.toContain("test-role");
		expect(await outsider({ type: "team.get", teamId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await outsider({ type: "team.list", workspaceId: "workspace" })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(await outsider({ type: "team.list", workspaceId: "other" })).toMatchObject({
			ok: true,
			result: { type: "team.list", teams: [] },
		});
		expect(await outsider({ type: "team.get", sessionId: f.lead })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		const owner = await connect("owner");
		const launch: Command = {
			type: "turn.prompt",
			sessionId: f.source,
			content: [{ type: "text", text: "Build a library manager" }],
			skills: ["team"],
		};
		expect(await viewer(launch)).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await outsider(launch)).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await owner({ ...launch, sessionId: f.lead })).toMatchObject({ ok: false });
		expect(await owner({ ...launch, type: "turn.steer" })).toMatchObject({ ok: false });
		expect(await owner({ ...launch, content: [{ type: "text", text: "/team" }] })).toMatchObject({ ok: false });
		await skills.manager(f.directory).setEnabled("team", false);
		expect(await owner(launch)).toMatchObject({ ok: false, error: { code: "not_found" } });
		await skills.manager(f.directory).setEnabled("team", true);
		expect(
			await owner({
				type: "turn.prompt",
				sessionId: f.source,
				content: [{ type: "text", text: "Explain the team skill and collaboration" }],
			})
		).toMatchObject({ ok: true });
		await f.runner.drainSession(f.source);
		expect(f.store.list()).toHaveLength(1);
		expect(f.calls).toHaveLength(1);
		expect(
			await owner({
				type: "agent.template.save",
				workspaceId: "workspace",
				scope: "user",
				template,
				expectedRevision: 0,
			})
		).toMatchObject({ ok: true, result: { canEditUser: true, canEditProject: true } });
		expect(
			await owner({
				type: "agent.template.delete",
				workspaceId: "workspace",
				scope: "user",
				name: "test-role",
				expectedRevision: 1,
			})
		).toMatchObject({ ok: true });
		expect(await owner({ type: "session.archive", sessionId: f.lead, archived: true })).toMatchObject({
			ok: false,
			error: { code: "conflict" },
		});
		expect(await owner({ type: "session.archive", sessionId: f.source, archived: true })).toMatchObject({ ok: true });
		expect(await owner({ type: "team.message", teamId, recipient: "lead", text: "independent" })).toMatchObject({
			ok: true,
		});
		expect(
			await owner({ type: "team.message", sessionId: f.lead, recipient: "lead", text: "authorized" })
		).toMatchObject({ ok: true, result: { type: "team.snapshot" } });
		expect(await owner({ type: "team.stop", sessionId: f.lead })).toMatchObject({
			ok: true,
			result: { team: { status: "stopped" } },
		});
	});

	it("fences queued turns when a crash occurred after the stop tombstone but before abort", async () => {
		const f = await fixture();
		const member = await f.service.addMember(f.lead, "worker", "implementation", "member");
		await f.runner.acceptTurn({
			principalId: "test",
			idempotencyKey: "queued",
			sessionId: member.sessionId,
			mode: "prompt",
			content: [{ type: "text", text: "queued work" }],
		});
		f.store.change(f.service.get(f.lead)!.id, (team) => {
			team.status = "stopped";
		});
		await f.service.recover();
		await f.runner.resumeQueuedSessions();
		expect(f.calls).toHaveLength(0);
		expect(f.sessions.loadSnapshot(member.sessionId)?.session.phase).toBe("idle");
	});
});

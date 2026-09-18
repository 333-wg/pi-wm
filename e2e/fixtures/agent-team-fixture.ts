import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore, type AgentRuntime } from "@wuming/orchestrator";
import { AgentTeamStore } from "../../apps/gateway/src/agent-team-store.js";
import { AgentTeamService } from "../../apps/gateway/src/agent-teams.js";
import { createAgentTeamTools } from "../../apps/gateway/src/agent-team-tools.js";
import type { AgentTemplateConfig } from "@wuming/protocol";

/** Model-facing TeamCreate invocation, isolated from any real provider or user data. */
export async function seedRunningAgentTeam(
	data: string,
	name = "Explicit team request",
	options: { sourceSessionId?: string; archiveSource?: boolean } = {}
): Promise<string> {
	await mkdir(data, { recursive: true });
	const sessions = new SqliteOrchestratorStore(join(data, "wuming.db"));
	const store = new AgentTeamStore(join(data, "agent-teams.db"));
	const runner = new SessionOrchestrator(sessions, {
		async executeTurn() {
			throw new Error("Seed must not run a model");
		},
	});
	const service = new AgentTeamService(store, runner);
	try {
		const snapshot = options.sourceSessionId
			? sessions.loadSnapshot(options.sourceSessionId)!
			: (
					await runner.createSession({
						principalId: "fixture",
						idempotencyKey: randomUUID(),
						workspaceId: "local-workspace",
						name,
						model: { provider: "demo", id: "wuming-demo" },
						thinkingLevel: "off",
						sandboxMode: "read_only",
						approvalPolicy: "on_risk",
					})
				).snapshot;
		const lead = snapshot.session.id;
		const tool = createAgentTeamTools(lead, service).find((value) => value.name === "TeamCreate")!;
		await tool.execute(
			randomUUID(),
			{ objective: "Review a feature with two teammates", name },
			new AbortController().signal,
			undefined,
			undefined as never
		);
		if (options.archiveSource)
			await runner.archiveSession({
				principalId: "fixture",
				idempotencyKey: randomUUID(),
				sessionId: lead,
				archived: true,
			});
		return lead;
	} finally {
		service.pause();
		await service.settled();
		store.close();
		sessions.close();
	}
}

/** Isolated scripted runtime fixture; never calls a model or changes application source files. */
export async function seedAgentTeam(data: string, template?: AgentTemplateConfig): Promise<string> {
	await mkdir(data, { recursive: true });
	const sessions = new SqliteOrchestratorStore(join(data, "wuming.db"));
	const store = new AgentTeamStore(join(data, "agent-teams.db"));
	let service: AgentTeamService;
	let lead: string;
	const runtime: AgentRuntime = {
		async executeTurn(input) {
			const sessionId = input.operation.sessionId;
			const team = service.get(lead)!;
			const member = team.members.find((value) => value.sessionId === sessionId)!;
			const task = team.tasks.find((value) => value.owner === member.id && value.status === "in_progress");
			if (task) {
				if (task.title === "接口契约")
					service.send(
						sessionId,
						team.members.find((value) => value.name === "前端工程师")!.id,
						"接口契约已就绪：GET /health 返回 { status: 'ok' }。",
						"contract"
					);
				service.updateTask(
					sessionId,
					{
						taskId: task.id,
						status: "completed",
						result: "隔离测试结果：契约校验通过，任务输出已记录。此记录由脚本运行时生成，未调用真实模型。",
					},
					`done:${task.id}`
				);
			}
			return {
				items: [
					{
						id: randomUUID(),
						type: "assistant",
						createdAt: Date.now(),
						status: "complete",
						content: [{ type: "text", text: "隔离团队测试回合完成。" }],
						model: input.snapshot.model,
					},
				],
				usage: {
					inputTokens: 20,
					outputTokens: 10,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 30,
					costUsd: 0,
				},
			};
		},
	};
	const runner = new SessionOrchestrator(sessions, runtime);
	service = new AgentTeamService(store, runner);
	try {
		const created = await runner.createSession({
			principalId: "fixture",
			idempotencyKey: "lead",
			workspaceId: "local-workspace",
			name: "团队协作隔离验收",
			model: { provider: "demo", id: "wuming-demo" },
			thinkingLevel: "off",
			sandboxMode: "read_only",
			approvalPolicy: "on_risk",
		});
		const team = await service.start(
			created.snapshot.session.id,
			"隔离测试：后端定义接口契约，前端实现状态视图，完成后执行集成验证。",
			"协作验收 · 测试数据",
			false
		);
		lead = team.sessionId;
		if (template) service.templates.save("local-workspace", "project", template, 0);
		const backend = await service.addMember(
			lead,
			"后端工程师",
			"接口契约与服务实现",
			"backend",
			template ? { templateName: template.name } : {}
		);
		const frontend = await service.addMember(lead, "前端工程师", "状态视图与交互", "frontend");
		const a = service.createTask(
			lead,
			{
				title: "接口契约",
				description: "定义健康检查响应并提交契约检查结果。",
				owner: backend.id,
				writePaths: ["server"],
			},
			"a"
		);
		const b = service.createTask(
			lead,
			{ title: "状态视图", description: "实现状态面板，与后端确认接口字段。", owner: frontend.id, writePaths: ["web"] },
			"b"
		);
		service.createTask(
			lead,
			{
				title: "集成验证",
				description: "依赖前后端输出，验证响应和界面状态一致。",
				dependsOn: [a.id, b.id],
				writePaths: ["tests"],
			},
			"c"
		);
		for (let i = 0; i < 12; i++) {
			service.tick();
			await service.settled();
		}
		service.finish(
			lead,
			"隔离验收通过：两个常驻成员完成三个任务，点对点消息已送达，依赖任务完成后由负责人收口。未调用付费模型。",
			"finish"
		);
		return lead;
	} finally {
		service.pause();
		await service.settled();
		store.close();
		sessions.close();
	}
}

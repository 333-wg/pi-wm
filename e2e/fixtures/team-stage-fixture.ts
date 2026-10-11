import { join } from "node:path";
import { AgentTeamStore } from "../../apps/gateway/src/agent-team-store.js";
import { seedAgentTeam } from "./agent-team-fixture.js";

/** Extend an isolated completed fixture with recorded handoffs; never execute a model. */
export async function seedTeamStages(data: string): Promise<string> {
	const sessionId = await seedAgentTeam(data);
	const store = new AgentTeamStore(join(data, "agent-teams.db"));
	try {
		const team = store.get(sessionId)!;
		store.change(team.id, (frame) => {
			const owner = frame.members.find((member) => member.name === "后端工程师")!.id;
			// The scripted scheduler may claim integration with any idle member. Pin this visual fixture's handoff.
			frame.tasks.find((task) => task.title === "集成验证")!.owner = frame.members.find((member) => member.lead)!.id;
			const base = { ...frame.tasks[0]! };
			delete base.result;
			const time = Math.max(...frame.tasks.map((task) => task.updatedAt)) + 100;
			frame.tasks.push(
				{
					...base,
					id: "stage-followup",
					title: "后续修复",
					description: "同一成员完成上一任务后接收修复，不声明调度依赖。",
					owner,
					dependsOn: [],
					createdAt: time,
					updatedAt: time + 100,
					status: "completed",
				},
				{
					...base,
					id: "stage-review",
					title: "回归验收",
					description: "复核后续修复成果，展示正在执行的链路。",
					owner,
					dependsOn: ["stage-followup"],
					createdAt: time + 200,
					updatedAt: time + 300,
					status: "in_progress",
				},
				{
					...base,
					id: "stage-release",
					title: "最终交付",
					description: "等待回归验收后汇总交付。",
					owner,
					dependsOn: ["stage-review"],
					createdAt: time + 400,
					updatedAt: time + 400,
					status: "pending",
				}
			);
			frame.result = "阶段展示隔离样例：已停止调度，状态仅用于 UI 验证。";
		});
		return sessionId;
	} finally {
		store.close();
	}
}

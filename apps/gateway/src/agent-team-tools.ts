import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentTemplateNameSchema, AgentTemplateModelSchema, AgentTemplateThinkingSchema } from "@wuming/protocol";
import type { AgentTeamService } from "./agent-teams.js";

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Text = Type.String({ minLength: 1, maxLength: 20_000 });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

export function createAgentTeamTools(sessionId: string, service: AgentTeamService): ToolDefinition[] {
	return [
		defineTool({
			name: "AgentTemplates",
			label: "AgentTemplates",
			description:
				"List effective reusable Agent role templates for this workspace, including instructions, model, effort and domain tool policy. User templates override same-name project templates, then builtin templates; shadowed entries are omitted. These are candidates, not a mandatory roster. Reuse suitable templates; create task-specific roles with Agent without templateName when none fit. Explicit user member/role assignments take precedence. Listing does not create a team or member.",
			parameters: Type.Object({}),
			execute: async () => {
				const snapshot = service.runner.store.loadSnapshot(sessionId);
				if (!snapshot) throw new Error("Session not found");
				return result(service.templates.effective(snapshot.session.workspaceId));
			},
		}),
		defineTool({
			name: "TeamCreate",
			label: "TeamCreate",
			description:
				"Launch an independent project-level Agent Team when the user's actual intent is to perform a task using team collaboration, including natural-language requests. Mere keywords, quotes, negation or questions about the feature do not authorize launch. Creates a dedicated lead, shared board and durable mailboxes. The lead chooses and creates suitable teammates and assigns work asynchronously, even without configured templates. This chat is only the launcher, NOT a member: after success report the team ID and return to the user; do not call Agent/TaskCreate from this chat. Include all requirements, explicit member/role assignments, exclusive-roster constraints and model choices in objective. Multiple distinct requests may launch teams; do not duplicate a successful host or tool launch.",
			parameters: Type.Object({ objective: Text, name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) }),
			execute: async (id, input) =>
				result(await service.start(sessionId, input.objective, input.name, true, `tool:${id}`)),
		}),
		defineTool({
			name: "Agent",
			label: "Agent",
			description:
				"Team lead: proactively create a persistent teammate whenever useful independent implementation, repair or verification needs capacity or expertise, at startup or later; do not wait for a user reminder. Reuse suitable retained members first, respect exclusive rosters and the 8-member limit including lead, and avoid duplicate roles without distinct work. Without templateName, role defines a task-specific member; no saved template or user setup is required. Optional templateName reuses a suitable configuration from AgentTemplates. Preserve explicit user member/role assignments; never replace a named template silently or bypass its tool limits. Explicit model/thinkingLevel overrides template values, otherwise inherit the lead. Template prompt, tools and color are frozen on creation. Returns immediately; create and explicitly assign the first task with TaskCreate/TaskUpdate so work can start. Members retain sessions and run concurrently; this does not wait for a report.",
			parameters: Type.Object({
				name: Type.String({ minLength: 1, maxLength: 80 }),
				role: Text,
				templateName: Type.Optional(AgentTemplateNameSchema),
				model: Type.Optional(AgentTemplateModelSchema),
				thinkingLevel: Type.Optional(AgentTemplateThinkingSchema),
			}),
			execute: async (id, input) =>
				result(await service.addMember(sessionId, input.name, input.role, `tool:${sessionId}:${id}`, input)),
		}),
		defineTool({
			name: "TaskCreate",
			label: "TaskCreate",
			description:
				"Create a shared team task for real deliverables throughout research, implementation, repair and verification. Lead should explicitly assign every teammate's first task and give suitable retained members owned follow-up tasks instead of taking over after research. Include concrete output and acceptance criteria; coding assignments require direct file edits, changed paths and check results. Declare dependency task IDs and disjoint workspace-relative writePaths (files/directories, no globs). Prefer explicit owners for specialized work: unowned tasks can be auto-claimed by any activated idle teammate. Task creation alone does not signal completion.",
			parameters: Type.Object({
				title: Type.String({ minLength: 1, maxLength: 500 }),
				description: Text,
				owner: Type.Optional(Id),
				dependsOn: Type.Optional(Type.Array(Id, { maxItems: 100 })),
				writePaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 })),
			}),
			execute: async (id, input) => result(service.createTask(sessionId, input, `tool:${sessionId}:${id}`)),
		}),
		defineTool({
			name: "TaskList",
			label: "TaskList",
			description:
				"Read the current team's shared task board and member IDs, including pending, in-progress, failed and completed tasks. This does not claim a task or wake another agent.",
			parameters: Type.Object({}),
			execute: async () => {
				const team = service.get(sessionId);
				return result(
					team
						? {
								status: team.status,
								members: team.members,
								tasks: team.tasks.map((task) => ({
									id: task.id,
									title: task.title,
									status: task.status,
									owner: task.owner,
									dependsOn: task.dependsOn,
									writePaths: task.writePaths,
								})),
							}
						: { error: "No team; call TeamCreate first" }
				);
			},
		}),
		defineTool({
			name: "TaskGet",
			label: "TaskGet",
			description:
				"Read one task in your own team, including its detailed objective, dependencies, owner, write scope and result.",
			parameters: Type.Object({ taskId: Id }),
			execute: async (_id, input) =>
				result(service.get(sessionId)?.tasks.find((task) => task.id === input.taskId) ?? { error: "Unknown task" }),
		}),
		defineTool({
			name: "TaskUpdate",
			label: "TaskUpdate",
			description:
				"Update a shared task. Only the lead can reassign pending tasks, change dependencies or reopen failed tasks. Only the owner or lead can complete/fail a claimed task; result must contain concrete output and verification evidence. in_progress claims atomically and rejects unmet dependencies, scope conflicts and busy owners. Never mark a task complete just because you sent a message.",
			parameters: Type.Object({
				taskId: Id,
				owner: Type.Optional(Id),
				status: Type.Optional(
					Type.Union([
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("completed"),
						Type.Literal("failed"),
					])
				),
				result: Type.Optional(Text),
				dependsOn: Type.Optional(Type.Array(Id, { maxItems: 100 })),
			}),
			execute: async (id, input) => result(service.updateTask(sessionId, input, `tool:${sessionId}:${id}`)),
		}),
		defineTool({
			name: "SendMessage",
			label: "SendMessage",
			description:
				"Send a real durable message to a member ID or 'all' for broadcast. Sender is derived from your session. Idle recipients are automatically woken; busy recipients receive mail on their next turn. Ordinary assistant text does NOT reach teammates. Avoid acknowledgement loops; send only actionable information.",
			parameters: Type.Object({ recipient: Id, text: Text }),
			execute: async (id, input) =>
				result({ messageIds: service.send(sessionId, input.recipient, input.text, `tool:${sessionId}:${id}`) }),
		}),
		defineTool({
			name: "TeamFinish",
			label: "TeamFinish",
			description:
				"Lead acceptance: complete a team only after every task is completed, teammates are idle, and pending mail has been delivered. Inspect and integrate actual outputs and run appropriate checks first. Supply the final result with concrete acceptance evidence. This stops automatic task claims and mailbox wakeups.",
			parameters: Type.Object({ result: Text }),
			execute: async (id, input) =>
				result({ result: service.finish(sessionId, input.result, `tool:${sessionId}:${id}`) }),
		}),
	];
}

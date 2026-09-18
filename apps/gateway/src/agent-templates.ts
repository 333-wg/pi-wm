import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { OrchestratorError } from "@wuming/orchestrator";
import { AgentTemplateConfigSchema, type AgentTemplate, type AgentTemplateConfig } from "@wuming/protocol";

const builtins: AgentTemplate[] = [
	{
		name: "general-purpose",
		description: "General implementation and multi-step project work",
		systemPrompt:
			"Implement the assigned task, respect ownership boundaries and verify concrete outputs before reporting completion.",
		tools: { mode: "all" },
		color: "green",
		scope: "builtin",
		revision: 0,
		updatedAt: 0,
	},
	{
		name: "explore",
		description: "Read-only code exploration and architecture investigation",
		systemPrompt:
			"Investigate the assigned question using read and search tools. Cite file paths and evidence. Do not modify files or delegate to another agent.",
		tools: { mode: "custom", names: ["read_file", "grep", "glob", "ls", "environment_status"] },
		color: "blue",
		scope: "builtin",
		revision: 0,
		updatedAt: 0,
	},
	{
		name: "reviewer",
		description: "Read-only review of correctness, security and regression risks",
		systemPrompt:
			"Review the assigned code. Report concrete issues ordered by severity, with paths, evidence and missing tests. Do not modify files. Do not claim tests were executed when they were not.",
		tools: { mode: "custom", names: ["read_file", "grep", "glob", "ls"] },
		color: "amber",
		scope: "builtin",
		revision: 0,
		updatedAt: 0,
	},
];
export const TEAM_COORDINATION_TOOLS = new Set(["TaskList", "TaskGet", "TaskUpdate", "SendMessage"]);
const restrictedBypassTools = new Set([
	"Agent",
	"TeamCreate",
	"TeamFinish",
	"TaskCreate",
	"AgentTemplates",
	"subagent",
	"skill_install",
	"skill_uninstall",
	"skill_set_enabled",
	"mcp_configure",
	"mcp_trust",
	"mcp_untrust",
]);

/** Restricts registered tools, not only the prompt. Coordination remains available. */
export function filterAgentTools<T extends { name: string }>(tools: T[], template?: AgentTemplate): T[] {
	if (!template || template.tools.mode === "all") return tools;
	const allowed = new Set(template.tools.mode === "custom" ? template.tools.names : []);
	return tools.filter(
		(tool) =>
			TEAM_COORDINATION_TOOLS.has(tool.name) || (allowed.has(tool.name) && !restrictedBypassTools.has(tool.name))
	);
}

export class AgentTemplateCatalog {
	constructor(readonly db: DatabaseSync) {
		db.exec(
			"CREATE TABLE IF NOT EXISTS agent_templates(scope_key TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(scope_key,name))"
		);
	}
	list(workspaceId: string): AgentTemplate[] {
		const rows = this.db
			.prepare("SELECT state FROM agent_templates WHERE scope_key IN (?,?) ORDER BY name")
			.all("user", `project:${workspaceId}`);
		return [...rows.map((row) => JSON.parse(String(row.state)) as AgentTemplate), ...structuredClone(builtins)];
	}
	resolve(workspaceId: string, name: string): AgentTemplate {
		const template = this.effective(workspaceId).find((item) => item.name === name);
		if (!template) throw new OrchestratorError("not_found", `Unknown Agent template: ${name}`);
		return template;
	}
	effective(workspaceId: string): AgentTemplate[] {
		const priority = { user: 0, project: 1, builtin: 2 };
		const templates = new Map<string, AgentTemplate>();
		for (const template of this.list(workspaceId).sort((a, b) => priority[a.scope] - priority[b.scope]))
			if (!templates.has(template.name)) templates.set(template.name, template);
		return [...templates.values()];
	}
	save(workspaceId: string, scope: "user" | "project", input: AgentTemplateConfig, expectedRevision: number): void {
		if (!Value.Check(AgentTemplateConfigSchema, input) || !input.description.trim() || !input.systemPrompt.trim())
			throw new OrchestratorError("conflict", "Invalid Agent template configuration");
		if (input.tools.mode === "custom" && input.tools.names.some((name) => restrictedBypassTools.has(name)))
			throw new OrchestratorError(
				"conflict",
				"Restricted Agent templates cannot delegate or change tool configuration"
			);
		const key = scope === "user" ? "user" : `project:${workspaceId}`;
		if (
			expectedRevision === 0 &&
			Number(this.db.prepare("SELECT count(*) AS count FROM agent_templates WHERE scope_key=?").get(key)?.count) >= 100
		)
			throw new OrchestratorError("conflict", "At most 100 Agent templates per scope");
		const state: AgentTemplate = {
			...input,
			description: input.description.trim(),
			systemPrompt: input.systemPrompt.trim(),
			scope,
			revision: expectedRevision + 1,
			updatedAt: Date.now(),
		};
		const result =
			expectedRevision === 0
				? this.db
						.prepare("INSERT OR IGNORE INTO agent_templates VALUES(?,?,?)")
						.run(key, input.name, JSON.stringify(state))
				: this.db
						.prepare(
							"UPDATE agent_templates SET state=? WHERE scope_key=? AND name=? AND json_extract(state,'$.revision')=?"
						)
						.run(JSON.stringify(state), key, input.name, expectedRevision);
		if (result.changes !== 1) throw new OrchestratorError("conflict", "Agent template changed; refresh before saving");
	}
	delete(workspaceId: string, scope: "user" | "project", name: string, expectedRevision: number): void {
		const result = this.db
			.prepare("DELETE FROM agent_templates WHERE scope_key=? AND name=? AND json_extract(state,'$.revision')=?")
			.run(scope === "user" ? "user" : `project:${workspaceId}`, name, expectedRevision);
		if (result.changes !== 1)
			throw new OrchestratorError("conflict", "Agent template changed; refresh before deleting");
	}
}

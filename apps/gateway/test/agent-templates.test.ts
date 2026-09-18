import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { CommandSchema, type AgentTemplate, type AgentTemplateConfig } from "@wuming/protocol";
import { AgentTemplateCatalog, filterAgentTools } from "../src/agent-templates.js";

const config: AgentTemplateConfig = {
	name: "reviewer",
	description: "Review API",
	systemPrompt: "Report concrete defects",
	tools: { mode: "none" },
	color: "blue",
};

describe("Agent template catalog", () => {
	it("resolves user over project over builtin and isolates project templates", () => {
		using db = new DatabaseSync(":memory:");
		const catalog = new AgentTemplateCatalog(db);
		expect(catalog.resolve("one", "reviewer").scope).toBe("builtin");
		catalog.save("one", "project", config, 0);
		expect(catalog.resolve("one", "reviewer")).toMatchObject({ scope: "project", revision: 1 });
		expect(catalog.resolve("two", "reviewer").scope).toBe("builtin");
		catalog.save("one", "user", { ...config, description: "User preference" }, 0);
		expect(catalog.resolve("one", "reviewer").scope).toBe("user");
		expect(catalog.resolve("two", "reviewer").description).toBe("User preference");
		catalog.delete("two", "user", "reviewer", 1);
		expect(catalog.resolve("one", "reviewer").scope).toBe("project");
		expect(catalog.resolve("two", "reviewer").scope).toBe("builtin");
	});
	it("persists edits with optimistic concurrency and leaves builtins unchanged", () => {
		using db = new DatabaseSync(":memory:");
		const catalog = new AgentTemplateCatalog(db);
		catalog.save("one", "user", config, 0);
		expect(() => catalog.save("one", "user", config, 0)).toThrow(/refresh/);
		catalog.save("one", "user", { ...config, systemPrompt: "Updated" }, 1);
		expect(() => catalog.delete("one", "user", "reviewer", 1)).toThrow(/refresh/);
		const reopened = new AgentTemplateCatalog(db);
		expect(reopened.resolve("one", "reviewer").systemPrompt).toBe("Updated");
		expect(
			reopened.list("one").find((item) => item.scope === "builtin" && item.name === "reviewer")?.systemPrompt
		).not.toBe("Updated");
	});
	it("exposes only effective candidates to models while preserving all settings entries", () => {
		using db = new DatabaseSync(":memory:");
		const catalog = new AgentTemplateCatalog(db);
		catalog.save("one", "project", { ...config, description: "Project reviewer" }, 0);
		catalog.save("one", "user", { ...config, description: "User reviewer" }, 0);
		catalog.save("two", "project", { ...config, name: "other-project" }, 0);
		expect(catalog.list("one").filter((item) => item.name === "reviewer")).toHaveLength(3);
		expect(catalog.effective("one").filter((item) => item.name === "reviewer")).toEqual([
			expect.objectContaining({ scope: "user", description: "User reviewer", tools: { mode: "none" } }),
		]);
		expect(catalog.effective("one").some((item) => item.name === "other-project")).toBe(false);
		for (const template of catalog.effective("one")) expect(template).toEqual(catalog.resolve("one", template.name));
	});
	it("rejects invalid templates and disallows delegation in restricted policies", () => {
		using db = new DatabaseSync(":memory:");
		const catalog = new AgentTemplateCatalog(db);
		for (const input of [
			{ ...config, name: "../bad" },
			{ ...config, systemPrompt: " " },
			{ ...config, tools: { mode: "custom" as const, names: ["subagent"] } },
		])
			expect(() => catalog.save("one", "user", input, 0)).toThrow();
		expect(
			Value.Check(CommandSchema, {
				type: "agent.template.save",
				workspaceId: "one",
				scope: "builtin",
				template: config,
				expectedRevision: 0,
			})
		).toBe(false);
		expect(
			Value.Check(CommandSchema, {
				type: "agent.template.save",
				workspaceId: "one",
				scope: "user",
				template: { ...config, thinkingLevel: "max" },
				expectedRevision: 0,
			})
		).toBe(true);
	});
	it("filters actual registrations, always keeps coordination, and rejects bypasses even in historical policies", () => {
		const tools = [
			"read_file",
			"write_file",
			"exec",
			"subagent",
			"Agent",
			"TaskList",
			"TaskGet",
			"TaskUpdate",
			"SendMessage",
			"skill_install",
			"mcp_configure",
			"mcp__example__read",
		].map((name) => ({ name }));
		const template: AgentTemplate = { ...config, scope: "user", revision: 1, updatedAt: 1 };
		expect(filterAgentTools(tools, template).map((item) => item.name)).toEqual([
			"TaskList",
			"TaskGet",
			"TaskUpdate",
			"SendMessage",
		]);
		expect(
			filterAgentTools(tools, {
				...template,
				tools: { mode: "custom", names: ["read_file", "subagent", "Agent", "mcp_configure", "mcp__example__read"] },
			}).map((item) => item.name)
		).toEqual(["read_file", "TaskList", "TaskGet", "TaskUpdate", "SendMessage", "mcp__example__read"]);
		expect(filterAgentTools(tools, { ...template, tools: { mode: "all" } })).toEqual(tools);
		expect(filterAgentTools(tools)).toEqual(tools);
	});
});

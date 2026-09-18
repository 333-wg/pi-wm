import Type, { type Static } from "typebox";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 200 });
export const AgentTemplateNameSchema = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" });
export const AgentTemplateModelSchema = object({ provider: id, id });
export const AgentTemplateThinkingSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export const AgentTemplateToolsSchema = Type.Union([
	object({ mode: Type.Literal("all") }),
	object({ mode: Type.Literal("none") }),
	object({
		mode: Type.Literal("custom"),
		names: Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_:-]{0,199}$" }), {
			maxItems: 100,
			uniqueItems: true,
		}),
	}),
]);
export const AgentTemplateConfigSchema = object({
	name: AgentTemplateNameSchema,
	description: Type.String({ minLength: 1, maxLength: 2000 }),
	systemPrompt: Type.String({ minLength: 1, maxLength: 16000 }),
	model: Type.Optional(AgentTemplateModelSchema),
	thinkingLevel: Type.Optional(AgentTemplateThinkingSchema),
	tools: AgentTemplateToolsSchema,
	color: Type.Union([
		Type.Literal("green"),
		Type.Literal("blue"),
		Type.Literal("amber"),
		Type.Literal("red"),
		Type.Literal("purple"),
		Type.Literal("cyan"),
	]),
});
export const AgentTemplateSchema = object({
	...AgentTemplateConfigSchema.properties,
	scope: Type.Union([Type.Literal("builtin"), Type.Literal("user"), Type.Literal("project")]),
	revision: Type.Integer({ minimum: 0 }),
	updatedAt: Type.Integer({ minimum: 0 }),
});
export type AgentTemplateConfig = Static<typeof AgentTemplateConfigSchema>;
export type AgentTemplate = Static<typeof AgentTemplateSchema>;
const scope = Type.Union([Type.Literal("user"), Type.Literal("project")]);
export const AgentTemplateCommandSchemas = [
	object({ type: Type.Literal("agent.template.list"), workspaceId: id }),
	object({
		type: Type.Literal("agent.template.save"),
		workspaceId: id,
		scope,
		template: AgentTemplateConfigSchema,
		expectedRevision: Type.Integer({ minimum: 0 }),
	}),
	object({
		type: Type.Literal("agent.template.delete"),
		workspaceId: id,
		scope,
		name: AgentTemplateNameSchema,
		expectedRevision: Type.Integer({ minimum: 1 }),
	}),
] as const;
export const AgentTemplateResultSchema = object({
	type: Type.Literal("agent.templates"),
	templates: Type.Array(AgentTemplateSchema),
	canEditUser: Type.Boolean(),
	canEditProject: Type.Boolean(),
});

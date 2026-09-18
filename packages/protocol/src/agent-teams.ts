import Type, { type Static } from "typebox";
import { ArtifactRefSchema } from "./artifact-ref.js";
import { AgentTemplateSchema, AgentTemplateModelSchema, AgentTemplateThinkingSchema } from "./agent-templates.js";

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Text = Type.String({ minLength: 1, maxLength: 20_000 });
const ObjectSchema = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const AgentTeamTaskSchema = ObjectSchema({
	id: Id,
	title: Type.String({ minLength: 1, maxLength: 500 }),
	description: Text,
	status: Type.Union([
		Type.Literal("pending"),
		Type.Literal("in_progress"),
		Type.Literal("completed"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
	]),
	owner: Type.Optional(Id),
	dependsOn: Type.Array(Id, { maxItems: 100, uniqueItems: true }),
	writePaths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
	result: Type.Optional(Text),
	createdAt: Type.Integer(),
	updatedAt: Type.Integer(),
});
export const AgentTeamMemberSchema = ObjectSchema({
	id: Id,
	name: Type.String({ minLength: 1, maxLength: 80 }),
	role: Text,
	template: Type.Optional(AgentTemplateSchema),
	model: Type.Optional(AgentTemplateModelSchema),
	thinkingLevel: Type.Optional(AgentTemplateThinkingSchema),
	sessionId: Id,
	deliveryId: Type.Optional(Id),
	lead: Type.Boolean(),
	activated: Type.Boolean(),
	state: Type.Union([
		Type.Literal("idle"),
		Type.Literal("working"),
		Type.Literal("awaiting_approval"),
		Type.Literal("error"),
		Type.Literal("stopped"),
	]),
	error: Type.Optional(Type.String()),
	costUsd: Type.Number(),
	totalTokens: Type.Number(),
});
export const AgentTeamMessageSchema = ObjectSchema({
	id: Id,
	from: Id,
	to: Id,
	text: Text,
	artifacts: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 31 })),
	createdAt: Type.Integer(),
	kind: Type.Union([
		Type.Literal("message"),
		Type.Literal("assignment"),
		Type.Literal("result"),
		Type.Literal("system"),
	]),
	delivery: Type.Union([Type.Literal("pending"), Type.Literal("delivered"), Type.Literal("cancelled")]),
	deliveredAt: Type.Optional(Type.Integer()),
});
export const AgentTeamSchema = ObjectSchema({
	id: Id,
	sessionId: Id,
	workspaceId: Type.Optional(Id),
	sourceSessionId: Type.Optional(Id),
	launchId: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
	name: Type.String(),
	objective: Text,
	revision: Type.Integer(),
	status: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("stopped")]),
	createdAt: Type.Integer(),
	updatedAt: Type.Integer(),
	members: Type.Array(AgentTeamMemberSchema),
	endedAt: Type.Optional(Type.Integer()),
	tasks: Type.Array(AgentTeamTaskSchema),
	messages: Type.Array(AgentTeamMessageSchema),
	startup: Type.Optional(ObjectSchema({ reminders: Type.Integer({ minimum: 0, maximum: 1 }) })),
	result: Type.Optional(Text),
});
export type AgentTeam = Static<typeof AgentTeamSchema>;
export type AgentTeamMember = Static<typeof AgentTeamMemberSchema>;
export type AgentTeamTask = Static<typeof AgentTeamTaskSchema>;
export type AgentTeamMessage = Static<typeof AgentTeamMessageSchema>;

export const AgentTeamSummarySchema = ObjectSchema({
	id: Id,
	sessionId: Id,
	workspaceId: Type.Optional(Id),
	sourceSessionId: Type.Optional(Id),
	name: Type.String(),
	status: AgentTeamSchema.properties.status,
	createdAt: Type.Integer(),
	archived: Type.Boolean(),
});
export type AgentTeamSummary = Static<typeof AgentTeamSummarySchema>;

export const AgentTeamCommandSchemas = [
	ObjectSchema({ type: Type.Literal("team.list"), workspaceId: Id }),
	ObjectSchema({
		type: Type.Literal("team.get"),
		teamId: Type.Optional(Id),
		sessionId: Type.Optional(Id),
		revision: Type.Optional(Type.Integer({ minimum: 1 })),
	}),
	ObjectSchema({
		type: Type.Literal("team.start"),
		sessionId: Id,
		objective: Text,
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
	}),
	ObjectSchema({
		type: Type.Literal("team.message"),
		teamId: Type.Optional(Id),
		sessionId: Type.Optional(Id),
		recipient: Id,
		text: Text,
	}),
	ObjectSchema({ type: Type.Literal("team.stop"), teamId: Type.Optional(Id), sessionId: Type.Optional(Id) }),
	ObjectSchema({
		type: Type.Literal("team.retry"),
		teamId: Type.Optional(Id),
		sessionId: Type.Optional(Id),
		memberId: Id,
	}),
] as const;
export const AgentTeamResultSchema = ObjectSchema({
	type: Type.Literal("team.snapshot"),
	team: Type.Union([AgentTeamSchema, Type.Null()]),
});
export const AgentTeamListResultSchema = ObjectSchema({
	type: Type.Literal("team.list"),
	teams: Type.Array(AgentTeamSummarySchema),
});

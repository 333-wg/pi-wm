import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "@wuming/artifacts";
import { ContextEngine, type ContextFragment } from "@wuming/context-engine";
import { buildWumingSystemPrompt } from "@wuming/pi-adapter";
import type { AgentTemplate, SessionSnapshot } from "@wuming/protocol";
import { createComputerTools, WindowsComputerManager, type ApprovalBroker } from "@wuming/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { filterAgentTools } from "../src/agent-templates.js";
import { computerRoutingFragment } from "../src/computer-routing.js";
import { MediaGenerationService } from "../src/media-generation.js";
import { MediaModelRegistry } from "../src/media-models.js";
import { adaptMediaSkillContent, mediaSkillRoutingFragment, mediaStatusFragment } from "../src/media-skill-policy.js";

const snapshot: SessionSnapshot = {
	session: { id: "session", workspaceId: "workspace", phase: "turn", createdAt: 1, updatedAt: 1 },
	revision: 1,
	model: { provider: "fixture", id: "fixture" },
	thinkingLevel: "off",
	sandboxMode: "workspace_write",
	approvalPolicy: "never",
	transcript: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	pendingApprovals: [],
	usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
};
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function restricted(tools: ToolDefinition[], names: string[]) {
	const template: AgentTemplate = {
		name: "restricted",
		description: "Restricted test member",
		systemPrompt: "Use available tools only.",
		tools: { mode: "custom", names },
		color: "blue",
		scope: "project",
		revision: 1,
		updatedAt: 0,
	};
	return filterAgentTools(tools, template);
}

function assemble(tools: ToolDefinition[], fragments: ContextFragment[]) {
	const result = new ContextEngine().assemble({
		workspaceId: "workspace",
		sessionId: "session",
		operationId: "operation",
		model: snapshot.model,
		query: "inspect",
		baseSystemPrompt: buildWumingSystemPrompt({
			tools,
			sandboxMode: snapshot.sandboxMode,
			approvalPolicy: snapshot.approvalPolicy,
		}),
		fragments,
		appendReferenceContext: true,
		budget: { contextWindowTokens: 128000, userInputTokens: 10, reservedOutputTokens: 2048, maxSystemTokens: 32000 },
	});
	expect(result.plan.omitted).toEqual([]);
	return [result.systemPrompt, result.referencePrompt, ...tools.map((tool) => tool.description)].join("\n");
}

it("keeps final computer context and real tool descriptions consistent across all restricted subsets", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-routing-computer-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const runner = vi.fn().mockRejectedValue(new Error("Desktop execution is forbidden in this test"));
	const manager = new WindowsComputerManager({ runtimeDirectory: root, platform: "win32", runner });
	cleanups.push(() => manager[Symbol.asyncDispose]());
	const tools = createComputerTools(manager, { snapshot, approvals: {} as ApprovalBroker });
	const names = tools.map((tool) => tool.name);
	for (let mask = 0; mask < 2 ** names.length; mask++) {
		const selected = restricted(
			tools,
			names.filter((_, index) => mask & (1 << index))
		);
		const available = new Set(selected.map((tool) => tool.name));
		const routing = computerRoutingFragment(available);
		const prompt = assemble(selected, routing ? [routing] : []);
		for (const name of names.filter((name) => !available.has(name))) expect(prompt).not.toContain(name);
		if (available.size) {
			expect(routing?.content).toContain("Never replay unknown input");
			expect(routing?.content).not.toContain("Load an applicable computer-use skill");
		} else expect(routing).toBeUndefined();
		if (available.has("computer_screenshot")) expect(routing?.content).toContain("inspect the image yourself");
		if (available.has("computer_element_action")) expect(routing?.content).toContain("fresh observed element refs");
	}
	expect(runner).not.toHaveBeenCalled();
});

it("keeps final media context, real tool definitions and status results consistent across all restricted subsets", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-routing-media-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const models = new MediaModelRegistry({ filePath: join(root, "models.enc"), encryptionKey: "test-only-key" });
	const artifacts = await ArtifactStore.open(join(root, "artifacts.db"), join(root, "objects"));
	cleanups.push(() => artifacts.close());
	const fetch = vi.fn().mockRejectedValue(new Error("Network execution is forbidden in this test"));
	const service = new MediaGenerationService({ models, artifacts, databasePath: join(root, "jobs.db"), fetch });
	cleanups.push(() => service.close());
	let available: ReadonlySet<string> = new Set();
	const tools = service.createTools(snapshot, {} as ApprovalBroker, () => available);
	const names = tools.map((tool) => tool.name);
	for (let mask = 0; mask < 2 ** names.length; mask++) {
		const selected = restricted(
			tools,
			names.filter((_, index) => mask & (1 << index))
		);
		available = new Set(selected.map((tool) => tool.name));
		const routing = mediaSkillRoutingFragment(available);
		const prompt = assemble(selected, [
			routing,
			mediaStatusFragment(models.list(), available),
			{
				id: "skill:selected",
				version: "1",
				kind: "skill",
				source: "fixture",
				required: true,
				content: adaptMediaSkillContent("Preserve the creative workflow.", models.list(), {
					availableTools: available,
				}),
			},
		]);
		const statusTool = selected.find((tool) => tool.name === "media_model_status");
		const status = statusTool
			? JSON.stringify(await statusTool.execute("status", {}, undefined, undefined, undefined as never))
			: "";
		for (const name of names.filter((name) => !available.has(name))) expect(prompt + status).not.toContain(name);
		expect(routing.content).toContain("Do not ask the user for another API key");
		expect(routing.content).toContain(
			"After a submitted generation fails, report the error and wait for user direction"
		);
		if (available.has("generate_image") && !available.has("get_generated_image"))
			expect(routing.content).toContain("Image retrieval is unavailable");
		if (available.has("get_generated_video")) expect(routing.content).toContain("returned jobId");
	}
	expect(fetch).not.toHaveBeenCalled();
});

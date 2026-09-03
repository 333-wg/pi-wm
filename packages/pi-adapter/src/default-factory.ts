import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	type SessionEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionSnapshot } from "@wuming/protocol";
import { Value } from "typebox/value";
import { buildWumingSystemPrompt } from "./system-prompt.js";
import type { PiProviderRegistration, PiSessionFactory, WorkspaceResolver } from "./types.js";

export interface DefaultPiSessionFactoryOptions {
	agentDir: string;
	sessionDataDir: string;
	resolveWorkspace: WorkspaceResolver;
	createCustomTools?: (snapshot: SessionSnapshot) => ToolDefinition[] | Promise<ToolDefinition[]>;
	autoRetry?: boolean;
	initialToolChoice?: "required";
	registerProviders?: () => PiProviderRegistration[] | Promise<PiProviderRegistration[]>;
	/**
	 * Replaces the Wuming coding-agent system prompt. Returning undefined falls
	 * back to Pi's own default prompt, which describes Pi's tool names rather than
	 * Wuming's — useful for comparison, rarely what a deployment wants.
	 */
	buildSystemPrompt?: (input: { snapshot: SessionSnapshot; tools: ToolDefinition[]; cwd: string }) => string | undefined;
}

function sessionDirectory(root: string, sessionId: string): string {
	const safeName = createHash("sha256").update(sessionId).digest("hex");
	return join(root, safeName);
}

function interruptionText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") {
		if (message.stopReason === "aborted") return "aborted";
		if (message.stopReason === "error") return message.errorMessage;
	}
	if (message.role === "toolResult" && message.isError) {
		return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	}
	return undefined;
}

/**
 * Pi persists interrupted provider/tool messages in its append-only log. Keep
 * those entries for diagnostics, but move the active leaf back before the user
 * request that started the interrupted turn so the next prompt cannot resume it.
 */
export function recoverInterruptedSession(manager: SessionManager): boolean {
	let recovered = false;
	for (;;) {
		const branch = manager.getBranch();
		const lastMessageIndex = branch.findLastIndex((entry) => entry.type === "message");
		if (lastMessageIndex < 0) return recovered;
		const interruption = interruptionText(branch[lastMessageIndex]!);
		if (!interruption || !/abort|cancel/i.test(interruption)) return recovered;
		let userIndex = lastMessageIndex - 1;
		while (userIndex >= 0) {
			const entry = branch[userIndex]!;
			if (entry.type === "message" && entry.message.role === "user") break;
			userIndex -= 1;
		}
		if (userIndex < 0) return recovered;
		const user = branch[userIndex]!;
		if (user.parentId) manager.branch(user.parentId);
		else manager.resetLeaf();
		recovered = true;
	}
}

function defaultSystemPrompt(input: { snapshot: SessionSnapshot; tools: ToolDefinition[] }): string {
	return buildWumingSystemPrompt({
		tools: input.tools,
		sandboxMode: input.snapshot.sandboxMode,
		approvalPolicy: input.snapshot.approvalPolicy,
	});
}

export function createDefaultPiSessionFactory(options: DefaultPiSessionFactoryOptions): PiSessionFactory {
	return async (snapshot: SessionSnapshot) => {
		const cwd = await options.resolveWorkspace(snapshot.session.workspaceId);
		const sessionDir = sessionDirectory(options.sessionDataDir, snapshot.session.id);
		await mkdir(sessionDir, { recursive: true });
		// The tools come first because the system prompt describes them, and Pi builds
		// that prompt from the resource loader the services own.
		const customTools = (await options.createCustomTools?.(snapshot)) ?? [];
		const systemPrompt = (options.buildSystemPrompt ?? defaultSystemPrompt)({ snapshot, tools: customTools, cwd });
		const services = await createAgentSessionServices({
			cwd,
			agentDir: options.agentDir,
			resourceLoaderOptions: {
				noExtensions: true,
				noThemes: true,
				// Wuming resolves skills through its own catalog and injects the selected
				// ones per turn, so Pi's parallel skill injection would either duplicate
				// them or add skills the Wuming UI never showed.
				noSkills: true,
				// A project SYSTEM.md still wins; ours is the default, not an override.
				systemPromptOverride: (base) => base ?? systemPrompt,
			},
		});
		for (const registration of (await options.registerProviders?.()) ?? []) services.modelRuntime.registerProvider(registration.provider, registration.config);
		const model = services.modelRuntime.getModel(snapshot.model.provider, snapshot.model.id);
		if (!model) {
			const available = services.modelRuntime.getModels(snapshot.model.provider).map((candidate) => candidate.id).slice(0, 20);
			throw new Error(`Unknown Pi model ${snapshot.model.provider}/${snapshot.model.id}; configure it in the Pi models catalog or choose one of: ${available.join(", ") || "none"}`);
		}
		const sessionManager = SessionManager.continueRecent(cwd, sessionDir);
		recoverInterruptedSession(sessionManager);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model,
			thinkingLevel: snapshot.thinkingLevel,
			noTools: "builtin",
			customTools,
		});
		session.setAutoRetryEnabled(options.autoRetry ?? false);
		let initialToolChoicePending = options.initialToolChoice === "required";
		if (initialToolChoicePending) {
			const streamFunction = session.agent.streamFunction.bind(session.agent);
			session.agent.streamFunction = (streamModel, context, streamOptions) => {
				const requireTool = initialToolChoicePending && (context.tools?.length ?? 0) > 0;
				initialToolChoicePending = false;
				const selectedModel = requireTool
					? {
						...streamModel,
						samplingParams: { ...streamModel.samplingParams, tool_choice: "required" },
					}
					: streamModel;
				return streamFunction(
					selectedModel,
					context,
					streamOptions,
				);
			};
		}
		const resumeApprovedTool = async (
			toolCallId: string,
			signal: AbortSignal,
			onUpdate?: (result: { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: unknown }) => void,
		): Promise<{ message: ToolResultMessage; input: unknown }> => {
			initialToolChoicePending = false;
			const messages = session.agent.state.messages;
			const assistant = [...messages].reverse().find((message): message is AssistantMessage =>
				message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === toolCallId),
			);
			if (!assistant || messages.at(-1) !== assistant) throw new Error(`Pending Pi tool call ${toolCallId} is not the active conversation leaf`);
			const call = assistant.content.find((part) => part.type === "toolCall" && part.id === toolCallId);
			if (!call || call.type !== "toolCall") throw new Error(`Pending Pi tool call ${toolCallId} was not found`);
			const tool = session.agent.state.tools.find((candidate) => candidate.name === call.name);
			if (!tool) throw new Error(`Pending Pi tool ${call.name} is no longer available`);
			const parameters = tool.prepareArguments?.(call.arguments) ?? call.arguments;
			if (!Value.Check(tool.parameters, parameters)) throw new Error(`Stored arguments for Pi tool ${call.name} are no longer valid`);
			let message: ToolResultMessage;
			try {
				const result = await tool.execute(toolCallId, parameters, signal, onUpdate);
				message = {
					role: "toolResult",
					toolCallId,
					toolName: call.name,
					content: result.content,
					details: result.details,
					...(result.usage ? { usage: result.usage } : {}),
					...(result.addedToolNames ? { addedToolNames: result.addedToolNames } : {}),
					isError: false,
					timestamp: Date.now(),
				};
			} catch (error) {
				const details = error && typeof error === "object" && "details" in error ? (error as { details?: unknown }).details : undefined;
				message = {
					role: "toolResult",
					toolCallId,
					toolName: call.name,
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					...(details === undefined ? {} : { details }),
					isError: true,
					timestamp: Date.now(),
				};
			}
			session.agent.state.messages = [...messages, message];
			session.sessionManager.appendMessage(message);
			if (signal.aborted) throw signal.reason;
			await session.agent.continue();
			return { message, input: parameters };
		};
		Object.assign(session, {
			prepareForPrompt: () => {
				if (!recoverInterruptedSession(sessionManager)) return;
				session.agent.state.messages = sessionManager.buildSessionContext().messages;
			},
			resumeApprovedTool,
			getSystemPrompt: () => session.agent.state.systemPrompt,
			setSystemPrompt: (prompt: string) => {
				session.agent.state.systemPrompt = prompt;
			},
		});
		return session;
	};
}

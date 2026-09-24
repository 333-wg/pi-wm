import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	type SessionEntry,
	type ToolDefinition,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, CacheRetention, ToolResultMessage } from "@earendil-works/pi-ai";
import { asCapabilityJson, type CapabilityManifest } from "@wuming/capability-kernel";
import type { SessionSnapshot } from "@wuming/protocol";
import { Value } from "typebox/value";
import { buildWumingSystemPrompt } from "./system-prompt.js";
import { ToolRecoveryMonitor } from "./tool-recovery.js";
import { stableToolDefinitions } from "./prompt-cache.js";
import { guardedModelStream } from "./model-stream.js";
import { PromptCacheObserver } from "./cache-diagnostics.js";
import { pendingReferenceMessage } from "./reference-context.js";
import { recoverDurableSession, requestDigest } from "./session-recovery.js";
import { persistHistoryBranch, sessionHistoryDirectory } from "./session-history.js";
import type { PiProviderRegistration, PiSessionFactory, PiSessionRecovery, WorkspaceResolver } from "./types.js";

export interface DefaultPiSessionFactoryOptions {
	agentDir: string;
	sessionDataDir: string;
	resolveWorkspace: WorkspaceResolver;
	createCustomTools?: (snapshot: SessionSnapshot) => ToolDefinition[] | Promise<ToolDefinition[]>;
	autoRetry?: boolean;
	autoCompaction?: boolean;
	/** Maximum silence per model stream. Zero disables this guard; tools are unaffected. */
	modelIdleTimeoutMs?: number;
	initialToolChoice?: "required";
	/** Unset preserves Pi/provider defaults, including PI_CACHE_RETENTION. */
	cacheRetention?: CacheRetention;
	registerProviders?: () => PiProviderRegistration[] | Promise<PiProviderRegistration[]>;
	createModelRuntime?: (snapshot: SessionSnapshot) => Promise<ModelRuntime>;
	/**
	 * Replaces the Wuming coding-agent system prompt. Returning undefined falls
	 * back to Pi's own default prompt, which describes Pi's tool names rather than
	 * Wuming's — useful for comparison, rarely what a deployment wants.
	 */
	buildSystemPrompt?: (input: {
		snapshot: SessionSnapshot;
		tools: ToolDefinition[];
		cwd: string;
	}) => string | undefined;
}

function interruptionText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") {
		if (message.stopReason === "aborted") return "aborted";
		if (message.stopReason === "error") return message.errorMessage;
	}
	if (message.role === "toolResult" && message.isError) {
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return undefined;
}

/**
 * Preserve interrupted turns as context. Pi's provider serializers omit incomplete
 * assistant messages and close unresolved tool calls; rolling back the whole turn
 * here would also erase the user's request and confirmed tool results.
 */
export function recoverInterruptedSession(manager: SessionManager): boolean {
	const branch = manager.getBranch();
	const lastMessageIndex = branch.findLastIndex((entry) => entry.type === "message");
	if (lastMessageIndex < 0) return false;
	const interrupted = branch[lastMessageIndex]!;
	const interruption = interruptionText(interrupted);
	if (!interruption || !/abort|cancel/i.test(interruption)) return false;
	const recoveryType = "wuming-interrupted-turn";
	if (
		branch
			.slice(lastMessageIndex + 1)
			.some((entry) => entry.type === "custom_message" && entry.customType === recoveryType)
	)
		return false;
	manager.appendCustomMessageEntry(
		recoveryType,
		"The previous execution was interrupted. Earlier user requests and completed tool results remain " +
			"available as conversation context. This notice is status data, not a new request or permission to resume. " +
			"Follow the latest user message: if it asks to continue, resume the unfinished task using the retained " +
			"context; if it changes tasks, follow the new task. A tool call without a confirmed result has an unknown " +
			"outcome. Inspect the current state before repeating it, and do not assume completed work was undone.",
		false,
		{ interruptedEntryId: interrupted.id }
	);
	return true;
}

function defaultSystemPrompt(input: { snapshot: SessionSnapshot; tools: ToolDefinition[] }): string {
	return buildWumingSystemPrompt({
		tools: input.tools,
		sandboxMode: input.snapshot.sandboxMode,
		approvalPolicy: input.snapshot.approvalPolicy,
	});
}

function toolCapability(tool: ToolDefinition): CapabilityManifest {
	const mcp = /^mcp__(.+?)__/.exec(tool.name);
	const contract = {
		name: tool.name,
		description: tool.description,
		inputSchema: asCapabilityJson(tool.parameters),
		executionMode: tool.executionMode ?? "parallel",
	};
	return {
		id: `tool:${tool.name}`,
		version: createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
		kind: "tool",
		provider: mcp ? `mcp:${mcp[1]}` : "wuming",
		scope: "session",
		activation: "always",
		modelVisible: true,
		description: tool.description,
		tool: { ...contract, executionMode: contract.executionMode, exposure: "direct" },
		metadata: { source: "pi-tool" },
	};
}

export function createDefaultPiSessionFactory(options: DefaultPiSessionFactoryOptions): PiSessionFactory {
	return async (snapshot: SessionSnapshot) => {
		const cwd = await options.resolveWorkspace(snapshot.session.workspaceId);
		const sessionDir = sessionHistoryDirectory(options.sessionDataDir, snapshot.session.id, snapshot.runtimeHistoryId);
		await mkdir(sessionDir, { recursive: true });
		// The tools come first because the system prompt describes them, and Pi builds
		// that prompt from the resource loader the services own.
		const definitions = stableToolDefinitions((await options.createCustomTools?.(snapshot)) ?? []);
		const recovery = new ToolRecoveryMonitor(definitions.some((tool) => tool.name === "skill_load"));
		const customTools = definitions.map((tool) => recovery.wrap(tool));
		const systemPrompt = (options.buildSystemPrompt ?? defaultSystemPrompt)({
			snapshot,
			tools: customTools,
			cwd,
		});
		let activeSystemPrompt: string | undefined;
		let activeReferenceContext: string | undefined;
		let pendingReference = () => pendingReferenceMessage(activeReferenceContext, []);
		const services = await createAgentSessionServices({
			cwd,
			agentDir: options.agentDir,
			...(options.createModelRuntime ? { modelRuntime: await options.createModelRuntime(snapshot) } : {}),
			resourceLoaderOptions: {
				// Pi resets agent.state.systemPrompt during prompt preflight. Return the
				// audited per-turn context at that lifecycle boundary as well.
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", () => {
							// Pi runs this after its own preflight compaction and persists the message.
							const message = pendingReference();
							return {
								...(activeSystemPrompt === undefined ? {} : { systemPrompt: activeSystemPrompt }),
								...(message ? { message } : {}),
							};
						});
					},
				],
				noExtensions: true,
				noThemes: true,
				// Workspace context is assembled per turn by Wuming's context engine so
				// every source, budget decision, and truncation is auditable.
				noContextFiles: true,
				// Wuming resolves skills through its own catalog and injects the selected
				// ones per turn, so Pi's parallel skill injection would either duplicate
				// them or add skills the Wuming UI never showed.
				noSkills: true,
				// A project SYSTEM.md still wins; ours is the default, not an override.
				systemPromptOverride: (base) => base ?? systemPrompt,
			},
		});
		for (const registration of (await options.registerProviders?.()) ?? [])
			services.modelRuntime.registerProvider(registration.provider, registration.config);
		const model = services.modelRuntime.getModel(snapshot.model.provider, snapshot.model.id);
		if (!model) {
			const available = services.modelRuntime
				.getModels(snapshot.model.provider)
				.map((candidate) => candidate.id)
				.slice(0, 20);
			throw new Error(
				`Unknown Pi model ${snapshot.model.provider}/${snapshot.model.id}; configure it in the Pi models catalog or choose one of: ${available.join(", ") || "none"}`
			);
		}
		if (snapshot.runtimeHistoryId && (await SessionManager.list(cwd, sessionDir)).length === 0)
			throw new Error("The selected model history is missing; refusing to start an empty conversation");
		const sessionManager = SessionManager.continueRecent(cwd, sessionDir);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model,
			thinkingLevel: snapshot.thinkingLevel,
			noTools: "builtin",
			customTools,
		});
		session.setAutoRetryEnabled(options.autoRetry ?? false);
		pendingReference = () => pendingReferenceMessage(activeReferenceContext, session.agent.state.messages);
		session.setAutoCompactionEnabled(options.autoCompaction ?? true);
		let initialToolChoicePending =
			options.initialToolChoice === "required" && session.agent.state.messages.length === 0;
		const cacheObserver = new PromptCacheObserver();
		{
			const streamFunction = session.agent.streamFunction.bind(session.agent);
			session.agent.streamFunction = (streamModel, context, streamOptions) => {
				cacheObserver.beginRequest();
				const requireTool = initialToolChoicePending && (context.tools?.length ?? 0) > 0;
				initialToolChoicePending = false;
				const selectedModel = requireTool
					? {
							...streamModel,
							samplingParams: { ...streamModel.samplingParams, tool_choice: "required" },
						}
					: streamModel;
				return guardedModelStream(
					selectedModel,
					(signal) =>
						streamFunction(selectedModel, context, {
							...streamOptions,
							signal,
							...(options.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
							onPayload: async (payload, model) => {
								const replacement = await streamOptions?.onPayload?.(payload, model);
								cacheObserver.observe(replacement === undefined ? payload : replacement, model);
								return replacement;
							},
						}),
					streamOptions?.signal,
					options.modelIdleTimeoutMs
				);
			};
		}
		const resumeApprovedTool = async (
			toolCallId: string,
			signal: AbortSignal,
			onUpdate?: (result: {
				content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
				details: unknown;
			}) => void
		): Promise<{ message: ToolResultMessage; input: unknown }> => {
			initialToolChoicePending = false;
			const messages = session.agent.state.messages;
			const assistant = [...messages]
				.reverse()
				.find(
					(message): message is AssistantMessage =>
						message.role === "assistant" &&
						message.content.some((part) => part.type === "toolCall" && part.id === toolCallId)
				);
			if (!assistant || messages.at(-1) !== assistant)
				throw new Error(`Pending Pi tool call ${toolCallId} is not the active conversation leaf`);
			const call = assistant.content.find((part) => part.type === "toolCall" && part.id === toolCallId);
			if (!call || call.type !== "toolCall") throw new Error(`Pending Pi tool call ${toolCallId} was not found`);
			const tool = session.agent.state.tools.find((candidate) => candidate.name === call.name);
			if (!tool) throw new Error(`Pending Pi tool ${call.name} is no longer available`);
			const parameters = tool.prepareArguments?.(call.arguments) ?? call.arguments;
			if (!Value.Check(tool.parameters, parameters))
				throw new Error(`Stored arguments for Pi tool ${call.name} are no longer valid`);
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
				const details =
					error && typeof error === "object" && "details" in error
						? (error as { details?: unknown }).details
						: undefined;
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
		const prompt = session.prompt.bind(session);
		Object.assign(session, {
			branchHistory: (input: Parameters<typeof persistHistoryBranch>[3], operations: Parameters<typeof persistHistoryBranch>[4]) =>
				persistHistoryBranch(options.sessionDataDir, cwd, sessionManager, input, operations),
			prompt: (text: string, promptOptions?: Parameters<typeof session.prompt>[1] & { operationId?: string; userItemId?: string }) => {
				if (promptOptions?.images?.length && !session.model?.input.includes("image")) {
					return Promise.reject(
						new Error("图片已上传，但当前模型不支持图片理解。请切换到支持视觉的模型后重试，无需重新上传图片。")
					);
				}
				if (promptOptions?.operationId)
					sessionManager.appendCustomEntry("wuming-turn-input", {
						operationId: promptOptions.operationId,
						...(promptOptions.userItemId ? { userItemId: promptOptions.userItemId } : {}),
						digest: requestDigest([{ type: "text", text }, ...(promptOptions.images ?? [])]),
					});
				const { operationId: _operationId, userItemId: _userItemId, ...options } = promptOptions ?? {};
				return prompt(text, options);
			},
			prepareForPrompt: async (input?: PiSessionRecovery) => {
				recovery.reset();
				try {
					if (input) await recoverDurableSession(sessionManager, input);
					else recoverInterruptedSession(sessionManager);
				} finally {
					// Earlier records may have been restored before a later attachment
					// failed to load. Keep live state aligned with the append-only log.
					session.agent.state.messages = sessionManager.buildSessionContext().messages;
				}
			},
			resumeApprovedTool,
			getSystemPrompt: () => session.agent.state.systemPrompt,
			getCacheDiagnostic: () => cacheObserver.diagnostic,
			setReferenceContext: (content: string | undefined) => {
				activeReferenceContext = content;
			},
			setSystemPrompt: (prompt: string) => {
				activeSystemPrompt = prompt;
				session.agent.state.systemPrompt = prompt;
			},
			getCapabilityManifests: () => customTools.map(toolCapability),
		});
		return session;
	};
}

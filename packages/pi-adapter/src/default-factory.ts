import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionSnapshot } from "@wuming/protocol";
import { Value } from "typebox/value";
import type { PiProviderRegistration, PiSessionFactory, WorkspaceResolver } from "./types.js";

export interface DefaultPiSessionFactoryOptions {
	agentDir: string;
	sessionDataDir: string;
	resolveWorkspace: WorkspaceResolver;
	createCustomTools?: (snapshot: SessionSnapshot) => ToolDefinition[] | Promise<ToolDefinition[]>;
	autoRetry?: boolean;
	initialToolChoice?: "required";
	registerProviders?: () => PiProviderRegistration[] | Promise<PiProviderRegistration[]>;
}

function sessionDirectory(root: string, sessionId: string): string {
	const safeName = createHash("sha256").update(sessionId).digest("hex");
	return join(root, safeName);
}

export function createDefaultPiSessionFactory(options: DefaultPiSessionFactoryOptions): PiSessionFactory {
	return async (snapshot: SessionSnapshot) => {
		const cwd = await options.resolveWorkspace(snapshot.session.workspaceId);
		const sessionDir = sessionDirectory(options.sessionDataDir, snapshot.session.id);
		await mkdir(sessionDir, { recursive: true });
		const services = await createAgentSessionServices({
			cwd,
			agentDir: options.agentDir,
			resourceLoaderOptions: {
				noExtensions: true,
				noThemes: true,
			},
		});
		for (const registration of (await options.registerProviders?.()) ?? []) services.modelRuntime.registerProvider(registration.provider, registration.config);
		const model = services.modelRuntime.getModel(snapshot.model.provider, snapshot.model.id);
		if (!model) {
			const available = services.modelRuntime.getModels(snapshot.model.provider).map((candidate) => candidate.id).slice(0, 20);
			throw new Error(`Unknown Pi model ${snapshot.model.provider}/${snapshot.model.id}; configure it in the Pi models catalog or choose one of: ${available.join(", ") || "none"}`);
		}
		const sessionManager = SessionManager.continueRecent(cwd, sessionDir);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model,
			thinkingLevel: snapshot.thinkingLevel,
			noTools: "builtin",
			customTools: (await options.createCustomTools?.(snapshot)) ?? [],
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
			resumeApprovedTool,
			getSystemPrompt: () => session.agent.state.systemPrompt,
			setSystemPrompt: (prompt: string) => {
				session.agent.state.systemPrompt = prompt;
			},
		});
		return session;
	};
}

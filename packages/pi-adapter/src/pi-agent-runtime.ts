import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, Usage as PiUsage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AgentRuntime, RuntimeTurnResult } from "@wuming/orchestrator";
import type {
	ArtifactRef,
	ContentPart,
	JsonValue,
	RunFailureKind,
	SessionSnapshot,
	TranscriptItem,
	Usage,
	UsageRequestSummary,
	UsageToolSummary,
	UserContentPart,
} from "@wuming/protocol";
import type { ArtifactResolver, PiSessionFactory, PiSessionLike, SkillResolver } from "./types.js";

export interface PiAgentRuntimeOptions {
	createSession: PiSessionFactory;
	resolveArtifact?: ArtifactResolver;
	resolveSkills?: SkillResolver;
	idFactory?: () => string;
	clock?: () => number;
	maxProgressPreviewChars?: number;
}

function jsonValue(value: unknown): JsonValue {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : (JSON.parse(serialized) as JsonValue);
	} catch {
		return String(value);
	}
}

function preview(value: unknown, maxChars: number): { text: string; truncated: boolean } {
	let text: string;
	if (typeof value === "string") text = value;
	else if (value && typeof value === "object" && "content" in value) {
		const content = (value as { content?: unknown }).content;
		if (Array.isArray(content)) {
			text = content
				.map((part) =>
					part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "",
				)
				.join("");
		} else text = JSON.stringify(value);
	} else text = JSON.stringify(value) ?? String(value);
	return text.length <= maxChars ? { text, truncated: false } : { text: text.slice(-maxChars), truncated: true };
}

function detailArtifact(value: unknown): ArtifactRef | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value) || !("details" in value)) return undefined;
	const details = (value as { details?: unknown }).details;
	if (!details || typeof details !== "object" || Array.isArray(details) || !("artifact" in details)) return undefined;
	const artifact = (details as { artifact?: unknown }).artifact;
	if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return undefined;
	const candidate = artifact as Partial<ArtifactRef>;
	if (
		typeof candidate.id !== "string" || !candidate.id ||
		typeof candidate.name !== "string" || !candidate.name ||
		typeof candidate.mimeType !== "string" || !candidate.mimeType ||
		typeof candidate.size !== "number" || !Number.isSafeInteger(candidate.size) || candidate.size < 0
	) return undefined;
	return { id: candidate.id, name: candidate.name, mimeType: candidate.mimeType, size: candidate.size };
}

function mcpToolDetails(value: unknown): { mcpServerId?: string; mcpToolName?: string; durationMs?: number } {
	if (!value || typeof value !== "object" || Array.isArray(value) || !("details" in value)) return {};
	const details = (value as { details?: unknown }).details;
	if (!details || typeof details !== "object" || Array.isArray(details)) return {};
	const candidate = details as Record<string, unknown>;
	return {
		...(typeof candidate.mcpServerId === "string" && candidate.mcpServerId ? { mcpServerId: candidate.mcpServerId } : {}),
		...(typeof candidate.mcpToolName === "string" && candidate.mcpToolName ? { mcpToolName: candidate.mcpToolName } : {}),
		...(typeof candidate.durationMs === "number" && Number.isSafeInteger(candidate.durationMs) && candidate.durationMs >= 0 ? { durationMs: candidate.durationMs } : {}),
	};
}

function mcpToolNameParts(toolName: string): { mcpServerId?: string; mcpToolName?: string } {
	const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
	return match ? { mcpServerId: match[1]!, mcpToolName: match[2]! } : {};
}

function mapUsage(usage: PiUsage): Usage {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		costUsd: usage.cost.total,
	};
}

function addUsage(left: Usage, right: Usage): Usage {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
		cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
		totalTokens: left.totalTokens + right.totalTokens,
		costUsd: left.costUsd + right.costUsd,
	};
}

function errorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw
		.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "$1-[REDACTED]")
		.replace(/((?:api[_ -]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
		.slice(0, 4000);
}

function providerFailure(error: unknown): { kind: RunFailureKind; retryable: boolean; message: string } {
	const message = errorMessage(error);
	const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
	const status = typeof candidate.status === "number" ? candidate.status : typeof candidate.statusCode === "number" ? candidate.statusCode : undefined;
	const code = typeof candidate.code === "string" ? candidate.code : "";
	const text = `${code} ${message}`.toLowerCase();
	if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|authentication|invalid api key|incorrect api key/.test(text)) {
		return { kind: "provider_auth", retryable: false, message };
	}
	if (status === 429 || /rate.?limit|too many requests|quota exceeded/.test(text)) {
		return { kind: "provider_rate_limit", retryable: true, message };
	}
	if (status === 408 || status === 504 || /\b(etimedout|timeout|timed out)\b/.test(text)) {
		return { kind: "provider_timeout", retryable: true, message };
	}
	if (/\b(econnreset|econnrefused|enotfound|eai_again|epipe)\b|fetch failed|network error|connection error|socket hang up|premature close|terminated/.test(text)) {
		return { kind: "provider_network", retryable: true, message };
	}
	return { kind: "provider", retryable: status !== undefined && status >= 500, message };
}

function assistantContent(message: AssistantMessage): ContentPart[] {
	return message.content.map((part): ContentPart => {
		switch (part.type) {
			case "text":
				return { type: "text", text: part.text };
			case "thinking":
				return {
					type: "thinking",
					text: part.thinking,
					...(part.redacted === undefined ? {} : { redacted: part.redacted }),
				};
			case "toolCall":
				return {
					type: "tool_call",
					toolCallId: part.id,
					toolName: part.name,
					input: jsonValue(part.arguments),
				};
		}
	});
}

function mapAssistant(message: AssistantMessage, id: string): TranscriptItem {
	const status =
		message.stopReason === "error"
			? "error"
			: message.stopReason === "aborted"
				? "aborted"
				: message.stopReason === "pending"
					? "streaming"
					: "complete";
	return {
		id,
		type: "assistant",
		createdAt: message.timestamp,
		status,
		content: assistantContent(message),
		model: { provider: message.provider, id: message.model },
		usage: mapUsage(message.usage),
		...(message.errorMessage === undefined ? {} : { error: errorMessage(message.errorMessage) }),
	};
}

function mapToolResult(
	message: ToolResultMessage,
	input: JsonValue,
): TranscriptItem {
	const artifact = detailArtifact(message);
	return {
		id: `tool:${message.toolCallId}`,
		type: "tool",
		createdAt: message.timestamp,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		status: message.isError ? "error" : "complete",
		input,
		content: [
			...message.content.map((part) =>
				part.type === "text"
					? { type: "text" as const, text: part.text }
					: { type: "text" as const, text: `[Image result: ${part.mimeType}]` },
			),
			...(artifact ? [{ type: "artifact" as const, artifact }] : []),
		],
		isError: message.isError,
	};
}

async function preparePrompt(
	content: UserContentPart[],
	snapshot: SessionSnapshot,
	resolveArtifact: ArtifactResolver | undefined,
): Promise<{ text: string; images: Array<{ type: "image"; data: string; mimeType: string }> }> {
	const supportedImageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
	const text: string[] = [];
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const part of content) {
		if (part.type === "text") {
			text.push(part.text);
			continue;
		}
		if (!resolveArtifact) throw new Error(`Artifact input ${part.artifact.id} is not configured`);
		const resolved = await resolveArtifact(part.artifact, snapshot);
		if (!resolved.binary && supportedImageMimes.has(resolved.mimeType)) {
			images.push({ type: "image", data: resolved.data, mimeType: resolved.mimeType });
			continue;
		}
		if (resolved.extractedText !== undefined) {
			text.push(
				`<attached_file name=${JSON.stringify(part.artifact.name)} mime_type=${JSON.stringify(resolved.mimeType)} extracted="true">\n${resolved.extractedText}\n</attached_file>`,
			);
			continue;
		}
		if (resolved.binary) {
			text.push(
				`<attached_file name=${JSON.stringify(part.artifact.name)} mime_type=${JSON.stringify(resolved.mimeType)} size=${JSON.stringify(part.artifact.size)} binary="true">\n${resolved.extractionNotice ?? "The binary file was uploaded successfully, but no readable text could be extracted from it."}\n</attached_file>`,
			);
			continue;
		}
		const textual = resolved.mimeType.startsWith("text/") || [
			"application/json",
			"application/ld+json",
			"application/xml",
			"application/javascript",
			"application/yaml",
			"application/toml",
		].includes(resolved.mimeType);
		if (!textual) {
			text.push(
				`<attached_file name=${JSON.stringify(part.artifact.name)} mime_type=${JSON.stringify(resolved.mimeType)} size=${JSON.stringify(part.artifact.size)} binary="true">\n${resolved.extractionNotice ?? "The binary file was uploaded successfully, but no readable text could be extracted from it."}\n</attached_file>`,
			);
			continue;
		}
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(resolved.data, "base64"));
		} catch {
			throw new Error(`Artifact ${part.artifact.id} is not valid UTF-8 text`);
		}
		text.push(
			`<attached_file name=${JSON.stringify(part.artifact.name)} mime_type=${JSON.stringify(resolved.mimeType)}>\n${content}\n</attached_file>`,
		);
	}
	return { text: text.join("\n\n") || "Inspect the attached image.", images };
}

export class PiAgentRuntime implements AgentRuntime, AsyncDisposable {
	readonly #createSession: PiSessionFactory;
	readonly #resolveArtifact: ArtifactResolver | undefined;
	readonly #resolveSkills: SkillResolver | undefined;
	readonly #idFactory: () => string;
	readonly #clock: () => number;
	readonly #maxProgressPreviewChars: number;
	readonly #sessions = new Map<string, { configurationKey: string; pending: Promise<PiSessionLike> }>();

	constructor(options: PiAgentRuntimeOptions) {
		this.#createSession = options.createSession;
		this.#resolveArtifact = options.resolveArtifact;
		this.#resolveSkills = options.resolveSkills;
		this.#idFactory = options.idFactory ?? randomUUID;
		this.#clock = options.clock ?? Date.now;
		this.#maxProgressPreviewChars = options.maxProgressPreviewChars ?? 200_000;
	}

	async #session(snapshot: SessionSnapshot): Promise<PiSessionLike> {
		const configurationKey = [
			snapshot.model.provider,
			snapshot.model.id,
			snapshot.thinkingLevel,
			snapshot.sandboxMode,
			snapshot.approvalPolicy,
		].join("\0");
		const existing = this.#sessions.get(snapshot.session.id);
		if (existing?.configurationKey === configurationKey) return existing.pending;
		if (existing) {
			this.#sessions.delete(snapshot.session.id);
			void existing.pending.then((session) => session.dispose()).catch(() => {});
		}
		const pending = this.#createSession(snapshot);
		this.#sessions.set(snapshot.session.id, { configurationKey, pending });
		pending.catch(() => {
			const current = this.#sessions.get(snapshot.session.id);
			if (current?.pending === pending) this.#sessions.delete(snapshot.session.id);
		});
		return pending;
	}

	async disposeSession(sessionId: string): Promise<void> {
		const entry = this.#sessions.get(sessionId);
		this.#sessions.delete(sessionId);
		if (entry) (await entry.pending).dispose();
	}

	async forceTerminate(sessionId: string): Promise<void> {
		await this.disposeSession(sessionId);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		const sessions = [...this.#sessions.values()].map((entry) => entry.pending);
		this.#sessions.clear();
		for (const pending of sessions) (await pending).dispose();
	}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]): Promise<RuntimeTurnResult> {
		const session = await this.#session(input.snapshot);
		const prepared = await preparePrompt(input.operation.payload.content, input.snapshot, this.#resolveArtifact);
		const requestedSkillIds = input.operation.payload.skills ?? [];
		const resolvedSkills = this.#resolveSkills ? await this.#resolveSkills(input.snapshot, requestedSkillIds) : [];
		if (input.signal.aborted) throw input.signal.reason;
		const activeSkillIds = resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.id) : requestedSkillIds;
		const previousSystemPrompt = session.getSystemPrompt?.();
		if (resolvedSkills.length > 0 && session.setSystemPrompt) {
			const skillPrompt = [
				previousSystemPrompt ?? "",
				"\n\n## Active workspace skills\n",
				"The following local skill documents are additional task guidance. System and user instructions take precedence.\n",
				...resolvedSkills.map((skill) => `\n### ${skill.name} (${skill.id})\n<skill-instructions>\n${skill.content}\n</skill-instructions>\n`),
			].join("");
			session.setSystemPrompt(skillPrompt);
		}
		const items: TranscriptItem[] = [];
		const toolInputs = new Map<string, JsonValue>();
		const toolUsage = new Map<string, UsageToolSummary>();
		const toolStartedAt = new Map<string, number>();
		const requests: UsageRequestSummary[] = [];
		const zeroUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
		const recordToolStart = (toolCallId: string, toolName: string) => {
			const existing = toolUsage.get(toolName);
			const mcp = mcpToolNameParts(toolName);
			toolUsage.set(toolName, existing
				? { ...existing, callCount: existing.callCount + 1 }
				: { toolName, callCount: 1, usage: zeroUsage, durationMs: 0, succeededCount: 0, failedCount: 0, abortedCount: 0, ...mcp });
			toolStartedAt.set(toolCallId, this.#clock());
		};
		const recordToolEnd = (toolCallId: string, toolName: string, result: unknown, isError: boolean) => {
			const existing = toolUsage.get(toolName) ?? { toolName, callCount: 1, usage: zeroUsage };
			const details = mcpToolDetails(result);
			const fallback = mcpToolNameParts(toolName);
			const startedAt = toolStartedAt.get(toolCallId);
			const durationMs = details.durationMs ?? (startedAt === undefined ? 0 : Math.max(0, this.#clock() - startedAt));
			const aborted = isError && input.signal.aborted;
			toolUsage.set(toolName, {
				...existing,
				durationMs: (existing.durationMs ?? 0) + durationMs,
				succeededCount: (existing.succeededCount ?? 0) + (!isError ? 1 : 0),
				failedCount: (existing.failedCount ?? 0) + (isError && !aborted ? 1 : 0),
				abortedCount: (existing.abortedCount ?? 0) + (aborted ? 1 : 0),
				...(details.mcpServerId || fallback.mcpServerId ? { mcpServerId: details.mcpServerId ?? fallback.mcpServerId! } : {}),
				...(details.mcpToolName || fallback.mcpToolName ? { mcpToolName: details.mcpToolName ?? fallback.mcpToolName! } : {}),
			});
			toolStartedAt.delete(toolCallId);
		};
		let activeAssistantId: string | undefined;
		let assistantStreamSeq = 0;
		const toolStreamSeq = new Map<string, number>();
		let cumulativeUsage = input.snapshot.usage;
		let lastFailureRetryable = false;

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				activeAssistantId = this.#idFactory();
				assistantStreamSeq = 0;
				return;
			}
			if (event.type === "message_update") {
				const update = event.assistantMessageEvent;
				if (!activeAssistantId) activeAssistantId = this.#idFactory();
				if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
					input.onProgress({
						type: "assistant.delta",
						sessionId: input.operation.sessionId,
						itemId: activeAssistantId,
						streamSeq: assistantStreamSeq++,
						contentIndex: update.contentIndex,
						kind:
							update.type === "text_delta"
								? "text"
								: update.type === "thinking_delta"
									? "thinking"
									: "tool_call",
						delta: update.delta,
					});
				}
				return;
			}
			if (event.type === "tool_execution_start") {
				const toolInput = jsonValue(event.args);
				toolInputs.set(event.toolCallId, toolInput);
				recordToolStart(event.toolCallId, event.toolName);
				toolStreamSeq.set(event.toolCallId, 0);
				input.onProgress({
					type: "tool.started",
					sessionId: input.operation.sessionId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					input: toolInput,
				});
				return;
			}
			if (event.type === "tool_execution_end") {
				recordToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
				return;
			}
			if (event.type === "tool_execution_update") {
				const output = preview(event.partialResult, this.#maxProgressPreviewChars);
				const artifact = detailArtifact(event.partialResult);
				input.onProgress({
					type: "tool.progress",
					sessionId: input.operation.sessionId,
					toolCallId: event.toolCallId,
					streamSeq: toolStreamSeq.get(event.toolCallId) ?? 0,
					preview: output.text,
					truncated: output.truncated,
					...(artifact ? { artifact } : {}),
				});
				toolStreamSeq.set(event.toolCallId, (toolStreamSeq.get(event.toolCallId) ?? 0) + 1);
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				const assistant = event.message as AssistantMessage;
				if (assistant.stopReason === "error") lastFailureRetryable = isRetryableAssistantError(assistant);
				const item = mapAssistant(assistant, activeAssistantId ?? this.#idFactory());
				items.push(item);
				cumulativeUsage = addUsage(cumulativeUsage, mapUsage(assistant.usage));
				requests.push({ requestId: item.id, model: { provider: assistant.provider, id: assistant.model }, usage: mapUsage(assistant.usage) });
				activeAssistantId = undefined;
				return;
			}
			if (event.type === "message_end" && event.message.role === "toolResult") {
				const toolResult = event.message as ToolResultMessage;
				items.push(mapToolResult(toolResult, toolInputs.get(toolResult.toolCallId) ?? null));
			}
			if (event.type === "auto_retry_start") {
				input.onRetry?.({
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					error: errorMessage(event.errorMessage),
				});
			}
		});

		const abort = () => {
			void session.abort().catch(() => {});
		};
		input.signal.addEventListener("abort", abort, { once: true });
		try {
			if (input.signal.aborted) throw input.signal.reason;
			if (input.operation.approvalId !== undefined) {
				if (!input.operation.approvalToolCallId || !session.resumeApprovedTool) throw new Error("The Pi runtime cannot resume this approved tool call safely");
				let recoveredToolSeq = 0;
				const resumed = await session.resumeApprovedTool(input.operation.approvalToolCallId, input.signal, (result) => {
					const output = preview(result, this.#maxProgressPreviewChars);
					input.onProgress({
						type: "tool.progress",
						sessionId: input.operation.sessionId,
						toolCallId: input.operation.approvalToolCallId!,
						streamSeq: recoveredToolSeq++,
						preview: output.text,
						truncated: output.truncated,
					});
				});
				toolInputs.set(resumed.message.toolCallId, jsonValue(resumed.input));
				recordToolStart(resumed.message.toolCallId, resumed.message.toolName);
				recordToolEnd(resumed.message.toolCallId, resumed.message.toolName, resumed.message, resumed.message.isError);
				items.unshift(mapToolResult(resumed.message, jsonValue(resumed.input)));
			} else {
				if (input.operation.payload.mode === "prompt") session.prepareForPrompt?.();
				await session.prompt(prepared.text, {
					images: prepared.images,
					...(session.isStreaming && input.operation.payload.mode !== "prompt"
						? { streamingBehavior: input.operation.payload.mode === "steer" ? ("steer" as const) : ("followUp" as const) }
						: {}),
					expandPromptTemplates: false,
					source: "rpc",
				});
			}
			if (input.signal.aborted) throw input.signal.reason;
			const failed = [...items].reverse().find((item) => item.type === "assistant" && item.status === "error");
			if (failed?.type === "assistant") {
				const classified = providerFailure(failed.error ?? "Provider request failed");
				return {
					items,
					usage: cumulativeUsage,
					tools: [...toolUsage.values()],
					requests,
					skills: activeSkillIds,
					failure: { code: "runtime_error", message: classified.message, retryable: lastFailureRetryable || classified.retryable, kind: classified.kind },
				};
			}
			if (input.costBudgetUsd !== undefined && cumulativeUsage.costUsd > input.costBudgetUsd) {
				return {
					items,
					usage: cumulativeUsage,
					tools: [...toolUsage.values()],
					requests,
					skills: activeSkillIds,
					failure: { code: "cost_budget_exceeded", message: `Cost budget of $${input.costBudgetUsd.toFixed(4)} was exceeded` },
				};
			}
			if (input.tokenBudget !== undefined && cumulativeUsage.totalTokens > input.tokenBudget) {
				return { items, usage: cumulativeUsage, tools: [...toolUsage.values()], requests, skills: activeSkillIds, failure: { code: "cost_budget_exceeded", message: `Token budget of ${input.tokenBudget} was exceeded` } };
			}
			return { items, usage: cumulativeUsage, tools: [...toolUsage.values()], requests, skills: activeSkillIds };
		} catch (error) {
			if (input.signal.aborted) throw input.signal.reason ?? error;
			const classified = providerFailure(error);
			return {
				items,
				usage: cumulativeUsage,
				tools: [...toolUsage.values()],
				requests,
				skills: activeSkillIds,
				failure: { code: "runtime_error", message: classified.message, retryable: classified.retryable, kind: classified.kind },
			};
		} finally {
			if (previousSystemPrompt !== undefined && session.setSystemPrompt) session.setSystemPrompt(previousSystemPrompt);
			input.signal.removeEventListener("abort", abort);
			unsubscribe();
		}
	}

	async compact(input: Parameters<NonNullable<AgentRuntime["compact"]>>[0]) {
		const session = await this.#session(input.snapshot);
		if (!session.compact) throw new Error("Pi session does not support compaction");
		if (input.signal.aborted) throw input.signal.reason;
		const result = await session.compact(input.instructions);
		if (input.signal.aborted) throw input.signal.reason;
		return {
			summary: result.summary,
			...(result.usage ? { usage: mapUsage(result.usage) } : {}),
		};
	}

	async injectTurn(input: Parameters<NonNullable<AgentRuntime["injectTurn"]>>[0]): Promise<void> {
		if (input.operation.payload.mode === "prompt") throw new Error("A prompt cannot be injected into an active Pi turn");
		if (input.signal.aborted) throw input.signal.reason;
		const session = await this.#session(input.snapshot);
		if (!session.isStreaming) throw new Error("Pi session is no longer streaming");
		const prepared = await preparePrompt(input.operation.payload.content, input.snapshot, this.#resolveArtifact);
		if (input.signal.aborted) throw input.signal.reason;
		const requestedSkillIds = input.operation.payload.skills ?? [];
		const resolvedSkills = this.#resolveSkills ? await this.#resolveSkills(input.snapshot, requestedSkillIds) : [];
		if (input.signal.aborted) throw input.signal.reason;
		const previousSystemPrompt = session.getSystemPrompt?.();
		if (resolvedSkills.length > 0 && session.setSystemPrompt) {
			session.setSystemPrompt([
				previousSystemPrompt ?? "",
				"\n\n## Active workspace skills\n",
				"The following local skill documents are additional task guidance. System and user instructions take precedence.\n",
				...resolvedSkills.map((skill) => `\n### ${skill.name} (${skill.id})\n<skill-instructions>\n${skill.content}\n</skill-instructions>\n`),
			].join(""));
		}
		try {
			await session.prompt(prepared.text, {
				images: prepared.images,
				streamingBehavior: input.operation.payload.mode === "steer" ? "steer" : "followUp",
				expandPromptTemplates: false,
				source: "rpc",
			});
		} finally {
			if (previousSystemPrompt !== undefined && session.setSystemPrompt) session.setSystemPrompt(previousSystemPrompt);
		}
	}
}

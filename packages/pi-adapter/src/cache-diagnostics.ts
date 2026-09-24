import { createHash } from "node:crypto";
import type { PromptCacheDiagnostic } from "@wuming/protocol";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
const digest = (value: unknown) =>
	`sha256:${createHash("sha256")
		.update(JSON.stringify(value) ?? "null")
		.digest("hex")}`;

function withoutMarker(value: unknown): unknown {
	const object = record(value);
	return object ? Object.fromEntries(Object.entries(object).filter(([key]) => key !== "cache_control")) : value;
}

function blocks(value: unknown): unknown {
	return Array.isArray(value) ? value.map(withoutMarker) : value;
}

function message(value: unknown): unknown {
	const object = record(value);
	// Strip only provider block markers, never keys inside tool arguments or results.
	return object && Array.isArray(object.content) ? { ...object, content: blocks(object.content) } : value;
}

interface Observation {
	model: string;
	system: string;
	tools: string;
	parameters: string;
	messages: string[];
	at: number;
}

/** Compare serialized requests without keeping prompt bodies or provider credentials. */
export class PromptCacheObserver {
	#previous: Observation | undefined;
	#current: PromptCacheDiagnostic | undefined;

	beginRequest(): void {
		this.#current = undefined;
	}

	get diagnostic(): PromptCacheDiagnostic | undefined {
		return this.#current ? { ...this.#current } : undefined;
	}

	observe(
		payload: unknown,
		model: { api: string; provider: string; id: string; baseUrl: string },
		now = Date.now()
	): void {
		const body = record(payload);
		if (
			!body ||
			!["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages"].includes(model.api)
		)
			return;
		const responses = model.api.endsWith("responses");
		const source = responses ? body.input : body.messages;
		if (!Array.isArray(source)) return;
		const systemMessage = (value: unknown) => ["system", "developer"].includes(String(record(value)?.role));
		const messages = source
			.filter((entry) => !systemMessage(entry))
			.map(message)
			.map(digest);
		const { tools, system, instructions, messages: _messages, input: _input, stream: _stream, ...parameters } = body;
		const current: Observation = {
			model: digest([model.api, model.provider, model.id, model.baseUrl]),
			system: digest([blocks(system), instructions, source.filter(systemMessage).map(message)]),
			tools: digest(blocks(tools)),
			parameters: digest(parameters),
			messages,
			at: now,
		};
		const previous = this.#previous;
		let shared = 0;
		while (
			previous &&
			shared < Math.min(messages.length, previous.messages.length) &&
			messages[shared] === previous.messages[shared]
		)
			shared++;
		const change: PromptCacheDiagnostic["change"] = !previous
			? "first_observation"
			: current.model !== previous.model
				? "model_changed"
				: current.tools !== previous.tools
					? "tools_changed"
					: current.system !== previous.system
						? "system_changed"
						: current.parameters !== previous.parameters
							? "parameters_changed"
							: shared < previous.messages.length
								? "history_changed"
								: messages.length > previous.messages.length
									? "append_only"
									: "unchanged";
		this.#current = {
			basis: "provider_payload",
			change,
			systemDigest: current.system,
			toolsDigest: current.tools,
			historyDigest: digest(messages),
			parametersDigest: current.parameters,
			messageCount: messages.length,
			sharedPrefixMessages: shared,
			...(previous
				? { previousMessageCount: previous.messages.length, intervalMs: Math.max(0, Math.trunc(now - previous.at)) }
				: {}),
		};
		this.#previous = current;
	}
}

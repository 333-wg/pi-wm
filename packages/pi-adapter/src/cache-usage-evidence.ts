import type { CacheUsageEvidence } from "@wuming/protocol";

const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const tokenCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Observe only numeric usage fields, never retain response text, headers or credentials. */
export class CacheUsageObserver {
	#evidence: CacheUsageEvidence = { source: "unavailable", read: "unknown", write: "unknown" };

	get evidence(): CacheUsageEvidence {
		return { ...this.#evidence };
	}

	observe(frame: unknown, api: string): void {
		const event = object(frame);
		if (!event) return;
		const usage = object(
			api === "anthropic-messages"
				? (object(event.message)?.usage ?? event.usage)
				: api.endsWith("responses")
					? object(event.response)?.usage
					: event.usage || object(Array.isArray(event.choices) ? event.choices[0] : undefined)?.usage
		);
		if (!usage) return;
		const details = object(usage[api.endsWith("responses") ? "input_tokens_details" : "prompt_tokens_details"]);
		const read =
			api === "anthropic-messages"
				? usage.cache_read_input_tokens
				: api.endsWith("responses")
					? details?.cached_tokens
					: (details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
		const write = api === "anthropic-messages" ? usage.cache_creation_input_tokens : details?.cache_write_tokens;
		// Pi replaces Completions/Responses usage objects, but Anthropic deltas
		// update only non-null fields. Evidence must describe the same final values.
		const incremental = api === "anthropic-messages" && !object(event.message)?.usage;
		this.#evidence = {
			source: "provider_response",
			read: incremental && read == null ? this.#evidence.read : tokenCount(read) ? "reported" : "unknown",
			write: incremental && write == null ? this.#evidence.write : tokenCount(write) ? "reported" : "unknown",
		};
	}

	/** Pass-through inspection: no extra request, tee, eager body read, or unbounded buffering. */
	wrapFetch(fetcher: typeof globalThis.fetch, api: string): typeof globalThis.fetch {
		return async (input, init) => {
			const response = await fetcher(input, init);
			// Reset for SDK retries. Evidence from an earlier failed HTTP attempt is not current.
			this.#evidence = { source: "unavailable", read: "unknown", write: "unknown" };
			if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
				return response;
			if (!["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses"].includes(api))
				return response;
			const decoder = new TextDecoder();
			let buffer = "";
			let data: string[] = [];
			let size = 0;
			let overflow = false;
			let lineOverflow = false;
			const limit = 1024 * 1024;
			const line = (value: string) => {
				if (value === "") {
					if (!overflow && data.length) {
						try {
							this.observe(JSON.parse(data.join("\n")), api);
						} catch {
							/* Not a usage frame. */
						}
					}
					data = [];
					size = 0;
					overflow = false;
				} else if (value.startsWith("data:") && !overflow) {
					const content = value.slice(5).replace(/^ /, "");
					size += content.length;
					if (size > limit) {
						overflow = true;
						data = [];
					} else data.push(content);
				}
			};
			const consume = (text: string) => {
				buffer += text;
				let end: number;
				while ((end = buffer.indexOf("\n")) >= 0) {
					const value = buffer.slice(0, end).replace(/\r$/, "");
					buffer = buffer.slice(end + 1);
					if (value.length > limit) {
						overflow = true;
						data = [];
					} else if (!lineOverflow) line(value);
					lineOverflow = false;
				}
				if (buffer.length > limit) {
					buffer = "";
					overflow = true;
					lineOverflow = true;
				}
			};
			const body = response.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform: (chunk, controller) => {
						consume(decoder.decode(chunk, { stream: true }));
						controller.enqueue(chunk);
					},
					flush: () => {
						consume(decoder.decode());
						if (buffer && !lineOverflow) line(buffer);
						line("");
					},
				})
			);
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		};
	}
}

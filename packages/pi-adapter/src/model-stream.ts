import {
	createAssistantMessageEventStream,
	type AssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { providerErrorMessage } from "./provider-error.js";

export const DEFAULT_MODEL_IDLE_TIMEOUT_MS = 10 * 60_000;

/** Bound a silent model request, never the surrounding turn or tool execution. */
export function guardedModelStream(
	model: Model<Api>,
	start: (signal: AbortSignal) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
	externalSignal?: AbortSignal,
	idleTimeoutMs = DEFAULT_MODEL_IDLE_TIMEOUT_MS
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const controller = new AbortController();
	let source: AssistantMessageEventStream | undefined;
	let finished = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const cleanup = () => {
		finished = true;
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", abort);
	};
	const fail = (message: string, aborted = false) => {
		if (finished) return;
		cleanup();
		const reason = aborted ? "aborted" : "error";
		const error: AssistantMessage = { ...structuredClone(partial), stopReason: reason, errorMessage: message };
		output.push({
			type: "error",
			reason,
			error,
		});
		output.end();
		// Release our consumer even if a provider ignores cancellation; discard late frames.
		source?.end(error);
		controller.abort(new Error(message));
	};
	const abort = () => fail("Model request aborted by caller", true);
	const refresh = () => {
		clearTimeout(timer);
		if (idleTimeoutMs > 0) {
			timer = setTimeout(
				() => fail(`Model response idle timeout after ${idleTimeoutMs}ms without stream events`),
				idleTimeoutMs
			);
			timer.unref?.();
		}
	};
	if (externalSignal?.aborted) {
		abort();
		return output;
	}
	externalSignal?.addEventListener("abort", abort, { once: true });
	refresh();
	void (async () => {
		try {
			source = await start(controller.signal);
			if (finished) {
				source.end(await output.result());
				return;
			}
			for await (const event of source) {
				if (finished) break;
				if ("partial" in event) partial = event.partial;
				if (event.type === "done" || event.type === "error") {
					cleanup();
					output.push(event);
					output.end();
					break;
				}
				refresh();
				output.push(event);
			}
			if (!finished) fail("Model stream ended without a terminal response");
		} catch (error) {
			fail(providerErrorMessage(error));
		}
	})();
	return output;
}

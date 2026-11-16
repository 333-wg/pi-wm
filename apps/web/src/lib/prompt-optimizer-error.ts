import type { PromptOptimizeErrorCode } from "@wuming/protocol";
import type { LocaleKey } from "./locale.js";

const messages: Record<PromptOptimizeErrorCode, LocaleKey> = {
	invalid_request: "optimizeInvalidRequest",
	model_unavailable: "optimizeModelUnavailable",
	unavailable: "optimizeUnavailable",
	busy: "optimizeBusy",
	timeout: "optimizeTimeout",
	invalid_output: "optimizeInvalidOutput",
	incomplete_output: "optimizeIncompleteOutput",
	provider_auth: "optimizeProviderAuth",
	rate_limited: "optimizeRateLimited",
	provider_failed: "optimizeFailed",
};

/** Only trusted local messages are rendered; provider text may contain credentials. */
export function optimizerErrorKey(code: unknown, status: number): LocaleKey {
	if (typeof code === "string" && Object.hasOwn(messages, code)) return messages[code as PromptOptimizeErrorCode];
	if (status === 401 || status === 403) return "optimizePermission";
	if (status === 409) return "optimizeBusy";
	if (status === 429) return "optimizeRateLimited";
	if (status === 504) return "optimizeTimeout";
	return "optimizeFailed";
}

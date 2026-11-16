import type { TranscriptItem, UsageToolSummary } from "@wuming/protocol";

const BROWSER_TOOLS = new Set([
	"browser_open",
	"browser_action",
	"browser_snapshot",
	"browser_screenshot",
	"browser_diagnostics",
	"browser_tabs",
]);
const OBSERVATION_TOOLS = new Set(["browser_snapshot", "browser_screenshot", "browser_diagnostics"]);

/** Tool-family counters, not a judgment of coverage, duplicate work or correctness. */
export function verificationMetrics(items: TranscriptItem[], tools: UsageToolSummary[] = []) {
	const calls = items.filter((item) => item.type === "tool");
	const browserCalls = calls.filter((call) => BROWSER_TOOLS.has(call.toolName));
	const lastEdit = calls.findLastIndex((call) => call.toolName === "edit" || call.toolName === "write_file");
	const browserSummaries = tools.filter((tool) => BROWSER_TOOLS.has(tool.toolName));
	const hasCompleteTiming =
		browserSummaries.length > 0 &&
		browserSummaries.every((tool) => tool.durationMs !== undefined) &&
		browserCalls.every((call) => browserSummaries.some((tool) => tool.toolName === call.toolName));
	return {
		browserCallCount: browserCalls.length,
		browserBatchCallCount: browserCalls.filter(
			(call) =>
				call.toolName === "browser_action" &&
				call.input !== null &&
				typeof call.input === "object" &&
				!Array.isArray(call.input) &&
				call.input.action === "batch"
		).length,
		browserObservationCallCount: calls.filter((call) => OBSERVATION_TOOLS.has(call.toolName)).length,
		previewStartCallCount: calls.filter((call) => call.toolName === "preview_start").length,
		...(lastEdit < 0 ? {} : { postEditToolCallCount: calls.length - lastEdit - 1 }),
		...(hasCompleteTiming
			? { browserToolDurationMs: browserSummaries.reduce((sum, tool) => sum + tool.durationMs!, 0) }
			: {}),
	};
}

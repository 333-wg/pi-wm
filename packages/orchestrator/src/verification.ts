import type { TranscriptItem, UsageToolSummary } from "@wuming/protocol";

const CHANGE_TOOLS = new Set(["write_file", "edit"]);
const INSPECTION_TOOLS = new Set(["browser_action", "browser_snapshot", "browser_screenshot", "browser_diagnostics"]);

/** Evidence of a check, not proof of correctness. Keep missing evidence visible. */
export function verificationEvidence(items: TranscriptItem[], tools: UsageToolSummary[] = []) {
	const calls = items.filter((item) => item.type === "tool");
	const changedTools = [
		...new Set([
			...tools.filter((tool) => tool.callCount > 0).map((tool) => tool.toolName),
			...calls.map((call) => call.toolName),
		]),
	].filter((name) => CHANGE_TOOLS.has(name));
	const lastChange = calls.findLastIndex((call) => CHANGE_TOOLS.has(call.toolName));
	// Aggregated tool counts cannot establish success or execution order.
	if (lastChange < 0) return { changedTools, hasVerification: false };
	const hasVerification = calls.slice(lastChange + 1).some((call) => {
		if (call.isError || call.status !== "complete") return false;
		if (INSPECTION_TOOLS.has(call.toolName)) return true;
		if (
			!["exec", "shell"].includes(call.toolName) ||
			!call.input ||
			typeof call.input !== "object" ||
			Array.isArray(call.input)
		)
			return false;
		// Process failures are returned as text by the sandbox, not tool exceptions.
		if (call.content.some((part) => part.type === "text" && /^\[exit code /m.test(part.text))) return false;
		const command = call.input.command ?? call.input.cmd;
		if (typeof command !== "string") return false;
		// Recognize common project checks without treating arbitrary shell use as verification.
		return (
			/^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check|typecheck)(?:[\s:]|$)/i.test(command) ||
			/^\s*(?:(?:npx|pnpm exec|bunx|uv run|python -m|python3 -m)\s+)?(?:vitest|jest|pytest|tsc|eslint|ruff)(?:\s|$)/i.test(
				command
			) ||
			/^\s*(?:npx\s+)?(?:playwright|cargo|go|dotnet)\s+test(?:\s|$)/i.test(command)
		);
	});
	return { changedTools, hasVerification };
}

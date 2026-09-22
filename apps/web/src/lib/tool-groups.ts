import type { ArtifactRef, WebEvidence } from "@wuming/protocol";
import type { ToolStatusValue } from "../components/ToolCard.js";
import type { LocaleKey, Translate } from "./locale.js";

export interface GroupableTool {
	toolCallId: string;
	toolName: string;
	input: unknown;
	status: ToolStatusValue;
	isError?: boolean;
	hasArtifact?: boolean;
	hasNotice?: boolean;
	webEvidence?: WebEvidence | undefined;
	artifacts?: ArtifactRef[];
}

export interface ToolTraceGroup<T> {
	key: string;
	entries: T[];
	tools: GroupableTool[];
}

// These calls have their own navigation or rich output affordances.
const standaloneTools = new Set([
	"subagent",
	"update_plan",
	"generate_image",
	"get_generated_image",
	"generate_video",
	"get_generated_video",
	"TeamCreate",
	"team_start",
	"preview_start",
]);

export function isCompactTool(tool: GroupableTool): boolean {
	return (
		!tool.hasArtifact &&
		!(tool.artifacts ?? []).some((artifact) => !isOutputLog(tool.toolName, artifact)) &&
		!tool.hasNotice &&
		!standaloneTools.has(tool.toolName) &&
		!tool.toolName.startsWith("computer_") &&
		["pending", "running", "complete", "error", "aborted"].includes(tool.status)
	);
}

// Only text output from read/execute tools is folded. Downloaded deliverables and media stay visible.
function isOutputLog(toolName: string, artifact: ArtifactRef): boolean {
	return (
		["read_file", "grep", "exec", "shell", "run_python", "web_fetch"].includes(toolName) &&
		artifact.mimeType === "text/plain"
	);
}

export function toolActivityCounts(tools: GroupableTool[]) {
	return {
		ended: tools.filter((tool) => ["complete", "error", "aborted"].includes(tool.status)).length,
		failed: tools.filter((tool) => tool.isError || tool.status === "error").length,
		aborted: tools.filter((tool) => tool.status === "aborted" && !tool.isError).length,
		blocked: tools.filter((tool) => tool.webEvidence?.level === "access_blocked").length,
		insufficient: tools.filter((tool) => tool.webEvidence?.level === "insufficient_content").length,
	};
}

const activityKeys: Record<string, LocaleKey> = {
	read_file: "activityRead",
	ls: "activitySearch",
	glob: "activitySearch",
	grep: "activitySearch",
	write_file: "activityEdit",
	edit: "activityEdit",
	exec: "activityExecute",
	shell: "activityExecute",
	run_python: "activityExecute",
	web_search: "activityWeb",
	web_fetch: "activityWeb",
	browser_search: "activityWeb",
	browser_open: "activityBrowser",
	browser_download: "activityBrowser",
	browser_diagnostics: "activityBrowser",
	browser_tabs: "activityBrowser",
	browser_close: "activityBrowser",
	browser_snapshot: "activityBrowser",
	browser_action: "activityBrowser",
	browser_screenshot: "activityBrowser",
	skill_list: "activitySkill",
	skill_load: "activitySkill",
	Agent: "activityTeam",
	AgentTemplates: "activityTeam",
	TaskGet: "activityTeam",
	TaskList: "activityTeam",
	TaskCreate: "activityTeam",
	TaskUpdate: "activityTeam",
	SendMessage: "activityTeam",
};

export function toolActivityLabel(tool: GroupableTool, t: Translate): string {
	return t(activityKeys[tool.toolName] ?? "activityOther");
}

export function summarizeToolActivity(tools: GroupableTool[], t: Translate): string {
	const counts = new Map<string, number>();
	for (const tool of tools) {
		const label = toolActivityLabel(tool, t);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts].map(([activity, count]) => t("activityCount", { activity, count })).join(t("activitySeparator"));
}

export function groupConsecutiveTools<T>(
	entries: T[],
	describe: (entry: T) => { key: string; tool?: GroupableTool }
): ToolTraceGroup<T>[] {
	const groups: ToolTraceGroup<T>[] = [];
	let previousCompact = false;
	for (const entry of entries) {
		const { key, tool } = describe(entry);
		const compact = tool !== undefined && isCompactTool(tool);
		const previous = groups.at(-1);
		if (compact && previousCompact && previous) {
			previous.entries.push(entry);
			previous.tools.push(tool!);
		} else {
			groups.push({ key: tool ? `tool:${tool.toolCallId}` : key, entries: [entry], tools: tool ? [tool] : [] });
		}
		previousCompact = compact;
	}
	return groups;
}

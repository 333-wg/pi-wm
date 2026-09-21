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
	"browser_open",
	"preview_start",
]);

export function isCompactTool(tool: GroupableTool): boolean {
	return (
		!tool.isError &&
		!tool.hasArtifact &&
		!tool.hasNotice &&
		!standaloneTools.has(tool.toolName) &&
		!tool.toolName.startsWith("computer_") &&
		["pending", "running", "complete"].includes(tool.status)
	);
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

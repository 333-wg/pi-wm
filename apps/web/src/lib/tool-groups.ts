import type { ToolStatusValue } from "../components/ToolCard.js";

export interface GroupableTool {
	toolCallId: string;
	toolName: string;
	input: unknown;
	status: ToolStatusValue;
	isError?: boolean;
	hasArtifact?: boolean;
}

export interface ToolTraceGroup<T> {
	key: string;
	entries: T[];
	tools: GroupableTool[];
}

// These calls have their own navigation or rich output affordances.
const standaloneTools = new Set(["subagent", "update_plan", "generate_image", "generate_video", "get_generated_video"]);

export function groupConsecutiveTools<T>(
	entries: T[],
	describe: (entry: T) => { key: string; tool?: GroupableTool }
): ToolTraceGroup<T>[] {
	const groups: ToolTraceGroup<T>[] = [];
	let previousName: string | undefined;
	for (const entry of entries) {
		const { key, tool } = describe(entry);
		const name =
			tool &&
			!tool.isError &&
			!tool.hasArtifact &&
			!standaloneTools.has(tool.toolName) &&
			["pending", "running", "complete"].includes(tool.status)
				? tool.toolName
				: undefined;
		const previous = groups.at(-1);
		if (name && name === previousName && previous) {
			previous.entries.push(entry);
			previous.tools.push(tool!);
		} else {
			groups.push({ key: tool ? `tool:${tool.toolCallId}` : key, entries: [entry], tools: tool ? [tool] : [] });
		}
		previousName = name;
	}
	return groups;
}

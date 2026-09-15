import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function parsePiCacheRetention(value: string | undefined): CacheRetention | undefined {
	if (value === undefined) return undefined;
	if (value === "none" || value === "short" || value === "long") return value;
	throw new Error("WUMING_PI_CACHE_RETENTION must be none, short, or long when set");
}

// Tool schemas are JSON. Keep array order (e.g. enum, anyOf, tuple items)
// intact: sorting arbitrary arrays can change the contract or model behavior.
function orderedJson<T>(value: T): T {
	if (Array.isArray(value)) return value.map(orderedJson) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, child]) => [key, orderedJson(child)])
		) as T;
	}
	return value;
}

export function stableToolDefinitions(tools: readonly ToolDefinition[]): ToolDefinition[] {
	const names = new Set<string>();
	return tools
		.map((tool) => {
			if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
			names.add(tool.name);
			return { ...tool, parameters: orderedJson(tool.parameters) };
		})
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

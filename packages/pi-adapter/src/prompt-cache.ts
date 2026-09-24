import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function parsePiCacheRetention(value: string | undefined): CacheRetention | undefined {
	if (value === undefined) return undefined;
	if (value === "none" || value === "short" || value === "long") return value;
	throw new Error("WUMING_PI_CACHE_RETENTION must be none, short, or long when set");
}

const schemaMaps = new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
	"dependencies",
]);
const subschemas = new Set([
	"items",
	"prefixItems",
	"additionalItems",
	"contains",
	"unevaluatedItems",
	"additionalProperties",
	"unevaluatedProperties",
	"propertyNames",
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"contentSchema",
]);

// Only a schema's required array is a set. Literal data (const/default/examples),
// property names and ordered alternatives/tuples must retain their array order.
function orderedJson<T>(value: T, position: "schema" | "map" | "data" = "schema"): T {
	if (Array.isArray(value)) return value.map((child) => orderedJson(child, position)) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, child]) => {
					if (
						position === "schema" &&
						key === "required" &&
						Array.isArray(child) &&
						child.every((entry) => typeof entry === "string")
					)
						return [key, [...child].sort()];
					const next =
						position === "map"
							? "schema"
							: position === "schema" && schemaMaps.has(key)
								? "map"
								: position === "schema" && subschemas.has(key)
									? "schema"
									: "data";
					return [key, orderedJson(child, next)];
				})
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

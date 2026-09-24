import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { parsePiCacheRetention, stableToolDefinitions } from "../src/prompt-cache.js";

function tool(name: string, parameters: ToolDefinition["parameters"] = Type.Object({})): ToolDefinition {
	return { name, label: name, description: name, parameters, execute: async () => ({ content: [], details: {} }) };
}

describe("prompt cache stability", () => {
	it("sorts tools and schema objects without mutating source definitions", () => {
		const first = Type.Object({ zebra: Type.Optional(Type.String()), alpha: Type.Optional(Type.String()) });
		const second = Type.Object({ alpha: Type.Optional(Type.String()), zebra: Type.Optional(Type.String()) });
		const source = [tool("zeta"), tool("alpha", first)];
		const before = JSON.stringify(source);
		const ordered = stableToolDefinitions(source);
		expect(ordered.map((value) => value.name)).toEqual(["alpha", "zeta"]);
		expect(JSON.stringify(ordered)).toBe(JSON.stringify(stableToolDefinitions([tool("alpha", second), tool("zeta")])));
		expect(JSON.stringify(source)).toBe(before);
		expect(ordered[0]?.execute).toBe(source[1]?.execute);
	});

	it("preserves array order and schema validation semantics", () => {
		const schema = Type.Object(
			{
				pair: Type.Tuple([Type.String(), Type.Number()]),
				mode: Type.Union([Type.Literal("z"), Type.Literal("a")]),
			},
			{ additionalProperties: false }
		);
		const result = stableToolDefinitions([tool("inspect", schema)])[0]!.parameters;
		expect(result).toEqual({ ...schema, required: [...schema.required!].sort() });
		for (const input of [{ pair: ["a", 1], mode: "z" }, { pair: [1, "a"], mode: "a" }, { pair: ["a", 1] }]) {
			expect(Value.Check(result, input)).toBe(Value.Check(schema, input));
		}
	});

	it("stabilizes required sets at schema locations without rewriting literal data", () => {
		const first = Type.Object({ zebra: Type.String(), alpha: Type.Object({ z: Type.String(), a: Type.String() }) });
		const second = Type.Object({ alpha: Type.Object({ a: Type.String(), z: Type.String() }), zebra: Type.String() });
		const before = JSON.stringify(first);
		const result = stableToolDefinitions([tool("inspect", first)])[0]!.parameters;
		expect(JSON.stringify(result)).toBe(
			JSON.stringify(stableToolDefinitions([tool("inspect", second)])[0]!.parameters)
		);
		expect(JSON.stringify(first)).toBe(before);
		for (const input of [
			{ zebra: "z", alpha: { z: "z", a: "a" } },
			{ alpha: { a: "a" } },
			{ zebra: "z", alpha: { z: "z" } },
		])
			expect(Value.Check(result, input)).toBe(Value.Check(first, input));
	});

	it("distinguishes schema keywords from properties, annotations and const values", () => {
		const literal = { required: ["z", "a"], properties: { nested: { required: ["z", "a"] } } };
		const child = {
			type: "object",
			required: ["z", "a"],
			properties: { z: { type: "string" }, a: { type: "string" } },
		};
		const schema = {
			type: "object",
			required: ["z", "a"],
			properties: { required: { const: literal }, examples: child },
			$defs: { child },
			definitions: { child },
			patternProperties: { "^x": child },
			dependentSchemas: { x: child },
			dependencies: { x: child, y: ["z", "a"] },
			items: [child, { type: "string" }],
			prefixItems: [child, { type: "number" }],
			allOf: [child],
			anyOf: [child, { type: "null" }],
			oneOf: [child],
			additionalProperties: child,
			additionalItems: child,
			unevaluatedProperties: child,
			unevaluatedItems: child,
			contains: child,
			propertyNames: child,
			not: child,
			if: child,
			// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a Promise method.
			then: child,
			else: child,
			contentSchema: child,
			const: literal,
			default: literal,
			examples: [literal],
			enum: [literal, { required: ["a", "z"] }],
			"x-annotation": literal,
		};
		const result = stableToolDefinitions([tool("inspect", Type.Unsafe(schema))])[0]!.parameters as typeof schema;
		const sorted = { ...child, required: ["a", "z"] };
		expect(result).toEqual({
			...schema,
			required: ["a", "z"],
			properties: { required: { const: literal }, examples: sorted },
			$defs: { child: sorted },
			definitions: { child: sorted },
			patternProperties: { "^x": sorted },
			dependentSchemas: { x: sorted },
			dependencies: { x: sorted, y: ["z", "a"] },
			items: [sorted, { type: "string" }],
			prefixItems: [sorted, { type: "number" }],
			allOf: [sorted],
			anyOf: [sorted, { type: "null" }],
			oneOf: [sorted],
			additionalProperties: sorted,
			additionalItems: sorted,
			unevaluatedProperties: sorted,
			unevaluatedItems: sorted,
			contains: sorted,
			propertyNames: sorted,
			not: sorted,
			if: sorted,
			// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a Promise method.
			then: sorted,
			else: sorted,
			contentSchema: sorted,
		});
	});

	it("rejects ambiguous duplicate names and keeps genuine changes", () => {
		expect(() => stableToolDefinitions([tool("read"), tool("read")])).toThrow("Duplicate tool name");
		expect(stableToolDefinitions([tool("read", Type.Object({ path: Type.String() }))])).not.toEqual(
			stableToolDefinitions([tool("read", Type.Object({ url: Type.String() }))])
		);
	});
});

describe("cache retention configuration", () => {
	it.each([undefined, "none", "short", "long"] as const)("preserves %s", (value) => {
		expect(parsePiCacheRetention(value)).toBe(value);
	});
	it.each(["", "LONG", "1h", "24h", "false", " long "])("rejects invalid preference %s", (value) => {
		expect(() => parsePiCacheRetention(value)).toThrow("WUMING_PI_CACHE_RETENTION");
	});
});

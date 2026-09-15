import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { parsePiCacheRetention, stableToolDefinitions } from "../src/prompt-cache.js";

function tool(name: string, parameters = Type.Object({})): ToolDefinition {
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
		expect(result).toEqual(schema);
		for (const input of [{ pair: ["a", 1], mode: "z" }, { pair: [1, "a"], mode: "a" }, { pair: ["a", 1] }]) {
			expect(Value.Check(result, input)).toBe(Value.Check(schema, input));
		}
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

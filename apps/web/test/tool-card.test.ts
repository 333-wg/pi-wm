import { describe, expect, it } from "vitest";
import { describeTool, resultEchoesCard } from "../src/components/ToolCard.js";

describe("describeTool", () => {
	it("summarises the workspace search tools instead of dumping their arguments", () => {
		expect(describeTool("grep", { pattern: "createAgencyTools", glob: "**/*.ts", output_mode: "files" })).toMatchObject({
			verb: "检索",
			target: "createAgencyTools",
			meta: "**/*.ts · 仅路径",
			quiet: true,
		});
		expect(describeTool("grep", { pattern: "x", path: "packages" }).meta).toBe("packages");
		expect(describeTool("grep", { pattern: "x" }).meta).toBeUndefined();
		expect(describeTool("glob", { pattern: "**/*.test.ts", path: "apps" })).toMatchObject({ verb: "匹配", target: "**/*.test.ts", meta: "apps", quiet: true });
		expect(describeTool("ls", { path: "packages/orchestrator/src", depth: 3 })).toMatchObject({ verb: "列出", meta: "3 层", quiet: true });
		expect(describeTool("ls", {})).toMatchObject({ verb: "列出", target: ".", meta: undefined });
		for (const tool of ["grep", "glob", "ls"]) expect(describeTool(tool, {}).fallbackArgs).toBeUndefined();
	});

	it("renders a plan as a checklist and names the step in progress", () => {
		const description = describeTool("update_plan", {
			plan: [
				{ step: "读取 reducer", status: "completed" },
				{ step: "接上新字段", status: "in_progress" },
				{ step: "补测试", status: "pending" },
			],
		});

		expect(description).toMatchObject({ verb: "计划", target: "接上新字段", meta: "1/3" });
		expect(description.body).toBeDefined();
		// The explanation only reaches the transcript through the card body: the plan
		// text the tool returns is suppressed as a duplicate of the checklist.
		expect(describeTool("update_plan", { explanation: "先定位类型再改字段" }).body).toBeDefined();
		expect(describeTool("update_plan", { explanation: "   " }).body).toBeUndefined();
		expect(resultEchoesCard("update_plan")).toBe(true);
		expect(resultEchoesCard("update_plan", false)).toBe(true);
		expect(resultEchoesCard("update_plan", true)).toBe(false);
		expect(resultEchoesCard("subagent")).toBe(false);
	});

	// Arguments stream in token by token, so every shape below is one the card
	// really renders before the call is complete.
	it("survives a half-streamed plan", () => {
		expect(describeTool("update_plan", {})).toMatchObject({ verb: "计划", meta: undefined, body: undefined });
		expect(describeTool("update_plan", { plan: [] })).toMatchObject({ meta: undefined, body: undefined });
		expect(describeTool("update_plan", { plan: [{ status: "pending" }] })).toMatchObject({ meta: undefined, body: undefined });
		expect(describeTool("update_plan", { plan: [{ step: "只有一步" }] })).toMatchObject({ meta: "0/1" });
		expect(describeTool("update_plan", { plan: [{ step: "只有一步" }] })).not.toHaveProperty("target");
	});

	it("shows a delegated task by name and keeps a multi-line brief in the body", () => {
		expect(describeTool("subagent", { task: "找出所有调用方", name: "callers", cost_budget_usd: 0.5 })).toMatchObject({
			verb: "子代理",
			target: "callers",
			meta: "$0.5",
			body: undefined,
		});
		const multiline = describeTool("subagent", { task: "第一行\n第二行" });
		expect(multiline).toMatchObject({ verb: "子代理", target: "第一行", title: "第一行\n第二行" });
		expect(multiline.body).toBeDefined();
	});

	it("still falls back to raw arguments for an unknown tool", () => {
		expect(describeTool("mystery_tool", { a: 1 })).toMatchObject({ verb: "mystery_tool", fallbackArgs: true });
	});
});

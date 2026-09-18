import { createElement } from "react";
import { renderLocalized as renderToStaticMarkup } from "./render-localized.js";
import { describe, expect, it } from "vitest";
import { groupConsecutiveTools, type GroupableTool } from "../src/lib/tool-groups.js";
import { ToolGroup } from "../src/components/ToolGroup.js";

const tool = (id: string, changes: Partial<GroupableTool> = {}): GroupableTool => ({
	toolCallId: id,
	toolName: "read_file",
	input: { path: id + ".ts" },
	status: "complete",
	...changes,
});
const group = (tools: Array<GroupableTool | null>) =>
	groupConsecutiveTools(tools, (item) => (item ? { key: item.toolCallId, tool: item } : { key: "message" }));

describe("consecutive tool groups", () => {
	it("combines repeated calls while retaining every input and output entry", () => {
		const tools = [tool("a"), tool("b"), tool("c", { status: "running" })];
		expect(group(tools)).toEqual([{ key: "tool:a", entries: tools, tools }]);
		expect(group(tools)[0]?.key).toBe(group([tools[0]!])[0]?.key);
	});
	it("preserves message boundaries and operation order", () => {
		const groups = group([tool("a"), tool("b"), null, tool("c"), tool("d", { toolName: "grep" }), tool("e")]);
		expect(groups.map((entry) => entry.entries.length)).toEqual([2, 1, 1, 1, 1]);
	});
	it("keeps failures, approvals, artifacts and special tools individually visible", () => {
		for (const changes of [
			{ status: "error" as const },
			{ status: "aborted" as const },
			{ status: "awaiting_approval" as const },
			{ isError: true },
			{ hasArtifact: true },
			{ toolName: "subagent" },
			{ toolName: "update_plan" },
			{ toolName: "generate_image" },
		]) {
			expect(group([tool("a", changes), tool("b", changes)])).toHaveLength(2);
		}
	});
	it("renders a collapsed summary with live progress and mounts details only on demand", () => {
		const html = renderToStaticMarkup(
			createElement(ToolGroup, {
				tools: [tool("first"), tool("current", { status: "running" })],
				children: "private detail",
			})
		);
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("2 次");
		expect(html).toContain("current.ts");
		expect(html).toContain("1/2");
		expect(html).toContain("运行中");
		expect(html).not.toContain("private detail");
	});
	it("leaves singleton rows intact and reports all-complete groups correctly", () => {
		expect(renderToStaticMarkup(createElement(ToolGroup, { tools: [tool("a")], children: "original row" }))).toBe(
			"original row"
		);
		const html = renderToStaticMarkup(createElement(ToolGroup, { tools: [tool("a"), tool("b")], children: "detail" }));
		expect(html).toContain("已完成");
		expect(html).not.toContain("运行中");
	});
});

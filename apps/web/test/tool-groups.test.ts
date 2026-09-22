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
		expect(groups.map((entry) => entry.entries.length)).toEqual([2, 1, 3]);
		expect(groups[2]?.tools.map((item) => item.toolCallId)).toEqual(["c", "d", "e"]);
	});
	it("keeps approvals, deliverables and special tools individually visible", () => {
		for (const changes of [
			{ status: "awaiting_approval" as const },
			{ hasArtifact: true },
			{ hasNotice: true },
			{ toolName: "subagent" },
			{ toolName: "update_plan" },
			{ toolName: "generate_image" },
			{ toolName: "get_generated_image" },
			{ toolName: "TeamCreate" },
			{ toolName: "team_start" },
			{ toolName: "preview_start" },
			{ toolName: "computer_action" },
		]) {
			expect(group([tool("a", changes), tool("b", changes)])).toHaveLength(2);
			expect(
				renderToStaticMarkup(createElement(ToolGroup, { tools: [tool("a", changes)], children: "visible notice" }))
			).toBe("visible notice");
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
		expect(html).toContain("正在读取文件");
		expect(html).not.toContain("current.ts");
		expect(html).toContain("1/2");
		expect(html).not.toContain("项操作已结束");
		expect(html).not.toContain("private detail");
	});
	it("summarizes singleton operations without exposing command arguments", () => {
		const html = renderToStaticMarkup(
			createElement(ToolGroup, {
				tools: [tool("a", { toolName: "exec", input: { command: "node -e very_long_script" } })],
				children: "raw output",
			})
		);
		expect(html).toContain("执行命令 1 次");
		expect(html).not.toContain("very_long_script");
		expect(html).not.toContain("raw output");
	});
	it("reports all-complete groups correctly", () => {
		const html = renderToStaticMarkup(createElement(ToolGroup, { tools: [tool("a"), tool("b")], children: "detail" }));
		expect(html).toContain("2 项操作已结束");
		expect(html).not.toContain("运行中");
	});
	it("summarizes mixed tools by actual operation count, including repeats", () => {
		const tools = [tool("a"), tool("b", { toolName: "exec" }), tool("c"), tool("d", { toolName: "SendMessage" })];
		expect(group(tools)).toHaveLength(1);
		const html = renderToStaticMarkup(createElement(ToolGroup, { tools, children: "detail" }));
		expect(html).toContain("读取文件 2 次 · 执行命令 1 次 · 协调团队 1 次");
		expect(html).not.toContain("任务完成");
	});
	it("shows running work before queued work and never claims a queued group is complete", () => {
		const tools = [tool("a", { status: "running", toolName: "exec" }), tool("b", { status: "pending" })];
		const html = renderToStaticMarkup(createElement(ToolGroup, { tools, children: "detail" }));
		expect(html).toContain("正在执行命令");
		expect(html).toContain("0/2");
		const queued = renderToStaticMarkup(createElement(ToolGroup, { tools: [tools[1]!], children: "detail" }));
		expect(queued).toContain("等待读取文件");
		expect(queued).not.toContain("tool-state complete");
	});
	it("folds 30 mixed web calls including errors and evidence without splitting the stable group", () => {
		const tools = Array.from({ length: 30 }, (_, index) =>
			tool(String(index), {
				toolName: index % 2 ? "browser_open" : "web_fetch",
				webEvidence: { level: "page_content", note: "Retrieved, not verified" },
			})
		);
		tools[4] = tool("4", { status: "error", isError: true });
		tools[5] = tool("5", { status: "aborted" });
		tools[6] = tool("6", { webEvidence: { level: "access_blocked", note: "Blocked" } });
		tools[7] = tool("7", { webEvidence: { level: "insufficient_content", note: "Shell only" } });
		expect(group(tools)).toHaveLength(1);
		const html = renderToStaticMarkup(createElement(ToolGroup, { tools, children: "hidden results" }));
		expect(html).toContain("30 项操作已结束");
		for (const notice of ["1 项失败", "1 项中止", "1 项访问受阻", "1 项内容不足"]) expect(html).not.toContain(notice);
		expect(html).not.toContain("hidden results");
		expect(html).not.toContain("已完成");
		expect(group(tools)[0]?.key).toBe(group([tool("0", { status: "running" })])[0]?.key);
	});
	it("folds text logs but keeps media and downloaded deliverables accessible", () => {
		const artifact = { id: "output", name: "output.txt", mimeType: "text/plain", size: 100 };
		expect(group([tool("a"), tool("b", { toolName: "web_fetch", artifacts: [artifact] })])).toHaveLength(1);
		for (const changes of [
			{ toolName: "browser_download", artifacts: [artifact] },
			{ artifacts: [{ ...artifact, mimeType: "image/png" }] },
		])
			expect(group([tool("a"), tool("b", changes)])).toHaveLength(2);
	});
	it("counts errors as ended but not successful, while continuing to show running activity", () => {
		const html = renderToStaticMarkup(
			createElement(ToolGroup, {
				tools: [tool("a", { status: "error" }), tool("b", { status: "running", toolName: "browser_open" })],
				children: "details",
			})
		);
		expect(html).toContain("正在操作浏览器");
		expect(html).toContain("已结束 1/2 项");
		expect(html).not.toContain("1 项失败");
	});
	it("localizes summaries and preserves ordinary messages", () => {
		const html = renderToStaticMarkup(createElement(ToolGroup, { tools: [tool("a")], children: "detail" }), "en");
		expect(html).toContain("Read files (1)");
		expect(renderToStaticMarkup(createElement(ToolGroup, { tools: [], children: "progress text" }))).toBe(
			"progress text"
		);
	});
});

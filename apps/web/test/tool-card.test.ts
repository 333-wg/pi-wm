import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolCard, describeTool, isPreviewableImageArtifact, resultEchoesCard } from "../src/components/ToolCard.js";

describe("describeTool", () => {
	it("separates successful execution from evidence and preserves legacy tool rendering", () => {
		for (const [level, label] of Object.entries({
			candidate_links: "候选链接",
			page_content: "页面已读取",
			insufficient_content: "内容不足",
			access_blocked: "访问受阻",
		})) {
			const evidence = { level, note: "Not verified" } as NonNullable<Parameters<typeof ToolCard>[0]["webEvidence"]>;
			const html = renderToStaticMarkup(
				createElement(ToolCard, {
					toolName: "browser_search",
					input: { query: "query" },
					status: "complete",
					webEvidence: evidence,
				})
			);
			expect(html).toContain(label);
			expect(html).toContain("已完成");
			expect(html).not.toContain("已核验");
			for (const status of ["running", "error"] as const) {
				expect(
					renderToStaticMarkup(
						createElement(ToolCard, { toolName: "browser_search", input: {}, status, webEvidence: evidence })
					)
				).not.toContain("tool-evidence");
			}
		}
		expect(describeTool("browser_search", { query: "query" })).toMatchObject({ verb: "搜索", target: "query" });
		expect(
			renderToStaticMarkup(createElement(ToolCard, { toolName: "web_search", input: {}, status: "complete" }))
		).not.toContain("tool-evidence");
	});
	it("renders tools as an unframed activity trace instead of a status card", () => {
		const html = renderToStaticMarkup(
			createElement(
				ToolCard,
				{ toolName: "web_search", input: { query: "github trending" }, status: "complete" },
				createElement("pre", null, "result")
			)
		);

		expect(html).toContain('class="tool-trace complete"');
		expect(html).toContain('class="tool-state complete"');
		expect(html).not.toContain("tool-card");
		expect(html).not.toContain("tool-pill");
	});

	it("summarises the workspace search tools instead of dumping their arguments", () => {
		expect(describeTool("grep", { pattern: "createAgencyTools", glob: "**/*.ts", output_mode: "files" })).toMatchObject(
			{
				verb: "检索",
				target: "createAgencyTools",
				meta: "**/*.ts · 仅路径",
				quiet: true,
			}
		);
		expect(describeTool("grep", { pattern: "x", path: "packages" }).meta).toBe("packages");
		expect(describeTool("grep", { pattern: "x" }).meta).toBeUndefined();
		expect(describeTool("glob", { pattern: "**/*.test.ts", path: "apps" })).toMatchObject({
			verb: "匹配",
			target: "**/*.test.ts",
			meta: "apps",
			quiet: true,
		});
		expect(describeTool("ls", { path: "packages/orchestrator/src", depth: 3 })).toMatchObject({
			verb: "列出",
			meta: "3 层",
			quiet: true,
		});
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
		expect(describeTool("update_plan", {})).toMatchObject({
			verb: "计划",
			meta: undefined,
			body: undefined,
		});
		expect(describeTool("update_plan", { plan: [] })).toMatchObject({
			meta: undefined,
			body: undefined,
		});
		expect(describeTool("update_plan", { plan: [{ status: "pending" }] })).toMatchObject({
			meta: undefined,
			body: undefined,
		});
		expect(describeTool("update_plan", { plan: [{ step: "只有一步" }] })).toMatchObject({
			meta: "0/1",
		});
		expect(describeTool("update_plan", { plan: [{ step: "只有一步" }] })).not.toHaveProperty("target");
	});

	it("shows a delegated task by name and keeps a multi-line brief in the body", () => {
		expect(describeTool("subagent", { task: "找出所有调用方", name: "callers", cost_budget_usd: 0.5 })).toMatchObject({
			verb: "子代理",
			target: "callers",
			meta: "预算 $0.5",
			body: undefined,
		});
		const multiline = describeTool("subagent", { task: "第一行\n第二行" });
		expect(multiline).toMatchObject({ verb: "子代理", target: "第一行", title: "第一行\n第二行" });
		expect(multiline.body).toBeDefined();
	});

	it("summarises browser verification calls without exposing typed values", () => {
		expect(describeTool("browser_open", { url: "http://localhost:5173/", width: 390, height: 844 })).toMatchObject({
			verb: "打开页面",
			target: "http://localhost:5173/",
			meta: "390x844",
			quiet: true,
		});
		const action = describeTool("browser_action", {
			action: "fill",
			ref: "e7",
			value: "private input",
		});
		expect(action).toMatchObject({ verb: "页面 · fill", target: "e7" });
		expect(action).not.toHaveProperty("fallbackArgs");
		expect(describeTool("browser_screenshot", { full_page: true })).toMatchObject({
			verb: "页面截图",
			meta: "完整页面",
			quiet: true,
		});
		expect(describeTool("browser_diagnostics", { clear: true })).toMatchObject({
			verb: "浏览器诊断",
			meta: "读取后清空",
			quiet: true,
		});
		expect(describeTool("browser_tabs", {})).toMatchObject({ verb: "查看标签页", quiet: true });
		expect(describeTool("browser_action", { action: "switch_tab", tab_id: "t2" })).toMatchObject({
			verb: "页面 · switch_tab",
			target: "t2",
		});
		expect(describeTool("preview_start", { command: "npm run dev", url: "http://localhost:5173/" })).toMatchObject({
			verb: "启动预览",
			target: "npm run dev",
			meta: "http://localhost:5173/",
		});
		expect(describeTool("preview_status", {})).toMatchObject({ verb: "预览状态", quiet: true });
		expect(describeTool("preview_stop", {})).toMatchObject({ verb: "停止预览", quiet: true });
	});

	it("still falls back to raw arguments for an unknown tool", () => {
		expect(describeTool("mystery_tool", { a: 1 })).toMatchObject({
			verb: "mystery_tool",
			fallbackArgs: true,
		});
	});

	it("only embeds browser-safe image artifacts in tool results", () => {
		expect(isPreviewableImageArtifact({ id: "1", name: "shot.png", mimeType: "image/png", size: 10 })).toBe(true);
		expect(
			isPreviewableImageArtifact({
				id: "2",
				name: "vector.svg",
				mimeType: "image/svg+xml",
				size: 10,
			})
		).toBe(false);
		expect(
			isPreviewableImageArtifact({
				id: "3",
				name: "report.pdf",
				mimeType: "application/pdf",
				size: 10,
			})
		).toBe(false);
	});
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentSummary } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { findToolSubagent } from "../src/lib/subagent-navigation.js";
import { ToolCard, describeTool } from "../src/components/ToolCard.js";
import { ChildConversationMenu } from "../src/components/ChildConversations.js";

function child(id: string, sourceToolCallId?: string): SubagentSummary {
	return {
		id,
		sessionId: id,
		parentSessionId: "parent",
		operationId: `${id}-op`,
		name: "Inspect",
		task: "Read the code",
		depth: 1,
		status: "running",
		createdAt: 1,
		updatedAt: 1,
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		sandboxMode: "read_only",
		approvalPolicy: "never",
		pendingApprovals: [],
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
		...(sourceToolCallId ? { sourceToolCallId } : {}),
	};
}

describe("subagent conversation links", () => {
	it("uses the durable call id even when tasks have the same name", () => {
		const children = [child("first", "call-1"), child("second", "call-2")];
		expect(findToolSubagent(children, "call-2", {})).toBe(children[1]);
	});
	it("opens UI-created child results by session id", () => {
		const children = [child("child")];
		expect(findToolSubagent(children, "child", {})).toBe(children[0]);
	});
	it("supports old failed tasks but refuses ambiguous legacy matches", () => {
		const failed = { ...child("old"), status: "failed" as const };
		const args = { task: "Read the code", name: "Inspect" };
		expect(findToolSubagent([failed], "old-call", args)).toBe(failed);
		expect(findToolSubagent([failed, child("duplicate")], "old-call", args)).toBeUndefined();
		expect(findToolSubagent([failed], "old-call", { task: "Other task" })).toBeUndefined();
	});
	it("keeps running and failed conversation links enabled and details separately accessible", () => {
		for (const status of ["running", "error"] as const) {
			const html = renderToStaticMarkup(
				createElement(ToolCard, {
					toolName: "subagent",
					input: { name: "Inspect", task: "Read the code" },
					status,
					onOpenSession: () => {},
					children: "Tool result",
				})
			);
			expect(html).toContain("打开子代理对话");
			expect(html).toContain("展开工具详情");
			expect(html).not.toContain("disabled");
		}
	});
	it("labels legacy cost caps as budgets, not spend", () => {
		expect(describeTool("subagent", { cost_budget_usd: 1.5 }).meta).toBe("预算 $1.5");
	});
});

describe("child conversation switcher", () => {
	function render(children: SubagentSummary[], open = true) {
		return renderToStaticMarkup(
			createElement(ChildConversationMenu, {
				session: { id: "parent", workspaceId: "workspace", phase: "idle", createdAt: 1, updatedAt: 1 },
				children,
				open,
				disabled: false,
				onOpenChange: () => {},
				load: async () => children,
				onSelect: async () => true,
				onCancel: async () => children[0]!,
			})
		);
	}
	it("shows the conversation entry rather than a creation control", () => {
		const html = render([child("running")], false);
		expect(html).toContain('aria-label="子对话"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("child-conversation-count running");
		expect(html).not.toContain('role="dialog"');
		expect(html).not.toContain("新建");
	});
	it("shows task names, summaries, status and separate stop actions", () => {
		const html = render([
			child("running"),
			{ ...child("failed"), status: "failed" },
			{ ...child("done"), status: "completed" },
		]);
		expect(html).toContain("Read the code");
		expect(html).toContain("进行中");
		expect(html).toContain("失败");
		expect(html).toContain("已完成");
		expect(html.match(/停止子对话/g)).toHaveLength(1);
		expect(html).not.toContain("新建");
	});
	it("shows an empty state without a create-agent form", () => {
		const html = render([]);
		expect(html).toContain("暂无子对话");
		expect(html).not.toContain("<form");
	});
});

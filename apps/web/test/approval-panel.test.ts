import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@wuming/protocol";
import { ApprovalPanel } from "../src/components/ApprovalPanel.js";

const approval: ApprovalRequest = {
	id: "approval-test",
	sessionId: "session-test",
	workspaceId: "workspace-test",
	toolCallId: "tool-test",
	risk: "high",
	summary: "Run: git status --short",
	capabilities: [{ type: "process.exec", executable: "git", args: ["status", "--short"] }],
	status: "pending",
	createdAt: 1,
	expiresAt: 100,
};
const render = (value: ApprovalRequest) =>
	renderToStaticMarkup(createElement(ApprovalPanel, { approval: value, onRespond: async () => {} }));

describe("approval presentation", () => {
	it("shows command text without the transport prefix and preserves risk and actions", () => {
		const html = render(approval);
		expect(html).toContain("approval-command");
		expect(html).toContain("git status --short");
		expect(html).not.toContain("Run: ");
		expect(html).toContain("高风险");
		expect(html).toContain("process.exec");
		expect(html).toContain("允许");
		expect(html).toContain("拒绝");
	});
	it("preserves non-command summaries as prose and deduplicates capability labels", () => {
		const value: ApprovalRequest = {
			...approval,
			risk: "medium",
			summary: "Write the selected configuration",
			capabilities: [
				{ type: "filesystem.write", paths: ["a"] },
				{ type: "filesystem.write", paths: ["b"] },
			],
		};
		const html = render(value);
		expect(html).toContain("approval-summary");
		expect(html).toContain(value.summary);
		expect(html).toContain("中风险");
		expect(html.match(/filesystem.write/g)).toHaveLength(1);
	});
	it("escapes command contents and keeps long commands intact", () => {
		const summary = "<script>alert(1)</script> " + "very-long-argument".repeat(75);
		const html = render({ ...approval, risk: "low", summary });
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("very-long-argument".repeat(75));
		expect(html).toContain("低风险");
	});
});

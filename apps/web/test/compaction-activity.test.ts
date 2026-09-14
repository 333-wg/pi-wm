import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CompactionActivity } from "../src/components/CompactionActivity.js";

it.each([
	["running", "正在压缩上下文"],
	["failed", "上下文压缩未完成"],
	["cancelled", "上下文压缩已取消"],
] as const)("renders accessible %s compaction feedback", (status, label) => {
	const html = renderToStaticMarkup(createElement(CompactionActivity, { status }));
	expect(html).toContain('role="status"');
	expect(html).toContain(`aria-label="${label}"`);
	expect(html.includes('class="compaction-motion"')).toBe(status === "running");
});

it("removes compaction feedback immediately on completion", () => {
	expect(renderToStaticMarkup(createElement(CompactionActivity, { status: "complete" }))).toBe("");
});

import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../src/lib/locale.js";
import { workbenchMessages } from "../src/lib/workbench-messages.js";
import { describeTool, StatusIndicator, ToolCard } from "../src/components/ToolCard.js";
import { ContextDetails, ContextPill } from "../src/components/ContextMeter.js";
import { PermissionPicker } from "../src/components/PermissionPicker.js";
import { SessionSearch } from "../src/components/SessionSearch.js";
import { thinkingLabel, thinkingOptions } from "../src/components/ThinkingPicker.js";
import { renderLocalized } from "./render-localized.js";

const english = createTranslator("en");
const chinese = createTranslator("zh");
const han = /[\u3400-\u9fff]/;

describe("workbench translations", () => {
	it("has matching placeholders and English text for every workbench message", () => {
		const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		for (const [key, [zh, en]] of Object.entries(workbenchMessages)) {
			expect(en, key).not.toMatch(han);
			expect(placeholders(en), key).toEqual(placeholders(zh));
		}
	});

	it("preserves interpolation values without reinterpreting dollars or nested placeholders", () => {
		expect(english("viewArtifact", { name: "$& 中文 {name}.png" })).toBe("View $& 中文 {name}.png");
		expect(english("toolBudget", { amount: 1.5 })).toBe("Budget $1.5");
		expect(chinese("toolBudget", { amount: 1.5 })).toBe("预算 $1.5");
	});

	it("localizes desktop actions and leaves user arguments unchanged", () => {
		const args = { action: { kind: "double_click", text: "保留用户内容" } };
		expect(describeTool("computer_action", args, english)).toMatchObject({
			verb: "Desktop · Double click",
			meta: "Uses the real mouse and keyboard",
		});
		expect(describeTool("computer_screenshot", { monitor: 2 }, english)).toMatchObject({
			verb: "Desktop screenshot",
			meta: "Monitor 2",
		});
		expect(describeTool("computer_action", args, chinese).verb).toBe("桌面 · 双击");
		expect(describeTool("web_search", { query: "保留用户内容" }, english).target).toBe("保留用户内容");
		expect(describeTool("custom_tool", { text: "保留用户内容" }, english).verb).toBe("custom_tool");
	});

	it("renders every tool status in English", () => {
		for (const status of ["pending", "awaiting_approval", "running", "complete", "error", "aborted"] as const) {
			expect(renderLocalized(createElement(StatusIndicator, { status }), "en")).not.toMatch(han);
		}
		const card = createElement(ToolCard, { toolName: "computer_release", input: {}, status: "complete" });
		expect(renderLocalized(card, "en")).toContain("Release desktop control");
		expect(renderLocalized(card, "zh")).toContain("释放桌面控制");
	});

	it("localizes reasoning options, permission picker and search", () => {
		expect(thinkingLabel("medium", english)).toBe("Medium");
		expect(thinkingLabel("medium", chinese)).toBe("中");
		for (const option of thinkingOptions(english)) expect(option.label + option.description).not.toMatch(han);
		const permission = createElement(PermissionPicker, {
			value: { sandboxMode: "unrestricted", approvalPolicy: "never" },
			disabled: false,
			onChange: async () => {},
		});
		expect(renderLocalized(permission, "en")).toContain("Full access");
		expect(renderLocalized(permission, "en")).not.toMatch(han);
		expect(renderLocalized(permission, "zh")).toContain("完全访问权限");
		const search = createElement(SessionSearch, {
			archived: false,
			disabled: false,
			search: async () => ({ matches: [], truncated: false }),
			onOpen: async () => {},
		});
		expect(renderLocalized(search, "en")).toContain("Search messages");
		expect(renderLocalized(search, "en")).not.toMatch(han);
	});

	it("localizes unknown and measured context usage including accessibility text", () => {
		for (const tokens of [null, 4000]) {
			const usage = {
				tokens,
				ratio: tokens === null ? null : 0.04,
				contextWindow: 100000,
				basis: "compaction" as const,
			};
			for (const component of [ContextDetails, ContextPill]) {
				const html = renderLocalized(createElement(component, { usage }), "en");
				expect(html).not.toMatch(han);
				expect(html).not.toContain("NaN");
			}
		}
	});
});

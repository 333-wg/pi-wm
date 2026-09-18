import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "@wuming/protocol";
import { TeamLaunchNotice } from "../src/components/TeamLaunchNotice.js";
import { renderLocalized } from "./render-localized.js";

const item: Extract<TranscriptItem, { type: "tool" }> = {
	id: "launch",
	type: "tool",
	createdAt: 1,
	toolName: "team_start",
	toolCallId: "launch",
	status: "complete",
	isError: false,
	input: {},
	content: [{ type: "text", text: '{"teamId":"real-team-id"}' }],
};
const render = (value: TranscriptItem[]) =>
	renderLocalized(createElement(TeamLaunchNotice, { transcript: value, onOpen: () => {} }));
describe("team launch receipt", () => {
	it("shows a team ID and navigation only for a successful receipt", () => {
		expect(render([item])).toContain("real-team-id");
		expect(render([item])).toContain("打开团队");
		expect(render([item])).toContain("团队已创建");
		expect(render([])).toBe("");
	});
	it("distinguishes pending, failed and malformed results", () => {
		expect(render([{ ...item, status: "running", content: [] }])).toContain("正在创建团队");
		for (const value of [
			{ ...item, status: "error" as const, isError: true },
			{ ...item, content: [] },
		]) {
			expect(render([value])).toContain("团队创建未成功");
			expect(render([value])).not.toContain("打开团队");
		}
	});
});

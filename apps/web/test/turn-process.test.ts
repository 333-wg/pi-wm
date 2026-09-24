import type { TranscriptItem, RunSummary } from "@wuming/protocol";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { completedTurnProcesses } from "../src/lib/turn-process.js";
import { TurnProcess } from "../src/components/TurnProcess.js";
import { renderLocalized } from "./render-localized.js";

const user: TranscriptItem = { id: "u", type: "user", createdAt: 1000, content: [{ type: "text", text: "task" }] };
const assistant = (id: string, text: string, at = 2000): TranscriptItem => ({
	id,
	type: "assistant",
	createdAt: at,
	status: "complete",
	model: { provider: "demo", id: "demo" },
	content: [{ type: "text", text }],
});
const tool: TranscriptItem = {
	id: "tool",
	type: "tool",
	createdAt: 2500,
	toolCallId: "call",
	toolName: "read_file",
	status: "complete",
	isError: false,
	input: { path: "a.ts" },
	content: [{ type: "text", text: "result" }],
};
const progress = assistant("progress", "checking");
const answer = assistant("answer", "done", 5000);
const items = [user, progress, tool, answer];

describe("completed turn processes", () => {
	it("folds only the process, keeping the prompt and final answer out", () => {
		const [process] = completedTurnProcesses(items, false);
		expect([...process!.itemIds]).toEqual(["progress", "tool"]);
		expect(process!.durationMs).toBeUndefined();
	});
	it("does not fold live, approval, failed, aborted or unanswered work", () => {
		expect(completedTurnProcesses(items, true)).toEqual([]);
		for (const status of ["error", "aborted", "streaming"] as const) {
			expect(
				completedTurnProcesses([user, progress, { ...answer, type: "assistant", status } as TranscriptItem], false)
			).toEqual([]);
		}
		for (const status of ["running", "pending", "awaiting_approval"] as const) {
			expect(completedTurnProcesses([user, { ...tool, status }, answer], false)).toEqual([]);
		}
		expect(completedTurnProcesses([user, progress, tool], false)).toEqual([]);
		expect(completedTurnProcesses([user, answer], false)).toEqual([]);
	});
	it("keeps historical turns collapsed while another turn runs", () => {
		const history = [...items, { ...user, id: "u2", createdAt: 6000 }, assistant("p2", "working", 7000)];
		expect(completedTurnProcesses(history, true).map((process) => process.key)).toEqual(["u"]);
	});
	it("keeps artifacts outside the process", () => {
		const artifactTool: TranscriptItem = {
			...tool,
			content: [
				{
					type: "artifact",
					artifact: {
						id: "image",
						name: "image.png",
						mimeType: "image/png",
						size: 10,
					},
				},
			],
		};
		expect([...completedTurnProcesses([user, progress, artifactTool, answer], false)[0]!.itemIds]).toEqual([
			"progress",
		]);
	});
	it("uses recorded run duration rather than assistant message creation time", () => {
		const run: RunSummary = {
			id: "run",
			sessionId: "session",
			mode: "prompt",
			status: "completed",
			attempt: 1,
			createdAt: 1000,
			updatedAt: 8000,
			startedAt: 1100,
			finishedAt: 8000,
			abortRequested: false,
		};
		expect(completedTurnProcesses(items, false, [run])[0]?.durationMs).toBe(6900);
		// Demo/runtime ordering offsets can put the final item just after run completion.
		expect(completedTurnProcesses(items, false, [{ ...run, finishedAt: 4998 }])[0]?.durationMs).toBe(3898);
	});
	it("starts collapsed, exposes an accessible toggle and reveals search hits", () => {
		const html = renderLocalized(createElement(TurnProcess, { durationMs: 374000, children: "progress" }));
		expect(html).toContain("用时 6 分 14 秒");
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('hidden=""');
		const revealed = renderLocalized(createElement(TurnProcess, { reveal: true, children: "progress" }));
		expect(revealed).toContain('aria-expanded="true"');
		expect(revealed).not.toContain('hidden=""');
	});
});

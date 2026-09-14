import type { TranscriptItem } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { verificationEvidence } from "../src/verification.js";

function call(
	toolName: string,
	command = "",
	overrides: Partial<Extract<TranscriptItem, { type: "tool" }>> = {}
): TranscriptItem {
	return {
		id: toolName,
		type: "tool",
		toolCallId: toolName,
		toolName,
		createdAt: 1,
		status: "complete",
		isError: false,
		input: { command },
		content: [{ type: "text", text: "ok" }],
		...overrides,
	};
}

describe("verification evidence", () => {
	it.each([
		"npm test",
		"npm run check:tests",
		"npx vitest run",
		"npx playwright test",
		"python -m pytest",
		"cargo test",
		"pnpm build",
	])("recognizes %s after an edit", (command) => {
		expect(verificationEvidence([call("edit"), call("exec", command)]).hasVerification).toBe(true);
	});
	it.each(["git status", "ls", "npm run dev", "echo npm test"])("does not mistake %s for a check", (command) => {
		expect(verificationEvidence([call("edit"), call("exec", command)]).hasVerification).toBe(false);
	});
	it("rejects failed process output even when the tool call completed", () => {
		expect(
			verificationEvidence([
				call("edit"),
				call("exec", "npm test", {
					content: [{ type: "text", text: "[exit code 1]\nTests failed" }],
				}),
			]).hasVerification
		).toBe(false);
	});
	it.each(["error", "aborted", "running"] as const)("rejects %s checks", (status) => {
		expect(verificationEvidence([call("edit"), call("browser_screenshot", "", { status })]).hasVerification).toBe(
			false
		);
	});
	it("rejects tool errors independently of status", () => {
		expect(verificationEvidence([call("edit"), call("exec", "npm test", { isError: true })]).hasVerification).toBe(
			false
		);
	});
	it("requires new evidence after another edit", () => {
		expect(verificationEvidence([call("edit"), call("exec", "npm test"), call("edit")]).hasVerification).toBe(false);
	});
	it("does not infer success or ordering from tool names alone", () => {
		expect(
			verificationEvidence(
				[],
				[
					{
						toolName: "edit",
						callCount: 1,
						usage: {
							inputTokens: 0,
							outputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
					},
				]
			)
		).toEqual({ changedTools: ["edit"], hasVerification: false });
	});
});

import { describe, expect, it } from "vitest";
import type { ContentPart, TranscriptItem } from "@wuming/protocol";
import { anchorBefore, formatItemTime, formatItemTimestamp, latestUserItemIndex, messageText } from "../src/lib/transcript.js";

function user(id: string, text: string): TranscriptItem {
	return { id, createdAt: 1, type: "user", content: [{ type: "text", text }] };
}

describe("messageText", () => {
	it("joins the text parts and drops everything else", () => {
		const parts: ContentPart[] = [
			{ type: "text", text: "第一段" },
			{ type: "thinking", text: "内部推理" },
			{ type: "tool_call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.ts" } },
			{ type: "text", text: "第二段" },
		];
		expect(messageText(parts)).toBe("第一段\n\n第二段");
	});

	it("is empty when a message carries no prose", () => {
		expect(messageText([{ type: "text", text: "   " }])).toBe("");
		expect(messageText([{ type: "thinking", text: "只有推理" }])).toBe("");
		expect(messageText([])).toBe("");
	});
});

describe("anchorBefore", () => {
	const transcript = [user("a", "一"), user("b", "二"), user("c", "三")];

	it("names the item before the one given", () => {
		expect(anchorBefore(transcript, "b")).toBe("a");
		expect(anchorBefore(transcript, "c")).toBe("b");
	});

	// Both of these must stay undefined rather than fall back to the last item:
	// the caller starts a fresh session for them, and a fork with no anchor would
	// copy the whole transcript instead.
	it("has no anchor for the first item or an unknown one", () => {
		expect(anchorBefore(transcript, "a")).toBeUndefined();
		expect(anchorBefore(transcript, "missing")).toBeUndefined();
		expect(anchorBefore([], "a")).toBeUndefined();
	});
});

describe("latestUserItemIndex", () => {
	it("separates the active turn from earlier transcript history", () => {
		const transcript: TranscriptItem[] = [
			user("first-user", "一"),
			{ id: "first-tool", createdAt: 2, type: "tool", toolCallId: "tool-1", toolName: "read_file", input: {}, content: [], status: "complete", isError: false },
			user("latest-user", "二"),
			{ id: "latest-tool", createdAt: 3, type: "tool", toolCallId: "tool-2", toolName: "ls", input: {}, content: [], status: "complete", isError: false },
		];

		expect(latestUserItemIndex(transcript)).toBe(2);
		expect(latestUserItemIndex([])).toBe(-1);
	});
});

describe("formatItemTime", () => {
	const at = new Date(2026, 8, 2, 9, 5).getTime();

	it("shows only the clock for the same day", () => {
		expect(formatItemTime(at, new Date(2026, 8, 2, 23, 59).getTime())).toBe("09:05");
	});

	it("adds the date once the day differs", () => {
		expect(formatItemTime(at, new Date(2026, 8, 3, 0, 1).getTime())).toBe("9 月 2 日 09:05");
		expect(formatItemTime(at, new Date(2027, 0, 1, 12, 0).getTime())).toBe("9 月 2 日 09:05");
	});

	it("spells the full timestamp for the tooltip", () => {
		expect(formatItemTimestamp(new Date(2026, 8, 2, 9, 5, 7).getTime())).toBe("2026-09-02 09:05:07");
	});
});

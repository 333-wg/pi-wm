import type { TranscriptItem } from "@wuming/protocol";
import { appendForkTitle, isAutomaticSessionTitle, suggestSessionTitle, suggestSessionTitleFromTranscript } from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("session titles", () => {
	it("builds a compact title from the first user text", () => {
		expect(suggestSessionTitle([{ type: "text", text: "#   Fix the login flow\n\nand add regression tests" }])).toBe(
			"Fix the login flow and add regression tests",
		);
	});

	it("uses attachment names when a prompt has no text", () => {
		expect(suggestSessionTitle([
			{ type: "artifact", artifact: { id: "one", name: "report.docx", mimeType: "application/octet-stream", size: 12 } },
			{ type: "artifact", artifact: { id: "two", name: "chart.png", mimeType: "image/png", size: 24 } },
		])).toBe("report.docx, chart.png");
	});

	it("uses the first usable user item in a transcript and truncates long titles", () => {
		const transcript: TranscriptItem[] = [
			{ id: "assistant", type: "assistant", createdAt: 1, status: "complete", content: [{ type: "text", text: "Ignore this" }], model: { provider: "test", id: "test" } },
			{ id: "empty", type: "user", createdAt: 2, content: [{ type: "text", text: "   " }] },
			{ id: "user", type: "user", createdAt: 3, content: [{ type: "text", text: "x".repeat(80) }] },
		];
		const title = suggestSessionTitleFromTranscript(transcript)!;
		expect(Array.from(title)).toHaveLength(48);
		expect(title.endsWith("…")).toBe(true);
	});

	it("recognizes legacy generated fork names and keeps one fork suffix", () => {
		expect(isAutomaticSessionTitle(undefined)).toBe(true);
		expect(isAutomaticSessionTitle("Session (fork) (fork)")).toBe(true);
		expect(isAutomaticSessionTitle("Release review")).toBe(false);
		expect(appendForkTitle("Release review (fork)")).toBe("Release review (fork)");
	});
});

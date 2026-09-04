import { describe, expect, it } from "vitest";
import { crashReport, crashSummary, ErrorBoundary } from "../src/components/ErrorBoundary.js";

describe("crash summary", () => {
	it("names the error and its message", () => {
		expect(crashSummary(new TypeError("items.map is not a function"))).toBe("TypeError: items.map is not a function");
	});

	it("falls back to the error name when there is no message", () => {
		expect(crashSummary(new RangeError(""))).toBe("RangeError");
	});

	it("keeps a thrown string readable", () => {
		expect(crashSummary("gateway closed the stream")).toBe("gateway closed the stream");
	});

	it("describes a thrown object without help from its own formatting", () => {
		expect(crashSummary({ code: 42 })).toBe('{"code":42}');
	});

	it("survives objects JSON cannot serialise", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(crashSummary(circular)).toBe("[object Object]");
		expect(crashSummary({ toJSON: () => undefined })).toBe("[object Object]");
		expect(crashSummary({ get boom(): never { throw new Error("getter"); } })).toBe("[object Object]");
	});

	it("still says something when nothing was thrown but the render failed", () => {
		expect(crashSummary(undefined)).toBe("undefined");
		expect(crashSummary("   ")).toBe("未知错误");
	});
});

describe("crash report", () => {
	it("prefers the stack and adds the component stack React alone can supply", () => {
		const error = new Error("boom");
		error.stack = "Error: boom\n    at Markdown (Markdown.tsx:12:3)";
		const report = crashReport(error, "\n    at Markdown\n    at TranscriptItemView");
		expect(report).toBe("Error: boom\n    at Markdown (Markdown.tsx:12:3)\n\n组件栈:\n    at Markdown\n    at TranscriptItemView");
	});

	it("omits the component stack section when React did not provide one", () => {
		const error = new Error("boom");
		error.stack = "Error: boom";
		expect(crashReport(error, "   ")).toBe("Error: boom");
		expect(crashReport(error, null)).toBe("Error: boom");
	});

	it("reports a stackless failure with its summary instead of nothing", () => {
		expect(crashReport("gateway closed the stream")).toBe("gateway closed the stream");
	});
});

describe("error boundary state", () => {
	it("records the failure and clears the previous copy result", () => {
		const error = new Error("boom");
		expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ crashed: true, error, copy: "idle" });
	});
});

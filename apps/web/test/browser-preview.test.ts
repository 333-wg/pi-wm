import { describe, expect, it } from "vitest";
import { previewUrl } from "../src/lib/browser-preview.js";

describe("preview tool routing", () => {
	it("only routes local preview URLs, not arbitrary tool or credential-bearing input", () => {
		expect(previewUrl("preview_start", { url: "http://localhost:3000" })).toBe("http://localhost:3000/");
		expect(previewUrl("preview_start", { url: "http://[::1]:3000" })).toBe("http://[::1]:3000/");
		for (const input of [
			null,
			{},
			{ url: "javascript:alert(1)" },
			{ url: "https://example.com" },
			{ url: "http://user:pass@localhost" },
		])
			expect(previewUrl("preview_start", input)).toBeUndefined();
		expect(previewUrl("bash", { url: "http://localhost" })).toBeUndefined();
	});
});

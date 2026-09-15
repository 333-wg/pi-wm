import { describe, expect, it } from "vitest";
import { mediaErrorDetail, mediaResponseError, mediaRetryAfter } from "../src/media-errors.js";
const config = {
	kind: "video" as const,
	baseUrl: "https://relay.example/v1",
	model: "video",
	apiKey: "fixture/private-secret",
};
describe("media diagnostic safety", () => {
	it("parses Retry-After seconds and HTTP dates without accepting invalid waits", () => {
		const now = Date.parse("2026-09-14T00:00:00Z");
		expect(mediaRetryAfter("120", now)).toBe(120_000);
		expect(mediaRetryAfter("Mon, 14 Sep 2026 00:02:00 GMT", now)).toBe(120_000);
		expect(mediaRetryAfter("0", now)).toBe(0);
		for (const value of [null, "", "invalid", "-1", "99999999999999999999999999", "Sun, 13 Sep 2026 00:00:00 GMT"])
			expect(mediaRetryAfter(value, now)).toBeUndefined();
	});
	it.each([429, 500, 502, 503, 504])("only marks safe retrieval as retryable for HTTP %i", async (status) => {
		const response = () => new Response("busy", { status, headers: { "retry-after": "120" } });
		expect(await mediaResponseError(response(), config, false)).toMatchObject({
			details: { retryable: true, retryAfterMs: 120_000 },
		});
		expect(await mediaResponseError(response(), config, true)).toMatchObject({ details: { retryable: false } });
	});
	it("preserves allowlisted diagnostics but redacts secrets, encoded keys, bearer values and URLs", () => {
		const detail = mediaErrorDetail(
			{
				error: {
					message:
						"size must be 720P " +
						config.apiKey +
						" " +
						encodeURIComponent(config.apiKey) +
						" " +
						Buffer.from(config.apiKey).toString("base64") +
						" Bearer other-secret https://cdn.example/file?token=signed data:image/png;base64,private-image",
				},
			},
			config
		);
		expect(detail).toContain("size must be 720P");
		for (const secret of [
			config.apiKey,
			"other-secret",
			"signed",
			"private-image",
			encodeURIComponent(config.apiKey),
			Buffer.from(config.apiKey).toString("base64"),
		])
			expect(detail).not.toContain(secret);
	});
	it("never serializes full provider payloads or HTML error pages", () => {
		expect(mediaErrorDetail({ prompt: "private", apiKey: "secret", error: { data: "private" } }, config)).toBe("");
		expect(mediaErrorDetail("<!DOCTYPE html><html>private</html>", config)).toBe("");
	});
	it("bounds diagnostic text and response bodies", async () => {
		expect(mediaErrorDetail({ detail: "x".repeat(2000) }, config)).toHaveLength(800);
		const error = await mediaResponseError(new Response("x".repeat(40 * 1024), { status: 400 }), config, true);
		expect(error.message).toContain("HTTP 400");
		expect(error.message.length).toBeLessThan(1000);
	});
});

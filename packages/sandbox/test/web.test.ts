import { describe, expect, it } from "vitest";
import {
	isAllowedWebResolution,
	isPublicWebAddress,
	isSupportedTextContentType,
	parseBingItems,
	parseDuckDuckGoItems,
	SafeWebClient,
	validateWebUrl,
} from "../src/index.js";

describe("safe web access", () => {
	it("accepts only public HTTP(S) URLs on their standard ports", () => {
		expect(validateWebUrl("https://example.com/path#fragment").toString()).toBe("https://example.com/path");
		for (const value of [
			"file:///etc/passwd",
			"http://user:password@example.com",
			"http://localhost",
			"http://service.local/path",
			"http://127.0.0.1",
			"http://169.254.169.254/latest/meta-data",
			"http://10.0.0.1",
			"http://[::ffff:127.0.0.1]",
			"https://example.com:8443",
		])
			expect(() => validateWebUrl(value)).toThrow();
	});

	it("classifies private, reserved, and public addresses", () => {
		for (const address of [
			"0.0.0.0",
			"10.1.2.3",
			"100.64.1.1",
			"127.0.0.1",
			"192.168.1.1",
			"::1",
			"fc00::1",
			"fe80::1",
			"2001:db8::1",
		]) {
			expect(isPublicWebAddress(address)).toBe(false);
		}
		expect(isPublicWebAddress("8.8.8.8")).toBe(true);
		expect(isPublicWebAddress("2606:4700:4700::1111")).toBe(true);
	});

	it("accepts textual MIME types with parameters and rejects binary content", () => {
		for (const contentType of [
			"text/html; charset=utf-8",
			"text/plain",
			"application/json",
			"application/xhtml+xml; charset=UTF-8",
			"application/problem+json",
			"application/atom+xml",
		])
			expect(isSupportedTextContentType(contentType)).toBe(true);

		for (const contentType of ["application/octet-stream", "image/png", "textual/html", ""]) {
			expect(isSupportedTextContentType(contentType)).toBe(false);
		}
	});

	it("rejects a public-looking hostname when DNS resolves to a private address", async () => {
		const client = new SafeWebClient({
			resolver: async () => [{ address: "127.0.0.1", family: 4 }],
		});
		await expect(client.fetch("https://example.com")).rejects.toMatchObject({
			code: "network_denied",
		});
	});

	it("applies the web deadline while DNS resolution is pending", async () => {
		const client = new SafeWebClient({
			timeoutMs: 20,
			resolver: () => new Promise(() => {}),
		});
		await expect(client.fetch("https://example.com")).rejects.toMatchObject({
			code: "network_timeout",
		});
	});

	it("cancels while DNS resolution is pending", async () => {
		const controller = new AbortController();
		const client = new SafeWebClient({ resolver: () => new Promise(() => {}) });
		const pending = client.fetch("https://example.com", { signal: controller.signal });
		controller.abort(new Error("cancelled by test"));
		await expect(pending).rejects.toThrow("cancelled by test");
	});

	it("allows synthetic proxy DNS only after an explicit opt-in", () => {
		expect(isAllowedWebResolution("198.18.1.25", false)).toBe(false);
		expect(isAllowedWebResolution("198.18.1.25", true)).toBe(true);
		expect(isAllowedWebResolution("127.0.0.1", true)).toBe(false);
	});

	it("parses structured DuckDuckGo HTML results and unwraps redirect URLs", () => {
		const items = parseDuckDuckGoItems(
			`
			<div class="result">
				<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example docs</a>
				<a class="result__snippet">Useful <b>documentation</b>.</a>
			</div>
		`,
			5
		);
		expect(items).toEqual([
			{ title: "Example docs", url: "https://example.com/docs", snippet: "Useful documentation." },
		]);
	});

	it("parses structured Bing HTML results", () => {
		expect(
			parseBingItems(
				`
			<li class="b_algo"><h2><a href="https://example.com/docs">Example docs</a></h2>
			<div class="b_caption"><p>Useful <strong>documentation</strong>.</p></div></li>
		`,
				5
			)
		).toEqual([{ title: "Example docs", url: "https://example.com/docs", snippet: "Useful documentation." }]);
	});

	it("validates search configuration without exposing secrets", async () => {
		expect(() => new SafeWebClient({ search: { provider: "brave", apiKey: "" } })).toThrow(/must not be empty/);
		const client = new SafeWebClient({ search: { provider: "brave", apiKey: "secret" } });
		expect(client.searchHost).toBe("api.search.brave.com");
		expect(client.searchSecretName).toBe("WUMING_WEB_SEARCH_API_KEY");
		await expect(client.search("   ")).rejects.toMatchObject({ code: "network_failed" });
	});
});

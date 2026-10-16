import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { deepSeekAccountFetch, deepSeekAccountProvider, loginDeepSeek } from "../src/deepseek-account.js";

const envelope = (value: unknown) => Response.json({ code: 0, data: { biz_code: 0, biz_data: value } });
const token = "private-deepseek-grant";
function authFixture() {
	let initialization: Record<string, string> = {};
	const calls: string[] = [];
	const fetcher = vi.fn<typeof fetch>(async (input, options) => {
		const url = String(input);
		calls.push(url);
		expect(options?.redirect).toBe("error");
		const body = JSON.parse(String(options?.body));
		if (url.endsWith("auth_init")) {
			initialization = body;
			return envelope({
				authorize_url: "https://platform.deepseek.com/dsh/authorize?id=example",
				authorize_id: "attempt",
				expires_in: 120,
			});
		}
		if (url.endsWith("auth_exchange")) {
			expect(body.redirect_uri).toBe(initialization.redirect_uri);
			expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(initialization.code_challenge);
			return envelope({ token, authorized_url: "https://platform.deepseek.com/dsh/authorized" });
		}
		return envelope({});
	});
	return {
		fetcher,
		calls,
		callback: (state?: string) =>
			`${initialization.redirect_uri}?code=one-use-code&state=${state ?? initialization.state}`,
	};
}

describe("DeepSeek browser authorization", () => {
	it("uses a loopback callback, validates state, exchanges once and closes its listener", async () => {
		const fixture = authFixture();
		let callback = "";
		let callbacks: Promise<void> = Promise.resolve();
		const controller = new AbortController();
		const result = await loginDeepSeek(
			{
				signal: controller.signal,
				prompt: async () => {
					throw new Error("No password prompt");
				},
				notify: () => {
					callback = fixture.callback();
					callbacks = (async () => {
						expect(new URL(callback).hostname).toBe("127.0.0.1");
						expect((await fetch(fixture.callback("wrong"))).status).toBe(400);
						expect((await fetch(callback + "&state=duplicate")).status).toBe(400);
						expect((await fetch(callback)).status).toBe(200);
					})();
					void callbacks.catch(() => controller.abort());
				},
			},
			fixture.fetcher
		);
		await callbacks;
		expect(result).toMatchObject({ type: "oauth", access: token });
		expect(fixture.calls.filter((url) => url.endsWith("auth_exchange"))).toHaveLength(1);
		await expect(fetch(callback)).rejects.toThrow();
	});
	it("cancel closes the listener, cancels the remote attempt and never exchanges", async () => {
		const fixture = authFixture();
		const controller = new AbortController();
		let callback = "";
		await expect(
			loginDeepSeek(
				{
					signal: controller.signal,
					prompt: async () => "",
					notify: () => {
						callback = fixture.callback();
						controller.abort();
					},
				},
				fixture.fetcher
			)
		).rejects.toThrow("DeepSeek");
		await expect(fetch(callback)).rejects.toThrow();
		await vi.waitFor(() => expect(fixture.calls.some((url) => url.endsWith("auth_cancel"))).toBe(true));
		expect(fixture.calls.some((url) => url.endsWith("auth_exchange"))).toBe(false);
	});
	it("rejects malicious authorization destinations and redacts malformed responses", async () => {
		const notify = vi.fn();
		await expect(
			loginDeepSeek({ signal: new AbortController().signal, prompt: async () => "", notify }, async () =>
				envelope({
					authorize_id: "x",
					authorize_url: "https://attacker.invalid/dsh/authorize?secret=hidden",
					expires_in: 60,
				})
			)
		).rejects.toThrow("DeepSeek account request failed");
		expect(notify).not.toHaveBeenCalled();
	});
	it("expires the server's short authorization window and closes its listener", async () => {
		const fixture = authFixture();
		let callback = "";
		const fetcher: typeof fetch = async (input, options) => {
			const result = await fixture.fetcher(input, options);
			if (!String(input).endsWith("auth_init")) return result;
			const body = await result.json();
			body.data.biz_data.expires_in = 0.02;
			return Response.json(body);
		};
		await expect(
			loginDeepSeek(
				{
					signal: new AbortController().signal,
					prompt: async () => "",
					notify: () => {
						callback = fixture.callback();
					},
				},
				fetcher
			)
		).rejects.toThrow("DeepSeek");
		await expect(fetch(callback)).rejects.toThrow();
		expect(fixture.calls.some((url) => url.endsWith("auth_exchange"))).toBe(false);
	});
	it("does not accept a late token after cancellation during exchange", async () => {
		const fixture = authFixture();
		const controller = new AbortController();
		const fetcher: typeof fetch = async (input, options) => {
			const result = await fixture.fetcher(input, options);
			if (String(input).endsWith("auth_exchange")) controller.abort();
			return result;
		};
		await expect(
			loginDeepSeek(
				{
					signal: controller.signal,
					prompt: async () => "",
					notify: () => {
						void fetch(fixture.callback()).catch(() => {});
					},
				},
				fetcher
			)
		).rejects.toThrow("DeepSeek");
	});
});

describe("DeepSeek account transport", () => {
	it("pins the inference destination and strips other auth and refuses redirects", async () => {
		const inner = vi.fn<typeof fetch>(async (_input, options) => {
			const headers = new Headers(options?.headers);
			expect(headers.get("x-dsh-auth-token")).toBe(token);
			expect(headers.has("authorization")).toBe(false);
			expect(headers.has("x-api-key")).toBe(false);
			expect(options?.redirect).toBe("error");
			return new Response("ok");
		});
		const safe = deepSeekAccountFetch(token, inner);
		await expect(safe("https://attacker.invalid/anthropic/v1/messages")).rejects.toThrow();
		await expect(safe("https://api.deepseek.com/other")).rejects.toThrow();
		expect(inner).not.toHaveBeenCalled();
		await safe("https://api.deepseek.com/anthropic/v1/messages", {
			headers: { Authorization: "Bearer other", "x-api-key": "other" },
		});
		expect(inner).toHaveBeenCalledTimes(1);
	});
	it("redacts upstream error bodies including opaque tokens", async () => {
		const response = await deepSeekAccountFetch(
			token,
			async () => new Response(token, { status: 401 })
		)("https://api.deepseek.com/anthropic/v1/messages");
		expect(response.status).toBe(401);
		const body = await response.text();
		expect(body).not.toContain(token);
		expect(body).toContain("重新登录");
	});
	it("sends native SDK tools, text and DeepSeek thinking settings without API-key auth", async () => {
		const provider = deepSeekAccountProvider();
		const model = provider.getModels()[0]!;
		const auth = await provider.auth.oauth!.toAuth({
			type: "oauth",
			access: token,
			refresh: "none",
			expires: Number.MAX_SAFE_INTEGER,
		});
		for (const reasoning of [undefined, "high"] as const) {
			const fetcher = vi.fn<typeof fetch>(async (_input, options) => {
				expect(new Headers(options?.headers).get("x-dsh-auth-token")).toBe(token);
				const body = JSON.parse(String(options?.body));
				expect(body.model).toBe("deepseek-flash");
				expect(body.tools[0].name).toBe("read_file");
				expect(body.thinking.type).toBe(reasoning ? "enabled" : "disabled");
				if (reasoning) expect(body.output_config.effort).toBe("high");
				const events = [
					[
						"message_start",
						{
							type: "message_start",
							message: {
								id: "m1",
								type: "message",
								role: "assistant",
								model: model.id,
								content: [],
								usage: { input_tokens: 10, output_tokens: 0 },
							},
						},
					],
					["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
					[
						"content_block_delta",
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
					],
					["content_block_stop", { type: "content_block_stop", index: 0 }],
					["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
					["message_stop", { type: "message_stop" }],
				];
				return new Response(
					events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } }
				);
			});
			const result = await provider
				.streamSimple(
					model,
					{
						messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
						tools: [{ name: "read_file", description: "Read file", parameters: Type.Object({ path: Type.String() }) }],
					},
					{ ...auth, fetch: fetcher, ...(reasoning ? { reasoning } : {}) }
				)
				.result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toContainEqual({ type: "text", text: "hello" });
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	});
});

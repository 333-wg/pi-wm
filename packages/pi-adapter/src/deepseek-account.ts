import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { arch, platform, release } from "node:os";
import {
	createProvider,
	type OAuthCredential,
	type ProviderAuthInteraction,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";

// Protocol reference: DeepSeek Harness packages/credentials/deepseek-account-platform.
// Account grants are not API keys and must never be sent to custom endpoints.
const PLATFORM = "https://platform.deepseek.com";
const INFERENCE = "https://api.deepseek.com";
const HEADER = "x-dsh-auth-token";
export const DEEPSEEK_ACCOUNT_ID = "official-deepseek";
const invalid = () => new Error("DeepSeek account request failed; check your connection or sign in again.");
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 8000) throw invalid();
	return value;
}
function browserUrl(value: unknown, path: string): string {
	const url = new URL(text(value));
	if (url.origin !== PLATFORM || url.pathname !== path || url.username || url.password || url.hash) throw invalid();
	return url.href;
}
async function json(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw invalid();
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			size += item.value.byteLength;
			if (size > 65536) throw invalid();
			chunks.push(item.value);
		}
		return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} finally {
		await reader.cancel().catch(() => {});
	}
}
function identityHeaders() {
	return {
		"x-client-bundle-id": "",
		"x-client-platform":
			process.platform === "win32" ? "desktop-win" : process.platform === "darwin" ? "desktop-mac" : "web",
		"x-client-version": "0.2.1-alpha.2",
		"x-client-locale": "zh_CN",
		"x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
	};
}
async function request(path: string, body: unknown, signal: AbortSignal, fetcher: typeof fetch, token?: string) {
	try {
		const result = await json(
			await fetcher(PLATFORM + path, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
				headers: { ...identityHeaders(), "content-type": "application/json", ...(token ? { [HEADER]: token } : {}) },
				body: JSON.stringify(body),
			})
		);
		const data = object(result.data);
		if (result.code !== 0 || data.biz_code !== 0) throw invalid();
		return data.biz_data;
	} catch {
		throw invalid();
	}
}

export async function loginDeepSeek(
	interaction: ProviderAuthInteraction,
	fetcher: typeof fetch = fetch
): Promise<OAuthCredential> {
	const verifier = randomBytes(32).toString("base64url");
	const state = randomBytes(32).toString("base64url");
	const lifetime = new AbortController();
	const signal = AbortSignal.any([interaction.signal, lifetime.signal]);
	const started = Date.now();
	let timer = setTimeout(() => lifetime.abort(), 600000);
	timer.unref();
	let authorizeId: string | undefined;
	let accepted = false;
	let ready = false;
	let complete = false;
	let resolveCode!: (code: string) => void;
	let rejectCode!: (error: Error) => void;
	const code = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
	void code.catch(() => {});
	const abort = () => rejectCode(invalid());
	signal.addEventListener("abort", abort, { once: true });
	let callbackOrigin = "";
	const server = createServer((req, res) => {
		res.setHeader("cache-control", "no-store");
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader("content-type", "text/plain; charset=utf-8");
		try {
			const url = new URL(req.url ?? "/", callbackOrigin);
			const received = url.searchParams.get("state") ?? "";
			const candidate = url.searchParams.get("code");
			if (
				req.method !== "GET" ||
				req.headers.host !== new URL(callbackOrigin).host ||
				url.origin !== callbackOrigin ||
				url.pathname !== "/oauth/callback" ||
				url.searchParams.getAll("state").length !== 1 ||
				url.searchParams.getAll("code").length !== 1 ||
				!candidate ||
				candidate.length > 8000 ||
				Buffer.byteLength(received) !== Buffer.byteLength(state) ||
				!timingSafeEqual(Buffer.from(received), Buffer.from(state))
			) {
				res.writeHead(400).end("Invalid authorization callback.");
				return;
			}
			if (!ready || accepted || signal.aborted) {
				res.writeHead(410).end("Authorization no longer available.");
				return;
			}
			accepted = true;
			resolveCode(candidate);
			res.end("已收到授权回调，请返回 Pi-Wm 查看登录结果。 / Return to Pi-Wm to check sign-in status.");
		} catch {
			res.writeHead(400).end("Invalid authorization callback.");
		}
	});
	try {
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw invalid();
		callbackOrigin = `http://127.0.0.1:${address.port}`;
		const redirect = callbackOrigin + "/oauth/callback";
		const init = object(
			await request(
				"/auth-api/v0/dsh/auth_init",
				{
					code_challenge: createHash("sha256").update(verifier).digest("base64url"),
					code_challenge_method: "S256",
					state,
					redirect_uri: redirect,
					locale: "zh_CN",
					login_source: "web",
				},
				signal,
				fetcher
			)
		);
		authorizeId = text(init.authorize_id);
		const authorizeUrl = browserUrl(init.authorize_url, "/dsh/authorize");
		if (typeof init.expires_in !== "number" || !Number.isFinite(init.expires_in) || init.expires_in <= 0)
			throw invalid();
		signal.throwIfAborted();
		clearTimeout(timer);
		timer = setTimeout(
			() => lifetime.abort(),
			Math.max(1, Math.min(600000 - (Date.now() - started), init.expires_in * 1000))
		);
		timer.unref();
		ready = true;
		interaction.notify({ type: "auth_url", url: authorizeUrl });
		const receivedCode = await code;
		signal.throwIfAborted();
		const result = object(
			await request(
				"/auth-api/v0/dsh/auth_exchange",
				{
					code: receivedCode,
					code_verifier: verifier,
					redirect_uri: redirect,
					device_id: randomUUID(),
					device_model: `${platform()}-${arch()}`,
					os_version: `${platform()} ${release()}`,
				},
				signal,
				fetcher
			)
		);
		const token = text(result.token);
		if (!/^[\x21-\x7e]+$/.test(token)) throw invalid();
		browserUrl(result.authorized_url, "/dsh/authorized");
		signal.throwIfAborted();
		complete = true;
		// SDK credential envelope only: this protocol has no refresh token or expiry.
		return { type: "oauth", access: token, refresh: "not-applicable", expires: Number.MAX_SAFE_INTEGER };
	} catch {
		throw invalid();
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (!complete && authorizeId)
			void request(
				"/auth-api/v0/dsh/auth_cancel",
				{
					authorize_id: authorizeId,
					code_verifier: verifier,
				},
				AbortSignal.timeout(5000),
				fetcher
			).catch(() => {});
	}
}

/** Local deletion is owned by the manager; remote failure must never restore a grant. */
export async function revokeDeepSeek(token: string, fetcher: typeof fetch = fetch): Promise<void> {
	await request("/auth-api/v0/users/logout", {}, AbortSignal.timeout(5000), fetcher, token);
}

export function deepSeekAccountFetch(token: string, inner: typeof fetch = fetch): typeof fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== INFERENCE || url.username || url.password || url.pathname !== "/anthropic/v1/messages")
			throw invalid();
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
		headers.delete("authorization");
		headers.delete("x-api-key");
		headers.delete("anthropic-beta");
		headers.set(HEADER, token);
		try {
			const response = await inner(input, { ...init, headers, redirect: "error" });
			if (!response.ok) {
				await response.body?.cancel();
				return Response.json(
					{
						type: "error",
						error: {
							type: "api_error",
							message:
								response.status === 401
									? "DeepSeek 登录已失效，请退出后重新登录。"
									: `DeepSeek 请求失败（HTTP ${response.status}），请检查账号余额或稍后重试。`,
						},
					},
					{ status: response.status }
				);
			}
			return response;
		} catch {
			throw invalid();
		}
	};
}

export function deepSeekAccountProvider() {
	const options = (value?: StreamOptions): StreamOptions => {
		const token = value?.headers?.[HEADER];
		if (!token) throw invalid();
		return {
			...value,
			apiKey: "account-auth-placeholder",
			fetch: deepSeekAccountFetch(token, value?.fetch),
			headers: { ...value?.headers, "anthropic-beta": null },
			onPayload: async (payload, model) => {
				const body = object(payload);
				if (body.thinking) body.thinking = { type: object(body.thinking).type === "disabled" ? "disabled" : "enabled" };
				else body.thinking = { type: "disabled" };
				return (await value?.onPayload?.(body, model)) ?? body;
			},
		};
	};
	return createProvider({
		id: DEEPSEEK_ACCOUNT_ID,
		name: "DeepSeek",
		baseUrl: INFERENCE + "/anthropic",
		auth: {
			oauth: {
				name: "DeepSeek 开放平台账号",
				login: (interaction) => loginDeepSeek(interaction),
				refresh: async () => {
					throw invalid();
				},
				toAuth: async (credential) => ({ headers: { [HEADER]: credential.access } }),
			},
		},
		models: ["deepseek-flash", "deepseek-v4-pro"].map((id) => ({
			id,
			name: id === "deepseek-flash" ? "DeepSeek-V4.1-Flash" : "DeepSeek-V4-Pro",
			api: "anthropic-messages" as const,
			provider: DEEPSEEK_ACCOUNT_ID,
			baseUrl: INFERENCE + "/anthropic",
			reasoning: true,
			input: ["text" as const],
			contextWindow: 1000000,
			maxTokens: 32768,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
			compat: { forceAdaptiveThinking: true, supportsStrictTools: false },
		})),
		api: {
			stream: (model, context, value) => stream(model as Parameters<typeof stream>[0], context, options(value)),
			streamSimple: (model, context, value) =>
				streamSimple(model as Parameters<typeof streamSimple>[0], context, { ...value, ...options(value) }),
		},
	});
}

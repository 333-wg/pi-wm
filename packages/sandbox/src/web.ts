import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { load } from "cheerio";
import { convert } from "html-to-text";
import { SandboxError } from "./errors.js";
import type { WebFetchOptions, WebFetchResult, WebSandbox, WebSearchOptions, WebSearchResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_URL_CHARS = 4096;
const MAX_SEARCH_RESULTS = 10;

const blockedAddresses = new BlockList();
const proxyDnsAddresses = new BlockList();
proxyDnsAddresses.addSubnet("198.18.0.0", 15, "ipv4");
for (const [network, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
	["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32],
	["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");

export type WebSearchConfiguration =
	| { provider: "bing"; endpoint?: string }
	| { provider: "duckduckgo"; endpoint?: string }
	| { provider: "brave"; apiKey: string; endpoint?: string }
	| { provider: "searxng"; endpoint: string };

export interface SafeWebClientOptions {
	search?: WebSearchConfiguration;
	timeoutMs?: number;
	maxResponseBytes?: number;
	allowProxyDnsAddresses?: boolean;
	resolver?: (hostname: string) => Promise<LookupAddress[]>;
}

interface RawResponse {
	url: string;
	status: number;
	headers: IncomingHttpHeaders;
	body: Buffer;
	truncated: boolean;
}

function hostnameOf(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

export function isPublicWebAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return !blockedAddresses.check(address, "ipv4");
	if (family === 6) return !address.toLowerCase().startsWith("::ffff:") && !blockedAddresses.check(address, "ipv6");
	return false;
}

export function validateWebUrl(value: string): URL {
	if (!value || value.length > MAX_URL_CHARS) throw new SandboxError("network_denied", "URL is empty or too long");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new SandboxError("network_denied", "URL is invalid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new SandboxError("network_denied", "Only HTTP and HTTPS URLs are allowed");
	if (url.username || url.password) throw new SandboxError("network_denied", "URLs containing credentials are not allowed");
	const hostname = hostnameOf(url);
	if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
		throw new SandboxError("network_denied", "Local network hostnames are not allowed");
	}
	const explicitPort = url.port ? Number(url.port) : undefined;
	const expectedPort = url.protocol === "https:" ? 443 : 80;
	if (explicitPort !== undefined && explicitPort !== expectedPort) {
		throw new SandboxError("network_denied", `Only port ${expectedPort} is allowed for ${url.protocol.slice(0, -1).toUpperCase()}`);
	}
	if (isIP(hostname) && !isPublicWebAddress(hostname)) throw new SandboxError("network_denied", "Private and reserved network addresses are not allowed");
	url.hash = "";
	return url;
}

function decodeBody(body: Buffer, contentType: string): string {
	const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(body);
	} catch {
		return new TextDecoder("utf-8").decode(body);
	}
}

function readableContent(body: Buffer, contentType: string): string {
	if (body.includes(0)) throw new SandboxError("content_unsupported", "Response appears to contain binary data");
	const decoded = decodeBody(body, contentType);
	if (/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
		return convert(decoded, {
			wordwrap: false,
			selectors: [
				{ selector: "script", format: "skip" },
				{ selector: "style", format: "skip" },
				{ selector: "noscript", format: "skip" },
				{ selector: "img", format: "skip" },
			],
		});
	}
	if (/^(application\/json|[^;]+\+json)(?:;|$)/i.test(contentType)) {
		try { return JSON.stringify(JSON.parse(decoded), null, 2); } catch { return decoded; }
	}
	return decoded;
}

function supportsText(contentType: string): boolean {
	return /^(text\/|application\/(json|xml|xhtml\+xml)|[^;]+\+(json|xml))(?:;|$)/i.test(contentType);
}

function parseSearchItems(value: unknown, provider: "brave" | "searxng", count: number): WebSearchResult["items"] {
	if (!value || typeof value !== "object") return [];
	const source = provider === "brave"
		? (value as { web?: { results?: unknown } }).web?.results
		: (value as { results?: unknown }).results;
	if (!Array.isArray(source)) return [];
	return source.slice(0, count).flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const item = entry as Record<string, unknown>;
		if (typeof item.url !== "string" || typeof item.title !== "string") return [];
		const snippet = provider === "brave" ? item.description : item.content;
		return [{ title: item.title.slice(0, 500), url: item.url.slice(0, MAX_URL_CHARS), snippet: typeof snippet === "string" ? snippet.slice(0, 4000) : "" }];
	});
}

function duckDuckGoResultUrl(value: string): string | undefined {
	try {
		const url = new URL(value, "https://html.duckduckgo.com");
		const redirected = url.hostname.endsWith("duckduckgo.com") ? url.searchParams.get("uddg") : undefined;
		const result = validateWebUrl(redirected ?? url.toString());
		return result.toString();
	} catch {
		return undefined;
	}
}

export function parseDuckDuckGoItems(html: string, count: number): WebSearchResult["items"] {
	const $ = load(html);
	const items: WebSearchResult["items"] = [];
	$(".result").each((_index, element) => {
		if (items.length >= count) return false;
		const link = $(element).find("a.result__a").first();
		const title = link.text().replace(/\s+/g, " ").trim();
		const url = duckDuckGoResultUrl(link.attr("href") ?? "");
		if (!title || !url) return;
		const snippet = $(element).find(".result__snippet").first().text().replace(/\s+/g, " ").trim();
		items.push({ title: title.slice(0, 500), url, snippet: snippet.slice(0, 4000) });
	});
	return items;
}

export function parseBingItems(html: string, count: number): WebSearchResult["items"] {
	const $ = load(html);
	const items: WebSearchResult["items"] = [];
	$("li.b_algo").each((_index, element) => {
		if (items.length >= count) return false;
		const link = $(element).find("h2 a").first();
		const title = link.text().replace(/\s+/g, " ").trim();
		let url: string | undefined;
		try { url = validateWebUrl(link.attr("href") ?? "").toString(); } catch { return; }
		const snippet = $(element).find(".b_caption p").first().text().replace(/\s+/g, " ").trim();
		if (title && url) items.push({ title: title.slice(0, 500), url, snippet: snippet.slice(0, 4000) });
	});
	return items;
}

export function isAllowedWebResolution(address: string, allowProxyDnsAddresses: boolean): boolean {
	return isPublicWebAddress(address) ||
		(allowProxyDnsAddresses && isIP(address) === 4 && proxyDnsAddresses.check(address, "ipv4"));
}

export class SafeWebClient implements WebSandbox {
	readonly searchHost: string | undefined;
	readonly searchSecretName: string | undefined;
	readonly #search: WebSearchConfiguration | undefined;
	readonly #timeoutMs: number;
	readonly #maxResponseBytes: number;
	readonly #allowProxyDnsAddresses: boolean;
	readonly #resolver: (hostname: string) => Promise<LookupAddress[]>;

	constructor(options: SafeWebClientOptions = {}) {
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
		this.#allowProxyDnsAddresses = options.allowProxyDnsAddresses ?? false;
		if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) throw new Error("Web timeout must be positive");
		if (!Number.isFinite(this.#maxResponseBytes) || this.#maxResponseBytes <= 0) throw new Error("Web response limit must be positive");
		this.#resolver = options.resolver ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
		this.#search = options.search;
		if (options.search) {
			if (options.search.provider === "brave" && !options.search.apiKey.trim()) throw new Error("Brave Search API key must not be empty");
			const endpoint = validateWebUrl(options.search.provider === "brave"
				? options.search.endpoint ?? "https://api.search.brave.com/res/v1/web/search"
				: options.search.provider === "bing"
					? options.search.endpoint ?? "https://www.bing.com/search"
				: options.search.provider === "duckduckgo"
					? options.search.endpoint ?? "https://html.duckduckgo.com/html/"
					: options.search.endpoint);
			this.searchHost = hostnameOf(endpoint);
			this.searchSecretName = options.search.provider === "brave" ? "WUMING_WEB_SEARCH_API_KEY" : undefined;
		}
	}

	async fetch(value: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
		const requested = validateWebUrl(value);
		const response = await this.#request(requested, {
			maxBytes: Math.min(options.maxBytes ?? this.#maxResponseBytes, this.#maxResponseBytes),
			...(options.signal ? { signal: options.signal } : {}),
		});
		const contentType = String(response.headers["content-type"] ?? "text/plain").toLowerCase();
		if (!supportsText(contentType)) throw new SandboxError("content_unsupported", `Unsupported response content type: ${contentType}`);
		return {
			requestedUrl: requested.toString(),
			finalUrl: response.url,
			status: response.status,
			contentType,
			content: readableContent(response.body, contentType),
			truncated: response.truncated,
		};
	}

	async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult> {
		if (!this.#search) throw new SandboxError("network_failed", "Web search is not configured");
		if (!query.trim()) throw new SandboxError("network_failed", "Search query must not be empty");
		const count = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(options.count ?? 5)));
		const endpoint = validateWebUrl(this.#search.provider === "brave"
			? this.#search.endpoint ?? "https://api.search.brave.com/res/v1/web/search"
			: this.#search.provider === "bing"
				? this.#search.endpoint ?? "https://www.bing.com/search"
			: this.#search.provider === "duckduckgo"
				? this.#search.endpoint ?? "https://html.duckduckgo.com/html/"
				: this.#search.endpoint);
		endpoint.searchParams.set("q", query);
		const htmlProvider = this.#search.provider === "bing" || this.#search.provider === "duckduckgo";
		const headers: Record<string, string> = { accept: htmlProvider ? "text/html" : "application/json" };
		if (this.#search.provider === "brave") {
			endpoint.searchParams.set("count", String(count));
			headers["x-subscription-token"] = this.#search.apiKey;
		} else if (this.#search.provider === "searxng") {
			endpoint.searchParams.set("format", "json");
			endpoint.searchParams.set("categories", "general");
		}
		const response = await this.#request(endpoint, {
			maxBytes: Math.min(this.#maxResponseBytes, 1024 * 1024),
			headers,
			...(this.#search.provider === "brave" ? { redirectOrigin: endpoint.origin } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		if (response.status < 200 || response.status >= 300) throw new SandboxError("network_failed", `Search provider returned HTTP ${response.status}`);
		if (this.#search.provider === "bing") {
			const html = decodeBody(response.body, String(response.headers["content-type"] ?? "text/html"));
			return { provider: this.#search.provider, items: parseBingItems(html, count) };
		}
		if (this.#search.provider === "duckduckgo") {
			const html = decodeBody(response.body, String(response.headers["content-type"] ?? "text/html"));
			const items = parseDuckDuckGoItems(html, count);
			if (items.length === 0 && /challenge-form|anomaly-modal/i.test(html)) {
				throw new SandboxError("network_failed", "DuckDuckGo requested a human verification challenge; configure Bing, Brave, or SearXNG instead");
			}
			return { provider: this.#search.provider, items };
		}
		let payload: unknown;
		try { payload = JSON.parse(decodeBody(response.body, String(response.headers["content-type"] ?? "application/json"))); }
		catch { throw new SandboxError("network_failed", "Search provider returned invalid JSON"); }
		return { provider: this.#search.provider, items: parseSearchItems(payload, this.#search.provider, count) };
	}

	async #request(url: URL, options: { maxBytes: number; headers?: Record<string, string>; redirectOrigin?: string; signal?: AbortSignal }, redirects = 0): Promise<RawResponse> {
		validateWebUrl(url.toString());
		const hostname = hostnameOf(url);
		let addresses: LookupAddress[];
		try {
			addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await this.#resolver(hostname);
		} catch (error) {
			throw new SandboxError("network_failed", `DNS lookup failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const allowSyntheticResolution = this.#allowProxyDnsAddresses || url.protocol === "https:";
		if (addresses.length === 0 || addresses.some((entry) => !isAllowedWebResolution(entry.address, allowSyntheticResolution))) {
			throw new SandboxError("network_denied", `Host ${hostname} did not resolve exclusively to public addresses`);
		}
		const selected = addresses[0]!;
		const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
			if (lookupOptions.all) callback(null, addresses);
			else callback(null, selected.address, selected.family);
		};
		const controller = new AbortController();
		let timedOut = false;
		const externalAbort = () => controller.abort(options.signal?.reason);
		if (options.signal?.aborted) externalAbort();
		else options.signal?.addEventListener("abort", externalAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new SandboxError("network_timeout", `Web request exceeded ${this.#timeoutMs}ms`));
		}, this.#timeoutMs);
		try {
			const response = await new Promise<RawResponse>((resolve, reject) => {
				const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
					protocol: url.protocol,
					hostname,
					port: url.port || undefined,
					path: `${url.pathname}${url.search}`,
					method: "GET",
					lookup,
					signal: controller.signal,
					headers: {
						accept: "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1",
						"accept-encoding": "identity",
						"user-agent": "Wuming-Agent/0.1 (+safe-web-fetch)",
						...options.headers,
					},
				}, (incoming) => {
					const chunks: Buffer[] = [];
					let bytes = 0;
					let settled = false;
					const finish = (truncated: boolean) => {
						if (settled) return;
						settled = true;
						resolve({ url: url.toString(), status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks), truncated });
					};
					const contentEncoding = String(incoming.headers["content-encoding"] ?? "identity").toLowerCase();
					if (contentEncoding !== "identity") {
						settled = true;
						incoming.destroy();
						reject(new SandboxError("content_unsupported", `Unsupported response content encoding: ${contentEncoding}`));
						return;
					}
					incoming.on("data", (chunk: Buffer) => {
						if (settled) return;
						const remaining = options.maxBytes - bytes;
						if (remaining <= 0) {
							finish(true);
							incoming.destroy();
							return;
						}
						const selectedChunk = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
						chunks.push(selectedChunk);
						bytes += selectedChunk.byteLength;
						if (selectedChunk.byteLength < chunk.byteLength) {
							finish(true);
							incoming.destroy();
						}
					});
					incoming.once("end", () => finish(false));
					incoming.once("error", (error) => { if (!settled) reject(error); });
				});
				request.once("error", reject);
				request.end();
			});
			if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
				if (redirects >= MAX_REDIRECTS) throw new SandboxError("network_failed", `Web request exceeded ${MAX_REDIRECTS} redirects`);
				const next = validateWebUrl(new URL(response.headers.location, url).toString());
				if (options.redirectOrigin && next.origin !== options.redirectOrigin) {
					throw new SandboxError("network_denied", "Search provider attempted a cross-origin redirect");
				}
				return this.#request(next, options, redirects + 1);
			}
			return response;
		} catch (error) {
			if (error instanceof SandboxError) throw error;
			if (timedOut) throw new SandboxError("network_timeout", `Web request exceeded ${this.#timeoutMs}ms`);
			if (controller.signal.aborted) throw controller.signal.reason ?? error;
			throw new SandboxError("network_failed", error instanceof Error ? error.message : String(error));
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", externalAbort);
		}
	}
}

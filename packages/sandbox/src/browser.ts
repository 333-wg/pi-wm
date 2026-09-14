import { mkdir, writeFile } from "node:fs/promises";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Download,
	type ElementHandle,
	type Locator,
	type Page,
	type Response,
} from "playwright";
import { SandboxError } from "./errors.js";
import type {
	BrowserAction,
	BrowserAutomation,
	BrowserDownloadRequest,
	BrowserDownloadResult,
	BrowserDiagnostics,
	BrowserSearchResult,
	BrowserSnapshot,
	BrowserTab,
	BrowserTarget,
} from "./types.js";
import { isAllowedWebResolution, isPublicWebAddress } from "./web.js";

const INTERACTIVE_SELECTOR = [
	"a[href]",
	"button",
	"input",
	"select",
	"textarea",
	"summary",
	"[contenteditable='true']",
	"[tabindex]:not([tabindex='-1'])",
	"[role='button']",
	"[role='link']",
	"[role='checkbox']",
	"[role='radio']",
	"[role='combobox']",
	"[role='menuitem']",
	"[role='option']",
	"[role='slider']",
	"[role='switch']",
	"[role='tab']",
].join(",");

const MAX_LOG_ENTRIES = 200;
const MAX_INTERACTIVE_ELEMENTS = 250;
const DEFAULT_SEARCH_ENDPOINT = "https://www.bing.com/search";
const SEARCH_RESULT_SELECTOR = ["li.b_algo", '[data-testid="result"]', "article", ".result", ".web-result"].join(",");

export interface PlaywrightBrowserManagerOptions {
	headless?: boolean;
	executablePath?: string;
	channel?: string;
	defaultTimeoutMs?: number;
	idleTimeoutMs?: number;
	maxSessions?: number;
	maxSnapshotChars?: number;
	maxScreenshotBytes?: number;
	maxDownloadBytes?: number;
	searchEndpoint?: string;
	resolver?: (hostname: string) => Promise<LookupAddress[]>;
}

interface BrowserPageState {
	id: string;
	page: Page;
	refs: Map<string, ElementHandle>;
	diagnostics: BrowserDiagnostics;
}

interface BrowserSessionState {
	context: BrowserContext;
	pages: Map<string, BrowserPageState>;
	activePageId: string;
	nextTabId: number;
	lastUsedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}

function hostname(url: URL): string {
	return url.hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
}

function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
}

/** Permit public sites and loopback development servers, but not other private-network targets. */
export async function validateBrowserNavigationUrl(
	value: string,
	resolver: (hostname: string) => Promise<LookupAddress[]> = (host) => dnsLookup(host, { all: true, verbatim: true }),
	allowProxyDnsAddresses = true
): Promise<URL> {
	if (!value || value.length > 4096) throw new SandboxError("network_denied", "Browser URL is empty or too long");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new SandboxError("network_denied", "Browser URL is invalid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SandboxError("network_denied", "Browser navigation only supports HTTP and HTTPS URLs");
	}
	if (url.username || url.password)
		throw new SandboxError("network_denied", "Browser URLs containing credentials are not allowed");
	const host = hostname(url);
	if (!host || host.endsWith(".local"))
		throw new SandboxError("network_denied", "Local network hostnames are not allowed");
	if (isLoopbackHost(host)) return url;
	if (isIP(host)) {
		if (!isPublicWebAddress(host))
			throw new SandboxError("network_denied", "Private and reserved browser destinations are not allowed");
		return url;
	}
	let addresses: LookupAddress[];
	try {
		addresses = await resolver(host);
	} catch (error) {
		throw new SandboxError(
			"network_failed",
			`Browser DNS lookup failed for ${host}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	const allowSyntheticResolution = allowProxyDnsAddresses && url.protocol === "https:";
	if (
		addresses.length === 0 ||
		addresses.some(({ address }) => !isAllowedWebResolution(address, allowSyntheticResolution))
	) {
		throw new SandboxError(
			"network_denied",
			`Browser destination ${host} did not resolve exclusively to public addresses`
		);
	}
	return url;
}

function appendBounded<T>(items: T[], item: T): void {
	items.push(item);
	if (items.length > MAX_LOG_ENTRIES) items.splice(0, items.length - MAX_LOG_ENTRIES);
}

function trimText(value: string, max = 180): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function workspaceDownloadPath(
	workspaceRoot: string,
	requestedPath: string | undefined,
	suggestedFilename: string
): { absolutePath: string; relativePath: string } {
	if (!workspaceRoot.trim())
		throw new SandboxError("path_invalid", "A workspace root is required for browser downloads");
	const fallbackName = suggestedFilename.replace(/[\\/]/g, "_").trim() || "download";
	const candidate = requestedPath?.trim() || fallbackName;
	if (isAbsolute(candidate))
		throw new SandboxError("path_invalid", "Browser download paths must be relative to the workspace");
	const absolutePath = resolve(workspaceRoot, candidate);
	const relativePath = relative(resolve(workspaceRoot), absolutePath);
	if (relativePath === "" || relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath)) {
		throw new SandboxError("path_escape", "Browser download path must stay inside the workspace");
	}
	return { absolutePath, relativePath: relativePath.split(sep).join("/") };
}

function emptyDiagnostics(): BrowserDiagnostics {
	return { url: "about:blank", console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
}

type BrowserTargetHandle = Locator | ElementHandle;

export class PlaywrightBrowserManager implements AsyncDisposable {
	readonly #options: Required<
		Pick<
			PlaywrightBrowserManagerOptions,
			| "headless"
			| "defaultTimeoutMs"
			| "idleTimeoutMs"
			| "maxSessions"
			| "maxSnapshotChars"
			| "maxScreenshotBytes"
			| "maxDownloadBytes"
		>
	> &
		PlaywrightBrowserManagerOptions;
	readonly #sessions = new Map<string, BrowserSessionState>();
	readonly #resolver: (hostname: string) => Promise<LookupAddress[]>;
	#browserPending: Promise<Browser> | undefined;
	#disposed = false;

	constructor(options: PlaywrightBrowserManagerOptions = {}) {
		this.#options = {
			...options,
			headless: options.headless ?? true,
			defaultTimeoutMs: options.defaultTimeoutMs ?? 20_000,
			idleTimeoutMs: options.idleTimeoutMs ?? 15 * 60_000,
			maxSessions: options.maxSessions ?? 8,
			maxSnapshotChars: options.maxSnapshotChars ?? 60_000,
			maxScreenshotBytes: options.maxScreenshotBytes ?? 8 * 1024 * 1024,
			maxDownloadBytes: options.maxDownloadBytes ?? 64 * 1024 * 1024,
		};
		this.#resolver = options.resolver ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
	}

	session(sessionId: string): BrowserAutomation {
		if (!sessionId) throw new SandboxError("process_unavailable", "Browser session ID is required");
		const searchHost = this.#searchHost();
		return {
			open: (url, options) => this.#open(sessionId, url, options),
			snapshot: (options) => this.#snapshot(sessionId, options),
			act: (action, signal) => this.#act(sessionId, action, signal),
			screenshot: (options) => this.#screenshot(sessionId, options),
			...(searchHost ? { searchHost } : {}),
			search: (query, options) => this.#search(sessionId, query, options),
			currentHost: () => this.#currentHost(sessionId),
			download: (request, options) => this.#download(sessionId, request, options),
			diagnostics: (clear) => this.#diagnostics(sessionId, clear),
			tabs: () => this.#tabs(sessionId),
			close: () => this.#closeSession(sessionId),
		};
	}

	#searchHost(): string | undefined {
		try {
			return hostname(new URL(this.#options.searchEndpoint ?? DEFAULT_SEARCH_ENDPOINT));
		} catch {
			return undefined;
		}
	}

	async #browser(): Promise<Browser> {
		if (this.#disposed) throw new SandboxError("process_unavailable", "Browser manager is closed");
		if (!this.#browserPending) {
			this.#browserPending = chromium
				.launch({
					headless: this.#options.headless,
					...(this.#options.executablePath ? { executablePath: this.#options.executablePath } : {}),
					...(this.#options.channel ? { channel: this.#options.channel } : {}),
				})
				.then(
					(browser) => {
						browser.once("disconnected", () => {
							this.#browserPending = undefined;
							for (const state of this.#sessions.values()) if (state.idleTimer) clearTimeout(state.idleTimer);
							this.#sessions.clear();
						});
						return browser;
					},
					(error) => {
						this.#browserPending = undefined;
						throw new SandboxError(
							"process_unavailable",
							`Chromium could not start. Run playwright install chromium or configure WUMING_BROWSER_EXECUTABLE: ${error instanceof Error ? error.message : String(error)}`
						);
					}
				);
		}
		return this.#browserPending;
	}

	async #state(sessionId: string): Promise<BrowserSessionState> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#touch(sessionId, existing);
			return existing;
		}
		while (this.#sessions.size >= this.#options.maxSessions) {
			const oldest = [...this.#sessions.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
			if (!oldest) break;
			await this.#closeSession(oldest[0]);
		}
		const browser = await this.#browser();
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			acceptDownloads: true,
		});
		const state: BrowserSessionState = {
			context,
			pages: new Map(),
			activePageId: "",
			nextTabId: 1,
			lastUsedAt: Date.now(),
		};
		context.on("page", (page) => {
			const attached = this.#attachPage(state, page);
			state.activePageId = attached.id;
		});
		await context.route("**/*", async (route) => {
			const requestUrl = route.request().url();
			let parsed: URL;
			try {
				parsed = new URL(requestUrl);
			} catch {
				await route.abort("blockedbyclient");
				return;
			}
			if (["about:", "blob:", "data:"].includes(parsed.protocol)) {
				await route.continue();
				return;
			}
			try {
				await validateBrowserNavigationUrl(requestUrl, this.#resolver);
				await route.continue();
			} catch {
				await route.abort("blockedbyclient");
			}
		});
		this.#sessions.set(sessionId, state);
		const page = await context.newPage();
		state.activePageId = this.#attachPage(state, page).id;
		this.#touch(sessionId, state);
		return state;
	}

	#attachPage(session: BrowserSessionState, page: Page): BrowserPageState {
		const existing = [...session.pages.values()].find((candidate) => candidate.page === page);
		if (existing) return existing;
		page.setDefaultTimeout(this.#options.defaultTimeoutMs);
		page.setDefaultNavigationTimeout(this.#options.defaultTimeoutMs);
		const state: BrowserPageState = {
			id: `t${session.nextTabId++}`,
			page,
			refs: new Map(),
			diagnostics: emptyDiagnostics(),
		};
		session.pages.set(state.id, state);
		this.#wireDiagnostics(state);
		page.once("close", () => {
			for (const handle of state.refs.values()) void handle.dispose().catch(() => undefined);
			session.pages.delete(state.id);
			if (session.activePageId === state.id) session.activePageId = session.pages.keys().next().value ?? "";
		});
		return state;
	}

	async #active(session: BrowserSessionState): Promise<BrowserPageState> {
		const current = session.pages.get(session.activePageId);
		if (current && !current.page.isClosed()) return current;
		const page = await session.context.newPage();
		const attached = this.#attachPage(session, page);
		session.activePageId = attached.id;
		return attached;
	}

	#wireDiagnostics(state: BrowserPageState): void {
		state.page.on("console", (message) =>
			appendBounded(state.diagnostics.console, {
				level: message.type(),
				text: trimText(message.text(), 2000),
				timestamp: Date.now(),
			})
		);
		state.page.on("pageerror", (error) =>
			appendBounded(state.diagnostics.pageErrors, {
				message: trimText(error.message, 4000),
				timestamp: Date.now(),
			})
		);
		state.page.on("requestfailed", (request) =>
			appendBounded(state.diagnostics.failedRequests, {
				method: request.method(),
				url: request.url().slice(0, 4096),
				error: request.failure()?.errorText ?? "Request failed",
				timestamp: Date.now(),
			})
		);
		state.page.on("response", (response) => {
			if (response.status() < 400) return;
			appendBounded(state.diagnostics.httpErrors, {
				method: response.request().method(),
				url: response.url().slice(0, 4096),
				status: response.status(),
				timestamp: Date.now(),
			});
		});
	}

	#touch(sessionId: string, state: BrowserSessionState): void {
		state.lastUsedAt = Date.now();
		if (state.idleTimer) clearTimeout(state.idleTimer);
		state.idleTimer = setTimeout(() => void this.#closeSession(sessionId), this.#options.idleTimeoutMs);
		state.idleTimer.unref?.();
	}

	async #open(
		sessionId: string,
		value: string,
		options: Parameters<BrowserAutomation["open"]>[1] = {}
	): Promise<BrowserSnapshot> {
		const url = await validateBrowserNavigationUrl(value, this.#resolver);
		const session = await this.#state(sessionId);
		const state = await this.#active(session);
		if (options?.signal?.aborted) throw options.signal.reason ?? new Error("Browser navigation aborted");
		if (options?.width || options?.height) {
			const current = state.page.viewportSize() ?? { width: 1440, height: 900 };
			await state.page.setViewportSize({
				width: options.width ?? current.width,
				height: options.height ?? current.height,
			});
		}
		await state.page.goto(url.href, { waitUntil: options?.waitUntil ?? "domcontentloaded" });
		if (options?.signal?.aborted) throw options.signal.reason ?? new Error("Browser navigation aborted");
		return this.#snapshot(sessionId);
	}

	async #search(
		sessionId: string,
		query: string,
		options: { count?: number; signal?: AbortSignal } = {}
	): Promise<BrowserSearchResult> {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) throw new SandboxError("process_failed", "Browser search query is required");
		const count = Math.min(10, Math.max(1, Math.floor(options.count ?? 5)));
		const endpoint = new URL(this.#options.searchEndpoint ?? DEFAULT_SEARCH_ENDPOINT);
		endpoint.searchParams.set("q", normalizedQuery);
		endpoint.searchParams.set("count", String(count));
		const url = await validateBrowserNavigationUrl(endpoint.href, this.#resolver);
		const session = await this.#state(sessionId);
		const page = await session.context.newPage();
		const state = this.#attachPage(session, page);
		session.activePageId = state.id;
		if (options.signal?.aborted) {
			await page.close().catch(() => undefined);
			throw options.signal.reason ?? new Error("Browser search aborted");
		}
		await page.goto(url.href, { waitUntil: "domcontentloaded" });
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Browser search aborted");

		const items = await page.locator(SEARCH_RESULT_SELECTOR).evaluateAll(
			(elements, input) => {
				const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
				const seen = new Set<string>();
				const results: Array<{ title: string; url: string; snippet: string }> = [];
				for (const element of elements) {
					const anchor = element.querySelector("h2 a[href], h3 a[href], a[href]") as HTMLAnchorElement | null;
					if (!anchor) continue;
					let parsed: URL;
					try {
						parsed = new URL(anchor.href, document.baseURI);
					} catch {
						continue;
					}
					if (!["http:", "https:"].includes(parsed.protocol)) continue;
					if (parsed.hostname.toLowerCase() === input.host) continue;
					const title = normalize(anchor.textContent) || normalize(element.querySelector("h2, h3")?.textContent);
					if (!title || seen.has(parsed.href)) continue;
					const snippetNode = element.querySelector("p, .b_caption, [data-snippet], .snippet, .content");
					let snippet = normalize(snippetNode?.textContent || element.textContent);
					if (snippet === title) snippet = "";
					else if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();
					seen.add(parsed.href);
					results.push({ title, url: parsed.href, snippet });
					if (results.length >= input.limit) break;
				}
				return results;
			},
			{ host: hostname(url), limit: count }
		);
		this.#touch(sessionId, session);
		return {
			provider: hostname(url),
			query: normalizedQuery,
			url: page.url(),
			items,
		};
	}

	async #currentHost(sessionId: string): Promise<string | undefined> {
		const state = await this.#active(await this.#state(sessionId));
		try {
			const url = new URL(state.page.url());
			return url.protocol === "http:" || url.protocol === "https:" ? hostname(url) : undefined;
		} catch {
			return undefined;
		}
	}

	async #download(
		sessionId: string,
		request: BrowserDownloadRequest,
		options: { workspaceRoot: string; signal?: AbortSignal }
	): Promise<BrowserDownloadResult> {
		if (Boolean(request.url) === Boolean(request.target))
			throw new SandboxError("process_failed", "Provide exactly one of url or browser target for download");
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Browser download aborted");

		const session = await this.#state(sessionId);
		let state = await this.#active(session);
		let temporaryPage: Page | undefined;
		let download: Download | undefined;
		let inlineBody: Buffer | undefined;
		let inlineUrl = request.url ?? "";
		let inlineTitle = "";
		try {
			if (request.url) {
				const url = await validateBrowserNavigationUrl(request.url, this.#resolver);
				const page = await session.context.newPage();
				temporaryPage = page;
				state = this.#attachPage(session, page);
				session.activePageId = state.id;
				const downloadPromise = page
					.waitForEvent("download", { timeout: Math.min(this.#options.defaultTimeoutMs, 1000) })
					.catch(() => undefined);
				let navigationError: unknown;
				let navigationResponse: Response | null = null;
				try {
					navigationResponse = await page.goto(url.href, { waitUntil: "commit" });
				} catch (error) {
					navigationError = error;
				}
				download = await downloadPromise;
				if (!download) {
					if (navigationError && !navigationResponse) throw navigationError;
					if (!navigationResponse)
						throw new SandboxError("network_failed", "Browser navigation returned no downloadable response");
					const finalUrl = await validateBrowserNavigationUrl(navigationResponse.url(), this.#resolver);
					if (!navigationResponse.ok())
						throw new SandboxError("network_failed", "Browser download returned HTTP " + navigationResponse.status());
					inlineBody = await navigationResponse.body();
					if (inlineBody.length > this.#options.maxDownloadBytes)
						throw new SandboxError(
							"file_too_large",
							"Browser download exceeds " + this.#options.maxDownloadBytes + " bytes"
						);
					inlineUrl = finalUrl.href;
					inlineTitle = await page.title().catch(() => "");
				}
			} else {
				const target = this.#target(state, request.target);
				const downloadPromise = state.page.waitForEvent("download", {
					timeout: this.#options.defaultTimeoutMs,
				});
				await target.click();
				download = await downloadPromise;
			}

			if (options.signal?.aborted) throw options.signal.reason ?? new Error("Browser download aborted");
			const suggestedFilename = download?.suggestedFilename();
			const suggestedIsGeneric = !suggestedFilename || suggestedFilename.toLowerCase() === "download";
			const sourceUrl = download?.url() || inlineUrl;
			const filename =
				(!suggestedIsGeneric ? suggestedFilename : undefined) ||
				basename(new URL(sourceUrl).pathname).trim() ||
				"download";
			const destination = workspaceDownloadPath(options.workspaceRoot, request.path, filename);
			await mkdir(dirname(destination.absolutePath), { recursive: true });
			if (download) await download.saveAs(destination.absolutePath);
			else if (inlineBody) await writeFile(destination.absolutePath, inlineBody);
			else throw new SandboxError("network_failed", "Browser did not produce a downloadable response");
			if (options.signal?.aborted) throw options.signal.reason ?? new Error("Browser download aborted");
			return {
				path: destination.relativePath,
				filename,
				url: sourceUrl,
				title: inlineTitle || (await state.page.title().catch(() => "")),
			};
		} finally {
			if (temporaryPage) await temporaryPage.close().catch(() => undefined);
			this.#touch(sessionId, session);
		}
	}

	async #snapshot(
		sessionId: string,
		options: Parameters<BrowserAutomation["snapshot"]>[0] = {}
	): Promise<BrowserSnapshot> {
		const session = await this.#state(sessionId);
		const state = await this.#active(session);
		for (const handle of state.refs.values()) await handle.dispose().catch(() => undefined);
		state.refs.clear();
		const root = options?.selector ? state.page.locator(options.selector).first() : state.page.locator("body");
		if (options?.selector) await root.waitFor({ state: "attached" });
		let aria = "";
		try {
			aria = await root.ariaSnapshot({ timeout: Math.min(this.#options.defaultTimeoutMs, 5000) });
		} catch {
			aria = trimText(await root.innerText().catch(() => "(page body is unavailable)"), 20_000);
		}
		const handles = await state.page.locator(INTERACTIVE_SELECTOR).elementHandles();
		const references: string[] = [];
		for (const handle of handles) {
			if (references.length >= MAX_INTERACTIVE_ELEMENTS) {
				await handle.dispose().catch(() => undefined);
				continue;
			}
			if (!(await handle.isVisible().catch(() => false))) {
				await handle.dispose().catch(() => undefined);
				continue;
			}
			const info = await handle
				.evaluate((node) => {
					const element = node as HTMLElement;
					const input = element as HTMLInputElement;
					const tag = element.tagName.toLowerCase();
					const inputType = (element.getAttribute("type") ?? "text").toLowerCase();
					const implicitRole =
						tag === "a"
							? "link"
							: tag === "button"
								? "button"
								: tag === "select"
									? "combobox"
									: tag === "textarea"
										? "textbox"
										: tag === "input"
											? inputType === "checkbox"
												? "checkbox"
												: inputType === "radio"
													? "radio"
													: inputType === "range"
														? "slider"
														: ["button", "submit", "reset"].includes(inputType)
															? "button"
															: "textbox"
											: tag;
					return {
						role: element.getAttribute("role") ?? implicitRole,
						name:
							element.getAttribute("aria-label") ??
							element.getAttribute("alt") ??
							element.getAttribute("title") ??
							element.getAttribute("placeholder") ??
							element.innerText ??
							input.value ??
							"",
						type: element.getAttribute("type") ?? "",
						disabled: (element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true",
					};
				})
				.catch(() => undefined);
			if (!info) {
				await handle.dispose().catch(() => undefined);
				continue;
			}
			const ref = `e${references.length + 1}`;
			state.refs.set(ref, handle);
			references.push(
				`[${ref}] ${info.role}${info.type ? ` type=${JSON.stringify(info.type)}` : ""}${info.disabled ? " disabled" : ""} ${JSON.stringify(trimText(info.name) || "(unnamed)")}`
			);
		}
		const maxChars = Math.min(
			Math.max(1000, options?.maxChars ?? this.#options.maxSnapshotChars),
			this.#options.maxSnapshotChars
		);
		const pageTitle = await state.page.title();
		const header = `Tab: ${state.id} (${session.pages.size} open)\nURL: ${state.page.url()}\nTitle: ${pageTitle}\nViewport: ${JSON.stringify(state.page.viewportSize())}`;
		const interactive = `Interactive elements (${references.length}${handles.length > MAX_INTERACTIVE_ELEMENTS ? "+" : ""}):\n${references.join("\n") || "(none)"}`;
		const full = `${header}\n\n${interactive}\n\nAccessibility tree:\n${aria}`;
		const truncated = full.length > maxChars;
		state.diagnostics.url = state.page.url();
		return {
			tabId: state.id,
			tabCount: session.pages.size,
			url: state.page.url(),
			title: pageTitle,
			text: truncated ? `${full.slice(0, maxChars)}\n[snapshot truncated]` : full,
			interactiveCount: references.length,
			truncated,
		};
	}

	#target(state: BrowserPageState, target: BrowserTarget | undefined): BrowserTargetHandle {
		if (!target) throw new SandboxError("process_failed", "This browser action requires a target");
		const selectors = [target.ref, target.selector, target.role, target.text].filter(Boolean);
		if (selectors.length !== 1)
			throw new SandboxError("process_failed", "Provide exactly one target: ref, selector, role, or text");
		if (target.ref) {
			const handle = state.refs.get(target.ref);
			if (!handle)
				throw new SandboxError(
					"process_failed",
					`Unknown or stale browser ref ${target.ref}; take a new browser_snapshot`
				);
			return handle;
		}
		if (target.selector) return state.page.locator(target.selector).first();
		if (target.role)
			return state.page
				.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
					...(target.name ? { name: target.name } : {}),
					exact: true,
				})
				.first();
		return state.page.getByText(target.text!, { exact: true }).first();
	}

	async #waitForTarget(
		target: BrowserTargetHandle,
		state: "attached" | "detached" | "visible" | "hidden",
		timeout: number
	): Promise<void> {
		if ("waitFor" in target) {
			await target.waitFor({ state, timeout });
			return;
		}
		if (state === "attached") return;
		await target.waitForElementState(state === "visible" ? "visible" : "hidden", { timeout });
	}

	async #scrollTarget(target: BrowserTargetHandle, delta: { x: number; y: number }): Promise<void> {
		const handle = "elementHandle" in target ? await target.elementHandle() : target;
		if (!handle) throw new SandboxError("process_failed", "Browser scroll target is no longer attached");
		await handle.evaluate((node, value) => (node as Element).scrollBy(value.x, value.y), delta);
	}

	async #act(sessionId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserSnapshot> {
		const session = await this.#state(sessionId);
		let state = await this.#active(session);
		if (signal?.aborted) throw signal.reason ?? new Error("Browser action aborted");
		switch (action.action) {
			case "click":
				await this.#target(state, action.target).click();
				break;
			case "hover":
				await this.#target(state, action.target).hover();
				break;
			case "check":
				await this.#target(state, action.target).check();
				break;
			case "uncheck":
				await this.#target(state, action.target).uncheck();
				break;
			case "fill":
				await this.#target(state, action.target).fill(action.value);
				break;
			case "type":
				await this.#target(state, action.target).type(action.value);
				break;
			case "press": {
				if (action.target) {
					await this.#target(state, action.target).press(action.key);
				} else {
					await state.page.keyboard.press(action.key);
				}
				break;
			}
			case "select":
				await this.#target(state, action.target).selectOption(action.values);
				break;
			case "scroll": {
				const delta = { x: action.deltaX ?? 0, y: action.deltaY ?? 600 };
				if (action.target) await this.#scrollTarget(this.#target(state, action.target), delta);
				else await state.page.mouse.wheel(delta.x, delta.y);
				break;
			}
			case "wait":
				if (action.target)
					await this.#waitForTarget(this.#target(state, action.target), action.state ?? "visible", action.timeoutMs);
				else await state.page.waitForTimeout(action.timeoutMs);
				break;
			case "back":
				await state.page.goBack({ waitUntil: "domcontentloaded" });
				break;
			case "forward":
				await state.page.goForward({ waitUntil: "domcontentloaded" });
				break;
			case "reload":
				await state.page.reload({ waitUntil: "domcontentloaded" });
				break;
			case "new_tab": {
				const page = await session.context.newPage();
				state = this.#attachPage(session, page);
				session.activePageId = state.id;
				if (action.url) {
					const url = await validateBrowserNavigationUrl(action.url, this.#resolver);
					await state.page.goto(url.href, { waitUntil: "domcontentloaded" });
				}
				break;
			}
			case "switch_tab": {
				const selected = session.pages.get(action.tabId);
				if (!selected || selected.page.isClosed())
					throw new SandboxError("process_failed", `Unknown browser tab ${action.tabId}; call browser_tabs`);
				session.activePageId = selected.id;
				state = selected;
				await selected.page.bringToFront();
				break;
			}
			case "close_tab": {
				const selected = action.tabId ? session.pages.get(action.tabId) : state;
				if (!selected)
					throw new SandboxError("process_failed", `Unknown browser tab ${action.tabId}; call browser_tabs`);
				await selected.page.close();
				state = await this.#active(session);
				break;
			}
		}
		if (signal?.aborted) throw signal.reason ?? new Error("Browser action aborted");
		return this.#snapshot(sessionId);
	}

	async #screenshot(
		sessionId: string,
		options: Parameters<BrowserAutomation["screenshot"]>[0] = {}
	): Promise<{ image: Buffer; url: string; title: string }> {
		const state = await this.#active(await this.#state(sessionId));
		if (options?.signal?.aborted) throw options.signal.reason ?? new Error("Browser screenshot aborted");
		const image = await state.page.screenshot({
			type: "png",
			fullPage: options?.fullPage ?? false,
		});
		if (image.length > this.#options.maxScreenshotBytes) {
			throw new SandboxError(
				"file_too_large",
				`Browser screenshot exceeds ${this.#options.maxScreenshotBytes} bytes; capture the viewport instead of the full page`
			);
		}
		return { image, url: state.page.url(), title: await state.page.title() };
	}

	async #diagnostics(sessionId: string, clear = false): Promise<BrowserDiagnostics> {
		const state = await this.#active(await this.#state(sessionId));
		const result = structuredClone({ ...state.diagnostics, url: state.page.url() });
		if (clear) state.diagnostics = { ...emptyDiagnostics(), url: state.page.url() };
		return result;
	}

	async #tabs(sessionId: string): Promise<BrowserTab[]> {
		const session = await this.#state(sessionId);
		const tabs: BrowserTab[] = [];
		for (const state of session.pages.values()) {
			if (state.page.isClosed()) continue;
			tabs.push({
				id: state.id,
				url: state.page.url(),
				title: await state.page.title(),
				active: state.id === session.activePageId,
			});
		}
		return tabs;
	}

	async #closeSession(sessionId: string): Promise<void> {
		const state = this.#sessions.get(sessionId);
		if (!state) return;
		this.#sessions.delete(sessionId);
		if (state.idleTimer) clearTimeout(state.idleTimer);
		for (const page of state.pages.values())
			for (const handle of page.refs.values()) await handle.dispose().catch(() => undefined);
		await state.context.close().catch(() => undefined);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await Promise.all([...this.#sessions.keys()].map((sessionId) => this.#closeSession(sessionId)));
		const browser = await this.#browserPending?.catch(() => undefined);
		await browser?.close().catch(() => undefined);
		this.#browserPending = undefined;
	}
}

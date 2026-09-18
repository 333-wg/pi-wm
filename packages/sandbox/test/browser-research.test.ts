import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserManager } from "../src/browser.js";

describe("browser research reliability", () => {
	let origin: string;
	let manager: PlaywrightBrowserManager;
	const paragraph =
		"A local controlled research page with enough readable content to distinguish it from an empty shell.";
	const server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		response.writeHead(path === "/blocked" ? 403 : 200, { "content-type": "text/html" });
		if (path === "/search") {
			response.end(
				'<li class="b_algo"><a href="https://example.com/breadcrumb">Breadcrumb</a><h2><a href="https://example.com/result">Actual title</a></h2><p>Candidate snippet</p></li>'
			);
		} else if (path === "/delayed") {
			response.end(
				'<main>Loading...</main><script>setTimeout(() => document.querySelector("main").innerHTML = \'<p>' +
					paragraph +
					'</p><button id="ready">Ready</button>\', 350)</script>'
			);
		} else if (path === "/evidence-race") {
			response.end(
				'<main>Loading...</main><script>const main = document.querySelector("main");' +
					"const clone = main.cloneNode.bind(main); main.cloneNode = (...args) => {" +
					"const copy = clone(...args); delete main.cloneNode;" +
					"queueMicrotask(() => main.innerHTML = " +
					JSON.stringify("<p>" + paragraph + '</p><button id="ready">Ready</button>') +
					"); return copy; };</script>"
			);
		} else if (path === "/footer" || path === "/blocked") {
			response.end("<footer>About Privacy Terms Contact</footer>");
		} else {
			response.end(
				"<main><p>" +
					paragraph +
					'</p><button onclick="this.textContent=\'Clicked\'">Primary</button><a target="_blank" href="/popup">Popup</a></main>'
			);
		}
	});
	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test port");
		origin = "http://127.0.0.1:" + address.port;
		manager = new PlaywrightBrowserManager({
			headless: true,
			defaultTimeoutMs: 1500,
			searchEndpoint: origin + "/search",
		});
	});
	afterAll(async () => {
		await manager?.[Symbol.asyncDispose]();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	function primaryRef(text: string): string {
		const line = text.split("\n").find((value) => value.includes("[t") && value.includes("Primary"));
		const ref = line?.match(/\[(t\d+-s\d+-e\d+)\]/)?.[1];
		if (!ref) throw new Error("Missing primary ref: " + text);
		return ref;
	}
	it("keeps background searches from stealing the active tab or invalidating its refs", async () => {
		const browser = manager.session("search-isolation");
		const before = await browser.open(origin);
		const ref = primaryRef(before.text);
		const result = await browser.search!("query");
		expect(result.items[0]).toEqual({
			title: "Actual title",
			url: "https://example.com/result",
			snippet: "Candidate snippet",
		});
		expect(result.webEvidence?.level).toBe("candidate_links");
		expect(await browser.tabs()).toEqual([expect.objectContaining({ id: before.tabId, active: true })]);
		expect((await browser.act({ action: "click", target: { ref } })).text).toContain("Clicked");
	});
	it("rejects stale snapshot and wrong-tab refs without clicking another element", async () => {
		const browser = manager.session("ref-ownership");
		const original = await browser.open(origin);
		const stale = primaryRef(original.text);
		const current = await browser.snapshot();
		expect(primaryRef(current.text)).not.toBe(stale);
		await expect(browser.act({ action: "click", target: { ref: stale } })).rejects.toThrow(/stale/);
		await browser.act({ action: "new_tab", url: origin });
		await expect(browser.act({ action: "click", target: { ref: primaryRef(current.text) } })).rejects.toThrow(
			/belongs to t1/
		);
		const switched = await browser.act({ action: "switch_tab", tabId: original.tabId });
		expect(switched.text).not.toContain("Clicked");
		expect((await browser.act({ action: "click", target: { ref: primaryRef(switched.text) } })).text).toContain(
			"Clicked"
		);
	});
	it("waits for delayed content and explicit selectors", async () => {
		const browser = manager.session("delayed");
		const automatic = await browser.open(origin + "/delayed");
		expect(automatic.webEvidence?.level).toBe("page_content");
		expect(automatic.text).toContain("Ready");
		const explicit = await browser.open(origin + "/delayed", { waitFor: "#ready", waitTimeoutMs: 1200 });
		expect(explicit.text).toContain("Ready");
		expect(explicit.webEvidence?.level).toBe("page_content");
	});
	it("refreshes evidence when a requested element becomes ready after the content read", async () => {
		const browser = manager.session("evidence-race");
		const snapshot = await browser.open(origin + "/evidence-race", { waitFor: "#ready", waitTimeoutMs: 1200 });
		expect(snapshot.text).toContain("Ready");
		expect(snapshot.webEvidence?.level).toBe("page_content");
	});
	it("still selects a popup opened from the active page", async () => {
		const browser = manager.session("popup");
		const initial = await browser.open(origin);
		await browser.act({ action: "click", target: { text: "Popup" } });
		await expect.poll(async () => (await browser.tabs()).find((tab) => tab.active)?.url).toBe(origin + "/popup");
		const popup = await browser.snapshot();
		expect(popup.tabId).not.toBe(initial.tabId);
		expect(popup.tabCount).toBe(2);
	});
	it("reports bounded waits, footer-only pages and access failures as incomplete evidence", async () => {
		const browser = manager.session("evidence");
		await browser.open(origin);
		const missing = await browser.snapshot({ waitFor: "#missing", waitTimeoutMs: 100 });
		expect(missing.waitedMs).toBeLessThan(1500);
		expect(missing.webEvidence).toMatchObject({
			level: "insufficient_content",
			note: expect.stringContaining("wait_for"),
		});
		expect((await browser.open(origin + "/footer", { waitTimeoutMs: 0 })).webEvidence?.level).toBe(
			"insufficient_content"
		);
		expect((await browser.open(origin + "/blocked")).webEvidence?.level).toBe("access_blocked");
	});
	it("cancels dynamic waiting and cleans up a cancelled search tab", async () => {
		const browser = manager.session("cancellation");
		const initial = await browser.open(origin);
		await expect(
			browser.snapshot({ waitFor: "#missing", waitTimeoutMs: 1500, signal: AbortSignal.timeout(100) })
		).rejects.toThrow();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(browser.search!("query", { signal: controller.signal })).rejects.toThrow("cancelled");
		expect(await browser.tabs()).toEqual([expect.objectContaining({ id: initial.tabId, active: true })]);
	});
});

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserManager } from "../src/browser.js";
import type { BrowserWorkflowStep } from "../src/browser-workflow.js";

describe("bounded browser workflows", () => {
	let externalUrl = "about:blank";
	const server = createServer((request, response) => {
		response.setHeader("content-type", "text/html");
		if (request.url === "/missing-body") {
			response.end("<!doctype html><button onclick='document.body.remove()'>Remove body</button>");
			return;
		}
		if (request.url === "/popup") {
			response.end("<!doctype html><button onclick=\"window.open('/popup-target')\">Open popup</button>");
			return;
		}
		if (request.url === "/popup-target") {
			response.end("<!doctype html><button>Popup content</button><script>console.error('popup diagnostic')</script>");
			return;
		}
		response.end(`<!doctype html><title>Workflow fixture</title><button hidden>Hidden control</button><main>
			<label>Name<input id="name" aria-label="Name"></label>
			<button id="save" onclick="document.querySelector('output').textContent='Saved: '+document.querySelector('input').value">Save</button>
			<output>No saved value</output></main><aside><button>Duplicate</button><button>Duplicate</button><a id="external" href="${externalUrl}">External</a></aside>`);
	});
	let origin: string;
	const manager = new PlaywrightBrowserManager({ headless: true, defaultTimeoutMs: 1500 });
	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture port");
		origin = `http://127.0.0.1:${address.port}`;
	});
	afterAll(async () => {
		await manager[Symbol.asyncDispose]();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("executes fill, save and a result assertion with only one final snapshot", async () => {
		const browser = manager.session("batch-success");
		const initial = await browser.open(origin);
		const result = await browser.run!([
			{ action: "fill", role: "textbox", name: "Name", value: "Verified user" },
			{ action: "click", role: "button", name: "Save" },
			{ action: "wait", text: "Saved: Verified user", state: "visible" },
		]);
		expect(result).toMatchObject({ completedSteps: 3, diagnostics: { pageErrors: [] } });
		expect(result.error).toBeUndefined();
		expect(result.snapshot?.text).toContain("Saved: Verified user");
		const revision = (text: string) => Number(text.match(/t\d+-s(\d+)-e\d+/)?.[1]);
		expect(revision(result.snapshot!.text)).toBe(revision(initial.text) + 1);
		expect(result.steps.map((step) => step.action)).toEqual(["fill", "click", "wait"]);
	});

	it("stops at a failed assertion and does not perform later side effects", async () => {
		const browser = manager.session("batch-failure");
		await browser.open(origin);
		const result = await browser.run!(
			[
				{ action: "fill", selector: "#name", value: "Unsaved" },
				{ action: "wait", selector: "#missing" },
				{ action: "click", selector: "#save" },
			],
			{ stepTimeoutMs: 100 }
		);
		expect(result).toMatchObject({ completedSteps: 1, failedStep: 2, error: expect.stringContaining("Timeout") });
		expect(result.snapshot?.text).toContain("No saved value");
		expect(result.snapshot?.text).not.toContain("Saved: Unsaved");
	});

	it("validates every step before executing the first one", async () => {
		const browser = manager.session("batch-validation");
		await browser.open(origin);
		await expect(
			browser.run!([{ action: "fill", selector: "#name", value: "Must not be entered" }, { action: "wait" }])
		).rejects.toThrow(/step 2/);
		expect((await browser.snapshot()).text).not.toContain("Must not be entered");
		await expect(
			browser.run!([{ action: "click", ref: "t1-s1-e1" } as unknown as BrowserWorkflowStep])
		).rejects.toThrow(/refs are not supported/);
	});

	it("rejects ambiguous targets instead of silently choosing the first match", async () => {
		const browser = manager.session("batch-ambiguous");
		await browser.open(origin);
		const result = await browser.run!([{ action: "click", role: "button", name: "Duplicate" }]);
		expect(result).toMatchObject({ completedSteps: 0, failedStep: 1, error: expect.stringContaining("strict mode") });
	});

	it("bounds a long auto-wait by the workflow's remaining time", async () => {
		const browser = manager.session("batch-budget");
		await browser.open(origin);
		const result = await browser.run!([{ action: "wait", selector: "#missing" }], {
			timeoutMs: 100,
			stepTimeoutMs: 5000,
		});
		expect(result.failedStep).toBe(1);
		expect(result.durationMs).toBeLessThan(2000);
	});

	it("bounds final snapshot collection while preserving successful actions", async () => {
		const browser = manager.session("evidence-budget");
		await browser.open(origin + "/missing-body");
		const result = await browser.run!([{ action: "click", role: "button", name: "Remove body" }], {
			evidenceTimeoutMs: 100,
		});
		expect(result).toMatchObject({ completedSteps: 1, error: expect.stringContaining("time budget") });
		expect(result.snapshot).toBeUndefined();
		expect(result.durationMs).toBeLessThan(1200);
	});

	it("stops after crossing origins before performing another action", async () => {
		const external = createServer((_, response) => {
			response.setHeader("content-type", "text/html");
			response.end(
				"<button onclick=\"document.querySelector('output').textContent='Modified'\">Later</button><output>Untouched</output>"
			);
		});
		await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
		const address = external.address();
		if (!address || typeof address === "string") throw new Error("Missing external fixture port");
		externalUrl = `http://127.0.0.1:${address.port}`;
		try {
			const browser = manager.session("cross-origin");
			await browser.open(origin);
			const result = await browser.run!([
				{ action: "click", selector: "#external" },
				{ action: "click", role: "button", name: "Later" },
			]);
			expect(result).toMatchObject({
				completedSteps: 1,
				failedStep: 2,
				error: expect.stringContaining("origin changed"),
			});
			expect(result.snapshot?.text).toContain("Untouched");
		} finally {
			externalUrl = "about:blank";
			await manager.session("cross-origin").close();
			await new Promise<void>((resolve) => external.close(() => resolve()));
		}
	});

	it("returns diagnostics for the same popup as its final snapshot", async () => {
		const browser = manager.session("popup-evidence");
		await browser.open(origin + "/popup");
		const result = await browser.run!([{ action: "click", role: "button", name: "Open popup" }]);
		expect(result.error).toBeUndefined();
		expect(result.snapshot?.url).toBe(origin + "/popup-target");
		expect(result.diagnostics.url).toBe(result.snapshot?.url);
		expect(JSON.stringify(result.diagnostics.console)).toContain("popup diagnostic");
	});

	it("cancels an in-flight wait and closes its page so it cannot act later", async () => {
		const browser = manager.session("batch-abort");
		await browser.open(origin);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("Stopped by user")), 100);
		try {
			await expect(
				browser.run!(
					[
						{ action: "wait", selector: "#missing" },
						{ action: "click", selector: "#save" },
					],
					{ signal: controller.signal }
				)
			).rejects.toThrow("Stopped by user");
			expect(await browser.tabs()).toEqual([]);
		} finally {
			clearTimeout(timer);
		}
	});

	it("does not wait two seconds for a short local form and scopes snapshot refs", async () => {
		const browser = manager.session("short-ui");
		const opened = await browser.open(origin);
		expect(opened.waitedMs).toBeLessThan(1000);
		expect(opened.webEvidence?.level).toBe("page_content");
		const scoped = await browser.snapshot({ selector: "main", waitTimeoutMs: 0 });
		expect(scoped.interactiveCount).toBe(2);
		expect(scoped.text).not.toContain("Duplicate");
		const inputOnly = await browser.snapshot({ selector: "#name", waitTimeoutMs: 0 });
		expect(inputOnly.interactiveCount).toBe(1);
		expect(inputOnly.text).toContain("Name");
		const required = await browser.snapshot({ waitFor: "#not-ready", waitTimeoutMs: 100 });
		expect(required.webEvidence?.level).toBe("insufficient_content");
		expect(required.waitedMs).toBeGreaterThanOrEqual(100);
	});
});

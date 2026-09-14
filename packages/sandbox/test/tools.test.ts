import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalBroker } from "../src/approval.js";
import type { BrowserAction, BrowserAutomation } from "../src/types.js";
import type { ArtifactRef, SessionSnapshot } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { createSandboxTools } from "../src/index.js";

// Pi invokes a tool with five positional arguments, the last being the extension
// context. These tools only forward it to Pi's own read/write/edit definitions
// and never read it, so the tests pass the `undefined` they have always passed
// at runtime and keep the cast that satisfies the signature in one place.
const noContext = undefined as unknown as Parameters<ToolDefinition["execute"]>[4];

/** One `onUpdate` payload, narrowed to what these assertions look at. */
type Update = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };

const snapshot: SessionSnapshot = {
	session: {
		id: "session-1",
		workspaceId: "workspace-1",
		phase: "turn",
		createdAt: 1,
		updatedAt: 1,
	},
	revision: 1,
	model: { provider: "test", id: "model" },
	thinkingLevel: "off",
	sandboxMode: "workspace_write",
	approvalPolicy: "never",
	transcript: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	pendingApprovals: [],
	usage: {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costUsd: 0,
	},
};

const approvals = { authorize: async () => {} } as unknown as ApprovalBroker;

function artifact(name: string, content: Buffer): ArtifactRef {
	return { id: `artifact-${name}`, name, mimeType: "text/plain", size: content.length };
}

describe("sandbox tool output artifacts", () => {
	it("gates skill source before file IO, output updates or artifact creation", async () => {
		let reads = 0;
		let updates = 0;
		let artifacts = 0;
		const guarded = {
			authorize: async (request: { requireExplicitApproval?: boolean }) => {
				if (request.requireExplicitApproval)
					throw Object.assign(new Error("human approval required"), { code: "approval_denied" });
			},
		} as unknown as ApprovalBroker;
		const tools = createSandboxTools({
			snapshot,
			approvals: guarded,
			protectSkillSources: true,
			artifactWriter: async ({ name, content }) => {
				artifacts++;
				return artifact(name, content);
			},
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						reads++;
						return { content: "proof=ok", bytesRead: 8, totalBytes: 8, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
			},
		});
		const read = tools.find((tool) => tool.name === "read_file")!;
		for (const path of [
			"packages/fixture/SKILL.md",
			"SKILL.MD",
			"C:\\workspace\\SKILL.md",
			"SKILL.md. ",
			"SKILL.md:$DATA",
		]) {
			await expect(
				read.execute(
					"read",
					{ path },
					undefined,
					() => {
						updates++;
					},
					noContext
				)
			).rejects.toMatchObject({ code: "approval_denied" });
		}
		const edit = tools.find((tool) => tool.name === "edit")!;
		await expect(
			edit.execute(
				"edit",
				{ path: "SKILL.md", edits: [{ oldText: "old", newText: "new" }] },
				undefined,
				undefined,
				noContext
			)
		).rejects.toMatchObject({ code: "approval_denied" });
		expect([reads, updates, artifacts]).toEqual([0, 0, 0]);
		await read.execute("ordinary", { path: "config.txt" }, undefined, undefined, noContext);
		expect(reads).toBeGreaterThan(0);
	});

	it("withholds skill source search content including context and spilled output", async () => {
		let saved = "";
		const tools = createSandboxTools({
			snapshot,
			approvals,
			protectSkillSources: true,
			maxToolOutputChars: 10,
			artifactWriter: async ({ name, content }) => {
				saved = content.toString();
				return artifact(name, content);
			},
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				search: {
					async list() {
						return { path: ".", entries: [], truncated: false };
					},
					async glob(pattern) {
						return { pattern, paths: [], truncated: false, filesVisited: 0 };
					},
					async grep(pattern) {
						return {
							pattern,
							matches: [
								{
									path: "package/SKILL.md",
									line: 2,
									text: "FORBIDDEN_SOURCE",
									before: ["FORBIDDEN_BEFORE"],
									after: ["FORBIDDEN_AFTER"],
								},
								{ path: "config.txt", line: 1, text: "proof=ok" },
							],
							counts: [
								{ path: "package/SKILL.md", count: 1 },
								{ path: "config.txt", count: 1 },
							],
							filesSearched: 2,
							filesMatched: 2,
							totalMatches: 2,
							truncated: false,
							skippedLarge: 0,
							skippedBinary: 0,
						};
					},
				},
			},
		});
		const grep = tools.find((tool) => tool.name === "grep")!;
		const result = await grep.execute("search", { pattern: ".", context: 1 }, undefined, undefined, noContext);
		expect(saved).toContain("proof=ok");
		expect(saved).toContain("Skill source content withheld");
		expect(saved + JSON.stringify(result)).not.toContain("FORBIDDEN_");
	});

	it("replays a failed write once after on_failure approval", async () => {
		let writes = 0;
		let failureApprovals = 0;
		const onFailureApprovals = {
			authorize: async () => {},
			authorizeFailure: async () => {
				failureApprovals += 1;
			},
		} as unknown as ApprovalBroker;
		const tools = createSandboxTools({
			snapshot: { ...snapshot, approvalPolicy: "on_failure" },
			approvals: onFailureApprovals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						writes += 1;
						if (writes === 1) throw new Error("transient write failure");
						return { bytesWritten: 4 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
			},
		});
		const write = tools.find((tool) => tool.name === "write_file");
		await expect(
			write!.execute("write-1", { path: "out.txt", content: "data" }, undefined, undefined, noContext)
		).resolves.toMatchObject({
			content: [{ text: "Successfully wrote 4 bytes to out.txt" }],
		});
		expect(writes).toBe(2);
		expect(failureApprovals).toBe(1);
	});

	it("uses Pi's multi-block edit contract and preserves line endings", async () => {
		let content = "alpha\r\nbeta\r\ngamma\r\n";
		const tools = createSandboxTools({
			snapshot,
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readFile() {
						return Buffer.from(content);
					},
					async readText() {
						return {
							content,
							bytesRead: Buffer.byteLength(content),
							totalBytes: Buffer.byteLength(content),
							truncated: false,
						};
					},
					async writeText(_path, next) {
						content = next;
						return { bytesWritten: Buffer.byteLength(next) };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
			},
		});
		const edit = tools.find((tool) => tool.name === "edit");
		const result = await edit!.execute(
			"edit-1",
			{
				path: "source.txt",
				edits: [
					{ oldText: "alpha", newText: "one" },
					{ oldText: "gamma", newText: "three" },
				],
			},
			undefined,
			undefined,
			noContext
		);

		expect(content).toBe("one\r\nbeta\r\nthree\r\n");
		expect(result.details).toMatchObject({ patch: expect.stringContaining("+three") });
	});
	it("spills the complete read result when the inline result is truncated", async () => {
		let written: Buffer | undefined;
		const tools = createSandboxTools({
			snapshot,
			approvals,
			maxToolOutputChars: 5,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "abcdefghij", bytesRead: 10, totalBytes: 10, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
			},
			artifactWriter: async ({ name, content }) => {
				written = content;
				return artifact(name, content);
			},
		});
		const read = tools.find((tool) => tool.name === "read_file");
		const updates: Update[] = [];
		const result = await read!.execute(
			"call/read",
			{ path: "large.txt" },
			undefined,
			(update) => updates.push(update as Update),
			noContext
		);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("abcde\n[output truncated]"),
		});
		expect(result.details).toMatchObject({
			artifact: { name: "read-output-call_read.txt" },
			artifactTruncated: false,
		});
		expect(written?.toString("utf8")).toBe("abcdefghij");
		expect(updates.at(-1)).toMatchObject({
			details: { artifact: { name: "read-output-call_read.txt" } },
		});
	});

	it("uses the live process stream when the process result window was truncated", async () => {
		let written: Buffer | undefined;
		const tools = createSandboxTools({
			snapshot,
			approvals,
			maxToolOutputChars: 5,
			maxArtifactOutputBytes: 20,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				process: {
					async exec(_command, options) {
						options?.onOutput?.("12345");
						options?.onOutput?.("67890");
						return { exitCode: 0, stdout: "67890", stderr: "", truncated: true, timedOut: false };
					},
				},
			},
			artifactWriter: async ({ name, content }) => {
				written = content;
				return artifact(name, content);
			},
		});
		const exec = tools.find((tool) => tool.name === "exec");
		const updates: Update[] = [];
		const result = await exec!.execute(
			"exec-1",
			{ command: "generate-output" },
			undefined,
			(update) => updates.push(update as Update),
			noContext
		);
		expect(result.details).toMatchObject({
			artifact: { name: "exec-output-exec-1.log", size: 10 },
			artifactCaptureTruncated: false,
			artifactTruncated: false,
		});
		expect(written?.toString("utf8")).toBe("1234567890");
		// The live stream is what the transcript renders while the command runs: each
		// chunk re-sends the accumulated output under the same result window, so the
		// second update is already truncated even though the artifact keeps all of it.
		expect(updates.slice(0, -1).map((update) => ({ text: update.content[0]?.text, details: update.details }))).toEqual([
			{ text: "12345", details: { running: true } },
			{ text: "12345\n[output truncated]", details: { running: true } },
		]);
		// The last update is the settled result, so the UI can swap the running card
		// for one that links the spilled artifact.
		expect(updates.at(-1)?.details).toMatchObject({ artifact: { name: "exec-output-exec-1.log" } });
		expect(updates.at(-1)?.details.running).toBeUndefined();
	});

	it("exposes the complete configured tool catalog and limits read-only sessions", () => {
		const executor = {
			files: {
				root: "C:/workspace",
				async readText() {
					return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
				},
				async writeText() {
					return { bytesWritten: 0 };
				},
				async editText() {
					return { bytesWritten: 0, replacements: 0 };
				},
			},
			process: {
				async exec() {
					return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };
				},
			},
			web: {
				searchHost: "search.example.com",
				searchSecretName: undefined,
				async fetch(url: string) {
					return {
						requestedUrl: url,
						finalUrl: url,
						status: 200,
						contentType: "text/plain",
						content: "ok",
						truncated: false,
					};
				},
				async search() {
					return { provider: "test", items: [] };
				},
			},
			search: {
				async list() {
					return { path: ".", entries: [], truncated: false };
				},
				async glob(pattern: string) {
					return { pattern, paths: [], truncated: false, filesVisited: 0 };
				},
				async grep(pattern: string) {
					return {
						pattern,
						matches: [],
						counts: [],
						filesSearched: 0,
						filesMatched: 0,
						totalMatches: 0,
						truncated: false,
						skippedLarge: 0,
						skippedBinary: 0,
					};
				},
			},
		};
		// Search is read-only, so it stays available even in a read_only session.
		expect(createSandboxTools({ snapshot, approvals, executor }).map((tool) => tool.name)).toEqual([
			"read_file",
			"grep",
			"glob",
			"ls",
			"web_fetch",
			"web_search",
			"write_file",
			"edit",
			"exec",
			"shell",
			"run_python",
		]);
		expect(
			createSandboxTools({
				snapshot: { ...snapshot, sandboxMode: "read_only" },
				approvals,
				executor,
			}).map((tool) => tool.name)
		).toEqual(["read_file", "grep", "glob", "ls", "web_fetch", "web_search"]);
		expect(
			createSandboxTools({ snapshot, approvals, executor }).find((tool) => tool.name === "web_search")?.description
		).toContain("weather");
	});

	it("accepts the shell compatibility alias with either command key", async () => {
		let command = "";
		const tools = createSandboxTools({
			snapshot,
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				process: {
					async exec(value) {
						command = value;
						return { exitCode: 0, stdout: "ok", stderr: "", truncated: false, timedOut: false };
					},
				},
			},
		});
		const shell = tools.find((tool) => tool.name === "shell")!;
		await expect(shell.execute("shell-1", { cmd: "echo ok" }, undefined, undefined, noContext)).resolves.toMatchObject({
			content: [{ text: "ok" }],
		});
		expect(command).toBe("echo ok");
	});

	it("keeps process-based environment diagnostics out of read-only sessions", () => {
		const tools = createSandboxTools({
			snapshot: { ...snapshot, sandboxMode: "read_only" },
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				environment: {
					async inspect() {
						return {
							platform: "win32",
							shell: "cmd.exe",
							inspectedAt: 1,
							tools: [{ name: "node", available: true, version: "v22.0.0" }],
							project: { kinds: ["node"], envExamplePresent: true, envFilePresent: false },
						};
					},
				},
			},
		});
		expect(tools.find((tool) => tool.name === "environment_status")).toBeUndefined();
	});

	it("returns failed command output without replaying a valid nonzero exit", async () => {
		let calls = 0;
		let failureApprovals = 0;
		const tools = createSandboxTools({
			snapshot: { ...snapshot, approvalPolicy: "on_failure" },
			approvals: {
				authorize: async () => {},
				authorizeFailure: async () => {
					failureApprovals += 1;
				},
			} as unknown as ApprovalBroker,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				process: {
					async exec() {
						calls += 1;
						return {
							exitCode: 2,
							stdout: "test failed",
							stderr: "details",
							truncated: false,
							timedOut: false,
						};
					},
				},
			},
		});
		const exec = tools.find((tool) => tool.name === "exec")!;
		await expect(
			exec.execute("exec-failed", { command: "npm test" }, undefined, undefined, noContext)
		).resolves.toMatchObject({
			content: [{ text: "[exit code 2]\ntest failed\ndetails" }],
			details: { exitCode: 2 },
		});
		expect(calls).toBe(1);
		expect(failureApprovals).toBe(0);
	});

	it("adds actionable diagnostics when a command-line tool is missing", async () => {
		const tools = createSandboxTools({
			snapshot,
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				process: {
					async exec() {
						return {
							exitCode: 127,
							stdout: "",
							stderr: "/bin/sh: 1: pnpm: not found",
							truncated: false,
							timedOut: false,
						};
					},
				},
			},
		});
		const result = await tools
			.find((tool) => tool.name === "exec")!
			.execute("missing-pnpm", { command: "pnpm install" }, undefined, undefined, noContext);

		expect(result.details).toMatchObject({
			exitCode: 127,
			environmentIssue: {
				code: "tool_missing",
				tool: "pnpm",
				requiredBy: "pnpm install",
			},
		});
		const diagnosis = result.content[0];
		if (!diagnosis || diagnosis.type !== "text") throw new Error("Expected text diagnosis");
		expect(diagnosis.text).toContain("Environment diagnosis");
		expect(diagnosis.text).toContain("不要原样重复执行");
	});

	it("runs Python through the isolated process without interpolating source into the shell", async () => {
		let command = "";
		const tools = createSandboxTools({
			snapshot,
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				process: {
					async exec(value, options) {
						command = value;
						options?.onOutput?.("4");
						options?.onOutput?.("2");
						return { exitCode: 0, stdout: "42", stderr: "", truncated: false, timedOut: false };
					},
				},
			},
		});
		const python = tools.find((tool) => tool.name === "run_python")!;
		const updates: Update[] = [];
		await expect(
			python.execute(
				"python-1",
				{ code: "print('quoted value', 42)" },
				undefined,
				(update) => updates.push(update as Update),
				noContext
			)
		).resolves.toMatchObject({ content: [{ text: "42" }] });
		expect(command).toContain("python3");
		expect(command).toContain(" -c ");
		expect(command).not.toContain("quoted value");
		expect(Buffer.from(command.match(/b64decode\('([^']+)/)?.[1] ?? "", "base64").toString("utf8")).toBe(
			"print('quoted value', 42)"
		);
		// run_python has its own forwarding of the update callback into the shared
		// process runner, so the live stream has to be asserted here too.
		expect(updates.map((update) => ({ text: update.content[0]?.text, details: update.details }))).toEqual([
			{ text: "4", details: { running: true } },
			{ text: "42", details: { running: true } },
		]);
	});

	it("formats web search and fetch results", async () => {
		const tools = createSandboxTools({
			snapshot,
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				web: {
					searchHost: "search.example.com",
					searchSecretName: "SEARCH_KEY",
					async fetch(url) {
						return {
							requestedUrl: url,
							finalUrl: "https://example.com/final",
							status: 200,
							contentType: "text/plain",
							content: "page body",
							truncated: false,
						};
					},
					async search() {
						return {
							provider: "test",
							items: [{ title: "Result", url: "https://example.com", snippet: "Summary" }],
						};
					},
				},
			},
		});
		await expect(
			tools
				.find((tool) => tool.name === "web_fetch")!
				.execute("fetch-1", { url: "https://example.com" }, undefined, undefined, noContext)
		).resolves.toMatchObject({
			content: [{ text: expect.stringContaining("page body") }],
			details: { finalUrl: "https://example.com/final", status: 200 },
		});
		await expect(
			tools
				.find((tool) => tool.name === "web_search")!
				.execute("search-1", { query: "query" }, undefined, undefined, noContext)
		).resolves.toMatchObject({
			content: [{ text: expect.stringContaining("1. Result\nhttps://example.com\nSummary") }],
			details: { provider: "test", resultCount: 1 },
		});
	});

	it("exposes a persistent browser workflow and stores screenshots with their real MIME type", async () => {
		const actions: BrowserAction[] = [];
		let opened = "";
		let screenshotMime = "";
		const page = {
			tabId: "t1",
			tabCount: 1,
			url: "http://localhost:5173/",
			title: "App",
			text: 'URL: http://localhost:5173/\n[e1] button "Save"',
			interactiveCount: 1,
			truncated: false,
		};
		const browser: BrowserAutomation = {
			async open(url) {
				opened = url;
				return page;
			},
			async snapshot() {
				return page;
			},
			async act(action) {
				actions.push(action);
				return { ...page, text: `${page.text}\nSaved` };
			},
			async screenshot() {
				return { image: Buffer.from("png-bytes"), url: page.url, title: page.title };
			},
			async diagnostics() {
				return { url: page.url, console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
			},
			async tabs() {
				return [{ id: "t1", url: page.url, title: page.title, active: true }];
			},
			async close() {},
		};
		const tools = createSandboxTools({
			snapshot,
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				browser,
			},
			artifactWriter: async ({ name, content, mimeType }) => {
				screenshotMime = mimeType ?? "";
				return {
					id: "screen-1",
					name,
					mimeType: mimeType ?? "application/octet-stream",
					size: content.length,
				};
			},
		});
		await expect(
			tools
				.find((tool) => tool.name === "browser_open")!
				.execute(
					"browser-open",
					{ url: "http://localhost:5173/", width: 390, height: 844 },
					undefined,
					undefined,
					noContext
				)
		).resolves.toMatchObject({ content: [{ text: expect.stringContaining("[e1] button") }] });
		expect(opened).toBe("http://localhost:5173/");

		await expect(
			tools
				.find((tool) => tool.name === "browser_action")!
				.execute("browser-action", { action: "fill", ref: "e1", value: "done" }, undefined, undefined, noContext)
		).resolves.toMatchObject({ content: [{ text: expect.stringContaining("Saved") }] });
		expect(actions).toEqual([{ action: "fill", target: { ref: "e1" }, value: "done" }]);
		await expect(
			tools.find((tool) => tool.name === "browser_tabs")!.execute("browser-tabs", {}, undefined, undefined, noContext)
		).resolves.toMatchObject({ details: { count: 1, tabs: [{ id: "t1", active: true }] } });

		const screenshot = await tools
			.find((tool) => tool.name === "browser_screenshot")!
			.execute("browser-shot", { full_page: false }, undefined, undefined, noContext);
		expect(screenshot.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "image",
					mimeType: "image/png",
					data: Buffer.from("png-bytes").toString("base64"),
				}),
			])
		);
		expect(screenshot.details).toMatchObject({
			artifact: { id: "screen-1", mimeType: "image/png" },
		});
		expect(screenshotMime).toBe("image/png");
		expect(screenshot.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("Capture alone is not a visual review"),
				}),
			])
		);
	});

	it("keeps browser interaction out of read-only sessions", () => {
		const browser: BrowserAutomation = {
			async open() {
				throw new Error("unused");
			},
			async snapshot() {
				throw new Error("unused");
			},
			async act() {
				throw new Error("unused");
			},
			async screenshot() {
				throw new Error("unused");
			},
			async diagnostics() {
				throw new Error("unused");
			},
			async tabs() {
				return [];
			},
			async close() {},
		};
		const tools = createSandboxTools({
			snapshot: { ...snapshot, sandboxMode: "read_only" },
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				browser,
			},
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"read_file",
			"browser_open",
			"browser_snapshot",
			"browser_screenshot",
			"browser_diagnostics",
			"browser_tabs",
			"browser_close",
		]);
	});

	it("uses the user browser for search and saves browser downloads to the workspace", async () => {
		const calls: Array<{ kind: string; value: unknown }> = [];
		const page = {
			tabId: "t1",
			tabCount: 1,
			url: "http://127.0.0.1:8787/",
			title: "App",
			text: "page",
			interactiveCount: 0,
			truncated: false,
		};
		const browser: BrowserAutomation = {
			searchHost: "www.bing.com",
			async open() {
				return page;
			},
			async snapshot() {
				return page;
			},
			async act() {
				return page;
			},
			async screenshot() {
				return { image: Buffer.from("png"), url: page.url, title: page.title };
			},
			async search(query) {
				calls.push({ kind: "search", value: query });
				return {
					provider: "www.bing.com",
					query,
					url: "https://www.bing.com/search?q=" + encodeURIComponent(query),
					items: [{ title: "Result", url: "https://example.com/result", snippet: "Snippet" }],
				};
			},
			async currentHost() {
				return "127.0.0.1";
			},
			async download(request, options) {
				calls.push({ kind: "download", value: { request, options } });
				return {
					path: request.path ?? "download.bin",
					filename: "download.bin",
					url: request.url ?? "http://127.0.0.1:8787/file",
					title: "Download",
				};
			},
			async diagnostics() {
				return { url: page.url, console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
			},
			async tabs() {
				return [{ id: "t1", url: page.url, title: page.title, active: true }];
			},
			async close() {},
		};
		const tools = createSandboxTools({
			snapshot,
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() {
						return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
					},
					async writeText() {
						return { bytesWritten: 0 };
					},
					async editText() {
						return { bytesWritten: 0, replacements: 0 };
					},
				},
				browser,
			},
		});

		await expect(
			tools
				.find((tool) => tool.name === "browser_search")!
				.execute("browser-search", { query: "local query" }, undefined, undefined, noContext)
		).resolves.toMatchObject({
			content: [{ text: expect.stringContaining("1. Result\nhttps://example.com/result\nSnippet") }],
			details: { provider: "www.bing.com", resultCount: 1 },
		});
		await expect(
			tools
				.find((tool) => tool.name === "browser_download")!
				.execute(
					"browser-download",
					{ url: "http://127.0.0.1:8787/file", path: "assets/download.bin" },
					undefined,
					undefined,
					noContext
				)
		).resolves.toMatchObject({
			content: [{ text: expect.stringContaining("Path: assets/download.bin") }],
			details: { path: "assets/download.bin" },
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({ kind: "search", value: "local query" });
		expect(calls[1]).toMatchObject({
			kind: "download",
			value: {
				request: { url: "http://127.0.0.1:8787/file", path: "assets/download.bin" },
				options: { workspaceRoot: "C:/workspace" },
			},
		});
	});

	it("starts, inspects, and stops a configured preview server", async () => {
		const calls: string[] = [];
		const preview = {
			async start(command: string) {
				calls.push(`start:${command}`);
				return {
					state: "running" as const,
					url: "http://127.0.0.1:4173/",
					log: "ready",
					truncated: false,
				};
			},
			async status() {
				calls.push("status");
				return {
					state: "running" as const,
					url: "http://127.0.0.1:4173/",
					log: "ready",
					truncated: false,
				};
			},
			async stop() {
				calls.push("stop");
				return { state: "stopped" as const, log: "ready", truncated: false };
			},
		};
		const files = {
			root: "C:/workspace",
			async readText() {
				return { content: "", bytesRead: 0, totalBytes: 0, truncated: false };
			},
			async writeText() {
				return { bytesWritten: 0 };
			},
			async editText() {
				return { bytesWritten: 0, replacements: 0 };
			},
		};
		const tools = createSandboxTools({ snapshot, approvals, executor: { files, preview } });
		await expect(
			tools
				.find((tool) => tool.name === "preview_start")!
				.execute(
					"preview-start",
					{ command: "npm run dev", url: "http://127.0.0.1:4173/" },
					undefined,
					undefined,
					noContext
				)
		).resolves.toMatchObject({ details: { state: "running" } });
		await tools
			.find((tool) => tool.name === "preview_status")!
			.execute("preview-status", {}, undefined, undefined, noContext);
		await tools
			.find((tool) => tool.name === "preview_stop")!
			.execute("preview-stop", {}, undefined, undefined, noContext);
		expect(calls).toEqual(["start:npm run dev", "status", "stop"]);

		const readOnly = createSandboxTools({
			snapshot: { ...snapshot, sandboxMode: "read_only" },
			approvals,
			executor: { files, preview },
		});
		expect(readOnly.map((tool) => tool.name)).toEqual(["read_file", "preview_status"]);
	});
});

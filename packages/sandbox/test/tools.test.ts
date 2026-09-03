import type { ApprovalBroker } from "../src/approval.js";
import type { ArtifactRef, SessionSnapshot } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import { createSandboxTools } from "../src/index.js";

const snapshot: SessionSnapshot = {
	session: { id: "session-1", workspaceId: "workspace-1", phase: "turn", createdAt: 1, updatedAt: 1 },
	revision: 1,
	model: { provider: "test", id: "model" },
	thinkingLevel: "off",
	sandboxMode: "workspace_write",
	approvalPolicy: "never",
	transcript: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	pendingApprovals: [],
	usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
};

const approvals = { authorize: async () => {} } as unknown as ApprovalBroker;

function artifact(name: string, content: Buffer): ArtifactRef {
	return { id: `artifact-${name}`, name, mimeType: "text/plain", size: content.length };
}

describe("sandbox tool output artifacts", () => {
	it("replays a failed write once after on_failure approval", async () => {
		let writes = 0;
		let failureApprovals = 0;
		const onFailureApprovals = {
			authorize: async () => {},
			authorizeFailure: async () => { failureApprovals += 1; },
		} as unknown as ApprovalBroker;
		const tools = createSandboxTools({
			snapshot: { ...snapshot, approvalPolicy: "on_failure" },
			approvals: onFailureApprovals,
			executor: { files: {
				root: "C:/workspace",
				async readText() { return { content: "", bytesRead: 0, totalBytes: 0, truncated: false }; },
				async writeText() { writes += 1; if (writes === 1) throw new Error("transient write failure"); return { bytesWritten: 4 }; },
				async editText() { return { bytesWritten: 0, replacements: 0 }; },
			} },
		});
		const write = tools.find((tool) => tool.name === "write_file");
		await expect(write!.execute("write-1", { path: "out.txt", content: "data" }, undefined)).resolves.toMatchObject({
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
			executor: { files: {
				root: "C:/workspace",
				async readFile() { return Buffer.from(content); },
				async readText() { return { content, bytesRead: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), truncated: false }; },
				async writeText(_path, next) { content = next; return { bytesWritten: Buffer.byteLength(next) }; },
				async editText() { return { bytesWritten: 0, replacements: 0 }; },
			} },
		});
		const edit = tools.find((tool) => tool.name === "edit");
		const result = await edit!.execute("edit-1", {
			path: "source.txt",
			edits: [
				{ oldText: "alpha", newText: "one" },
				{ oldText: "gamma", newText: "three" },
			],
		}, undefined);

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
					async readText() { return { content: "abcdefghij", bytesRead: 10, totalBytes: 10, truncated: false }; },
					async writeText() { return { bytesWritten: 0 }; },
					async editText() { return { bytesWritten: 0, replacements: 0 }; },
				},
			},
			artifactWriter: async ({ name, content }) => {
				written = content;
				return artifact(name, content);
			},
		});
		const read = tools.find((tool) => tool.name === "read_file");
		const updates: unknown[] = [];
		const result = await read!.execute("call/read", { path: "large.txt" }, undefined, (update) => updates.push(update));
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("abcde\n[output truncated]") });
		expect(result.details).toMatchObject({ artifact: { name: "read-output-call_read.txt" }, artifactTruncated: false });
		expect(written?.toString("utf8")).toBe("abcdefghij");
		expect(updates.at(-1)).toMatchObject({ details: { artifact: { name: "read-output-call_read.txt" } } });
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
					async readText() { return { content: "", bytesRead: 0, totalBytes: 0, truncated: false }; },
					async writeText() { return { bytesWritten: 0 }; },
					async editText() { return { bytesWritten: 0, replacements: 0 }; },
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
		const result = await exec!.execute("exec-1", { command: "generate-output" }, undefined, () => {});
		expect(result.details).toMatchObject({
			artifact: { name: "exec-output-exec-1.log", size: 10 },
			artifactCaptureTruncated: false,
			artifactTruncated: false,
		});
		expect(written?.toString("utf8")).toBe("1234567890");
	});

	it("exposes the complete configured tool catalog and limits read-only sessions", () => {
		const executor = {
			files: {
				root: "C:/workspace",
				async readText() { return { content: "", bytesRead: 0, totalBytes: 0, truncated: false }; },
				async writeText() { return { bytesWritten: 0 }; },
				async editText() { return { bytesWritten: 0, replacements: 0 }; },
			},
			process: { async exec() { return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false }; } },
			web: {
				searchHost: "search.example.com",
				searchSecretName: undefined,
				async fetch(url: string) { return { requestedUrl: url, finalUrl: url, status: 200, contentType: "text/plain", content: "ok", truncated: false }; },
				async search() { return { provider: "test", items: [] }; },
			},
			search: {
				async list() { return { path: ".", entries: [], truncated: false }; },
				async glob(pattern: string) { return { pattern, paths: [], truncated: false, filesVisited: 0 }; },
				async grep(pattern: string) {
					return { pattern, matches: [], counts: [], filesSearched: 0, filesMatched: 0, totalMatches: 0, truncated: false, skippedLarge: 0, skippedBinary: 0 };
				},
			},
		};
		// Search is read-only, so it stays available even in a read_only session.
		expect(createSandboxTools({ snapshot, approvals, executor }).map((tool) => tool.name)).toEqual([
			"read_file", "grep", "glob", "ls", "web_fetch", "web_search", "write_file", "edit", "exec", "run_python",
		]);
		expect(createSandboxTools({ snapshot: { ...snapshot, sandboxMode: "read_only" }, approvals, executor }).map((tool) => tool.name)).toEqual([
			"read_file", "grep", "glob", "ls", "web_fetch", "web_search",
		]);
		expect(createSandboxTools({ snapshot, approvals, executor }).find((tool) => tool.name === "web_search")?.description).toContain("weather");
	});

	it("returns failed command output without replaying a valid nonzero exit", async () => {
		let calls = 0;
		let failureApprovals = 0;
		const tools = createSandboxTools({
			snapshot: { ...snapshot, approvalPolicy: "on_failure" },
			approvals: {
				authorize: async () => {},
				authorizeFailure: async () => { failureApprovals += 1; },
			} as unknown as ApprovalBroker,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() { return { content: "", bytesRead: 0, totalBytes: 0, truncated: false }; },
					async writeText() { return { bytesWritten: 0 }; },
					async editText() { return { bytesWritten: 0, replacements: 0 }; },
				},
				process: { async exec() { calls += 1; return { exitCode: 2, stdout: "test failed", stderr: "details", truncated: false, timedOut: false }; } },
			},
		});
		const exec = tools.find((tool) => tool.name === "exec")!;
		await expect(exec.execute("exec-failed", { command: "npm test" }, undefined)).resolves.toMatchObject({
			content: [{ text: "[exit code 2]\ntest failed\ndetails" }],
			details: { exitCode: 2 },
		});
		expect(calls).toBe(1);
		expect(failureApprovals).toBe(0);
	});

	it("runs Python through the isolated process without interpolating source into the shell", async () => {
		let command = "";
		const tools = createSandboxTools({
			snapshot,
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() { return { content: "", bytesRead: 0, totalBytes: 0, truncated: false }; },
					async writeText() { return { bytesWritten: 0 }; },
					async editText() { return { bytesWritten: 0, replacements: 0 }; },
				},
				process: { async exec(value) { command = value; return { exitCode: 0, stdout: "42", stderr: "", truncated: false, timedOut: false }; } },
			},
		});
		const python = tools.find((tool) => tool.name === "run_python")!;
		await expect(python.execute("python-1", { code: "print('quoted value', 42)" }, undefined)).resolves.toMatchObject({ content: [{ text: "42" }] });
		expect(command).toContain("python3 -c");
		expect(command).not.toContain("quoted value");
		expect(Buffer.from(command.match(/b64decode\(\"([^\"]+)/)?.[1] ?? "", "base64").toString("utf8")).toBe("print('quoted value', 42)");
	});

	it("formats web search and fetch results", async () => {
		const tools = createSandboxTools({
			snapshot,
			approvals,
			executor: {
				files: {
					root: "C:/workspace",
					async readText() { return { content: "", bytesRead: 0, totalBytes: 0, truncated: false }; },
					async writeText() { return { bytesWritten: 0 }; },
					async editText() { return { bytesWritten: 0, replacements: 0 }; },
				},
				web: {
					searchHost: "search.example.com",
					searchSecretName: "SEARCH_KEY",
					async fetch(url) { return { requestedUrl: url, finalUrl: "https://example.com/final", status: 200, contentType: "text/plain", content: "page body", truncated: false }; },
					async search() { return { provider: "test", items: [{ title: "Result", url: "https://example.com", snippet: "Summary" }] }; },
				},
			},
		});
		await expect(tools.find((tool) => tool.name === "web_fetch")!.execute("fetch-1", { url: "https://example.com" }, undefined)).resolves.toMatchObject({
			content: [{ text: expect.stringContaining("page body") }],
			details: { finalUrl: "https://example.com/final", status: 200 },
		});
		await expect(tools.find((tool) => tool.name === "web_search")!.execute("search-1", { query: "query" }, undefined)).resolves.toMatchObject({
			content: [{ text: expect.stringContaining("1. Result\nhttps://example.com\nSummary") }],
			details: { provider: "test", resultCount: 1 },
		});
	});
});

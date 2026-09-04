import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildWumingSystemPrompt, type WumingSystemPromptOptions } from "../src/system-prompt.js";

type PromptTool = WumingSystemPromptOptions["tools"][number];

function tool(name: string, promptSnippet?: string, promptGuidelines?: string[]): PromptTool {
	return { name, ...(promptSnippet ? { promptSnippet } : {}), ...(promptGuidelines ? { promptGuidelines } : {}) };
}

/** The tool set a workspace_write session with every backend configured produces. */
const fullToolset: PromptTool[] = [
	tool("read_file", "Read file contents", ["Use read_file to examine files rather than shell commands such as cat, head or sed."]),
	tool("grep", "Search workspace file contents by regular expression"),
	tool("glob", "Find workspace files by path glob"),
	tool("ls", "List workspace directory entries"),
	tool("web_fetch", "Fetch readable content from a public web page"),
	tool("web_search", "Search the public web for current information"),
	tool("write_file", "Create or overwrite files", ["Use write_file only for new files or complete rewrites; use edit to change part of an existing file."]),
	tool("edit", "Make precise file edits with exact text replacement", ["Use edit for precise changes (edits[].oldText must match exactly)"]),
	tool("exec", "Run isolated workspace commands"),
	tool("run_python", "Run isolated Python 3 code"),
];

function build(tools: PromptTool[], overrides: Partial<Omit<WumingSystemPromptOptions, "tools">> = {}): string {
	return buildWumingSystemPrompt({ tools, sandboxMode: "workspace_write", approvalPolicy: "on_risk", ...overrides });
}

/** The `<available_tools>`/`<tool_guidelines>` body, without the surrounding prose. */
function section(prompt: string, name: string): string {
	const match = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(prompt);
	if (!match) throw new Error(`Prompt is missing a <${name}> section`);
	return match[1]!;
}

describe("buildWumingSystemPrompt tool rendering", () => {
	it("lists every tool that has a snippet, in registration order", () => {
		const tools = section(build(fullToolset), "available_tools");
		expect(tools.split("\n").filter((line) => line.startsWith("- "))).toEqual([
			"- read_file: Read file contents",
			"- grep: Search workspace file contents by regular expression",
			"- glob: Find workspace files by path glob",
			"- ls: List workspace directory entries",
			"- web_fetch: Fetch readable content from a public web page",
			"- web_search: Search the public web for current information",
			"- write_file: Create or overwrite files",
			"- edit: Make precise file edits with exact text replacement",
			"- exec: Run isolated workspace commands",
			"- run_python: Run isolated Python 3 code",
		]);
	});

	it("omits a tool with no snippet, and says so when nothing is configured", () => {
		expect(section(build([tool("read_file", "Read file contents"), tool("mcp__extension__thing")]), "available_tools"))
			.toContain("- read_file: Read file contents");
		expect(section(build([tool("read_file", "Read file contents"), tool("mcp__extension__thing")]), "available_tools"))
			.not.toContain("mcp__extension__thing");
		expect(section(build([]), "available_tools")).toContain("(no tools are configured for this session)");
	});

	it("describes only the tools a read-only session actually has", () => {
		const readOnly = fullToolset.filter((candidate) => ["read_file", "grep", "glob", "ls"].includes(candidate.name));
		const listed = section(build(readOnly, { sandboxMode: "read_only" }), "available_tools");

		expect(listed.split("\n").filter((line) => line.startsWith("- "))).toEqual([
			"- read_file: Read file contents",
			"- grep: Search workspace file contents by regular expression",
			"- glob: Find workspace files by path glob",
			"- ls: List workspace directory entries",
		]);
	});
});

describe("buildWumingSystemPrompt guidelines", () => {
	it("emits a conditional guideline only when its gating tool is registered", () => {
		const withExec = section(build(fullToolset), "tool_guidelines");
		expect(withExec).toContain("Use exec for build, test and lint commands");
		expect(withExec).toContain("Locate code with grep and glob before reading anything");
		expect(withExec).toContain("Use ls to orient yourself");
		expect(withExec).toContain("Use run_python for calculation");
		expect(withExec).toContain("Search the web when a fact could have changed");

		const readOnly = section(build([tool("read_file", "Read file contents")]), "tool_guidelines");
		expect(readOnly).not.toContain("Use exec");
		expect(readOnly).not.toContain("Locate code with grep");
		expect(readOnly).not.toContain("Use ls to orient");
		expect(readOnly).not.toContain("run_python");
		expect(readOnly).not.toContain("Search the web");
	});

	it("emits the search guideline when either grep or glob is present", () => {
		expect(section(build([tool("glob", "Find workspace files by path glob")]), "tool_guidelines"))
			.toContain("Locate code with grep and glob");
	});

	it("carries each tool's own guidelines and never repeats one", () => {
		const duplicated = [
			tool("read_file", "Read file contents", ["Prefer read_file over cat."]),
			tool("edit", "Edit files", ["Prefer read_file over cat.", "Keep oldText small."]),
		];
		const lines = section(build(duplicated), "tool_guidelines").split("\n");

		expect(lines.filter((line) => line === "- Prefer read_file over cat.")).toHaveLength(1);
		expect(lines).toContain("- Keep oldText small.");
	});

	it("names Wuming's renamed tools rather than Pi's originals", () => {
		const guidelines = section(build(fullToolset), "tool_guidelines");
		expect(guidelines).toContain("Use read_file to examine files");
		expect(guidelines).toContain("Use write_file only for new files");
		expect(guidelines).not.toMatch(/Use `?read`? to/);
		expect(guidelines).not.toMatch(/Use `?write`? (only|to)/);
	});

	it("always states how to batch calls, even with no tools", () => {
		expect(section(build([]), "tool_guidelines")).toContain("Make independent tool calls in the same batch");
	});

	it("uses the plan tool for substantial work without forcing it on simple tasks", () => {
		const guidelines = section(build([tool("update_plan", "Track a multi-step plan")]), "tool_guidelines");
		expect(guidelines).toContain("create a short plan after the initial inspection");
		expect(guidelines).toContain("Skip a plan for a simple question or one-step edit");
	});
});

describe("buildWumingSystemPrompt environment", () => {
	it("states the session's sandbox mode and nothing else", () => {
		expect(build(fullToolset, { sandboxMode: "read_only" })).toContain("Sandbox mode: read_only — you may read and search");
		expect(build(fullToolset, { sandboxMode: "workspace_write" })).toContain("Sandbox mode: workspace_write — you may read, search, write and run commands");
		expect(build(fullToolset, { sandboxMode: "unrestricted" })).toContain("Sandbox mode: unrestricted — the sandbox limits are relaxed");
		expect(build(fullToolset, { sandboxMode: "read_only" })).not.toContain("Sandbox mode: workspace_write");
	});

	it("states the session's approval policy and nothing else", () => {
		expect(build(fullToolset, { approvalPolicy: "always" })).toContain("Approval policy: always — every tool call pauses");
		expect(build(fullToolset, { approvalPolicy: "on_risk" })).toContain("Approval policy: on_risk — writes and commands pause");
		expect(build(fullToolset, { approvalPolicy: "on_failure" })).toContain("Approval policy: on_failure — a failed call is paused");
		expect(build(fullToolset, { approvalPolicy: "never" })).toContain("Approval policy: never — tool calls run without asking");
		expect(build(fullToolset, { approvalPolicy: "never" })).not.toContain("Approval policy: on_risk");
	});

	it("keeps the sections the runtime prose depends on", () => {
		const prompt = build(fullToolset);
		for (const name of ["environment", "available_tools", "tool_guidelines", "how_to_work", "verification", "safety", "communication"]) {
			expect(prompt).toContain(`<${name}>`);
			expect(prompt).toContain(`</${name}>`);
		}
	});

	it("introduces Wuming rather than Pi", () => {
		const prompt = build(fullToolset);
		expect(prompt.startsWith("You are Wuming (无名), a coding agent.")).toBe(true);
		expect(prompt).not.toMatch(/\bpi\b/i);
		expect(prompt).not.toContain("pi.dev");
		expect(prompt).not.toContain(".pi/");
	});

	it("asks for concise, localized progress rather than hidden chain-of-thought", () => {
		const prompt = build(fullToolset);
		expect(prompt).toContain("brief progress updates at meaningful transitions");
		expect(prompt).toContain("not private chain-of-thought");
		expect(prompt).toContain("must use the user's language");
	});
});

describe("buildWumingSystemPrompt typing", () => {
	it("accepts a real ToolDefinition without narrowing it first", () => {
		const definition: ToolDefinition = {
			name: "todo_write",
			label: "todo_write",
			description: "Track the plan for a multi-step task",
			promptSnippet: "Track the plan for a multi-step task",
			promptGuidelines: ["Keep the todo list current as you work."],
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};

		const prompt = build([definition]);
		expect(prompt).toContain("- todo_write: Track the plan for a multi-step task");
		expect(prompt).toContain("- Keep the todo list current as you work.");
	});
});

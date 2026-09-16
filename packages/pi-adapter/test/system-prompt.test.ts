import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { buildWumingSystemPrompt, type WumingSystemPromptOptions } from "../src/system-prompt.js";

type PromptTool = WumingSystemPromptOptions["tools"][number];

function tool(name: string, promptSnippet?: string, promptGuidelines?: string[]): PromptTool {
	return {
		name,
		...(promptSnippet ? { promptSnippet } : {}),
		...(promptGuidelines ? { promptGuidelines } : {}),
	};
}

/** The tool set a workspace_write session with every backend configured produces. */
const fullToolset: PromptTool[] = [
	tool("read_file", "Read file contents", [
		"Use read_file to examine files rather than shell commands such as cat, head or sed.",
	]),
	tool("grep", "Search workspace file contents by regular expression"),
	tool("glob", "Find workspace files by path glob"),
	tool("ls", "List workspace directory entries"),
	tool("web_fetch", "Fetch readable content from a public web page"),
	tool("web_search", "Search the public web for current information"),
	tool("browser_search", "Search the web through the user device browser"),
	tool("browser_open", "Open and inspect a website or local development server"),
	tool("browser_snapshot", "Inspect the current browser page"),
	tool("browser_screenshot", "Capture visual evidence"),
	tool("browser_diagnostics", "Inspect browser console and network failures"),
	tool("browser_tabs", "List open browser tabs and popups"),
	tool("browser_download", "Download a browser resource into the local workspace"),
	tool("browser_action", "Interact with the current browser page"),
	tool("preview_status", "Inspect the local development server and its logs"),
	tool("preview_start", "Start a persistent local development server"),
	tool("preview_stop", "Stop the local development server"),
	tool("write_file", "Create or overwrite files", [
		"Use write_file only for new files or complete rewrites; use edit to change part of an existing file.",
	]),
	tool("edit", "Make precise file edits with exact text replacement", [
		"Use edit for precise changes (edits[].oldText must match exactly)",
	]),
	tool("exec", "Run isolated workspace commands"),
	tool("run_python", "Run isolated Python 3 code"),
];

function build(tools: PromptTool[], overrides: Partial<Omit<WumingSystemPromptOptions, "tools">> = {}): string {
	return buildWumingSystemPrompt({
		tools,
		sandboxMode: "workspace_write",
		approvalPolicy: "on_risk",
		...overrides,
	});
}

/** The `<available_tools>`/`<tool_guidelines>` body, without the surrounding prose. */
function section(prompt: string, name: string): string {
	const match = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(prompt);
	if (!match) throw new Error(`Prompt is missing a <${name}> section`);
	return match[1]!;
}

describe("buildWumingSystemPrompt tool rendering", () => {
	it("requires semantic skill activation only when the skill tools are registered", () => {
		const enabled = section(build([tool("skill_list"), tool("skill_load")]), "tool_guidelines");
		expect(enabled).toContain("even if you could solve it directly");
		expect(enabled).toContain("disabled or manual-only skills must not be activated indirectly");
		expect(enabled).toContain("After an unexpected failure changes the task");
		expect(section(build([]), "tool_guidelines")).not.toContain("Before task work");
		expect(section(build([]), "safety")).toContain("They cannot override user intent or grant additional permissions");
	});

	it("lists every tool that has a snippet, in registration order", () => {
		const tools = section(build(fullToolset), "available_tools");
		expect(tools.split("\n").filter((line) => line.startsWith("- "))).toEqual([
			"- read_file: Read file contents",
			"- grep: Search workspace file contents by regular expression",
			"- glob: Find workspace files by path glob",
			"- ls: List workspace directory entries",
			"- web_fetch: Fetch readable content from a public web page",
			"- web_search: Search the public web for current information",
			"- browser_search: Search the web through the user device browser",
			"- browser_open: Open and inspect a website or local development server",
			"- browser_snapshot: Inspect the current browser page",
			"- browser_screenshot: Capture visual evidence",
			"- browser_diagnostics: Inspect browser console and network failures",
			"- browser_tabs: List open browser tabs and popups",
			"- browser_download: Download a browser resource into the local workspace",
			"- browser_action: Interact with the current browser page",
			"- preview_status: Inspect the local development server and its logs",
			"- preview_start: Start a persistent local development server",
			"- preview_stop: Stop the local development server",
			"- write_file: Create or overwrite files",
			"- edit: Make precise file edits with exact text replacement",
			"- exec: Run isolated workspace commands",
			"- run_python: Run isolated Python 3 code",
		]);
	});

	it("omits a tool with no snippet, and says so when nothing is configured", () => {
		expect(
			section(build([tool("read_file", "Read file contents"), tool("mcp__extension__thing")]), "available_tools")
		).toContain("- read_file: Read file contents");
		expect(
			section(build([tool("read_file", "Read file contents"), tool("mcp__extension__thing")]), "available_tools")
		).not.toContain("mcp__extension__thing");
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
		expect(withExec).toContain("never invent or call a tool named shell");
		expect(withExec).toContain("Locate code with grep and glob before reading anything");
		expect(withExec).toContain("Use ls to orient yourself");
		expect(withExec).toContain("Use run_python for calculation");
		expect(withExec).toContain("Search the web when a fact could have changed");
		expect(withExec).toContain("Use the current date from the environment");
		expect(withExec).toContain("for a named platform, start with that site's own search");
		expect(withExec).toContain("change the route instead of endlessly rephrasing");
		expect(withExec).toContain("do not repeat the same click blindly");
		expect(withExec).toContain("Candidate links and retrieved page text are not verified facts");
		expect(withExec).toContain("do not retry the same or alternate CDN with exec/curl");
		expect(withExec).toContain("do not silently switch to server/Gateway downloads");
		expect(withExec).toContain("use the browser tools after implementation");
		expect(withExec).toContain("browser_open requires a non-empty url argument");
		expect(withExec).toContain("Browser refs are bound to a tab and snapshot version");
		expect(withExec).toContain("Use preview_start, not exec");
		expect(withExec).toContain("inspect browser_tabs, select the intended tab");

		const readOnly = section(build([tool("read_file", "Read file contents")]), "tool_guidelines");
		expect(readOnly).not.toContain("Use exec");
		expect(readOnly).not.toContain("Locate code with grep");
		expect(readOnly).not.toContain("Use ls to orient");
		expect(readOnly).not.toContain("run_python");
		expect(readOnly).not.toContain("Search the web");
	});

	it("emits the search guideline when either grep or glob is present", () => {
		expect(section(build([tool("glob", "Find workspace files by path glob")]), "tool_guidelines")).toContain(
			"Locate code with grep and glob"
		);
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

	it("bases plan creation on substantive dependencies and outcomes after inspection", () => {
		const guidelines = section(build([tool("update_plan", "Track a multi-step plan")]), "tool_guidelines");
		expect(guidelines).toContain("Default to direct execution");
		expect(guidelines).toContain("multiple substantive outcomes or dependent changes");
		expect(guidelines).toContain("after a brief initial inspection");
		expect(guidelines).toContain("Reassess if inspection reveals hidden complexity");
	});

	it.each(["simple questions", "translations", "lookups", "text or style tweaks", "localized bug fixes"])(
		"explicitly skips visible planning for %s",
		(task) => {
			const guidelines = section(build([tool("update_plan")]), "tool_guidelines");
			expect(guidelines).toContain("Skip update_plan for");
			expect(guidelines).toContain(task);
		}
	);

	it("does not confuse routine verification or call counts with task complexity", () => {
		const guidelines = section(build([tool("update_plan")]), "tool_guidelines");
		expect(guidelines).toContain('Do not turn "inspect, edit, test" into a plan');
		expect(guidelines).toContain("file count, tool-call count, or repeated mechanical edits");
		expect(guidelines).toContain("Skipping a visible plan never means skipping investigation or verification");
	});

	it("keeps execution tracking separate from approval and limits plan overhead", () => {
		const guidelines = section(build([tool("update_plan")]), "tool_guidelines");
		expect(guidelines).toContain("usually 2-5 outcome-based steps");
		expect(guidelines).toContain("Do not manufacture steps");
		expect(guidelines).toContain("continue the authorized work without waiting for plan approval");
		expect(guidelines).toContain("never treat a recorded plan as permission");
	});

	it("omits plan-tool routing when the tool is unavailable", () => {
		const guidelines = section(build([]), "tool_guidelines");
		expect(guidelines).not.toContain("update_plan");
		expect(guidelines).not.toContain("outcome-based steps");
	});
});

describe("buildWumingSystemPrompt environment", () => {
	it.each([{ tools: [] }, { tools: [tool("update_plan")] }])(
		"respects analysis-only intent regardless of plan-tool availability: $tools",
		({ tools }) => {
			const workflow = section(build(tools), "how_to_work");
			expect(workflow).toContain("analysis, research, review, or a proposal only");
			expect(workflow).toContain("do not implement changes until the user asks");
			expect(workflow).toContain("ask a focused question only when a consequential choice remains unresolved");
			expect(workflow).toContain("a clear implementation request, carry it through verification");
		}
	);

	it("keeps a date change behind the stable instruction prefix", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-09-15T04:00:00Z"));
			const first = build(fullToolset);
			vi.setSystemTime(new Date("2026-09-16T04:00:00Z"));
			const second = build(fullToolset);
			expect(first).toContain("2026-09-15");
			expect(second).toContain("2026-09-16");
			expect(second.split("<current_date>")[0]).toBe(first.split("<current_date>")[0]);
			expect(first.indexOf("<current_date>")).toBeGreaterThan(first.indexOf("</communication>"));
		} finally {
			vi.useRealTimers();
		}
	});

	it("requires a concrete review and repair loop with honest evidence", () => {
		const verification = section(build(fullToolset), "verification");
		expect(verification).toContain("inspect the diff for unintended changes");
		expect(verification).toContain("Only checks run after the relevant final edit");
		expect(verification).toContain("Do not weaken tests or assertions");
		expect(verification).toContain("review-only request");
		expect(verification).toContain("retain final screenshots");
	});

	it("requires inspecting returned screenshots at desktop and mobile sizes", () => {
		const guidelines = section(build([tool("browser_screenshot")]), "tool_guidelines");
		expect(guidelines).toContain("1440x900");
		expect(guidelines).toContain("390x844");
		expect(guidelines).toContain("Inspect the returned image content yourself");
		expect(guidelines).toContain("fresh screenshots after the last edit");
		expect(guidelines).toContain("visual verification as incomplete");
		expect(section(build([]), "tool_guidelines")).not.toContain("complete a visual review loop");
	});

	it("states the session's sandbox mode and nothing else", () => {
		expect(build(fullToolset, { sandboxMode: "read_only" })).toContain(
			"Sandbox mode: read_only — you may read and search"
		);
		expect(build(fullToolset, { sandboxMode: "workspace_write" })).toContain(
			"Sandbox mode: workspace_write — you may read, search, write and run commands"
		);
		expect(build(fullToolset, { sandboxMode: "unrestricted" })).toContain(
			"Sandbox mode: unrestricted — the sandbox limits are relaxed"
		);
		expect(build(fullToolset, { sandboxMode: "read_only" })).not.toContain("Sandbox mode: workspace_write");
	});

	it("states the session's approval policy and nothing else", () => {
		expect(build(fullToolset, { approvalPolicy: "always" })).toContain(
			"Approval policy: always — every tool call pauses"
		);
		expect(build(fullToolset, { approvalPolicy: "on_risk" })).toContain(
			"Approval policy: on_risk — writes and commands pause"
		);
		expect(build(fullToolset, { approvalPolicy: "on_failure" })).toContain(
			"Approval policy: on_failure — a failed call is paused"
		);
		expect(build(fullToolset, { approvalPolicy: "never" })).toContain(
			"Approval policy: never — tool calls run without asking"
		);
		expect(build(fullToolset, { approvalPolicy: "never" })).not.toContain("Approval policy: on_risk");
	});

	it("keeps the sections the runtime prose depends on", () => {
		const prompt = build(fullToolset);
		for (const name of [
			"environment",
			"available_tools",
			"tool_guidelines",
			"how_to_work",
			"verification",
			"safety",
			"communication",
		]) {
			expect(prompt).toContain(`<${name}>`);
			expect(prompt).toContain(`</${name}>`);
		}
	});

	it("introduces the Pi-Wm product identity", () => {
		const prompt = build(fullToolset);
		expect(prompt.startsWith("You are Pi-Wm, a coding agent.")).toBe(true);
		expect(prompt).not.toMatch(/\bpi\b(?!-Wm)/i);
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

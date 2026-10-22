import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { BackgroundTasks } from "../src/background-tasks.js";

const directories: string[] = [];
const managers: BackgroundTasks[] = [];
const context = {} as Parameters<ToolDefinition["execute"]>[4];
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		manager.dispose();
		await manager.end();
	}
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "wuming-background-"));
	directories.push(directory);
	const manager = new BackgroundTasks("session", directory, join(directory, "tasks.json"));
	managers.push(manager);
	const controller = new AbortController();
	manager.begin("operation", controller.signal);
	return { manager, controller, directory };
}

function slowTool(name = "exec") {
	const work = deferred<ReturnType<typeof result>>();
	let calls = 0;
	const tool = defineTool({
		name,
		label: name,
		description: name,
		parameters: Type.Object({ command: Type.String() }),
		execute: async () => {
			calls++;
			return work.promise;
		},
	});
	return { tool, work, calls: () => calls };
}

it("returns a receipt before completion and permits independent work, then preserves the real result", async () => {
	const { manager } = await setup();
	const { tool, work } = slowTool();
	const receipt = await manager.start(tool, { command: "check" }, "call", "Checks", ["src"], 0, 10, undefined, context);
	expect(receipt.details).toMatchObject({ backgroundTask: { status: "running" } });
	const write = defineTool({
		name: "write_file",
		label: "write",
		description: "write",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => result("docs written"),
	});
	expect(await manager.guard(write).execute("write", { path: "docs/guide.md" }, undefined, undefined, context)).toEqual(
		result("docs written")
	);
	await expect(
		manager.guard(write).execute("conflict", { path: "src/main.ts" }, undefined, undefined, context)
	).rejects.toThrow("Resource is in use");
	work.resolve(result("checks passed"));
	const completed = await manager.next(new AbortController().signal);
	expect(completed).toHaveLength(1);
	expect(completed[0]?.result).toEqual(result("checks passed"));
	await manager.consume(completed.map(({ task }) => task.id));
	expect(await manager.next(new AbortController().signal)).toEqual([]);
	expect(await manager.guard(write).execute("after", { path: "src/main.ts" }, undefined, undefined, context)).toEqual(
		result("docs written")
	);
});

it("deduplicates running requests without issuing a second billable call", async () => {
	const { manager } = await setup();
	const { tool, work, calls } = slowTool("mcp__remote__build");
	const one = await manager.start(tool, { command: "build" }, "a", "Build", [], 0, 10, undefined, context);
	const two = await manager.start(tool, { command: "build" }, "b", "Build", [], 0, 10, undefined, context);
	expect(one.details).toEqual(two.details);
	expect(calls()).toBe(1);
	work.resolve(result("done"));
	await manager.next(new AbortController().signal);
});

it("returns fast results directly and validates nested tool arguments", async () => {
	const { manager } = await setup();
	let calls = 0;
	const tool = defineTool({
		name: "web_fetch",
		label: "Fetch",
		description: "Fetch",
		parameters: Type.Object({ url: Type.String() }),
		execute: async () => {
			calls++;
			return result("page");
		},
	});
	const start = manager.tools([tool])[0]!;
	await expect(
		start.execute("bad", { tool: "web_fetch", arguments: {}, label: "Fetch" }, undefined, undefined, context)
	).rejects.toThrow("Invalid arguments");
	expect(calls).toBe(0);
	expect(
		await start.execute(
			"ok",
			{ tool: "web_fetch", arguments: { url: "https://example.test" }, label: "Fetch" },
			undefined,
			undefined,
			context
		)
	).toEqual(result("page"));
	expect(manager.list()[0]).toMatchObject({ status: "completed", consumed: true });
});

it("does not turn background execution into permission to create agents or run unsupported tools", async () => {
	const { manager } = await setup();
	const { tool } = slowTool();
	await expect(
		manager
			.tools([tool])[0]!
			.execute("bad", { tool: "subagent", arguments: {}, label: "Delegate" }, undefined, undefined, context)
	).rejects.toThrow("cannot run");
	expect(manager.list()).toEqual([]);
});

it("cancels without reviving late results and retains resource ownership until actual work settles", async () => {
	const { manager } = await setup();
	const { tool, work } = slowTool();
	await manager.start(tool, { command: "slow" }, "call", "Slow", undefined, 0, 10, undefined, context);
	const task = manager.list()[0]!;
	await manager.cancel(task.id);
	expect(manager.list()[0]?.status).toBe("cancelled");
	expect(() => manager.assertAvailable(["*"])).toThrow("Resource is in use");
	work.resolve(result("late success"));
	await new Promise((done) => setTimeout(done, 0));
	expect(manager.list()[0]?.status).toBe("cancelled");
	expect(() => manager.assertAvailable(["*"])).not.toThrow();
	await expect(manager.cancel("another-session-task")).rejects.toThrow("does not belong");
});

it("aborting a wait leaves the task running, while aborting the operation cancels it", async () => {
	const { manager, controller } = await setup();
	const { tool, work } = slowTool();
	await manager.start(tool, { command: "slow" }, "call", "Slow", [], 0, 10, undefined, context);
	const waiter = new AbortController();
	const wait = manager.tools([tool]).find((item) => item.name === "background_wait")!;
	const pending = wait.execute(
		"wait",
		{ task_id: manager.list()[0]!.id, wait_ms: 30000 },
		waiter.signal,
		undefined,
		context
	);
	waiter.abort(new Error("stop waiting"));
	await expect(pending).rejects.toThrow("stop waiting");
	expect(manager.list()[0]?.status).toBe("running");
	controller.abort(new Error("user stopped"));
	await manager.next(new AbortController().signal);
	expect(manager.list()[0]?.status).toBe("cancelled");
	work.resolve(result("ignored"));
});

it("restores unresolved work as interrupted without replaying any operation", async () => {
	const { manager, directory } = await setup();
	await writeFile(
		join(directory, "tasks.json"),
		JSON.stringify([
			{
				task: {
					id: "saved",
					sessionId: "session",
					operationId: "old",
					toolCallId: "call",
					toolName: "exec",
					label: "Old work",
					status: "running",
					startedAt: 1,
					preview: "",
					consumed: false,
				},
			},
		])
	);
	await manager.restore();
	expect(manager.list()[0]).toMatchObject({ status: "interrupted", consumed: false });
	expect((await manager.next(new AbortController().signal))[0]?.result.content).toEqual([
		{ type: "text", text: expect.stringContaining("do not resubmit") },
	]);
});

it.each([1, null])(
	"reports unsuccessful command exits (%s) as failed even when the tool resolves normally",
	async (exitCode) => {
		const { manager } = await setup();
		const { tool, work } = slowTool();
		await manager.start(tool, { command: "check" }, "call", "Checks", [], 0, 10, undefined, context);
		work.resolve({ ...result("failure output"), details: { exitCode } });
		expect((await manager.next(new AbortController().signal))[0]?.task.status).toBe("failed");
	}
);

it("keeps immediate approval failures resumable without bypassing the original approval", async () => {
	const { manager } = await setup();
	const approval = Object.assign(new Error("approval required"), { code: "approval_required" });
	const tool = defineTool({
		name: "exec",
		label: "exec",
		description: "exec",
		parameters: Type.Object({}),
		execute: async () => {
			throw approval;
		},
	});
	await expect(manager.start(tool, {}, "call", "Needs approval", [], 1000, 10, undefined, context)).rejects.toBe(
		approval
	);
	expect(manager.list()).toEqual([]);
});

it("distinguishes an early receipt from the execution timeout and ignores late success", async () => {
	const { manager } = await setup();
	const { tool, work } = slowTool();
	const receipt = await manager.start(tool, { command: "timeout" }, "call", "Timeout", [], 0, 0.05, undefined, context);
	expect(receipt.details).toMatchObject({ backgroundTask: { status: "running" } });
	const completed = await manager.next(new AbortController().signal);
	expect(completed[0]?.task).toMatchObject({ status: "failed", preview: expect.stringContaining("execution timeout") });
	work.resolve(result("late success"));
	await new Promise((done) => setTimeout(done, 0));
	expect(manager.list()[0]?.status).toBe("failed");
});

it("bounds concurrent work and keeps results from different tasks", async () => {
	const { manager } = await setup();
	const { tool, work, calls } = slowTool();
	for (let index = 0; index < 8; index++)
		await manager.start(tool, { command: `check-${index}` }, `call-${index}`, "Check", [], 0, 10, undefined, context);
	await expect(
		manager.start(tool, { command: "overflow" }, "overflow", "Overflow", [], 0, 10, undefined, context)
	).rejects.toThrow("At most 8");
	expect(calls()).toBe(8);
	work.resolve(result("all done"));
	const completed = await manager.next(new AbortController().signal);
	expect(completed).toHaveLength(8);
	expect(new Set(completed.map(({ task }) => task.id)).size).toBe(8);
	await manager.consume(completed.map(({ task }) => task.id));
	expect(await manager.next(new AbortController().signal)).toEqual([]);
});

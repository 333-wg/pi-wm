import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ToolRecoveryMonitor } from "../src/tool-recovery.js";

const invoke = (tool: ToolDefinition, params = {}, signal?: AbortSignal) =>
	tool.execute("call", params, signal, undefined, undefined as unknown as Parameters<ToolDefinition["execute"]>[4]);
const success = { content: [{ type: "text" as const, text: "ok" }], details: {} };

describe("tool failure feedback", () => {
	it("blocks changed billable submissions after a provider failure, even after successful status inspection", async () => {
		let calls = 0;
		const monitor = new ToolRecoveryMonitor(true);
		const tool = monitor.wrap(
			defineTool({
				name: "generate_video",
				label: "video",
				description: "video",
				parameters: Type.Object({ prompt: Type.String() }),
				async execute() {
					calls++;
					throw Object.assign(new Error("HTTP 400 size must be 720P; do not retry"), {
						code: "media_submission_failed",
					});
				},
			})
		);
		await expect(invoke(tool, { prompt: "first" })).rejects.toMatchObject({ code: "media_submission_failed" });
		const statusTool = monitor.wrap(
			defineTool({
				name: "media_model_status",
				label: "status",
				description: "status",
				parameters: Type.Object({}),
				async execute() {
					return success;
				},
			})
		);
		expect((await invoke(statusTool)).details).toMatchObject({ wumingRecovery: { status: "diagnostic_succeeded" } });
		await expect(invoke(tool, { prompt: "different" })).rejects.toMatchObject({ code: "media_submission_blocked" });
		expect(calls).toBe(1);
		monitor.reset();
		await expect(invoke(tool, { prompt: "user-directed retry" })).rejects.toMatchObject({
			code: "media_submission_failed",
		});
		expect(calls).toBe(2);
	});
	it("allows correcting a validation error before any media submission", async () => {
		const tool = new ToolRecoveryMonitor().wrap(
			defineTool({
				name: "generate_video",
				label: "video",
				description: "video",
				parameters: Type.Object({ seconds: Type.Integer() }),
				async execute(_id, params) {
					if (params.seconds > 12) throw new Error("Invalid duration");
					return success;
				},
			})
		);
		await expect(invoke(tool, { seconds: 120 })).rejects.toThrow("Invalid duration");
		expect((await invoke(tool, { seconds: 8 })).content[0]).toMatchObject({ text: "ok" });
	});
	it("reminds about skill reassessment only when the capability is available", async () => {
		const definition = defineTool({
			name: "read_file",
			label: "read",
			description: "read",
			parameters: Type.Object({}),
			async execute() {
				throw new Error("ENOENT");
			},
		});
		await expect(invoke(new ToolRecoveryMonitor(true).wrap(definition))).rejects.toThrow("use skill_load");
		await expect(invoke(new ToolRecoveryMonitor().wrap(definition))).rejects.not.toThrow("use skill_load");
	});
	it("never retries internally and blocks a third identical failure", async () => {
		let calls = 0;
		const monitor = new ToolRecoveryMonitor();
		const tool = monitor.wrap(
			defineTool({
				name: "read_file",
				label: "read",
				description: "read",
				parameters: Type.Object({}),
				async execute() {
					calls++;
					throw new Error("ENOENT missing file");
				},
			})
		);
		await expect(invoke(tool)).rejects.toThrow("configuration, attempt 1");
		expect(calls).toBe(1);
		await expect(invoke(tool)).rejects.toThrow("attempt 2");
		await expect(invoke(tool)).rejects.toMatchObject({ code: "repeated_tool_failure" });
		expect(calls).toBe(2);
		monitor.reset();
		await expect(invoke(tool)).rejects.toThrow("attempt 1");
		expect(calls).toBe(3);
	});

	it("accepts changed input and emits observed recovery, not a task-completed claim", async () => {
		const monitor = new ToolRecoveryMonitor();
		const tool = monitor.wrap(
			defineTool({
				name: "read_file",
				label: "read",
				description: "read",
				parameters: Type.Object({ path: Type.String() }),
				async execute(_id, params) {
					if (params.path === "bad") throw new Error("ENOENT");
					return success;
				},
			})
		);
		await expect(invoke(tool, { path: "bad" })).rejects.toThrow();
		const result = await invoke(tool, { path: "actual" });
		expect(result.details).toMatchObject({
			wumingRecovery: { status: "changed_attempt_succeeded", previousTool: "read_file" },
		});
		expect(JSON.stringify(result.content)).toContain("does not prove");
	});

	it("preserves denied approvals and abort errors exactly", async () => {
		for (const error of [
			Object.assign(new Error("Explicit selection required"), { protocolCode: "forbidden" }),
			Object.assign(new Error("no"), { code: "approval_denied" }),
		]) {
			const tool = new ToolRecoveryMonitor().wrap(
				defineTool({
					name: "tool",
					label: "tool",
					description: "tool",
					parameters: Type.Object({}),
					async execute() {
						throw error;
					},
				})
			);
			await expect(invoke(tool)).rejects.toBe(error);
		}
	});

	it("counts nonzero process exits without losing original output", async () => {
		let calls = 0;
		const tool = new ToolRecoveryMonitor().wrap(
			defineTool({
				name: "exec",
				label: "exec",
				description: "exec",
				parameters: Type.Object({}),
				async execute() {
					calls++;
					return {
						content: [{ type: "text", text: "assertion failed" }],
						details: { exitCode: 1 },
					};
				},
			})
		);
		expect((await invoke(tool)).content[0]).toMatchObject({ text: "assertion failed" });
		expect((await invoke(tool)).details).toMatchObject({
			wumingRecovery: { status: "failed", attempts: 2 },
		});
		await expect(invoke(tool)).rejects.toMatchObject({ code: "repeated_tool_failure" });
		expect(calls).toBe(2);
	});
});

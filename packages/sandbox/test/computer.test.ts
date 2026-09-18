import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "@wuming/protocol";
import {
	WindowsComputerManager,
	runComputerProcess,
	type ComputerProcessRunner,
	type ComputerManagerOptions,
} from "../src/computer.js";
import { createComputerTools } from "../src/computer-tools.js";
import { ApprovalBroker } from "../src/approval.js";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { SemanticState } from "../src/computer-semantic.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9xkAAAAASUVORK5CYII=";
const window = { id: "42", pid: 123, title: "Test editor", process: "C:/test/editor.exe", bounds: [0, 0, 800, 600] };
const shot = {
	image: png,
	width: 800,
	height: 600,
	left: -1600,
	top: 0,
	screenWidth: 1600,
	screenHeight: 1200,
	monitor: 1,
	foreground: window,
	windows: [window],
};
const snapshot = {
	session: { id: "session-1", workspaceId: "workspace-1", phase: "turn", createdAt: 1, updatedAt: 1 },
	revision: 1,
	model: { provider: "test", id: "vision" },
	thinkingLevel: "off",
	sandboxMode: "workspace_write",
	approvalPolicy: "on_risk",
	transcript: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	pendingApprovals: [],
	usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
} as SessionSnapshot;
const noContext = undefined as unknown as Parameters<ToolDefinition["execute"]>[4];
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action();
});

async function setup(overrides: Partial<ComputerManagerOptions> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "wuming-computer-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const calls: Record<string, unknown>[] = [];
	const runner: ComputerProcessRunner = async (_file, _args, options) => {
		const input = JSON.parse(options.input ?? "{}") as Record<string, unknown>;
		calls.push(input);
		return JSON.stringify({
			ok: true,
			result: input.command === "probe" ? { ready: true } : input.command === "screenshot" ? shot : { performed: true },
		});
	};
	const manager = new WindowsComputerManager({ runtimeDirectory: directory, platform: "win32", runner, ...overrides });
	cleanup.push(() => manager[Symbol.asyncDispose]());
	await manager.refresh();
	return { manager, calls, directory, runner };
}

describe("Windows Computer Use", () => {
	it("does not revoke consent solely because global input ticks change between observations", async () => {
		let inputTick = 100;
		const { manager } = await setup({
			settingsAuthorization: true,
			runner: async (_file, _args, options) => {
				const request = JSON.parse(options.input!);
				return JSON.stringify({
					ok: true,
					result: request.command === "probe" ? { ready: true } : { ...shot, inputTick },
				});
			},
		});
		manager.setEnabled(true);
		await manager.withSession("s1", undefined, async (signal) => {
			const beforeConsent = await manager.screenshot(1, signal);
			manager.grantForegroundControl("s1", "op1", 5);
			expect(() => manager.resolveSnapshot(beforeConsent.id)).toThrow("stale");
			await manager.screenshot(1, signal);
		});
		expect(manager.hasForegroundControl("s1", "op1")).toBe(true);
		inputTick++;
		await manager.withSession("s1", undefined, (signal) => manager.screenshot(1, signal));
		expect(manager.hasForegroundControl("s1", "op1")).toBe(true);
	});

	it("executes WIN+D with real full-access authorization and no task-control prerequisite", async () => {
		const { manager, calls } = await setup({ settingsAuthorization: true });
		manager.setEnabled(true);
		const store = new SqliteOrchestratorStore(":memory:");
		cleanup.push(async () => store.close());
		const orchestrator = new SessionOrchestrator(store, { executeTurn: async () => ({ items: [] }) });
		const created = await orchestrator.createSession({
			principalId: "owner",
			idempotencyKey: "create",
			workspaceId: "w1",
			model: { provider: "fixture", id: "fixture" },
			thinkingLevel: "off",
			sandboxMode: "unrestricted",
			approvalPolicy: "never",
		});
		const broker = new ApprovalBroker({ store });
		const tools = createComputerTools(manager, {
			snapshot: { ...created.snapshot, sandboxMode: "workspace_write", approvalPolicy: "on_risk" },
			approvals: broker,
			operationScope: () => "op1",
		});
		const run = (name: string, input: Record<string, unknown>) =>
			tools.find((tool) => tool.name === name)!.execute(name, input, undefined, undefined, noContext);
		const before = await run("computer_screenshot", {});
		const after = await run("computer_action", {
			snapshot_id: (before.details as { id: string }).id,
			action: { kind: "key", key: "WIN+D" },
		});
		expect(after.details).toMatchObject({ performed: true });
		expect(calls.filter((request) => request.command === "action")).toHaveLength(1);
		expect(calls.find((request) => request.command === "action")).toMatchObject({ restoreFocus: false });
		await run("computer_control", { task: "Optional compatibility call" });
		expect(manager.hasForegroundControl(created.snapshot.session.id, "op1")).toBe(true);
		expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
	});

	it("opens only a fresh observed application ref and never exposes shortcut paths", async () => {
		let launches = 0;
		const { manager } = await setup({
			runner: async (_file, _args, options) => {
				const request = JSON.parse(options.input!);
				if (request.command === "applications")
					return JSON.stringify({
						ok: true,
						result: {
							apps: [{ name: "Fixture app", path: "C:/private/fixture.lnk", fingerprint: "digest" }],
							truncated: false,
						},
					});
				if (request.command === "open_application") {
					launches++;
					expect(request.application.path).toBe("C:/private/fixture.lnk");
					return JSON.stringify({ ok: true, result: { performed: true, outcome: "launch_requested" } });
				}
				return JSON.stringify({ ok: true, result: { ready: true } });
			},
		});
		manager.setEnabled(true);
		await manager.withSession("s1", undefined, async (signal) => {
			const inventory = await manager.listApplications(signal);
			expect(JSON.stringify(inventory)).not.toContain("private");
			expect(() => manager.resolveApplication("invented")).toThrow("stale");
			const ref = inventory.apps[0]!.ref;
			expect(await manager.openApplication(ref, signal)).toMatchObject({
				performed: true,
				outcome: "launch_requested",
			});
			expect(() => manager.resolveApplication(ref)).toThrow("stale");
		});
		expect(launches).toBe(1);
	});

	it("consumes uncertain semantic receipts even when they contain an observed control tree", async () => {
		const target = { id: "42", pid: 123, startedAt: "123", title: "Fixture", process: "fixture" };
		const state: SemanticState = {
			window: target,
			truncated: false,
			elements: [
				{
					ref: "fixture",
					runtimeId: [1],
					name: "Input",
					automationId: "Input",
					controlType: "ControlType.Edit",
					enabled: true,
					offscreen: false,
					actions: ["set_value"],
					depth: 1,
					value: "before",
				},
			],
		};
		let actions = 0;
		const { manager } = await setup({
			settingsAuthorization: true,
			semanticCall: async <T>(request: Record<string, unknown>) => {
				if (request.command === "windows") return { windows: [target] } as T;
				if (request.command === "inspect") return state as T;
				actions++;
				return { performed: true, outcome: "unknown", verified: false, state } as T;
			},
		});
		manager.setEnabled(true);
		await manager.withSession("s1", undefined, async (signal) => {
			manager.grantForegroundControl("s1", "op1", 5);
			await manager.listWindows(signal);
			const before = await manager.inspectWindow("42", signal);
			const after = await manager.semanticAction(before.id, before.elements[0]!.ref, "set_value", "after", signal);
			expect(after).toMatchObject({ performed: true, outcome: "unknown" });
			if (!("state" in after) || !after.state) throw new Error("Expected observation");
			expect(() => manager.resolveSemantic(after.state!.id, after.state!.elements[0]!.ref)).toThrow("stale");
		});
		expect(manager.hasForegroundControl("s1", "op1")).toBe(false);
		expect(actions).toBe(1);
	});

	it("uses task-scoped foreground consent, but still asks for consequential actions and new tasks", async () => {
		const { manager, calls } = await setup({ settingsAuthorization: true });
		manager.setEnabled(true);
		let scope = "operation-1:1";
		const authorize = vi.fn(async (request: { requireExplicitApproval?: boolean }) =>
			request.requireExplicitApproval ? { approvalId: "approved" } : undefined
		);
		const tools = createComputerTools(manager, {
			snapshot,
			operationScope: () => scope,
			approvals: { authorize, completeAuthorization: vi.fn() } as unknown as ApprovalBroker,
		});
		const tool = (name: string) => tools.find((item) => item.name === name)!;
		const run = (name: string, params: Record<string, unknown>) =>
			tool(name).execute(name, params, undefined, undefined, noContext);
		await run("computer_control", { task: "Fill local fixture", minutes: 2 });
		expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ requireExplicitApproval: true }));
		expect(manager.hasForegroundControl("session-1", scope)).toBe(true);
		expect(manager.hasForegroundControl("other-session", scope)).toBe(false);
		const initial = await run("computer_screenshot", {});
		const after = await run("computer_action", {
			snapshot_id: (initial.details as { id: string }).id,
			action: { kind: "type", text: "fixture" },
		});
		expect(authorize).toHaveBeenLastCalledWith(
			expect.objectContaining({ requireExplicitApproval: false, preauthorizedComputerUse: true })
		);
		expect(calls.find((call) => call.command === "action")).toMatchObject({ restoreFocus: false });
		expect(calls.at(-1)).toMatchObject({ command: "screenshot", settleMs: 1500 });
		const confirmed = await run("computer_action", {
			snapshot_id: (after.details as { id: string }).id,
			action: { kind: "key", key: "ENTER" },
			require_confirmation: true,
		});
		expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ requireExplicitApproval: true }));
		scope = "operation-2:1";
		await run("computer_action", {
			snapshot_id: (confirmed.details as { id: string }).id,
			action: { kind: "key", key: "TAB" },
		});
		expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ requireExplicitApproval: true }));
	});

	it.each(["expiry", "idle", "release", "stop", "failure"])("revokes continuous control on %s", async (cause) => {
		let now = 1000;
		const { manager } = await setup({ settingsAuthorization: true, clock: () => now });
		manager.setEnabled(true);
		await manager.withSession("s1", undefined, async () => {
			manager.grantForegroundControl("s1", "op1", 1);
		});
		expect(manager.hasForegroundControl("s1", "op1")).toBe(true);
		if (cause === "expiry") now += 60_001;
		if (cause === "idle") {
			now += 120_001;
			manager.status();
		}
		if (cause === "release") manager.release("s1");
		if (cause === "stop") manager.stop();
		if (cause === "failure")
			await expect(
				manager.withSession("s1", undefined, async () => {
					throw new Error("interrupted");
				})
			).rejects.toThrow();
		expect(manager.hasForegroundControl("s1", "op1")).toBe(false);
	});

	it.each(["denied", "task_changed", "no_task", "shared"])("never grants continuous control when %s", async (cause) => {
		const { manager, calls } = await setup({ settingsAuthorization: cause !== "shared" });
		manager.setEnabled(true);
		let scope: string | undefined = cause === "no_task" ? undefined : "op1";
		const authorize = vi.fn(async () => {
			if (cause === "denied") throw new Error("denied");
			if (cause === "task_changed") scope = "op2";
			return { approvalId: "approved" };
		});
		const tools = createComputerTools(manager, {
			snapshot,
			operationScope: () => scope,
			approvals: { authorize, completeAuthorization: vi.fn() } as unknown as ApprovalBroker,
		});
		await expect(
			tools
				.find((tool) => tool.name === "computer_control")!
				.execute("consent", { task: "fixture" }, undefined, undefined, noContext)
		).rejects.toThrow();
		expect(manager.hasForegroundControl("session-1", scope)).toBe(false);
		expect(calls.filter((call) => call.command === "action")).toHaveLength(0);
	});

	it.each(["timeout", "unknown", "not_started"])(
		"never replays %s input and revokes the task grant",
		async (outcome) => {
			let actions = 0;
			const { manager } = await setup({
				settingsAuthorization: true,
				runner: async (_file, _args, options) => {
					const request = JSON.parse(options.input!);
					if (request.command === "action") {
						actions++;
						if (outcome === "timeout") throw new Error("Transport timed out after input");
						return JSON.stringify({
							ok: true,
							result: { performed: outcome === "not_started" ? false : null, outcome },
						});
					}
					return JSON.stringify({ ok: true, result: request.command === "probe" ? { ready: true } : shot });
				},
			});
			manager.setEnabled(true);
			await manager.withSession("session-1", undefined, async () => {
				manager.grantForegroundControl("session-1", "op1", 5);
			});
			const tools = createComputerTools(manager, {
				snapshot,
				operationScope: () => "op1",
				approvals: { authorize: async () => undefined } as unknown as ApprovalBroker,
			});
			const initial = await tools[0]!.execute("shot", {}, undefined, undefined, noContext);
			const id = (initial.details as { id: string }).id;
			const result = await tools[1]!.execute(
				"input",
				{ snapshot_id: id, action: { kind: "key", key: "ENTER" } },
				undefined,
				undefined,
				noContext
			);
			expect(result.details).toMatchObject({
				performed: outcome === "not_started" ? false : null,
				outcome: outcome === "not_started" ? "not_started" : "unknown",
			});
			expect(manager.hasForegroundControl("session-1", "op1")).toBe(false);
			expect(() => manager.resolveSnapshot(id)).toThrow("stale");
			expect(actions).toBe(1);
		}
	);
	it.each([true, false])(
		"uses opaque refs, consumes semantic snapshots and escalates target activation=%s",
		async (targetActivated) => {
			const target = { id: "42", pid: 123, startedAt: "123456", title: "Test", process: "fixture" };
			const state: SemanticState = {
				window: target,
				truncated: false,
				elements: [
					{
						ref: "untrusted-helper-ref",
						runtimeId: [1, 2, 3],
						name: "Input",
						automationId: "Input",
						controlType: "ControlType.Edit",
						value: "before",
						valueFingerprint: "private-host-fingerprint",
						enabled: true,
						offscreen: false,
						actions: ["set_value"],
						depth: 1,
					},
				],
			};
			const requests: Record<string, unknown>[] = [];
			const { manager } = await setup({
				semanticCall: async <T>(request: Record<string, unknown>) => {
					requests.push(request);
					if (request.command === "windows") return { windows: [target] } as T;
					if (request.command === "inspect") return state as T;
					return {
						performed: true,
						foregroundChanged: true,
						targetActivated,
						cursorMoved: true,
						state: { ...state, elements: state.elements.map((element) => ({ ...element, value: request.value })) },
					} as T;
				},
			});
			manager.setEnabled(true);
			await manager.withSession("s1", undefined, (signal) => manager.listWindows(signal), "semantic");
			const before = await manager.withSession(
				"s1",
				undefined,
				(signal) => manager.inspectWindow("42", signal),
				"semantic"
			);
			expect(before.elements[0]!.ref).not.toBe("untrusted-helper-ref");
			expect(before.elements[0]).not.toHaveProperty("runtimeId");
			expect(before.elements[0]).not.toHaveProperty("valueFingerprint");
			expect(() => manager.resolveSemantic(before.id, "invented")).toThrow("reference");
			await expect(
				manager.semanticAction(before.id, before.elements[0]!.ref, "invoke", undefined, new AbortController().signal)
			).rejects.toThrow("does not support");
			expect(requests.filter((request) => request.command === "action")).toHaveLength(0);
			const after = await manager.withSession(
				"s1",
				undefined,
				(signal) => manager.semanticAction(before.id, before.elements[0]!.ref, "set_value", "after", signal),
				"semantic"
			);
			expect(after).toMatchObject({
				performed: true,
				state: { elements: [expect.objectContaining({ value: "after" })] },
			});
			expect(() => manager.resolveSemantic(before.id, before.elements[0]!.ref)).toThrow("stale");
			expect(requests.at(-1)).toMatchObject({ command: "action", window: target, element: { runtimeId: [1, 2, 3] } });
			const afterState = (after as { state: { id: string; elements: { ref: string }[] } }).state;
			expect(manager.semanticNeedsApproval(afterState.id, afterState.elements[0]!.ref)).toBe(targetActivated);
			manager.release("s1");
			await expect(manager.inspectWindow("42", new AbortController().signal)).rejects.toThrow("List windows");
		}
	);
	it("does not replay or fall back to pixels after an uncertain UIA action", async () => {
		const target = { id: "42", pid: 123, startedAt: "123456", title: "Test", process: "fixture" };
		const element = {
			ref: "1",
			runtimeId: [1],
			name: "Save",
			automationId: "Save",
			controlType: "Button",
			enabled: true,
			offscreen: false,
			actions: ["invoke"],
			depth: 1,
		};
		const requests: string[] = [];
		const { manager, calls } = await setup({
			semanticCall: async <T>(request: Record<string, unknown>) => {
				requests.push(String(request.command));
				if (request.command === "windows") return { windows: [target] } as T;
				if (request.command === "inspect") return { window: target, elements: [element], truncated: false } as T;
				throw new Error("helper timed out");
			},
		});
		manager.setEnabled(true);
		await manager.withSession("s1", undefined, (signal) => manager.listWindows(signal), "semantic");
		const state = await manager.withSession(
			"s1",
			undefined,
			(signal) => manager.inspectWindow("42", signal),
			"semantic"
		);
		const result = await manager.withSession(
			"s1",
			undefined,
			(signal) => manager.semanticAction(state.id, state.elements[0]!.ref, "invoke", undefined, signal),
			"semantic"
		);
		expect(result).toMatchObject({ performed: null, outcome: "unknown" });
		expect(requests).toEqual(["windows", "inspect", "action"]);
		expect(calls.map((call) => call.command)).toEqual(["probe"]);
		expect(() => manager.resolveSemantic(state.id, state.elements[0]!.ref)).toThrow("stale");
	});
	it("foreground fallback requires explicit approval even after Settings authorization", async () => {
		const { manager, calls } = await setup({ settingsAuthorization: true });
		manager.setEnabled(true);
		const authorize = vi.fn(async (request: { requireExplicitApproval: boolean }) => {
			if (request.requireExplicitApproval) throw new Error("foreground denied");
			return undefined;
		});
		const tools = createComputerTools(manager, { snapshot, approvals: { authorize } as unknown as ApprovalBroker });
		const shot = await tools[0]!.execute("shot", {}, undefined, undefined, noContext);
		await expect(
			tools[1]!.execute(
				"action",
				{ snapshot_id: (shot.details as { id: string }).id, action: { kind: "click", x: 2, y: 3 } },
				undefined,
				undefined,
				noContext
			)
		).rejects.toThrow("foreground denied");
		expect(authorize).toHaveBeenLastCalledWith(
			expect.objectContaining({ requireExplicitApproval: true, preauthorizedComputerUse: false })
		);
		expect(calls.map((call) => call.command)).toEqual(["probe", "screenshot"]);
	});
	it("discards an in-flight semantic read when stopped", async () => {
		let finish!: (result: unknown) => void;
		const { manager } = await setup({
			semanticCall: <T>() =>
				new Promise<T>((resolve) => {
					finish = resolve as (result: unknown) => void;
				}),
		});
		manager.setEnabled(true);
		const pending = manager.withSession("s1", undefined, (signal) => manager.listWindows(signal), "semantic");
		const rejected = expect(pending).rejects.toThrow();
		expect(manager.status().activity).toBe("semantic");
		manager.stop();
		finish({ windows: [] });
		await rejected;
		expect(manager.status()).toMatchObject({ enabled: false });
		expect(manager.status().activity).toBeUndefined();
	});
	it("restores a settings grant only after a successful probe; emergency stop persists off", async () => {
		const { manager, directory, runner } = await setup({ settingsAuthorization: true });
		manager.setEnabled(true);
		await manager[Symbol.asyncDispose]();
		const restored = new WindowsComputerManager({
			runtimeDirectory: directory,
			runner,
			platform: "win32",
			settingsAuthorization: true,
		});
		cleanup.push(() => restored[Symbol.asyncDispose]());
		expect(restored.status()).toMatchObject({ enabled: false, requestedEnabled: true });
		await restored.refresh();
		expect(restored.status()).toMatchObject({ enabled: true, authorization: "settings" });
		restored.stop();
		const stopped = new WindowsComputerManager({ runtimeDirectory: directory, runner, platform: "win32" });
		cleanup.push(() => stopped[Symbol.asyncDispose]());
		await stopped.refresh();
		expect(stopped.status()).toMatchObject({ enabled: false, requestedEnabled: false });
	});
	it.each([false, true])(
		"one-click setup installs dependencies and respects stopped=%s during installation",
		async (stopDuringInstall) => {
			let installed = false;
			let finishInstall!: () => void;
			const stages: string[] = [];
			const { manager } = await setup({
				runner: async (_file, args, options) => {
					if (options.input) {
						if (!installed) throw new Error("Missing dependencies");
						return JSON.stringify({ ok: true, result: { ready: true } });
					}
					if (args.includes("venv")) stages.push("venv");
					if (args.includes("pip")) {
						stages.push("pip");
						await new Promise<void>((resolve) => {
							finishInstall = resolve;
						});
						installed = true;
					}
					return "";
				},
			});
			expect(manager.setEnabled(true)).toMatchObject({ enabled: false, installing: true, requestedEnabled: true });
			await vi.waitFor(() => expect(manager.status().setupStage).toBe("installing_packages"));
			if (stopDuringInstall) manager.stop();
			finishInstall();
			await vi.waitFor(() => expect(manager.status().installing).toBe(false));
			expect(stages).toEqual(["venv", "pip"]);
			expect(manager.status()).toMatchObject({
				enabled: !stopDuringInstall,
				ready: true,
				requestedEnabled: !stopDuringInstall,
			});
		}
	);
	it("passes a settings grant to the broker only on explicitly configured local deployments", async () => {
		const { manager } = await setup({ settingsAuthorization: true });
		manager.setEnabled(true);
		const authorize = vi.fn(async () => undefined);
		const tools = createComputerTools(manager, { snapshot, approvals: { authorize } as unknown as ApprovalBroker });
		await tools[0]!.execute("capture", {}, undefined, undefined, noContext);
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({ requireExplicitApproval: false, preauthorizedComputerUse: true })
		);
	});
	it("rejects oversized input before persisting an invalid approval", async () => {
		const { manager, calls } = await setup();
		manager.setEnabled(true);
		const authorize = vi.fn(async () => undefined);
		const tools = createComputerTools(manager, { snapshot, approvals: { authorize } as unknown as ApprovalBroker });
		const captured = await tools[0]!.execute("shot", {}, undefined, undefined, noContext);
		await expect(
			tools[1]!.execute(
				"oversized",
				{ snapshot_id: (captured.details as { id: string }).id, action: { kind: "type", text: "x".repeat(2000) } },
				undefined,
				undefined,
				noContext
			)
		).rejects.toThrow("shorter operations");
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(calls.map((call) => call.command)).toEqual(["probe", "screenshot"]);
	});
	it("defaults off and rejects desktop calls before explicit enable", async () => {
		const { manager, calls } = await setup();
		expect(manager.status()).toMatchObject({ enabled: false, ready: true });
		await expect(manager.withSession("s1", undefined, (signal) => manager.screenshot(1, signal))).rejects.toThrow(
			"Settings"
		);
		expect(calls.map((call) => call.command)).toEqual(["probe"]);
	});
	it("rejects unsupported platforms and failed environment probes", async () => {
		const { manager } = await setup({ platform: "linux" });
		expect(manager.status()).toMatchObject({ supported: false, ready: false });
		expect(() => manager.setEnabled(true)).toThrow("not ready");
	});
	it("binds screenshot to one session, single-use IDs and bounded coordinates", async () => {
		const { manager, calls } = await setup();
		manager.setEnabled(true);
		const captured = await manager.withSession("s1", undefined, (signal) => manager.screenshot(1, signal));
		await expect(manager.withSession("s2", undefined, async () => {})).rejects.toThrow("holds control");
		await expect(
			manager.withSession("s1", undefined, (signal) =>
				manager.act(captured.id, { kind: "click", x: 800, y: 0 }, signal)
			)
		).rejects.toThrow("outside");
		const fresh = await manager.withSession("s1", undefined, (signal) => manager.screenshot(1, signal));
		await manager.withSession("s1", undefined, (signal) =>
			manager.act(fresh.id, { kind: "click", x: 20, y: 30 }, signal)
		);
		expect(calls.at(-1)).toMatchObject({ command: "action", snapshot: { foreground: window, left: -1600 } });
		expect((calls.at(-1)!.snapshot as Record<string, unknown>).image).toBeUndefined();
		expect(() => manager.resolveSnapshot(fresh.id)).toThrow("stale");
		manager.release("s1");
		await manager.withSession("s2", undefined, async () => {});
	});
	it("expires snapshots and releases idle session leases", async () => {
		let now = 10;
		const { manager } = await setup({ clock: () => now });
		manager.setEnabled(true);
		const captured = await manager.withSession("s1", undefined, (signal) => manager.screenshot(1, signal));
		now += 120_001;
		expect(() => manager.resolveSnapshot(captured.id)).toThrow("stale");
		await manager.withSession("s2", undefined, async () => {});
	});
	it("emergency stop aborts approvals and rejects pending or future input", async () => {
		const { manager } = await setup();
		manager.setEnabled(true);
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pending = manager.withSession(
			"s1",
			undefined,
			(signal) =>
				new Promise<void>((_resolve, reject) => {
					entered();
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				})
		);
		const rejected = expect(pending).rejects.toThrow("stopped");
		await started;
		manager.stop();
		expect(() => manager.setEnabled(true)).toThrow("stopping");
		await rejected;
		expect(manager.status()).toMatchObject({ enabled: false });
		await expect(manager.withSession("s1", undefined, async () => {})).rejects.toThrow("Settings");
	});
	it("does not expose a late screenshot after cancellation", async () => {
		let finish!: (value: string) => void;
		const { manager } = await setup({
			runner: async (_file, _args, options) => {
				if (JSON.parse(options.input!).command === "probe")
					return JSON.stringify({ ok: true, result: { ready: true } });
				return new Promise<string>((resolve) => {
					finish = resolve;
				});
			},
		});
		manager.setEnabled(true);
		const pending = manager.withSession("s1", undefined, (signal) => manager.screenshot(1, signal));
		const rejected = expect(pending).rejects.toThrow();
		manager.stop();
		finish(JSON.stringify({ ok: true, result: shot }));
		await rejected;
		expect(manager.status().ownerSessionId).toBeUndefined();
	});
	it("gates screenshots and actions, returns real images and screenshot artifacts", async () => {
		const { manager, calls } = await setup();
		manager.setEnabled(true);
		const authorize = vi.fn(async () => ({ approvalId: "a1" }));
		const completeAuthorization = vi.fn();
		const tools = createComputerTools(manager, {
			snapshot,
			approvals: { authorize, completeAuthorization } as unknown as ApprovalBroker,
			artifactWriter: async ({ name, content }) => ({
				id: "artifact-1",
				name,
				mimeType: "image/png",
				size: content.length,
			}),
		});
		const result = await tools[0]!.execute("shot", {}, undefined, undefined, noContext);
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				requireExplicitApproval: true,
				capabilities: [{ type: "computer.use", action: "screenshot" }],
			})
		);
		expect(result.content).toContainEqual({ type: "image", data: png, mimeType: "image/png" });
		expect(result.details).toMatchObject({ artifact: { id: "artifact-1" } });
		const id = (result.details as { id: string }).id;
		const after = await tools[1]!.execute(
			"click",
			{ snapshot_id: id, action: { kind: "click", x: 1, y: 2 } },
			undefined,
			undefined,
			noContext
		);
		expect(after.details).toMatchObject({ performed: true });
		expect(calls.map((call) => call.command)).toEqual(["probe", "screenshot", "action", "screenshot"]);
		expect(authorize).toHaveBeenLastCalledWith(
			expect.objectContaining({
				requireExplicitApproval: true,
				capabilities: [{ type: "computer.use", action: "input" }],
			})
		);
		expect(completeAuthorization).toHaveBeenCalledTimes(2);
	});
	it("never runs the helper after denied approval", async () => {
		const { manager, calls } = await setup();
		manager.setEnabled(true);
		const tools = createComputerTools(manager, {
			snapshot,
			approvals: {
				authorize: async () => {
					throw new Error("denied");
				},
			} as unknown as ApprovalBroker,
		});
		await expect(tools[0]!.execute("denied", {}, undefined, undefined, noContext)).rejects.toThrow("denied");
		expect(calls.map((call) => call.command)).toEqual(["probe"]);
		expect(manager.status().ownerSessionId).toBeUndefined();
	});
	it("reports sent input separately from failed observation, without retrying input", async () => {
		let screenshots = 0;
		let actions = 0;
		const { manager } = await setup({
			runner: async (_file, _args, options) => {
				const request = JSON.parse(options.input!);
				if (request.command === "action") actions++;
				if (request.command === "screenshot" && ++screenshots > 1) throw new Error("capture failed");
				return JSON.stringify({
					ok: true,
					result:
						request.command === "probe" ? { ready: true } : request.command === "action" ? { performed: true } : shot,
				});
			},
		});
		manager.setEnabled(true);
		const tools = createComputerTools(manager, {
			snapshot,
			approvals: { authorize: async () => undefined } as unknown as ApprovalBroker,
		});
		const initial = await tools[0]!.execute("shot", {}, undefined, undefined, noContext);
		const result = await tools[1]!.execute(
			"type",
			{ snapshot_id: (initial.details as { id: string }).id, action: { kind: "type", text: "test" } },
			undefined,
			undefined,
			noContext
		);
		expect(result.details).toMatchObject({ performed: true, observationFailed: true });
		expect(actions).toBe(1);
	});
	it("bounds process runtime and cancels before starting", async () => {
		await expect(
			runComputerProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 50 })
		).rejects.toThrow("timed out");
		const abort = new AbortController();
		abort.abort(new Error("cancelled before start"));
		await expect(
			runComputerProcess(process.execPath, ["-e", "throw new Error('must not run')"], {
				timeoutMs: 1000,
				signal: abort.signal,
			})
		).rejects.toThrow("cancelled before start");
	});
});

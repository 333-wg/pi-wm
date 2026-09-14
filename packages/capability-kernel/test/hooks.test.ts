import { describe, expect, it } from "vitest";
import {
	CapabilityRegistry,
	HookPipeline,
	type CapabilityManifest,
	type CapabilityPlan,
	type HookHandler,
} from "../src/index.js";

const context = {
	workspaceId: "workspace-1",
	sessionId: "session-1",
	turnId: "operation-1",
	model: { provider: "openai", id: "gpt" },
	sandboxMode: "workspace_write",
	approvalPolicy: "on_risk",
};

function hook(id: string, mode: "enforce" | "observe", priority = 0, timeoutMs = 100): CapabilityManifest {
	return {
		id,
		version: "1",
		kind: "hook",
		provider: "test",
		scope: "system",
		priority,
		hook: { points: ["operation.before_execute", "operation.on_error"], mode, timeoutMs },
	};
}

function plan(...manifests: CapabilityManifest[]): CapabilityPlan {
	const registry = new CapabilityRegistry();
	for (const manifest of manifests) registry.register(manifest);
	return registry.resolve(context);
}

function dispatch(pipeline: HookPipeline, capabilityPlan: CapabilityPlan, signal = new AbortController().signal) {
	return pipeline.dispatch({
		plan: capabilityPlan,
		point: "operation.before_execute",
		operationId: "operation-1",
		sessionId: "session-1",
		timestamp: 10,
		data: { mode: "prompt" },
		signal,
	});
}

describe("HookPipeline", () => {
	it("runs planned hooks sequentially in capability priority order with immutable input", async () => {
		const first = hook("hook:first", "observe", 10);
		const second = hook("hook:second", "enforce", 0);
		const seen: string[] = [];
		const handler =
			(id: string): HookHandler =>
			(invocation) => {
				seen.push(id);
				expect(Object.isFrozen(invocation)).toBe(true);
				expect(Object.isFrozen(invocation.data)).toBe(true);
				return { annotations: { checked: true } };
			};
		const pipeline = new HookPipeline();
		pipeline.register(first, handler("first"));
		pipeline.register(second, handler("second"));
		const result = await dispatch(pipeline, plan(second, first));
		expect(result.allowed).toBe(true);
		expect(seen).toEqual(["first", "second"]);
		expect(result.records.map((record) => record.outcome)).toEqual(["completed", "completed"]);
		expect(result.records[0]?.annotations).toEqual({ checked: true });
	});

	it("ignores observer denial and failure but stops on an enforcing denial", async () => {
		const observerDeny = hook("hook:observer-deny", "observe", 30);
		const observerFail = hook("hook:observer-fail", "observe", 20);
		const enforcement = hook("hook:enforce", "enforce", 10);
		const skipped = hook("hook:skipped", "observe", 0);
		const pipeline = new HookPipeline();
		pipeline.register(observerDeny, () => ({ decision: "deny", reason: "advisory only" }));
		pipeline.register(observerFail, () => {
			throw new Error("telemetry unavailable");
		});
		pipeline.register(enforcement, () => ({
			decision: "deny",
			code: "policy_block",
			reason: "policy rejected operation",
		}));
		pipeline.register(skipped, () => {
			throw new Error("must not run");
		});
		const result = await dispatch(pipeline, plan(observerDeny, observerFail, enforcement, skipped));
		expect(result.allowed).toBe(false);
		expect(result.records.map((record) => record.outcome)).toEqual(["denial_ignored", "failed", "denied"]);
		expect(result.denial).toEqual({
			hookId: "hook:enforce",
			code: "policy_block",
			reason: "policy rejected operation",
		});
	});

	it("fails closed on enforcing timeout, invalid output, missing registration, and version drift", async () => {
		const timeoutHook = hook("hook:timeout", "enforce", 0, 5);
		const timeoutPipeline = new HookPipeline();
		timeoutPipeline.register(timeoutHook, () => new Promise(() => {}));
		const timedOut = await dispatch(timeoutPipeline, plan(timeoutHook));
		expect(timedOut).toMatchObject({ allowed: false, denial: { code: "hook_timeout" } });
		expect(timedOut.records[0]?.outcome).toBe("timed_out");

		const invalid = hook("hook:invalid", "enforce");
		const invalidPipeline = new HookPipeline();
		invalidPipeline.register(invalid, () => ({ decision: "deny" }));
		expect(await dispatch(invalidPipeline, plan(invalid))).toMatchObject({
			allowed: false,
			denial: { code: "hook_invalid_result" },
		});

		const missing = hook("hook:missing", "observe");
		expect(await dispatch(new HookPipeline(), plan(missing))).toMatchObject({
			allowed: false,
			denial: { code: "hook_drift" },
		});

		const versioned = hook("hook:versioned", "enforce");
		const driftPipeline = new HookPipeline();
		driftPipeline.register({ ...versioned, version: "2" }, () => {});
		expect(await dispatch(driftPipeline, plan(versioned))).toMatchObject({
			allowed: false,
			denial: { code: "hook_drift" },
		});

		const contract = hook("hook:contract", "enforce", 0, 100);
		const contractPipeline = new HookPipeline();
		contractPipeline.register({ ...contract, hook: { ...contract.hook!, timeoutMs: 200 } }, () => {});
		expect(await dispatch(contractPipeline, plan(contract))).toMatchObject({
			allowed: false,
			denial: { code: "hook_drift" },
		});
	});

	it("supports reversible handler overrides and caller cancellation", async () => {
		const manifest = hook("hook:override", "enforce");
		const pipeline = new HookPipeline();
		pipeline.register(manifest, () => ({ decision: "deny", reason: "base" }));
		const override = pipeline.register(manifest, () => {});
		expect((await dispatch(pipeline, plan(manifest))).allowed).toBe(true);
		override.dispose();
		expect(await dispatch(pipeline, plan(manifest))).toMatchObject({
			allowed: false,
			denial: { reason: "base" },
		});

		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(dispatch(pipeline, plan(manifest), controller.signal)).rejects.toThrow("cancelled");
	});

	it("rejects tampered plans and dispatch context reuse", async () => {
		const manifest = hook("hook:bound", "enforce");
		const pipeline = new HookPipeline();
		pipeline.register({ ...manifest, dependencies: [] }, () => {});
		const capabilityPlan = plan(manifest);
		expect((await dispatch(pipeline, capabilityPlan)).allowed).toBe(true);
		await expect(
			dispatch(pipeline, {
				...capabilityPlan,
				context: { ...capabilityPlan.context, sessionId: "other" },
			})
		).rejects.toThrow("verifiable capability plan");
		await expect(
			pipeline.dispatch({
				plan: capabilityPlan,
				point: "operation.before_execute",
				operationId: "other-operation",
				sessionId: "session-1",
				timestamp: 10,
				signal: new AbortController().signal,
			})
		).rejects.toThrow("does not match");
	});
});

import { describe, expect, it } from "vitest";
import {
	CapabilityRegistry,
	verifyCapabilityPlan,
	type CapabilityManifest,
	type CapabilityResolutionContext,
} from "../src/index.js";

const context: CapabilityResolutionContext = {
	workspaceId: "workspace-1",
	sessionId: "session-1",
	turnId: "turn-1",
	model: { provider: "openai", id: "gpt" },
	sandboxMode: "workspace_write",
	approvalPolicy: "on_risk",
};

function tool(id: string, dependencies?: string[]): CapabilityManifest {
	return {
		id,
		version: "1",
		kind: "tool",
		provider: "test",
		scope: "session",
		...(dependencies ? { dependencies } : {}),
		permissions: [{ type: "filesystem.read" }],
		tool: { name: id.replace("tool:", ""), executionMode: "parallel", exposure: "direct" },
	};
}

describe("CapabilityRegistry", () => {
	it("builds deterministic, verifiable plans with dependencies and deduplicated permissions", () => {
		const registry = new CapabilityRegistry();
		registry.register({ ...tool("tool:read"), activation: "requested" });
		registry.register({
			...tool("tool:search", ["tool:read"]),
			activation: "requested",
			priority: 10,
		});
		const first = registry.resolve(context, { requested: ["tool:search"] });
		const second = registry.resolve({ ...context }, { requested: ["tool:search"] });
		expect(first).toEqual(second);
		expect(first.capabilities.map((capability) => capability.id)).toEqual(["tool:search", "tool:read"]);
		expect(first.modelVisible.tools).toEqual(["search", "read"]);
		expect(first.permissions).toEqual([{ type: "filesystem.read" }]);
		expect(verifyCapabilityPlan(first)).toBe(true);
		expect(Object.isFrozen(first.capabilities[0])).toBe(true);
	});

	it("supports scoped overrides that unwind on disposal", () => {
		const root = new CapabilityRegistry();
		root.register(tool("tool:read"));
		const scope = root.createScope();
		const override = scope.register({ ...tool("tool:read"), provider: "remote", version: "2" });
		expect(scope.resolve(context).capabilities[0]).toMatchObject({
			provider: "remote",
			version: "2",
		});
		override.dispose();
		expect(scope.resolve(context).capabilities[0]).toMatchObject({
			provider: "test",
			version: "1",
		});
	});

	it("rejects missing dependencies, cycles, conflicts, and denied requirements", () => {
		const missing = new CapabilityRegistry();
		missing.register(tool("tool:search", ["tool:read"]));
		expect(() => missing.resolve(context)).toThrow("not registered");

		const cyclic = new CapabilityRegistry();
		cyclic.register(tool("tool:a", ["tool:b"]));
		cyclic.register(tool("tool:b", ["tool:a"]));
		expect(() => cyclic.resolve(context)).toThrow("cycle");

		const conflicting = new CapabilityRegistry();
		conflicting.register({ ...tool("tool:a"), conflicts: ["tool:b"] });
		conflicting.register(tool("tool:b"));
		expect(() => conflicting.resolve(context)).toThrow("conflicts");
		expect(() => conflicting.resolve(context, { denied: ["tool:a"], requested: ["tool:a"] })).toThrow("denied");
	});

	it("uses predicates without serializing executable registration state", () => {
		const registry = new CapabilityRegistry();
		registry.register(tool("tool:write"), {
			when: (candidate) => candidate.sandboxMode !== "read_only",
		});
		expect(registry.resolve(context).modelVisible.tools).toEqual(["write"]);
		expect(registry.resolve({ ...context, sandboxMode: "read_only" }).modelVisible.tools).toEqual([]);
	});

	it("validates hook contracts as part of capability resolution", () => {
		const registry = new CapabilityRegistry();
		expect(() =>
			registry.register({
				id: "hook:missing",
				version: "1",
				kind: "hook",
				provider: "test",
				scope: "system",
			})
		).toThrow("missing its hook contract");
		expect(() =>
			registry.register({
				id: "hook:invalid-timeout",
				version: "1",
				kind: "hook",
				provider: "test",
				scope: "system",
				hook: { points: ["operation.before_execute"], mode: "enforce", timeoutMs: 0 },
			})
		).toThrow("invalid timeout");
		registry.register({
			id: "hook:policy",
			version: "1",
			kind: "hook",
			provider: "test",
			scope: "system",
			hook: { points: ["operation.before_execute"], mode: "enforce", timeoutMs: 100 },
		});
		expect(registry.resolve(context).capabilities[0]?.hook).toEqual({
			points: ["operation.before_execute"],
			mode: "enforce",
			timeoutMs: 100,
		});
	});
});

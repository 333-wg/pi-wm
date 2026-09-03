import { describe, expect, it } from "vitest";
import { isImplicitWorkspace } from "../src/lib/workspaces.js";

describe("implicit workspace", () => {
	it("keeps the gateway fallback out of the project presentation", () => {
		expect(isImplicitWorkspace({ id: "local-workspace" })).toBe(true);
		expect(isImplicitWorkspace({ id: "project-1" })).toBe(false);
		expect(isImplicitWorkspace(undefined)).toBe(false);
	});
});

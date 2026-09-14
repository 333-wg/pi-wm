import { describe, expect, it } from "vitest";
import type { WorkspaceSummary } from "@wuming/protocol";
import { isImplicitWorkspace, resolveNewChatWorkspace } from "../src/lib/workspaces.js";

function workspace(id: string): WorkspaceSummary {
	return {
		id,
		name: id,
		status: "ready",
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("implicit workspace", () => {
	it("keeps the gateway fallback out of the project presentation", () => {
		expect(isImplicitWorkspace({ id: "local-workspace" })).toBe(true);
		expect(isImplicitWorkspace({ id: "project-1" })).toBe(false);
		expect(isImplicitWorkspace(undefined)).toBe(false);
	});

	it("starts a new chat in the current project by default", () => {
		const workspaces = [workspace("local-workspace"), workspace("project-1"), workspace("project-2")];

		expect(resolveNewChatWorkspace(workspaces, "project-1")?.id).toBe("project-1");
		expect(resolveNewChatWorkspace(workspaces, "project-1", "project-2")?.id).toBe("project-2");
		expect(resolveNewChatWorkspace(workspaces, undefined)?.id).toBe("local-workspace");
	});
});

import { describe, expect, it } from "vitest";
import type { WorkspaceSummary } from "@wuming/protocol";
import {
	isImplicitWorkspace,
	resolveNewChatWorkspace,
	moveProject,
	orderProjects,
	readProjectOrder,
	writeProjectOrder,
	PROJECT_ORDER_STORAGE_KEY,
} from "../src/lib/workspaces.js";

function workspace(id: string): WorkspaceSummary {
	return {
		id,
		name: id,
		status: "ready",
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("project order", () => {
	it("moves in both directions without mutating or accepting unknown IDs", () => {
		const ids = ["a", "b", "c"];
		expect(moveProject(ids, "c", "a")).toEqual(["c", "a", "b"]);
		expect(moveProject(ids, "a", "c")).toEqual(["b", "c", "a"]);
		expect(moveProject(ids, "a", "a")).toEqual(ids);
		expect(moveProject(ids, "unknown", "a")).toEqual(ids);
		expect(moveProject(ids, "a", "unknown")).toEqual(ids);
		expect(ids).toEqual(["a", "b", "c"]);
	});

	it("restores order, ignores removed projects and appends new ones", () => {
		const projects = [workspace("local-workspace"), workspace("a"), workspace("b"), workspace("new")];
		expect(orderProjects(projects, ["deleted", "b", "a"]).map((item) => item.id)).toEqual(["b", "a", "new"]);
		expect(orderProjects(projects, []).map((item) => item.id)).toEqual(["a", "b", "new"]);
		expect(projects.map((item) => item.id)).toEqual(["local-workspace", "a", "b", "new"]);
	});

	it("round trips storage and tolerates invalid or unavailable storage", () => {
		let raw = "";
		const storage = {
			getItem: () => raw,
			setItem: (key: string, value: string) => {
				expect(key).toBe(PROJECT_ORDER_STORAGE_KEY);
				raw = value;
			},
		};
		expect(writeProjectOrder(storage, ["b", "a"])).toBe(true);
		expect(readProjectOrder(storage)).toEqual(["b", "a"]);
		for (const invalid of ["bad json", "null", "{}", "1"]) {
			raw = invalid;
			expect(readProjectOrder(storage)).toEqual([]);
		}
		raw = '["b", 1, "b", "a"]';
		expect(readProjectOrder(storage)).toEqual(["b", "a"]);
		expect(
			readProjectOrder({
				getItem() {
					throw new Error("blocked");
				},
			})
		).toEqual([]);
		expect(
			writeProjectOrder(
				{
					setItem() {
						throw new Error("quota");
					},
				},
				["a"]
			)
		).toBe(false);
	});
});

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

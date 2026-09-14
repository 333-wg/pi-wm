import { describe, expect, it } from "vitest";
import { recoveryAction, routeSkills } from "../src/skill-router.js";

const skills = [
	{
		id: "browser-research",
		workspaceId: "w",
		name: "Browser Research",
		description: "Search current web information and cite sources",
		path: "x",
		updatedAt: 0,
	},
	{
		id: "code-review",
		workspaceId: "w",
		name: "Code Review",
		description: "Review diffs, bugs, tests and regressions",
		path: "x",
		updatedAt: 0,
	},
];

describe("skill router", () => {
	it("routes only evidence-backed skills", () => {
		expect(routeSkills("review the diffs and check tests", skills).map((item) => item.skill.id)).toEqual([
			"code-review",
		]);
		expect(routeSkills("tell me something", skills)).toEqual([]);
	});
	it("requires a strategy change after the first retry", () => {
		expect(recoveryAction(1, true, true)).toBe("retry_same");
		expect(recoveryAction(2, true, true)).toBe("change_strategy");
		expect(recoveryAction(2, true, false)).toBe("ask_user");
		expect(recoveryAction(1, false, true)).toBe("ask_user");
	});
});

import { describe, expect, it } from "vitest";
import type { Trigger } from "../src/lib/suggest.js";
import {
	applyCompletion,
	cycleIndex,
	detectTrigger,
	quoteMention,
	rankBy,
	subsequenceScore,
} from "../src/lib/suggest.js";
import { skillItems } from "../src/components/ComposerSuggest.js";

// The composer's autocomplete is all in these primitives, so this is where the
// rules live: what counts as a trigger, which candidate wins, and what the
// textarea holds afterwards.

describe("detectTrigger", () => {
	it("searches Chinese slash aliases and inline skill mentions without treating prices as skills", () => {
		expect(detectTrigger("/调试", 3)).toMatchObject({ kind: "command", query: "调试" });
		expect(detectTrigger("请审查 $code-review", 16)).toMatchObject({
			kind: "skill",
			start: 4,
			query: "code-review",
		});
		expect(detectTrigger("US$30", 5)).toBeUndefined();
		expect(detectTrigger("$debug next", 11)).toBeUndefined();
	});
	it("opens as soon as the trigger character is typed", () => {
		expect(detectTrigger("@", 1)).toEqual({ kind: "file", start: 0, end: 1, query: "" });
		expect(detectTrigger("/", 1)).toEqual({ kind: "command", start: 0, end: 1, query: "" });
	});

	it("completes a slash command only when it is the whole prompt", () => {
		expect(detectTrigger("/ne", 3)).toEqual({ kind: "command", start: 0, end: 3, query: "ne" });
		// Prose that happens to contain a slash is prose.
		expect(detectTrigger("run /new", 8)).toBeUndefined();
		// So is a second line, however the first one started.
		expect(detectTrigger("/new\nmore", 9)).toBeUndefined();
		// And a name a command cannot have closes the menu instead of filtering.
		expect(detectTrigger("/new file", 9)).toBeUndefined();
	});

	it("only opens a mention where a word can start", () => {
		expect(detectTrigger("see @doc", 8)?.query).toBe("doc");
		expect(detectTrigger('("@doc', 6)?.query).toBe("doc");
		// An address is not a mention, which is the whole reason for the check.
		expect(detectTrigger("me@example.com", 14)).toBeUndefined();
	});

	it("ends a mention at a character a path cannot hold", () => {
		expect(detectTrigger("@src/a.ts", 9)?.query).toBe("src/a.ts");
		expect(detectTrigger("@a b", 4)).toBeUndefined();
		expect(detectTrigger("(@a)", 4)).toBeUndefined();
	});

	it("completes the mention the caret is in, not the last one typed", () => {
		expect(detectTrigger("@one @two", 9)).toEqual({ kind: "file", start: 5, end: 9, query: "two" });
		// The caret moved back over `dme`, so only `rea` is being completed.
		expect(detectTrigger("@readme", 4)).toEqual({ kind: "file", start: 0, end: 4, query: "rea" });
	});

	it("clamps a caret outside the text", () => {
		expect(detectTrigger("@a", 99)).toEqual({ kind: "file", start: 0, end: 2, query: "a" });
		expect(detectTrigger("@a", -3)).toBeUndefined();
	});
});

describe("skill candidates", () => {
	it("ranks skill names ahead of description matches and avoids scattered prose matches", () => {
		const base = { workspaceId: "w", path: "SKILL.md", updatedAt: 1 };
		const skills = [
			{ ...base, id: "run-app", name: "run-app", description: "启动项目" },
			{ ...base, id: "review", name: "项目审查", description: "检查变更" },
			{ ...base, id: "other", name: "other", description: "do examine broken user globals" },
		];
		expect(skillItems(skills, "项目").map((item) => item.skillId)).toEqual(["review", "run-app"]);
		expect(skillItems(skills, "debug")).toEqual([]);
	});
	it("matches descriptions and exposes provenance without hiding explicit-only skills", () => {
		const items = skillItems(
			[
				{
					id: "debug",
					workspaceId: "w",
					name: "debug",
					description: "排查报错",
					path: "SKILL.md",
					updatedAt: 1,
					source: "builtin",
				},
				{
					id: "manual",
					workspaceId: "w",
					name: "manual",
					description: "排查报错",
					path: "SKILL.md",
					updatedAt: 1,
					source: "user",
					allowImplicitInvocation: false,
				},
			],
			"报错"
		);
		expect(items.map(({ skillId, badge }) => ({ skillId, badge }))).toEqual([
			{ skillId: "debug", badge: "系统" },
			{ skillId: "manual", badge: "工作区 · 手动" },
		]);
		expect(items.every((item) => item.action === undefined)).toBe(true);
	});
});

describe("subsequenceScore", () => {
	it("takes the needle in order, ignoring case on both sides", () => {
		expect(subsequenceScore("anything", "")).toBe(0);
		expect(subsequenceScore("abc", "abd")).toBeUndefined();
		// A subsequence, not a subset: `ba` is both letters but the wrong way round.
		expect(subsequenceScore("abc", "ba")).toBeUndefined();
		expect(subsequenceScore("README.md", "rd")).toBe(30);
		expect(subsequenceScore("readme.md", "RD")).toBe(30);
	});

	it("rewards a boundary and a run, and charges for a skip", () => {
		// The same two letters, three placements: after a separator and adjacent,
		// mid-word and adjacent, then mid-word with a letter skipped between them.
		expect(subsequenceScore("a/bc", "bc")).toBe(40);
		expect(subsequenceScore("abc", "bc")).toBe(33);
		expect(subsequenceScore("abxc", "bc")).toBe(22);
		// A prefix hit collects both bonuses on every character.
		expect(subsequenceScore("md.txt", "md")).toBe(42);
		expect(subsequenceScore("readme.md", "md")).toBe(17);
	});

	it("caps what one skip can cost", () => {
		// Without the cap a hit deep in a long path would score below a shallow
		// miss and sort under it.
		expect(subsequenceScore(`${"x".repeat(40)}z`, "z")).toBe(2);
	});
});

describe("rankBy", () => {
	it("keeps the registry order among equal scores", () => {
		const items = ["alpha", "alpine", "alps"];
		expect(rankBy(items, "al", (item) => [item])).toEqual(items);
		// Nothing typed yet: everything shows, still in order.
		expect(rankBy(["b", "a"], "", (item) => [item])).toEqual(["b", "a"]);
	});

	it("scores an item by its best key", () => {
		// The first row matches through its alias only — a Chinese label with an
		// English alias is the case this exists for.
		const rows = [
			{ label: "打开设置", alias: "settings" },
			{ label: "st", alias: "" },
		];
		expect(rankBy(rows, "sett", (row) => [row.label, row.alias])).toEqual([rows[0]]);
	});

	it("drops what does not match and honours the limit", () => {
		expect(rankBy(["ab", "ba", "abc"], "ab", (item) => [item])).toEqual(["ab", "abc"]);
		expect(rankBy(["ab", "abc"], "ab", (item) => [item], 1)).toEqual(["ab"]);
	});
});

describe("quoteMention", () => {
	it("leaves a path that is already one token alone", () => {
		expect(quoteMention("src/a.ts")).toBe("src/a.ts");
	});

	it("wraps a path that would otherwise break apart", () => {
		expect(quoteMention("my notes.md")).toBe('"my notes.md"');
		expect(quoteMention('a"b.md')).toBe('"a\\"b.md"');
	});
});

describe("applyCompletion", () => {
	const mention: Trigger = { kind: "file", start: 4, end: 8, query: "rea" };

	it("replaces the token and leaves the caret past the trailing space", () => {
		expect(applyCompletion("see @rea", mention, "readme.md")).toEqual({
			text: "see @readme.md ",
			caret: 15,
		});
	});

	it("does not add a second space when the text already has one", () => {
		expect(applyCompletion("@a b", { kind: "file", start: 0, end: 2, query: "a" }, "abc")).toEqual({
			text: "@abc b",
			caret: 4,
		});
	});

	it("can leave the space out, for a command still waiting for an argument", () => {
		const slash: Trigger = { kind: "command", start: 0, end: 3, query: "co" };
		expect(applyCompletion("/co", slash, "compact", { trailing: false })).toEqual({
			text: "/compact",
			caret: 8,
		});
	});
});

describe("cycleIndex", () => {
	it("wraps at both ends", () => {
		expect(cycleIndex(0, 1, 3)).toBe(1);
		expect(cycleIndex(2, 1, 3)).toBe(0);
		expect(cycleIndex(0, -1, 3)).toBe(2);
	});

	it("stays put when there is nothing to cycle", () => {
		// `% 0` is NaN, which would reach the DOM as an invalid active descendant.
		expect(cycleIndex(0, -1, 0)).toBe(0);
	});
});

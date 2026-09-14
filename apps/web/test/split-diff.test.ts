import { expect, it } from "vitest";
import { parseUnifiedDiff, splitDiffRows } from "../src/lib/diff";

it("aligns replacements and pads unequal sides", () => {
	const { hunks } = parseUnifiedDiff("@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n same");
	const rows = splitDiffRows(hunks[0]!.lines);
	expect(rows.map((pair) => pair.map((line) => line?.text))).toEqual([
		["old", "new"],
		[undefined, "extra"],
		["same", "same"],
	]);
	expect(rows[2]![0]?.oldNumber).toBe(2);
	expect(rows[2]![1]?.newNumber).toBe(3);
});

it("does not include the next file metadata in a hunk", () => {
	const patch =
		"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b b/b\nnew file mode 100644\n--- /dev/null\n+++ b/b\n@@ -0,0 +1 @@\n+c";
	expect(parseUnifiedDiff(patch).hunks.map((hunk) => hunk.lines.length)).toEqual([2, 1]);
});

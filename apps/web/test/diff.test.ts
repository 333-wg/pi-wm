import { describe, expect, it } from "vitest";
import { collapseContext, countChanges, diffLines, parseUnifiedDiff } from "../src/lib/diff.js";

/** `count` numbered lines, the shape of a file long enough to matter. */
function body(count: number, label = "line"): string[] {
	return Array.from({ length: count }, (_, index) => `${label} ${index + 1}`);
}

/** A long file with exactly one line rewritten in the middle. */
function oneLineEdit(): { before: string; after: string } {
	const before = body(2000);
	const after = [...before];
	after[999] = "line 1000 edited";
	return { before: before.join("\n"), after: after.join("\n") };
}

describe("diffLines", () => {
	it("marks unchanged lines as context and pairs a replacement", () => {
		expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
			{ kind: "context", text: "a", oldNumber: 1, newNumber: 1 },
			{ kind: "del", text: "b", oldNumber: 2 },
			{ kind: "add", text: "B", newNumber: 2 },
			{ kind: "context", text: "c", oldNumber: 3, newNumber: 3 },
		]);
	});

	it("treats an empty side as a pure insertion or deletion", () => {
		expect(diffLines("", "a\nb")).toEqual([
			{ kind: "add", text: "a", newNumber: 1 },
			{ kind: "add", text: "b", newNumber: 2 },
		]);
		expect(diffLines("a\nb", "")).toEqual([
			{ kind: "del", text: "a", oldNumber: 1 },
			{ kind: "del", text: "b", oldNumber: 2 },
		]);
		expect(diffLines("", "")).toEqual([]);
	});

	it("reports an unchanged block as context only", () => {
		expect(countChanges(diffLines("a\nb", "a\nb"))).toEqual({ added: 0, removed: 0 });
	});

	it("keeps a one-line edit inside a long file to one line", () => {
		const { before, after } = oneLineEdit();
		const rows = diffLines(before, after);
		// Untrimmed, 2000 x 2000 cells exceed the table guard and every single line
		// comes back as replaced.
		expect(countChanges(rows)).toEqual({ added: 1, removed: 1 });
		expect(rows).toHaveLength(2001);
		expect(rows[998]).toEqual({
			kind: "context",
			text: "line 999",
			oldNumber: 999,
			newNumber: 999,
		});
		expect(rows[999]).toEqual({ kind: "del", text: "line 1000", oldNumber: 1000 });
		expect(rows[1000]).toEqual({ kind: "add", text: "line 1000 edited", newNumber: 1000 });
		expect(rows[1001]).toEqual({
			kind: "context",
			text: "line 1001",
			oldNumber: 1001,
			newNumber: 1001,
		});
		expect(rows[2000]).toEqual({
			kind: "context",
			text: "line 2000",
			oldNumber: 2000,
			newNumber: 2000,
		});
	});

	it("does not let the tail claim a line the head already took", () => {
		// Both edges match the same "x", so an unbounded tail would report this
		// deletion as two unchanged lines and lose the change entirely.
		expect(diffLines("x\nx", "x")).toEqual([
			{ kind: "context", text: "x", oldNumber: 1, newNumber: 1 },
			{ kind: "del", text: "x", oldNumber: 2 },
		]);
	});

	it("keeps a trailing newline aligned with the line it follows", () => {
		expect(diffLines("a\n", "a\nb\n")).toEqual([
			{ kind: "context", text: "a", oldNumber: 1, newNumber: 1 },
			{ kind: "add", text: "b", newNumber: 2 },
			{ kind: "context", text: "", oldNumber: 2, newNumber: 3 },
		]);
	});

	it("still degrades to a block replacement when the changed middle is huge", () => {
		const rows = diffLines(
			["head", ...body(600, "old"), "tail"].join("\n"),
			["head", ...body(600, "new"), "tail"].join("\n")
		);
		expect(countChanges(rows)).toEqual({ added: 600, removed: 600 });
		// Numbering stays anchored to the file, not to the trimmed middle.
		expect(rows[1]).toEqual({ kind: "del", text: "old 1", oldNumber: 2 });
		expect(rows[600]).toEqual({ kind: "del", text: "old 600", oldNumber: 601 });
		expect(rows[601]).toEqual({ kind: "add", text: "new 1", newNumber: 2 });
		expect(rows[1200]).toEqual({ kind: "add", text: "new 600", newNumber: 601 });
		expect(rows[1201]).toEqual({ kind: "context", text: "tail", oldNumber: 602, newNumber: 602 });
	});
});

describe("collapseContext", () => {
	it("hides the runs that are far from any change", () => {
		const { before, after } = oneLineEdit();
		const rows = collapseContext(diffLines(before, after));
		expect(rows).toHaveLength(10);
		expect(rows[0]).toEqual({ kind: "gap", hidden: 996 });
		expect(rows[9]).toEqual({ kind: "gap", hidden: 997 });
	});

	it("keeps the requested window on both sides of a change", () => {
		expect(collapseContext(diffLines("a\nb\nc\nd\ne\nf\ng\nh\ni", "a\nb\nc\nd\nE\nf\ng\nh\ni"), 1)).toEqual([
			{ kind: "gap", hidden: 3 },
			{ kind: "context", text: "d", oldNumber: 4, newNumber: 4 },
			{ kind: "del", text: "e", oldNumber: 5 },
			{ kind: "add", text: "E", newNumber: 5 },
			{ kind: "context", text: "f", oldNumber: 6, newNumber: 6 },
			{ kind: "gap", hidden: 3 },
		]);
	});
});

describe("countChanges", () => {
	it("counts both sides of a change and ignores context", () => {
		const counted = countChanges([
			{ kind: "context", text: "a", oldNumber: 1, newNumber: 1 },
			{ kind: "add", text: "b", newNumber: 2 },
			{ kind: "add", text: "c", newNumber: 3 },
			{ kind: "del", text: "d", oldNumber: 2 },
		]);
		expect(counted).toEqual({ added: 2, removed: 1 });
	});
});

const patch = [
	"diff --git a/app.ts b/app.ts",
	"index 1234567..89abcde 100644",
	"--- a/app.ts",
	"+++ b/app.ts",
	"@@ -1,4 +1,5 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 3;",
	"+const c = 4;",
	" const d = 5;",
	"@@ -20,2 +21,2 @@ function tail() {",
	"-old tail",
	"+new tail",
	"\\ No newline at end of file",
	"",
].join("\n");

describe("parseUnifiedDiff", () => {
	it("reads every hunk and numbers both sides from its header", () => {
		const parsed = parseUnifiedDiff(patch);
		expect(parsed.binary).toBe(false);
		expect(parsed.hunks).toHaveLength(2);
		expect(parsed.hunks[0]?.header).toBe("@@ -1,4 +1,5 @@");
		expect(parsed.hunks[0]?.lines).toEqual([
			{ kind: "context", text: "const a = 1;", oldNumber: 1, newNumber: 1 },
			{ kind: "del", text: "const b = 2;", oldNumber: 2 },
			{ kind: "add", text: "const b = 3;", newNumber: 2 },
			{ kind: "add", text: "const c = 4;", newNumber: 3 },
			{ kind: "context", text: "const d = 5;", oldNumber: 3, newNumber: 4 },
		]);
		expect(parsed.hunks[1]?.lines).toEqual([
			{ kind: "del", text: "old tail", oldNumber: 20 },
			{ kind: "add", text: "new tail", newNumber: 21 },
		]);
	});

	it("keeps the file header and the no-newline marker out of the hunks", () => {
		const texts = parseUnifiedDiff(patch).hunks.flatMap((hunk) => hunk.lines.map((line) => line.text));
		expect(texts.some((text) => text.includes("app.ts"))).toBe(false);
		expect(texts.some((text) => text.includes("No newline"))).toBe(false);
	});

	it("reports a binary patch instead of inventing lines for it", () => {
		expect(
			parseUnifiedDiff("diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n")
		).toEqual({ hunks: [], binary: true });
	});

	it("accepts a header without line counts and normalises CRLF", () => {
		expect(parseUnifiedDiff("@@ -7 +7 @@\r\n-was\r\n+now\r\n").hunks[0]?.lines).toEqual([
			{ kind: "del", text: "was", oldNumber: 7 },
			{ kind: "add", text: "now", newNumber: 7 },
		]);
	});
});

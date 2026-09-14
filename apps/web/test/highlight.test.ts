import { describe, expect, it } from "vitest";
import { highlight, resolveLanguage } from "../src/lib/highlight.js";

// The highlighter is one hand-written tokenizer plus two special modes, and it
// runs over every code block in a transcript. Two things matter: that it never
// eats a character, and that the handful of precedence rules it encodes — a
// comment marker before punctuation, a builtin before a call, the longest quote
// first — stay in that order.

/** Every token as `kind:value`, flattened across lines. */
function shape(code: string, lang: string): string[] {
	return highlight(code, lang)
		.flat()
		.map((token) => `${token.kind}:${token.value}`);
}

/** Only the tokens that carry a colour, so whitespace runs stay out of the way. */
function marked(code: string, lang: string): string[] {
	return shape(code, lang).filter((entry) => !entry.startsWith("plain:"));
}

describe("resolveLanguage", () => {
	it("normalises the fence's spelling and follows aliases", () => {
		expect(resolveLanguage("  .TSX ")).toBe("ts");
		expect(resolveLanguage("yml")).toBe("yaml");
	});

	it("hands back a language it has no alias for", () => {
		expect(resolveLanguage("python")).toBe("python");
		expect(resolveLanguage("")).toBe("");
	});
});

describe("losslessness", () => {
	// Every mode has to give back exactly what it was handed. A dropped character
	// is silent in the tokenizer and only shows up as code missing on screen, so
	// each mode gets a snippet with the things that tempt it: tabs, a CRLF, a
	// string that runs to the end of a line, unicode, a trailing newline.
	const snippets: [language: string, code: string][] = [
		["ts", "const a = `x${1}`; // done\n\tif (a) {}\r\n"],
		["python", "def f(x):\n\treturn '''a\nb''' # 注释\n"],
		["bash", "cat <<'EOF' | grep -i x\n$HOME/a b\nEOF\n"],
		["json", '{"a": [1, -2, {"b": null}], "c": "x\\ny"}'],
		["css", "@media (min-width: 40rem) {\n\t.a::after { content: 'x'; }\n}\n"],
		["yaml", "key: [1, 2] # c\n'quoted': |\n  text\n"],
		["sql", "SELECT a /* c\nc */ FROM t WHERE b = 'x''y';\n"],
		["go", "func main() {\n\tfmt.Println(`raw\nstring`)\n}\n"],
		["rust", "fn main() {\n\tlet v: Vec<i32> = vec![1];\n}\n"],
		["html", '<div class="a" data-x>\n\t<!-- c -->\n\ttext &amp; more\n</div>\n'],
		["diff", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n\n"],
		["cobol", "MOVE 1 TO X.\n\nEND.\r\n"],
	];
	for (const [language, code] of snippets) {
		it(`keeps every character of ${language}`, () => {
			const rebuilt = highlight(code, language)
				.map((line) => line.map((token) => token.value).join(""))
				.join("\n");
			expect(rebuilt).toBe(code);
		});
	}

	it("gives an empty block one empty line, whichever mode runs", () => {
		// The renderer maps over lines, so zero lines would blank the block and a
		// stray token would give it a phantom row.
		for (const language of ["ts", "html", "diff", "cobol"]) expect(highlight("", language)).toEqual([[]]);
	});
});

describe("the shared tokenizer", () => {
	it("tells a keyword, a call, a number and their punctuation apart", () => {
		expect(marked("const value = compute(2);", "ts")).toEqual([
			"keyword:const",
			"punct:=",
			"function:compute",
			"punct:(",
			"number:2",
			"punct:)",
			"punct:;",
		]);
	});

	it("prefers a builtin to a call, and reads a capital as a type", () => {
		// `Map` is both known and called, and `Key` is neither — it is a type only
		// because the grammar says a leading capital is one.
		expect(marked("const cache = new Map<Key>();", "ts")).toEqual([
			"keyword:const",
			"punct:=",
			"keyword:new",
			"builtin:Map",
			"punct:<",
			"builtin:Key",
			"punct:>",
			"punct:(",
			"punct:)",
			"punct:;",
		]);
	});

	it("marks a name a colon follows as a property, unless the colon is doubled", () => {
		expect(marked("{ name: 1 }", "ts")).toEqual(["punct:{", "property:name", "punct::", "number:1", "punct:}"]);
		// A selector is not a property: `::` has to fall through to plain.
		expect(shape("a::before", "css")).toEqual(["plain:a", "punct::", "punct::", "plain:before"]);
	});

	it("takes a number in each form it is written, and only where one can start", () => {
		expect(marked("0xFF 1_000 1.5e-3", "ts")).toEqual(["number:0xFF", "number:1_000", "number:1.5e-3"]);
		// `a1` is one name, not a name and a number.
		expect(shape("a1", "ts")).toEqual(["plain:a1"]);
	});

	it("reads a comment to the end of the line and a block to its terminator", () => {
		expect(marked('const a = "x"; // note', "ts")).toEqual([
			"keyword:const",
			"punct:=",
			'string:"x"',
			"punct:;",
			"comment:// note",
		]);
		expect(highlight("/* a\nb */ 1", "ts")).toEqual([
			[{ kind: "comment", value: "/* a" }],
			[
				{ kind: "comment", value: "b */" },
				{ kind: "plain", value: " " },
				{ kind: "number", value: "1" },
			],
		]);
		// An unterminated block takes the rest rather than falling back to punctuation.
		expect(marked("/* a", "ts")).toEqual(["comment:/* a"]);
	});

	it("checks a comment marker before punctuation that starts the same way", () => {
		// Both `-` characters are in the punctuation set, so order is what makes
		// this a comment.
		expect(marked("SELECT count(*) FROM t -- all", "sql")).toEqual([
			"keyword:SELECT",
			"builtin:count",
			"punct:(",
			"punct:*",
			"punct:)",
			"keyword:FROM",
			"comment:-- all",
		]);
	});

	it("keeps an escape inside a string and stops an unclosed one at the newline", () => {
		const escaped = '"a\\"b"';
		// The escaped quote does not end the string, so this is one token.
		expect(marked(escaped, "ts")).toEqual([`string:${escaped}`]);
		// A typo in one line must not paint the rest of the block as a string...
		expect(highlight("'oops\nnext", "ts")).toEqual([
			[{ kind: "string", value: "'oops" }],
			[{ kind: "plain", value: "next" }],
		]);
		// ...but a template literal is allowed to span lines.
		expect(highlight("`a\nb`", "ts")).toEqual([[{ kind: "string", value: "`a" }], [{ kind: "string", value: "b`" }]]);
	});

	it("tries the longest quote first", () => {
		// With `"` tried first this would be an empty string, a name, and so on for
		// the rest of the file.
		expect(marked('"""a "b" c"""', "python")).toEqual(['string:"""a "b" c"""']);
	});

	it("uses the grammar it was given, not one shared word list", () => {
		expect(marked("def run(self):", "python")).toEqual([
			"keyword:def",
			"function:run",
			"punct:(",
			"builtin:self",
			"punct:)",
			"punct::",
		]);
		expect(marked("git status # ok", "bash")).toEqual(["builtin:git", "comment:# ok"]);
		expect(marked('{"a": 1, "b": true}', "json")).toEqual([
			"punct:{",
			'string:"a"',
			"punct::",
			"number:1",
			"punct:,",
			'string:"b"',
			"punct::",
			"keyword:true",
			"punct:}",
		]);
		expect(marked(".card { color: red; }", "css")).toEqual([
			"punct:.",
			"punct:{",
			"property:color",
			"punct::",
			"punct:;",
			"punct:}",
		]);
	});
});

describe("markup", () => {
	it("splits a tag into its name, attributes and values", () => {
		expect(marked('<a href="x">text</a>', "html")).toEqual([
			"punct:<",
			"tag:a",
			"attr:href",
			"punct:=",
			'string:"x"',
			"punct:>",
			"punct:</",
			"tag:a",
			"punct:>",
		]);
	});

	it("leaves the text between tags alone", () => {
		expect(shape("<b>hi</b>", "html")).toEqual([
			"punct:<",
			"tag:b",
			"punct:>",
			"plain:hi",
			"punct:</",
			"tag:b",
			"punct:>",
		]);
	});

	it("keeps a self-closing tag and a comment in one piece", () => {
		expect(marked("<br/>", "html")).toEqual(["punct:<", "tag:br", "punct:/>"]);
		expect(marked("<!-- hi --><b>", "html")).toEqual(["comment:<!-- hi -->", "punct:<", "tag:b", "punct:>"]);
		// A tag or comment left open takes the rest instead of dropping it.
		expect(marked("<!-- hi", "html")).toEqual(["comment:<!-- hi"]);
		expect(marked("<div", "html")).toEqual(["punct:<", "tag:div"]);
	});
});

describe("diff", () => {
	it("scores each line by its marker, headers first", () => {
		const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n\nx";
		// `--- ` and `+++ ` are removals and additions by their first character, so
		// the header rule has to win before them.
		expect(highlight(patch, "diff").map((line) => line[0]?.kind)).toEqual([
			"meta",
			"meta",
			"meta",
			"removed",
			"added",
			"plain",
			undefined,
			"plain",
		]);
	});

	it("keeps the marker in the value and treats a patch as a diff", () => {
		expect(highlight("-a", "patch")).toEqual([[{ kind: "removed", value: "-a" }]]);
	});
});

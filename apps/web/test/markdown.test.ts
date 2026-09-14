import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown.js";
import type { BlockNode, InlineNode } from "../src/lib/markdown.js";
import { parseInline, parseMarkdown } from "../src/lib/markdown.js";

const text = (value: string): InlineNode => ({ type: "text", value });

/** The single block a source is expected to produce. */
function only(source: string): BlockNode {
	const blocks = parseMarkdown(source);
	expect(blocks).toHaveLength(1);
	return blocks[0] as BlockNode;
}

/** The href of the first link, or null when the source produced no link at all. */
function href(source: string): string | null {
	const link = parseInline(source).find((node) => node.type === "link");
	return link?.type === "link" ? link.href : null;
}

describe("inline text", () => {
	it("keeps plain text in one node", () => {
		expect(parseInline("just words")).toEqual([text("just words")]);
	});

	it("turns a newline into an explicit break", () => {
		expect(parseInline("a\nb")).toEqual([text("a"), { type: "break" }, text("b")]);
	});

	it("unescapes a backslashed punctuation mark and drops its emphasis", () => {
		expect(parseInline("\\*not em\\*")).toEqual([text("*not em*")]);
	});

	it("reads a code span and strips the one padding space each side", () => {
		expect(parseInline("a `code` b")).toEqual([text("a "), { type: "code", value: "code" }, text(" b")]);
		expect(parseInline("`` `x` ``")).toEqual([{ type: "code", value: "`x`" }]);
	});

	it("leaves an unclosed marker as literal text", () => {
		expect(parseInline("**unclosed")).toEqual([text("**unclosed")]);
		expect(parseInline("a ` b")).toEqual([text("a ` b")]);
	});
});

describe("inline emphasis", () => {
	it("reads single and double markers of both kinds", () => {
		expect(parseInline("*em*")).toEqual([{ type: "em", children: [text("em")] }]);
		expect(parseInline("_em_")).toEqual([{ type: "em", children: [text("em")] }]);
		expect(parseInline("**strong**")).toEqual([{ type: "strong", children: [text("strong")] }]);
		expect(parseInline("__strong__")).toEqual([{ type: "strong", children: [text("strong")] }]);
		expect(parseInline("~~gone~~")).toEqual([{ type: "del", children: [text("gone")] }]);
	});

	it("nests emphasis inside emphasis", () => {
		expect(parseInline("**bold `code`**")).toEqual([
			{ type: "strong", children: [text("bold "), { type: "code", value: "code" }] },
		]);
	});

	it("leaves an underscore inside a word alone", () => {
		// Identifiers arrive constantly in agent output; italicising half of
		// snake_case_name would be worse than not supporting `_` at all.
		expect(parseInline("snake_case_name")).toEqual([text("snake_case_name")]);
		expect(parseInline("a*b*c")).toEqual([text("a"), { type: "em", children: [text("b")] }, text("c")]);
	});

	it("does not open emphasis on whitespace", () => {
		expect(parseInline("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
		// The closer here is tight against `b`, so only the opener's own check
		// keeps this from becoming "a <em> b</em>".
		expect(parseInline("a * b*")).toEqual([text("a * b*")]);
	});
});

describe("links", () => {
	it("reads a labelled link and keeps inline markup in the label", () => {
		expect(parseInline("[the **docs**](https://example.com/a)")).toEqual([
			{
				type: "link",
				href: "https://example.com/a",
				children: [text("the "), { type: "strong", children: [text("docs")] }],
			},
		]);
	});

	it("keeps URLs and link syntax inside a link label as text", () => {
		expect(parseInline("[outer https://inner.example](https://outer.example)")).toEqual([
			{
				type: "link",
				href: "https://outer.example",
				children: [text("outer https://inner.example")],
			},
		]);
		expect(parseInline("[outer [inner](https://inner.example)](https://outer.example)")).toEqual([
			{
				type: "link",
				href: "https://outer.example",
				children: [text("outer [inner](https://inner.example)")],
			},
		]);
	});

	it("never renders an anchor inside another anchor", () => {
		const markup = renderToStaticMarkup(
			createElement(Markdown, {
				text: "[outer https://inner.example](https://outer.example)",
			})
		);

		expect(markup.match(/<a\b/g)).toHaveLength(1);
		expect(markup).toContain("outer https://inner.example");
	});

	it("drops a link title and angle brackets around the target", () => {
		expect(href('[x](https://example.com "title")')).toBe("https://example.com");
		expect(href("[x](<https://example.com>)")).toBe("https://example.com");
	});

	it("reads an autolink and leaves trailing punctuation outside it", () => {
		expect(parseInline("see https://example.com/x. done")).toEqual([
			text("see "),
			{ type: "link", href: "https://example.com/x", children: [text("https://example.com/x")] },
			text(". done"),
		]);
		expect(href("<mailto:dev@example.com>")).toBe("mailto:dev@example.com");
	});

	it("leaves an unmatched bracket as text", () => {
		expect(parseInline("see [the docs")).toEqual([text("see [the docs")]);
		expect(parseInline("[label] (not a link)")).toEqual([text("[label] (not a link)")]);
	});
});

describe("link safety", () => {
	it("accepts only the schemes the renderer can be trusted with", () => {
		expect(href("[x](https://example.com)")).toBe("https://example.com");
		expect(href("[x](http://example.com)")).toBe("http://example.com");
		expect(href("[x](mailto:dev@example.com)")).toBe("mailto:dev@example.com");
		expect(href("[x](#section)")).toBe("#section");
		expect(href("[x](/workspace/file.ts)")).toBe("/workspace/file.ts");
	});

	it("refuses a scripting scheme however it is dressed up", () => {
		expect(href("[x](javascript:alert(1))")).toBeNull();
		expect(href("[x](JavaScript:alert(1))")).toBeNull();
		expect(href("[x](vbscript:msgbox(1))")).toBeNull();
		expect(href("[x](data:text/html,<script>alert(1)</script>)")).toBeNull();
		// A leading control character is stripped by the browser but not by
		// `trim()`, so the scheme check has to see the raw string.
		expect(href("[x](javascript:alert(1))")).toBeNull();
	});

	it("refuses a protocol-relative target that only looks root-relative", () => {
		expect(href("[x](//evil.example/login)")).toBeNull();
		expect(href("[x](<//evil.example>)")).toBeNull();
	});

	it("never interprets raw HTML", () => {
		expect(parseInline("<script>alert(1)</script>")).toEqual([text("<script>alert(1)</script>")]);
		expect(parseInline('<img src=x onerror="alert(1)">')).toEqual([text('<img src=x onerror="alert(1)">')]);
	});
});

describe("headings, rules and paragraphs", () => {
	it("reads every heading level and drops the closing hashes", () => {
		expect(only("# Title")).toEqual({ type: "heading", level: 1, children: [text("Title")] });
		expect(only("###### Deep ###")).toEqual({
			type: "heading",
			level: 6,
			children: [text("Deep")],
		});
	});

	it("needs a space and at most six hashes to be a heading", () => {
		expect(only("#NoSpace")).toEqual({ type: "paragraph", children: [text("#NoSpace")] });
		expect(only("####### too deep")).toEqual({
			type: "paragraph",
			children: [text("####### too deep")],
		});
	});

	it("reads a thematic break, including the spaced form", () => {
		expect(only("---")).toEqual({ type: "hr" });
		expect(only("- - -")).toEqual({ type: "hr" });
		expect(only("___")).toEqual({ type: "hr" });
		expect(only("--")).toEqual({ type: "paragraph", children: [text("--")] });
	});

	it("joins the lines of a paragraph and stops at the next block", () => {
		expect(parseMarkdown("one\ntwo\n\n# next")).toEqual([
			{ type: "paragraph", children: [text("one"), { type: "break" }, text("two")] },
			{ type: "heading", level: 1, children: [text("next")] },
		]);
		expect(parseMarkdown("text\n# heading")).toHaveLength(2);
	});

	it("normalises CRLF before splitting lines", () => {
		expect(only("one\r\ntwo")).toEqual({
			type: "paragraph",
			children: [text("one"), { type: "break" }, text("two")],
		});
		// A paragraph trims each line, so the stray `\r` only survives where the
		// text is kept verbatim.
		expect(only("```\r\none\r\ntwo\r\n```")).toEqual({
			type: "code",
			lang: "",
			text: "one\ntwo",
			open: false,
		});
	});
});

describe("fenced code", () => {
	it("reads the language in lower case and the body verbatim", () => {
		expect(only("```TS\nconst a = 1;\n```")).toEqual({
			type: "code",
			lang: "ts",
			text: "const a = 1;",
			open: false,
		});
	});

	it("reports an unterminated fence as still open instead of swallowing the rest", () => {
		// This is the streaming case: the closing fence has not arrived yet.
		expect(only("```py\nprint(1)")).toEqual({
			type: "code",
			lang: "py",
			text: "print(1)",
			open: true,
		});
	});

	it("accepts tilde fences and strips the fence indentation from the body", () => {
		expect(only("~~~\nplain\n~~~")).toEqual({ type: "code", lang: "", text: "plain", open: false });
		expect(only("  ```\n  indented\n  ```")).toEqual({
			type: "code",
			lang: "",
			text: "indented",
			open: false,
		});
	});

	it("drops the blank lines a model leaves before the closing fence", () => {
		expect(only("```\nbody\n\n\n```")).toEqual({
			type: "code",
			lang: "",
			text: "body",
			open: false,
		});
	});

	it("keeps markdown inside a fence uninterpreted", () => {
		expect(only("```\n# not a heading\n- not a list\n```")).toEqual({
			type: "code",
			lang: "",
			text: "# not a heading\n- not a list",
			open: false,
		});
	});
});

describe("lists", () => {
	const item = (value: string): BlockNode[] => [{ type: "paragraph", children: [text(value)] }];

	it("reads a bullet list as tight items", () => {
		expect(only("- one\n- two")).toEqual({
			type: "list",
			ordered: false,
			start: 1,
			items: [item("one"), item("two")],
			tight: true,
		});
	});

	it("keeps the number an ordered list starts at", () => {
		expect(only("3. three\n4. four")).toMatchObject({ type: "list", ordered: true, start: 3 });
	});

	it("calls a list loose once a blank line separates its items", () => {
		expect(only("- one\n\n- two")).toMatchObject({
			type: "list",
			tight: false,
			items: [item("one"), item("two")],
		});
	});

	it("nests an indented list inside the item above it", () => {
		expect(only("- outer\n  - inner")).toMatchObject({
			type: "list",
			items: [
				[
					{ type: "paragraph", children: [text("outer")] },
					{ type: "list", items: [item("inner")] },
				],
			],
		});
	});

	it("starts a new list when the marker kind changes", () => {
		const blocks = parseMarkdown("- bullet\n1. ordered");
		expect(blocks).toHaveLength(2);
		expect(blocks.map((block) => block.type === "list" && block.ordered)).toEqual([false, true]);
	});
});

describe("quotes and tables", () => {
	it("parses the quoted lines as their own blocks", () => {
		expect(only("> quoted\n> more")).toEqual({
			type: "quote",
			children: [{ type: "paragraph", children: [text("quoted"), { type: "break" }, text("more")] }],
		});
		expect(only("> - listed")).toMatchObject({ type: "quote", children: [{ type: "list" }] });
	});

	it("reads a table with its per-column alignment", () => {
		expect(only("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |")).toEqual({
			type: "table",
			align: ["left", "center", "right"],
			head: [[text("a")], [text("b")], [text("c")]],
			rows: [[[text("1")], [text("2")], [text("3")]]],
		});
	});

	it("keeps an escaped pipe inside a cell", () => {
		expect(only("| a \\| b |\n| --- |")).toMatchObject({ head: [[text("a | b")]], rows: [] });
	});

	it("needs the delimiter row, so a lone pipe line stays a paragraph", () => {
		expect(only("| a | b |")).toMatchObject({ type: "paragraph" });
	});
});

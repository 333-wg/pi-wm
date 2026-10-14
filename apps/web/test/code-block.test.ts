import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock } from "../src/components/CodeBlock.js";
import { languageFromPath } from "../src/components/ToolCard.js";

describe("file code previews", () => {
	it.each([
		["src/main.TSX", "tsx"],
		["C:\\project\\main.cts", "ts"],
		["Dockerfile", "dockerfile"],
		["docker/Dockerfile.dev", "dockerfile"],
		["build/Makefile", "makefile"],
		["data.json", "json"],
		["unknown.xyz", ""],
	])("resolves %s without guessing from source text", (path, language) => {
		expect(languageFromPath(path)).toBe(language);
	});

	it("renders syntax, non-copyable line numbers and escaped source", () => {
		const html = renderToStaticMarkup(
			createElement(CodeBlock, {
				code: 'const tag = "<script>";\n// safe',
				lang: "ts",
				variant: "file",
			})
		);
		expect(html).toContain("code-block-file");
		expect(html).toContain('aria-label="文件预览字号"');
		expect(html).toContain('style="font-size:12.5px"');
		expect(html).toContain('class="tok tok-keyword">const</span>');
		expect(html).toContain('aria-hidden="true" data-line="2"');
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});

	it("keeps the transcript variant free of gutters", () => {
		const html = renderToStaticMarkup(createElement(CodeBlock, { code: "plain" }));
		expect(html).not.toContain("code-line-number");
		expect(html).not.toContain("code-block-file");
		expect(html).not.toContain("文件预览字号");
		expect(html).not.toContain("font-size:");
	});
});

// Dependency-free Markdown subset parser for assistant transcript rendering.
//
// It covers the constructs coding agents actually emit: ATX headings, fenced
// code, ordered/unordered nested lists, block quotes, GFM tables, thematic
// breaks, paragraphs, and inline emphasis/code/links. Raw HTML is never
// interpreted, and a link survives parsing only if it is http(s), mailto, a
// same-page anchor, or a root-relative path, so streamed model output cannot
// inject markup or dangerous URLs.
//
// Parsing is streaming-safe: an unterminated fence yields a code block with
// `open: true` instead of swallowing the remainder as plain text.

export type InlineNode =
	| { type: "text"; value: string }
	| { type: "code"; value: string }
	| { type: "strong"; children: InlineNode[] }
	| { type: "em"; children: InlineNode[] }
	| { type: "del"; children: InlineNode[] }
	| { type: "link"; href: string; children: InlineNode[] }
	| { type: "break" };

export type TableAlign = "left" | "center" | "right" | null;

export type BlockNode =
	| { type: "heading"; level: number; children: InlineNode[] }
	| { type: "paragraph"; children: InlineNode[] }
	| { type: "code"; lang: string; text: string; open: boolean }
	| { type: "list"; ordered: boolean; start: number; items: BlockNode[][]; tight: boolean }
	| { type: "quote"; children: BlockNode[] }
	| { type: "table"; align: TableAlign[]; head: InlineNode[][]; rows: InlineNode[][][] }
	| { type: "hr" };

const FENCE = /^(\s{0,3})(```+|~~~+)[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}> ?/;
const BULLET = /^(\s*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
// A leading `//` has to be excluded by hand: it reads as a relative path but
// browsers resolve it as a protocol-relative URL, so `[x](//evil.example)` would
// otherwise be a link off this origin that looks local in the source.
const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\/(?!\/))/i;

function pushText(nodes: InlineNode[], value: string): void {
	if (!value) return;
	const last = nodes[nodes.length - 1];
	if (last && last.type === "text") last.value += value;
	else nodes.push({ type: "text", value });
}

function findClosing(source: string, from: number, marker: string): number {
	if (from >= source.length || /\s/.test(source[from] ?? "")) return -1;
	let index = from;
	while (index < source.length) {
		if (source[index] === "\\") {
			index += 2;
			continue;
		}
		if (source.startsWith(marker, index)) {
			if (index === from) return -1;
			if (/\s/.test(source[index - 1] ?? "")) {
				index += marker.length;
				continue;
			}
			return index;
		}
		index += 1;
	}
	return -1;
}

function matchLink(source: string, start: number): { node: InlineNode; next: number } | null {
	let depth = 0;
	let index = start;
	for (; index < source.length; index += 1) {
		const char = source[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "[") depth += 1;
		else if (char === "]") {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	if (depth !== 0 || source[index + 1] !== "(") return null;
	let end = index + 2;
	let parens = 1;
	for (; end < source.length; end += 1) {
		const char = source[end];
		if (char === "\\") {
			end += 1;
			continue;
		}
		if (char === "(") parens += 1;
		else if (char === ")") {
			parens -= 1;
			if (parens === 0) break;
		}
	}
	if (parens !== 0) return null;
	const target = (source.slice(index + 2, end).trim().split(/\s+/)[0] ?? "").replace(/^<|>$/g, "");
	if (!SAFE_HREF.test(target)) return null;
	return { node: { type: "link", href: target, children: parseInline(source.slice(start + 1, index)) }, next: end + 1 };
}

export function parseInline(source: string): InlineNode[] {
	const nodes: InlineNode[] = [];
	let pending = "";
	let index = 0;
	const flush = () => {
		pushText(nodes, pending);
		pending = "";
	};
	while (index < source.length) {
		const char = source[index] as string;
		if (char === "\\" && /[\\`*_~[\]()>#+\-!|]/.test(source[index + 1] ?? "")) {
			pending += source[index + 1];
			index += 2;
			continue;
		}
		if (char === "\n") {
			flush();
			nodes.push({ type: "break" });
			index += 1;
			continue;
		}
		if (char === "`") {
			const run = /^`+/.exec(source.slice(index))?.[0] ?? "`";
			const close = source.indexOf(run, index + run.length);
			if (close > 0) {
				let value = source.slice(index + run.length, close);
				if (value.length > 2 && value.startsWith(" ") && value.endsWith(" ")) value = value.slice(1, -1);
				flush();
				nodes.push({ type: "code", value });
				index = close + run.length;
				continue;
			}
			pending += run;
			index += run.length;
			continue;
		}
		if (char === "~" && source.startsWith("~~", index)) {
			const end = findClosing(source, index + 2, "~~");
			if (end >= 0) {
				flush();
				nodes.push({ type: "del", children: parseInline(source.slice(index + 2, end)) });
				index = end + 2;
				continue;
			}
			pending += char;
			index += 1;
			continue;
		}
		if (char === "*" || char === "_") {
			const intraword = char === "_" && /[\w一-鿿]/.test(source[index - 1] ?? "");
			const doubled = source.startsWith(char + char, index);
			const marker = doubled ? char + char : char;
			const end = intraword ? -1 : findClosing(source, index + marker.length, marker);
			if (end >= 0) {
				flush();
				const children = parseInline(source.slice(index + marker.length, end));
				nodes.push(doubled ? { type: "strong", children } : { type: "em", children });
				index = end + marker.length;
				continue;
			}
			pending += char;
			index += 1;
			continue;
		}
		if (char === "[") {
			const link = matchLink(source, index);
			if (link) {
				flush();
				nodes.push(link.node);
				index = link.next;
				continue;
			}
			pending += char;
			index += 1;
			continue;
		}
		const autolink = /^(?:<((?:https?:\/\/|mailto:)[^>\s]+)>|(https?:\/\/[^\s<>()[\]]+))/.exec(source.slice(index));
		if (autolink && (char === "<" || char === "h")) {
			const raw = (autolink[1] ?? autolink[2] ?? "").replace(/[.,;:!?]+$/, "");
			flush();
			nodes.push({ type: "link", href: raw, children: [{ type: "text", value: raw }] });
			index += autolink[1] ? autolink[0].length : raw.length;
			continue;
		}
		pending += char;
		index += 1;
	}
	flush();
	return nodes;
}

function splitTableRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let current = "";
	for (let index = 0; index < trimmed.length; index += 1) {
		const char = trimmed[index];
		if (char === "\\") {
			current += trimmed[index + 1] ?? "";
			index += 1;
			continue;
		}
		if (char === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	cells.push(current.trim());
	return cells;
}

function isTableStart(line: string, next: string): boolean {
	return line.includes("|") && TABLE_DELIMITER.test(next) && next.includes("-");
}

function startsBlock(line: string, next: string): boolean {
	return (
		FENCE.test(line) ||
		HEADING.test(line) ||
		HR.test(line) ||
		QUOTE.test(line) ||
		BULLET.test(line) ||
		ORDERED.test(line) ||
		isTableStart(line, next)
	);
}

function alignOf(cell: string): TableAlign {
	const left = cell.startsWith(":");
	const right = cell.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	if (left) return "left";
	return null;
}

function readFence(lines: string[], start: number): { block: BlockNode; next: number } {
	const fence = FENCE.exec(lines[start] ?? "");
	const marker = fence?.[2] ?? "```";
	const indent = (fence?.[1] ?? "").length;
	const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},} *$`);
	const body: string[] = [];
	let cursor = start + 1;
	let closed = false;
	while (cursor < lines.length) {
		const candidate = lines[cursor] ?? "";
		cursor += 1;
		if (closing.test(candidate)) {
			closed = true;
			break;
		}
		body.push(indent > 0 ? candidate.replace(new RegExp(`^ {0,${indent}}`), "") : candidate);
	}
	while (body.length > 0 && !(body[body.length - 1] ?? "").trim()) body.pop();
	return {
		block: { type: "code", lang: (fence?.[3] ?? "").toLowerCase(), text: body.join("\n"), open: !closed },
		next: cursor,
	};
}

function readList(lines: string[], start: number): { block: BlockNode; next: number } {
	const first = BULLET.exec(lines[start] ?? "") ?? ORDERED.exec(lines[start] ?? "");
	const ordered = !BULLET.test(lines[start] ?? "");
	const baseIndent = (first?.[1] ?? "").length;
	const items: string[][] = [];
	let contentIndent = baseIndent + (first?.[2] ?? "").length + 1;
	let tight = true;
	let cursor = start;
	let pendingBlank = false;
	while (cursor < lines.length) {
		const line = lines[cursor] ?? "";
		if (!line.trim()) {
			const next = lines[cursor + 1] ?? "";
			const continues =
				next.trim().length > 0 &&
				((BULLET.test(next) || ORDERED.test(next)
					? (BULLET.exec(next) ?? ORDERED.exec(next))?.[1]?.length ?? 0
					: Number.POSITIVE_INFINITY) <= baseIndent ||
					(next.length - next.trimStart().length) > baseIndent);
			if (!continues) break;
			tight = false;
			pendingBlank = true;
			cursor += 1;
			continue;
		}
		const marker = BULLET.exec(line) ?? ORDERED.exec(line);
		const indent = line.length - line.trimStart().length;
		if (marker && (marker[1] ?? "").length <= baseIndent) {
			if (ordered !== !BULLET.test(line)) break;
			items.push([marker[3] ?? ""]);
			contentIndent = (marker[1] ?? "").length + (marker[2] ?? "").length + 1;
			pendingBlank = false;
			cursor += 1;
			continue;
		}
		if (items.length === 0 || indent <= baseIndent) break;
		const target = items[items.length - 1] as string[];
		if (pendingBlank) target.push("");
		pendingBlank = false;
		target.push(line.replace(new RegExp(`^ {0,${contentIndent}}`), ""));
		cursor += 1;
	}
	const start1 = ordered ? Number.parseInt(first?.[2] ?? "1", 10) : 1;
	return {
		block: { type: "list", ordered, start: Number.isFinite(start1) ? start1 : 1, items: items.map(parseBlocks), tight },
		next: cursor,
	};
}

function parseBlocks(lines: string[]): BlockNode[] {
	const blocks: BlockNode[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		const next = lines[index + 1] ?? "";
		if (!line.trim()) {
			index += 1;
			continue;
		}
		if (FENCE.test(line)) {
			const fence = readFence(lines, index);
			blocks.push(fence.block);
			index = fence.next;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			blocks.push({ type: "heading", level: (heading[1] ?? "#").length, children: parseInline(heading[2] ?? "") });
			index += 1;
			continue;
		}
		if (HR.test(line)) {
			blocks.push({ type: "hr" });
			index += 1;
			continue;
		}
		if (QUOTE.test(line)) {
			const body: string[] = [];
			while (index < lines.length && QUOTE.test(lines[index] ?? "")) {
				body.push((lines[index] ?? "").replace(QUOTE, ""));
				index += 1;
			}
			blocks.push({ type: "quote", children: parseBlocks(body) });
			continue;
		}
		if (BULLET.test(line) || ORDERED.test(line)) {
			const list = readList(lines, index);
			blocks.push(list.block);
			index = list.next;
			continue;
		}
		if (isTableStart(line, next)) {
			const align = splitTableRow(next).map(alignOf);
			const head = splitTableRow(line).map(parseInline);
			const rows: InlineNode[][][] = [];
			let cursor = index + 2;
			while (cursor < lines.length && (lines[cursor] ?? "").includes("|") && (lines[cursor] ?? "").trim()) {
				rows.push(splitTableRow(lines[cursor] ?? "").map(parseInline));
				cursor += 1;
			}
			blocks.push({ type: "table", align, head, rows });
			index = cursor;
			continue;
		}
		const buffer: string[] = [];
		while (index < lines.length) {
			const candidate = lines[index] ?? "";
			if (!candidate.trim()) break;
			if (buffer.length > 0 && startsBlock(candidate, lines[index + 1] ?? "")) break;
			buffer.push(candidate.trim());
			index += 1;
		}
		if (buffer.length === 0) index += 1;
		else blocks.push({ type: "paragraph", children: parseInline(buffer.join("\n")) });
	}
	return blocks;
}

export function parseMarkdown(source: string): BlockNode[] {
	return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

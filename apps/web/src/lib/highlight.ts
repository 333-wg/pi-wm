// Compact multi-language syntax highlighter.
//
// Coding transcripts are dominated by a handful of languages, so instead of
// pulling in a megabyte-scale grammar engine this module runs one small
// hand-written tokenizer over a per-language keyword/comment/string
// description, plus dedicated modes for markup and unified diffs. Output is
// token lines, which keeps the React renderer trivial and keeps every value
// escaped by React rather than by string concatenation.

export type TokenKind =
	| "plain"
	| "comment"
	| "string"
	| "number"
	| "keyword"
	| "builtin"
	| "function"
	| "property"
	| "punct"
	| "tag"
	| "attr"
	| "added"
	| "removed"
	| "meta";

export interface Token {
	kind: TokenKind;
	value: string;
}

interface Grammar {
	line: string[];
	block: [string, string] | null;
	quotes: string[];
	keywords: Set<string>;
	builtins: Set<string>;
	capitalIsType: boolean;
}

const words = (value: string) => new Set(value.split(/\s+/).filter(Boolean));

const grammars: Record<string, Grammar> = {
	ts: {
		line: ["//"],
		block: ["/*", "*/"],
		quotes: ['"', "'", "`"],
		keywords: words(`abstract as async await break case catch class const continue declare default delete do
			else enum export extends finally for from function get if implements import in infer instanceof interface
			keyof let new of private protected public readonly return satisfies set static super switch this throw try
			type typeof var void while yield`),
		builtins: words(`Array Boolean Date Error JSON Map Math Number Object Promise Record RegExp Set String Symbol
			any bigint boolean console document false globalThis never null number object string symbol true undefined
			unknown window`),
		capitalIsType: true,
	},
	python: {
		line: ["#"],
		block: null,
		quotes: ['"""', "'''", '"', "'"],
		keywords: words(`and as assert async await break class continue def del elif else except finally for from
			global if import in is lambda match nonlocal not or pass raise return try while with yield`),
		builtins: words(`False None True bool bytes dict enumerate float format int isinstance len list map open print
			range repr self set sorted str sum super tuple type zip`),
		capitalIsType: false,
	},
	bash: {
		line: ["#"],
		block: null,
		quotes: ['"', "'"],
		keywords: words(`case do done elif else esac export fi for function if in local return then time until while`),
		builtins: words(`awk cat cd chmod cp curl cut date docker echo env find git grep head jq kill ls mkdir mv node
			npm printf ps pwd python python3 rm rsync sed sh sort ssh sudo tail tar tee test touch tr uname wc which`),
		capitalIsType: false,
	},
	json: {
		line: [],
		block: null,
		quotes: ['"'],
		keywords: words("false null true"),
		builtins: new Set<string>(),
		capitalIsType: false,
	},
	css: {
		line: [],
		block: ["/*", "*/"],
		quotes: ['"', "'"],
		keywords: words(`and important media not only supports keyframes from to`),
		builtins: words(`absolute auto block center flex grid hidden inherit initial none relative solid transparent`),
		capitalIsType: false,
	},
	yaml: {
		line: ["#"],
		block: null,
		quotes: ['"', "'"],
		keywords: words("false no null off on true yes"),
		builtins: new Set<string>(),
		capitalIsType: false,
	},
	sql: {
		line: ["--"],
		block: ["/*", "*/"],
		quotes: ["'", '"'],
		keywords: words(`ALTER AND AS ASC BY CREATE DELETE DESC DISTINCT DROP FROM GROUP HAVING IN INDEX INNER INSERT
			INTO JOIN LEFT LIMIT NOT NULL ON OR ORDER OUTER SELECT SET TABLE UNION UPDATE VALUES WHERE`),
		builtins: words(`avg boolean count integer max min now sum text timestamp uuid varchar`),
		capitalIsType: false,
	},
	go: {
		line: ["//"],
		block: ["/*", "*/"],
		quotes: ['"', "`", "'"],
		keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import
			interface map package range return select struct switch type var`),
		builtins: words(`append bool byte cap close complex copy delete error float64 int int64 len make new nil panic
			print println recover rune string true false uint`),
		capitalIsType: false,
	},
	rust: {
		line: ["//"],
		block: ["/*", "*/"],
		quotes: ['"', "'"],
		keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop
			match mod move mut pub ref return self static struct super trait type unsafe use where while`),
		builtins: words(`bool char f64 i32 i64 Option Result String Vec bool false none some true u32 u64 usize`),
		capitalIsType: true,
	},
};

const aliases: Record<string, string> = {
	javascript: "ts",
	js: "ts",
	jsx: "ts",
	mjs: "ts",
	cjs: "ts",
	tsx: "ts",
	typescript: "ts",
	py: "python",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	console: "bash",
	powershell: "bash",
	ps1: "bash",
	yml: "yaml",
	postgres: "sql",
	psql: "sql",
	scss: "css",
	less: "css",
	golang: "go",
	rs: "rust",
	java: "ts",
	kotlin: "ts",
	swift: "ts",
	c: "ts",
	cpp: "ts",
	"c++": "ts",
	csharp: "ts",
	cs: "ts",
	php: "ts",
	ruby: "python",
	rb: "python",
	toml: "yaml",
	ini: "yaml",
	dockerfile: "bash",
	makefile: "bash",
};

const markupLanguages = new Set(["html", "xml", "svg", "vue", "htm"]);

function readString(code: string, start: number, quote: string): string {
	let index = start + quote.length;
	while (index < code.length) {
		if (code[index] === "\\") {
			index += 2;
			continue;
		}
		if (code.startsWith(quote, index)) return code.slice(start, index + quote.length);
		if (quote.length === 1 && quote !== "`" && code[index] === "\n") return code.slice(start, index);
		index += 1;
	}
	return code.slice(start);
}

function tokenize(code: string, grammar: Grammar): Token[] {
	const tokens: Token[] = [];
	let plain = "";
	let index = 0;
	const flush = () => {
		if (plain) {
			tokens.push({ kind: "plain", value: plain });
			plain = "";
		}
	};
	const push = (kind: TokenKind, value: string) => {
		flush();
		tokens.push({ kind, value });
		index += value.length;
	};
	while (index < code.length) {
		const rest = code.slice(index);
		if (grammar.block && rest.startsWith(grammar.block[0])) {
			const end = code.indexOf(grammar.block[1], index + grammar.block[0].length);
			push("comment", end < 0 ? rest : code.slice(index, end + grammar.block[1].length));
			continue;
		}
		const comment = grammar.line.find((prefix) => rest.startsWith(prefix));
		if (comment) {
			const newline = rest.indexOf("\n");
			push("comment", newline < 0 ? rest : rest.slice(0, newline));
			continue;
		}
		const quote = grammar.quotes.find((candidate) => rest.startsWith(candidate));
		if (quote) {
			push("string", readString(code, index, quote));
			continue;
		}
		const number = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(rest);
		if (number && !/[\w$]/.test(code[index - 1] ?? "")) {
			push("number", number[0]);
			continue;
		}
		const word = /^[A-Za-z_$@][\w$-]*/.exec(rest);
		if (word) {
			const value = word[0];
			const after = rest.slice(value.length);
			const kind: TokenKind = grammar.keywords.has(value)
				? "keyword"
				: grammar.builtins.has(value)
					? "builtin"
					: /^\s*\(/.test(after)
						? "function"
						: /^\s*:/.test(after) && !/^\s*::/.test(after)
							? "property"
							: grammar.capitalIsType && /^[A-Z]/.test(value)
								? "builtin"
								: "plain";
			push(kind, value);
			continue;
		}
		if (/^[{}()[\].,;:?!<>=+\-*/%&|^~]/.test(rest)) {
			push("punct", rest[0] as string);
			continue;
		}
		plain += code[index];
		index += 1;
	}
	flush();
	return tokens;
}

function tokenizeTag(raw: string): Token[] {
	const name = /^<\/?[A-Za-z][\w:.-]*/.exec(raw);
	if (!name) return [{ kind: "punct", value: raw }];
	const tokens: Token[] = [
		{ kind: "punct", value: raw.startsWith("</") ? "</" : "<" },
		{ kind: "tag", value: (name[0] ?? "").replace(/^<\/?/, "") },
	];
	const rest = raw.slice((name[0] ?? "").length);
	const attribute = /([A-Za-z_@:#$][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?/g;
	let cursor = 0;
	let match = attribute.exec(rest);
	while (match) {
		if (match.index > cursor) tokens.push({ kind: "plain", value: rest.slice(cursor, match.index) });
		tokens.push({ kind: "attr", value: match[1] ?? "" });
		tokens.push({ kind: "punct", value: match[2] ?? "" });
		if (match[3]) tokens.push({ kind: "string", value: match[3] });
		cursor = match.index + match[0].length;
		match = attribute.exec(rest);
	}
	if (cursor < rest.length) tokens.push({ kind: "punct", value: rest.slice(cursor) });
	return tokens;
}

function tokenizeMarkup(code: string): Token[] {
	const tokens: Token[] = [];
	let text = "";
	let index = 0;
	const flush = () => {
		if (text) {
			tokens.push({ kind: "plain", value: text });
			text = "";
		}
	};
	while (index < code.length) {
		const rest = code.slice(index);
		if (rest.startsWith("<!--")) {
			const end = code.indexOf("-->", index);
			const value = end < 0 ? rest : code.slice(index, end + 3);
			flush();
			tokens.push({ kind: "comment", value });
			index += value.length;
			continue;
		}
		if (code[index] === "<") {
			const close = code.indexOf(">", index);
			const raw = close < 0 ? rest : code.slice(index, close + 1);
			flush();
			tokens.push(...tokenizeTag(raw));
			index += raw.length;
			continue;
		}
		text += code[index];
		index += 1;
	}
	flush();
	return tokens;
}

function toLines(tokens: Token[]): Token[][] {
	const lines: Token[][] = [[]];
	for (const token of tokens) {
		const parts = token.value.split("\n");
		for (let position = 0; position < parts.length; position += 1) {
			if (position > 0) lines.push([]);
			const value = parts[position] ?? "";
			if (value) (lines[lines.length - 1] as Token[]).push({ kind: token.kind, value });
		}
	}
	return lines;
}

export function resolveLanguage(lang: string): string {
	const normalized = (lang || "").trim().toLowerCase().replace(/^\./, "");
	return aliases[normalized] ?? normalized;
}

export function highlight(code: string, lang: string): Token[][] {
	const language = resolveLanguage(lang);
	if (language === "diff" || language === "patch") {
		return code.split("\n").map((line) => {
			if (/^(?:diff |index |--- |\+\+\+ |@@)/.test(line)) return [{ kind: "meta" as TokenKind, value: line }];
			if (line.startsWith("+")) return [{ kind: "added" as TokenKind, value: line }];
			if (line.startsWith("-")) return [{ kind: "removed" as TokenKind, value: line }];
			return line ? [{ kind: "plain" as TokenKind, value: line }] : [];
		});
	}
	if (markupLanguages.has(language)) return toLines(tokenizeMarkup(code));
	const grammar = grammars[language];
	if (!grammar) return code.split("\n").map((line) => (line ? [{ kind: "plain" as TokenKind, value: line }] : []));
	return toLines(tokenize(code, grammar));
}

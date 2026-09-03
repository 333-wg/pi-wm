// Line diffing shared by the transcript edit cards and the Changes view.
//
// Edit blocks are small, so a straightforward LCS table gives minimal, readable
// diffs without a dependency. Oversized inputs degrade to a whole-block
// replacement instead of allocating a quadratic table.

export type DiffKind = "add" | "del" | "context";

export interface DiffLine {
	kind: DiffKind;
	text: string;
	oldNumber?: number;
	newNumber?: number;
}

export interface DiffGap {
	kind: "gap";
	hidden: number;
}

export type DiffRow = DiffLine | DiffGap;

const MAX_CELLS = 250_000;

export function diffLines(before: string, after: string): DiffLine[] {
	const a = before.length > 0 ? before.split("\n") : [];
	const b = after.length > 0 ? after.split("\n") : [];
	if (a.length * b.length > MAX_CELLS) {
		return [
			...a.map((text, index) => ({ kind: "del" as const, text, oldNumber: index + 1 })),
			...b.map((text, index) => ({ kind: "add" as const, text, newNumber: index + 1 })),
		];
	}
	const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			const row = table[i] as number[];
			const nextRow = table[i + 1] as number[];
			row[j] = a[i] === b[j] ? (nextRow[j + 1] as number) + 1 : Math.max(nextRow[j] as number, row[j + 1] as number);
		}
	}
	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			lines.push({ kind: "context", text: a[i] as string, oldNumber: i + 1, newNumber: j + 1 });
			i += 1;
			j += 1;
			continue;
		}
		const down = (table[i + 1] as number[])[j] as number;
		const right = (table[i] as number[])[j + 1] as number;
		if (down >= right) {
			lines.push({ kind: "del", text: a[i] as string, oldNumber: i + 1 });
			i += 1;
		} else {
			lines.push({ kind: "add", text: b[j] as string, newNumber: j + 1 });
			j += 1;
		}
	}
	while (i < a.length) {
		lines.push({ kind: "del", text: a[i] as string, oldNumber: i + 1 });
		i += 1;
	}
	while (j < b.length) {
		lines.push({ kind: "add", text: b[j] as string, newNumber: j + 1 });
		j += 1;
	}
	return lines;
}

export function collapseContext(lines: DiffLine[], context = 3): DiffRow[] {
	const keep = new Array<boolean>(lines.length).fill(false);
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]?.kind === "context") continue;
		for (let offset = Math.max(0, index - context); offset <= Math.min(lines.length - 1, index + context); offset += 1) {
			keep[offset] = true;
		}
	}
	const rows: DiffRow[] = [];
	let hidden = 0;
	for (let index = 0; index < lines.length; index += 1) {
		if (keep[index]) {
			if (hidden > 0) {
				rows.push({ kind: "gap", hidden });
				hidden = 0;
			}
			rows.push(lines[index] as DiffLine);
			continue;
		}
		hidden += 1;
	}
	if (hidden > 0) rows.push({ kind: "gap", hidden });
	return rows;
}

export function countChanges(lines: DiffLine[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.kind === "add") added += 1;
		else if (line.kind === "del") removed += 1;
	}
	return { added, removed };
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export interface ParsedDiff {
	hunks: DiffHunk[];
	binary: boolean;
}

export function parseUnifiedDiff(patch: string): ParsedDiff {
	const lines = patch.replace(/\r\n?/g, "\n").split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | undefined;
	let oldNumber = 0;
	let newNumber = 0;
	let binary = false;
	for (const raw of lines) {
		if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
			binary = true;
			continue;
		}
		const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
		if (header) {
			oldNumber = Number(header[1]);
			newNumber = Number(header[2]);
			current = { header: raw, lines: [] };
			hunks.push(current);
			continue;
		}
		if (!current || raw.startsWith("\\")) continue;
		if (raw.startsWith("+")) {
			current.lines.push({ kind: "add", text: raw.slice(1), newNumber });
			newNumber += 1;
			continue;
		}
		if (raw.startsWith("-")) {
			current.lines.push({ kind: "del", text: raw.slice(1), oldNumber });
			oldNumber += 1;
			continue;
		}
		current.lines.push({ kind: "context", text: raw.slice(1), oldNumber, newNumber });
		oldNumber += 1;
		newNumber += 1;
	}
	return { hunks, binary };
}

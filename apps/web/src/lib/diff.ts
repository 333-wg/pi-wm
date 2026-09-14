// Line diffing shared by the transcript edit cards and the Changes view.
//
// Edit blocks are small, so a straightforward LCS table gives minimal, readable
// diffs without a dependency. Identical lines at the top and bottom are trimmed
// before the table is built, which is what keeps a one-line change inside a long
// file readable: only the differing middle is quadratic, and that middle is
// almost always tiny even when the file is not. A middle that is still oversized
// degrades to a whole-block replacement rather than allocating the table.

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

/**
 * How many lines at the start and at the end are identical in both versions.
 *
 * Such lines can never be part of a change, so keeping them out of the table is
 * both cheaper and — because the size guard then only measures the middle — the
 * difference between a real diff and "the whole block was replaced".
 */
function commonEdges(a: readonly string[], b: readonly string[]): { head: number; tail: number } {
	const shortest = Math.min(a.length, b.length);
	let head = 0;
	while (head < shortest && a[head] === b[head]) head += 1;
	// The head already claimed its lines; a tail that walked back past them would
	// report the same line twice, which a run of repeated lines hits immediately.
	let tail = 0;
	while (tail < shortest - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
	return { head, tail };
}

export function diffLines(before: string, after: string): DiffLine[] {
	const a = before.length > 0 ? before.split("\n") : [];
	const b = after.length > 0 ? after.split("\n") : [];
	const { head, tail } = commonEdges(a, b);
	const lines: DiffLine[] = [];
	for (let index = 0; index < head; index += 1) {
		lines.push({
			kind: "context",
			text: a[index] as string,
			oldNumber: index + 1,
			newNumber: index + 1,
		});
	}
	for (const line of diffMiddle(a.slice(head, a.length - tail), b.slice(head, b.length - tail), head)) lines.push(line);
	for (let index = 0; index < tail; index += 1) {
		const oldIndex = a.length - tail + index;
		lines.push({
			kind: "context",
			text: a[oldIndex] as string,
			oldNumber: oldIndex + 1,
			newNumber: b.length - tail + index + 1,
		});
	}
	return lines;
}

/** Diffs whatever the identical edges left behind; `offset` is how many lines they took. */
function diffMiddle(a: readonly string[], b: readonly string[], offset: number): DiffLine[] {
	if (a.length * b.length > MAX_CELLS) {
		return [
			...a.map((text, index) => ({ kind: "del" as const, text, oldNumber: offset + index + 1 })),
			...b.map((text, index) => ({ kind: "add" as const, text, newNumber: offset + index + 1 })),
		];
	}
	const table: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			const row = table[i] as number[];
			const nextRow = table[i + 1] as number[];
			row[j] = a[i] === b[j] ? (nextRow[j + 1] as number) + 1 : Math.max(nextRow[j] as number, row[j + 1] as number);
		}
	}
	const rows: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			rows.push({
				kind: "context",
				text: a[i] as string,
				oldNumber: offset + i + 1,
				newNumber: offset + j + 1,
			});
			i += 1;
			j += 1;
			continue;
		}
		const down = (table[i + 1] as number[])[j] as number;
		const right = (table[i] as number[])[j + 1] as number;
		if (down >= right) {
			rows.push({ kind: "del", text: a[i] as string, oldNumber: offset + i + 1 });
			i += 1;
		} else {
			rows.push({ kind: "add", text: b[j] as string, newNumber: offset + j + 1 });
			j += 1;
		}
	}
	while (i < a.length) {
		rows.push({ kind: "del", text: a[i] as string, oldNumber: offset + i + 1 });
		i += 1;
	}
	while (j < b.length) {
		rows.push({ kind: "add", text: b[j] as string, newNumber: offset + j + 1 });
		j += 1;
	}
	return rows;
}

export function collapseContext(lines: DiffLine[], context = 3): DiffRow[] {
	const keep = Array.from({ length: lines.length }, () => false);
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]?.kind === "context") continue;
		for (
			let offset = Math.max(0, index - context);
			offset <= Math.min(lines.length - 1, index + context);
			offset += 1
		) {
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

export function splitDiffRows(lines: DiffLine[]): Array<[DiffLine | undefined, DiffLine | undefined]> {
	const rows: Array<[DiffLine | undefined, DiffLine | undefined]> = [];
	let removed: DiffLine[] = [];
	let added: DiffLine[] = [];
	const flush = () => {
		for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push([removed[i], added[i]]);
		removed = [];
		added = [];
	};
	for (const line of lines) {
		if (line.kind === "context") {
			flush();
			rows.push([line, line]);
		} else if (line.kind === "del") removed.push(line);
		else added.push(line);
	}
	flush();
	return rows;
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
		if (raw.startsWith("diff --git ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) {
			if (raw.startsWith("diff --git ")) current = undefined;
			if (!current) continue;
		}
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
		if (!raw.startsWith(" ")) continue;
		current.lines.push({ kind: "context", text: raw.slice(1), oldNumber, newNumber });
		oldNumber += 1;
		newNumber += 1;
	}
	return { hunks, binary };
}

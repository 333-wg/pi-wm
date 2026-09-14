import type { MemoryRecord, MemorySearchMatch, MemorySummary } from "@wuming/protocol";
import { trajectoryDigest } from "@wuming/trajectory";

export type MemoryDraft = Omit<MemorySummary, "digest">;

export function createDurableMemory(draft: MemoryDraft): MemorySummary {
	const summary = draft.summary.trim();
	if (!summary) throw new Error("Memory summary cannot be empty");
	if (summary.length > 20_000) throw new Error("Memory summary exceeds 20000 characters");
	const unsigned: MemoryDraft = { ...draft, summary };
	return Object.freeze({ ...unsigned, digest: trajectoryDigest(unsigned) });
}

export function verifyDurableMemory(memory: MemorySummary): boolean {
	try {
		const { digest, ...unsigned } = memory;
		return digest === trajectoryDigest(unsigned) && createDurableMemory(unsigned).digest === digest;
	} catch {
		return false;
	}
}

function queryTerms(query: string): string[] {
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) return [];
	const split = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
	const cjkBigrams = split.flatMap((chunk) => {
		if (
			!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(chunk) ||
			[...chunk].length < 2
		)
			return [];
		const characters = [...chunk];
		return characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`);
	});
	return [...new Set([normalized, ...split, ...cjkBigrams])].filter((term) => term.length > 0).slice(0, 20);
}

function occurrences(haystack: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (count < 20) {
		const index = haystack.indexOf(needle, offset);
		if (index < 0) break;
		count += 1;
		offset = index + Math.max(1, needle.length);
	}
	return count;
}

/** Deterministic lexical ranking for the small, session-local memory corpus. */
export function searchMemoryRecords(records: readonly MemoryRecord[], query: string, limit = 5): MemorySearchMatch[] {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const terms = queryTerms(query);
	if (!normalizedQuery || terms.length === 0) return [];
	return records
		.filter((record) => record.status === "active")
		.map((record): MemorySearchMatch | undefined => {
			const text = record.memory.summary.toLocaleLowerCase();
			const matchedTerms = terms.filter((term) => text.includes(term));
			if (matchedTerms.length === 0) return undefined;
			const exact = text.includes(normalizedQuery) ? 100 : 0;
			const frequency = matchedTerms.reduce((total, term) => total + Math.min(5, occurrences(text, term)), 0);
			const coverage = matchedTerms.length / terms.length;
			const retained = record.retention === "retained" ? 10 : 0;
			return { memory: record, score: exact + coverage * 50 + frequency + retained, matchedTerms };
		})
		.filter((match): match is MemorySearchMatch => match !== undefined)
		.sort(
			(left, right) =>
				right.score - left.score ||
				right.memory.memory.createdAt - left.memory.memory.createdAt ||
				left.memory.memory.id.localeCompare(right.memory.memory.id)
		)
		.slice(0, Math.max(1, Math.min(10, Math.trunc(limit))));
}

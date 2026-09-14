import type { MemoryRecord } from "@wuming/protocol";
import { createDurableMemory, searchMemoryRecords, verifyDurableMemory } from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("durable memory", () => {
	it("binds a compaction summary to its session source citation", () => {
		const memory = createDurableMemory({
			id: "memory-1",
			sessionId: "session-1",
			operationId: "operation-1",
			kind: "compaction",
			reason: "threshold",
			summary: " Keep the verified migration decision. ",
			source: { revision: 12, fromItemId: "item-1", throughItemId: "item-8" },
			tokensBefore: 9000,
			estimatedTokensAfter: 2400,
			createdAt: 100,
		});
		expect(memory.summary).toBe("Keep the verified migration decision.");
		expect(memory.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(verifyDurableMemory(memory)).toBe(true);
		expect(verifyDurableMemory({ ...memory, source: { ...memory.source, revision: 13 } })).toBe(false);
	});

	it("ranks active same-session records deterministically and ignores inactive ones", () => {
		const record = (
			id: string,
			summary: string,
			status: MemoryRecord["status"],
			retention: MemoryRecord["retention"],
			createdAt: number
		): MemoryRecord => ({
			memory: createDurableMemory({
				id,
				sessionId: "session-1",
				kind: "compaction",
				reason: "threshold",
				summary,
				source: { revision: createdAt },
				createdAt,
			}),
			status,
			retention,
			updatedAt: createdAt,
		});
		const matches = searchMemoryRecords(
			[
				record("memory-old", "Use SQLite for durable state.", "active", "retained", 1),
				record("memory-new", "The durable state migration uses SQLite transactions.", "active", "automatic", 2),
				record("memory-forgotten", "SQLite secret that must not return.", "forgotten", "automatic", 3),
			],
			"SQLite durable state",
			5
		);
		expect(matches.map((match) => match.memory.memory.id)).toEqual(["memory-old", "memory-new"]);
		expect(matches.every((match) => match.matchedTerms.includes("sqlite"))).toBe(true);
		const chinese = record("memory-cn", "已经确认数据库的迁移必须在事务中完成。", "active", "automatic", 4);
		expect(searchMemoryRecords([chinese], "数据库迁移", 5)[0]?.memory.memory.id).toBe("memory-cn");
	});
});

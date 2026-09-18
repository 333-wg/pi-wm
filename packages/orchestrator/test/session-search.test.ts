import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "@wuming/protocol";
import { SessionOrchestrator, SqliteOrchestratorStore } from "../src/index.js";

async function create(store: SqliteOrchestratorStore, workspaceId = "workspace") {
	const orchestrator = new SessionOrchestrator(store, {
		async executeTurn() {
			return { items: [] };
		},
	});
	const { snapshot } = await orchestrator.createSession({
		principalId: "test",
		idempotencyKey: crypto.randomUUID(),
		workspaceId,
		name: "Search test",
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		sandboxMode: "read_only",
		approvalPolicy: "never",
	});
	return { sessionId: snapshot.session.id, orchestrator };
}

function put(store: SqliteOrchestratorStore, sessionId: string, item: TranscriptItem) {
	const snapshot = store.loadSnapshot(sessionId)!;
	const transcript = [...snapshot.transcript.filter((entry) => entry.id !== item.id), item];
	store.commitMutation({
		sessionId,
		expectedRevision: snapshot.revision,
		snapshot: { ...snapshot, revision: snapshot.revision + 1, transcript },
		events: [
			{
				type: "session.item.upserted",
				eventId: crypto.randomUUID(),
				sessionId,
				timestamp: 1,
				revision: snapshot.revision + 1,
				item,
			},
		],
	});
}

function user(id: string, text: string): TranscriptItem {
	return { id, type: "user", createdAt: 1, content: [{ type: "text", text }] };
}

describe("chat content search", () => {
	it("excludes team execution contexts before search and list limits are applied", async () => {
		using store = new SqliteOrchestratorStore(":memory:");
		const chat = await create(store);
		const internal = await create(store);
		put(store, chat.sessionId, user("chat", "shared phrase"));
		put(store, internal.sessionId, user("team", "shared phrase"));
		const excludeSessionIds = [internal.sessionId, "' OR 1=1 --"];
		expect(store.listSnapshots("workspace", { limit: 1, excludeSessionIds }).map((item) => item.session.id)).toEqual([
			chat.sessionId,
		]);
		const result = store.searchSessions("workspace", { query: "shared", limit: 1, excludeSessionIds });
		expect(result.matches.map((item) => item.sessionId)).toEqual([chat.sessionId]);
		expect(result.truncated).toBe(false);
	});

	it("rolls the search projection back when the authoritative event commit fails", async () => {
		using store = new SqliteOrchestratorStore(":memory:");
		const { sessionId } = await create(store);
		put(store, sessionId, user("saved", "original"));
		const snapshot = store.loadSnapshot(sessionId)!;
		const item = user("rejected", "must-not-be-searchable");
		expect(() =>
			store.commitMutation({
				sessionId,
				expectedRevision: snapshot.revision,
				snapshot: { ...snapshot, revision: snapshot.revision + 1, transcript: [...snapshot.transcript, item] },
				events: [
					{
						type: "session.item.upserted",
						item,
						sessionId,
						revision: snapshot.revision + 1,
						timestamp: 1,
						eventId: store.loadEvents(sessionId)[0]!.eventId,
					},
				],
			})
		).toThrow();
		expect(store.loadSnapshot(sessionId)!.revision).toBe(snapshot.revision);
		expect(store.searchSessions("workspace", { query: "must-not-be-searchable" }).matches).toHaveLength(0);
		expect(store.searchSessions("workspace", { query: "original" }).matches).toHaveLength(1);
	});

	it("searches Chinese and literal punctuation, preserves highlight offsets and workspace boundaries", async () => {
		using store = new SqliteOrchestratorStore(":memory:");
		const { sessionId } = await create(store);
		put(store, sessionId, user("message", "😀".repeat(100) + "这里讨论 Search_100% 配置"));
		const other = await create(store, "other");
		put(store, other.sessionId, user("private", "Search_100% other workspace"));
		const { matches } = store.searchSessions("workspace", { query: "search_100%" });
		expect(matches).toHaveLength(1);
		expect(matches[0]!.snippet.slice(matches[0]!.highlightStart, matches[0]!.highlightEnd)).toBe("Search_100%");
		expect(store.searchSessions("workspace", { query: "这里讨论" }).matches).toHaveLength(1);
		expect(store.searchSessions("workspace", { query: "' OR 1=1 --" }).matches).toHaveLength(0);
		expect(store.searchSessions("workspace", { query: "  " }).matches).toHaveLength(0);
	});

	it("indexes settled visible text only and replaces previous content atomically", async () => {
		using store = new SqliteOrchestratorStore(":memory:");
		const { sessionId } = await create(store);
		const assistant: TranscriptItem = {
			id: "assistant",
			type: "assistant",
			createdAt: 2,
			status: "streaming",
			model: { provider: "test", id: "model" },
			content: [
				{ type: "text", text: "visible" },
				{ type: "thinking", text: "private-reasoning" },
			],
		};
		put(store, sessionId, assistant);
		put(store, sessionId, {
			id: "tool",
			type: "tool",
			createdAt: 3,
			toolCallId: "call",
			toolName: "read",
			status: "complete",
			input: {},
			isError: false,
			content: [{ type: "text", text: "private-tool" }],
		});
		expect(store.searchSessions("workspace", { query: "visible" }).matches).toHaveLength(0);
		put(store, sessionId, { ...assistant, status: "complete" });
		expect(store.searchSessions("workspace", { query: "visible" }).matches).toHaveLength(1);
		expect(store.searchSessions("workspace", { query: "private" }).matches).toHaveLength(0);
		put(store, sessionId, { ...assistant, status: "complete", content: [{ type: "text", text: "replacement" }] });
		expect(store.searchSessions("workspace", { query: "visible" }).matches).toHaveLength(0);
		expect(store.searchSessions("workspace", { query: "replacement" }).matches).toHaveLength(1);
	});

	it("bounds result counts and respects archive changes without reindexing", async () => {
		using store = new SqliteOrchestratorStore(":memory:");
		const { sessionId, orchestrator } = await create(store);
		for (let index = 0; index < 4; index++) put(store, sessionId, user(`message-${index}`, "needle"));
		expect(store.searchSessions("workspace", { query: "needle", limit: 2 })).toMatchObject({
			truncated: true,
			matches: [expect.anything(), expect.anything()],
		});
		await orchestrator.archiveSession({ principalId: "test", idempotencyKey: "archive", sessionId, archived: true });
		expect(store.searchSessions("workspace", { query: "needle" }).matches).toHaveLength(0);
		expect(store.searchSessions("workspace", { query: "needle", archived: true }).matches).toHaveLength(4);
	});

	it("rebuilds old databases and repairs revision drift after a downgrade", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-search-"));
		const path = join(directory, "state.db");
		try {
			let sessionId: string;
			{
				using store = new SqliteOrchestratorStore(path);
				({ sessionId } = await create(store));
				put(store, sessionId, user("message", "before-upgrade"));
			}
			{
				const db = new DatabaseSync(path);
				db.exec("DROP TABLE session_search_revisions; DROP TABLE session_search_messages;");
				db.close();
			}
			{
				using store = new SqliteOrchestratorStore(path);
				expect(store.searchSessions("workspace", { query: "before-upgrade" }).matches).toHaveLength(1);
			}
			{
				const db = new DatabaseSync(path);
				const row = db.prepare("SELECT snapshot_json FROM session_snapshots WHERE session_id = ?").get(sessionId);
				const snapshot = JSON.parse(String(row!.snapshot_json));
				snapshot.revision++;
				snapshot.transcript = [user("replacement", "after-downgrade")];
				db.prepare("UPDATE session_snapshots SET snapshot_json = ?, revision = ? WHERE session_id = ?").run(
					JSON.stringify(snapshot),
					snapshot.revision,
					sessionId
				);
				db.close();
			}
			using store = new SqliteOrchestratorStore(path);
			expect(store.searchSessions("workspace", { query: "before-upgrade" }).matches).toHaveLength(0);
			expect(store.searchSessions("workspace", { query: "after-downgrade" }).matches).toHaveLength(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

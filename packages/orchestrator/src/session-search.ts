import type { DatabaseSync } from "node:sqlite";
import type { SessionSearchMatch, SessionSnapshot, TranscriptItem } from "@wuming/protocol";

export interface SessionSearchOptions {
	query: string;
	archived?: boolean;
	limit?: number;
	excludeSessionIds?: readonly string[];
}

function searchableText(item: TranscriptItem): string {
	if (item.type === "tool" || (item.type === "assistant" && item.status === "streaming")) return "";
	return item.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

// ASCII folding preserves offsets, including Chinese and supplementary characters.
function fold(value: string): string {
	return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Rebuildable read projection; authoritative messages stay in session_snapshots. */
export class SessionSearchIndex {
	constructor(private readonly db: DatabaseSync) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS session_search_messages (
				session_id TEXT NOT NULL REFERENCES session_snapshots(session_id) ON DELETE CASCADE,
				message_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL,
				body TEXT NOT NULL, folded_body TEXT NOT NULL,
				PRIMARY KEY(session_id, message_id)
			);
			CREATE TABLE IF NOT EXISTS session_search_revisions (
				session_id TEXT PRIMARY KEY REFERENCES session_snapshots(session_id) ON DELETE CASCADE,
				revision INTEGER NOT NULL
			);
		`);
	}

	upsert(sessionId: string, item: TranscriptItem): void {
		const body = searchableText(item);
		if (!body) {
			this.db
				.prepare("DELETE FROM session_search_messages WHERE session_id = ? AND message_id = ?")
				.run(sessionId, item.id);
			return;
		}
		this.db
			.prepare(
				`INSERT INTO session_search_messages VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id, message_id) DO UPDATE SET
			role = excluded.role, created_at = excluded.created_at, body = excluded.body, folded_body = excluded.folded_body
			WHERE body != excluded.body OR role != excluded.role OR created_at != excluded.created_at`
			)
			.run(sessionId, item.id, item.type, item.createdAt, body, fold(body));
	}

	replace(snapshot: SessionSnapshot): void {
		this.db.prepare("DELETE FROM session_search_messages WHERE session_id = ?").run(snapshot.session.id);
		for (const item of snapshot.transcript) this.upsert(snapshot.session.id, item);
		this.markRevision(snapshot.session.id, snapshot.revision);
	}

	markRevision(sessionId: string, revision: number): void {
		this.db
			.prepare(
				`INSERT INTO session_search_revisions VALUES (?, ?)
			ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision`
			)
			.run(sessionId, revision);
	}

	search(workspaceId: string, options: SessionSearchOptions): { matches: SessionSearchMatch[]; truncated: boolean } {
		const query = fold(options.query.trim());
		if (!query || query.length > 200) return { matches: [], truncated: false };
		const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, Math.trunc(options.limit!))) : 30;
		const rows = this.db
			.prepare(
				`
			SELECT m.session_id, COALESCE(s.name, '') AS session_name, m.message_id, m.role, m.created_at, m.body
			FROM session_snapshots s JOIN session_search_messages m ON m.session_id = s.session_id
			WHERE s.workspace_id = ? AND s.parent_session_id IS NULL
			AND s.archived_at IS ${options.archived ? "NOT NULL" : "NULL"}
			AND instr(m.folded_body, ?) > 0
			AND s.session_id NOT IN (SELECT value FROM json_each(?))
			ORDER BY s.updated_at DESC, m.created_at DESC, m.session_id, m.message_id LIMIT ?
		`
			)
			.all(workspaceId, query, JSON.stringify(options.excludeSessionIds ?? []), limit + 1) as unknown as Array<{
			session_id: string;
			session_name: string;
			message_id: string;
			role: "user" | "assistant";
			created_at: number;
			body: string;
		}>;
		return {
			truncated: rows.length > limit,
			matches: rows.slice(0, limit).map((row) => {
				const at = fold(row.body).indexOf(query);
				let start = Math.max(0, at - 100);
				let end = Math.min(row.body.length, at + query.length + 160);
				if (start > 0 && /[\uDC00-\uDFFF]/.test(row.body[start]!)) start--;
				if (end < row.body.length && /[\uDC00-\uDFFF]/.test(row.body[end]!)) end++;
				const prefix = start > 0 ? "..." : "";
				return {
					sessionId: row.session_id,
					sessionName: row.session_name,
					messageId: row.message_id,
					role: row.role,
					createdAt: row.created_at,
					snippet: prefix + row.body.slice(start, end) + (end < row.body.length ? "..." : ""),
					highlightStart: prefix.length + at - start,
					highlightEnd: prefix.length + at - start + query.length,
				};
			}),
		};
	}
}

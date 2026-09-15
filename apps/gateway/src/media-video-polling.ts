import type { DatabaseSync } from "node:sqlite";

interface PollState {
	next_at: number;
	interval_ms: number;
	failures: number;
	lease_until: number;
	cooldown: number;
}

// Durable scheduling also prevents concurrent tool calls from multiplying provider queries.
export class VideoPollSchedule {
	constructor(
		private readonly db: DatabaseSync,
		private readonly baseMs = 30_000
	) {
		db.exec(`CREATE TABLE IF NOT EXISTS media_video_polling (
   job_id TEXT PRIMARY KEY, connection_hash TEXT NOT NULL, next_at INTEGER NOT NULL,
   interval_ms INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS media_video_cooldowns (connection_hash TEXT PRIMARY KEY, next_at INTEGER NOT NULL);`);
	}
	initialize(jobId: string, connection: string, now: number, submitted = false): void {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO media_video_polling (job_id, connection_hash, next_at, interval_ms) VALUES (?, ?, ?, ?)"
			)
			.run(jobId, connection, now + (submitted ? this.baseMs : 0), this.baseMs);
	}
	state(jobId: string): PollState {
		return this.db
			.prepare(
				`SELECT p.*, COALESCE(c.next_at, 0) AS cooldown FROM media_video_polling p
   LEFT JOIN media_video_cooldowns c ON c.connection_hash = p.connection_hash WHERE p.job_id = ?`
			)
			.get(jobId) as unknown as PollState;
	}
	nextAt(jobId: string): number {
		const state = this.state(jobId);
		return Math.max(state.next_at, state.lease_until, state.cooldown);
	}
	claim(jobId: string, now: number): boolean {
		return (
			this.db
				.prepare(
					`UPDATE media_video_polling SET lease_until = ?, next_at = ? + interval_ms
   WHERE job_id = ? AND next_at <= ? AND lease_until <= ?
   AND NOT EXISTS (SELECT 1 FROM media_video_cooldowns c WHERE c.connection_hash = media_video_polling.connection_hash AND c.next_at > ?)`
				)
				.run(now + 180_000, now, jobId, now, now, now).changes === 1
		);
	}
	pending(jobId: string, now: number): void {
		const interval = Math.min(Math.max(this.baseMs, 60_000), Math.ceil(this.state(jobId).interval_ms * 1.5));
		this.db
			.prepare("UPDATE media_video_polling SET next_at = ?, interval_ms = ?, failures = 0 WHERE job_id = ?")
			.run(now + interval, interval, jobId);
	}
	defer(jobId: string, now: number, retryAfterMs = 0, shared = false): void {
		const failures = this.state(jobId).failures;
		const interval = Math.min(300_000, this.baseMs * 2 ** Math.min(failures + 1, 20));
		const next = now + Math.max(interval, retryAfterMs);
		this.db
			.prepare("UPDATE media_video_polling SET next_at = ?, failures = failures + 1 WHERE job_id = ?")
			.run(next, jobId);
		if (shared)
			this.db
				.prepare(
					`INSERT INTO media_video_cooldowns (connection_hash, next_at)
   SELECT connection_hash, ? FROM media_video_polling WHERE job_id = ?
   ON CONFLICT(connection_hash) DO UPDATE SET next_at = MAX(next_at, excluded.next_at)`
				)
				.run(next, jobId);
	}
	release(jobId: string): void {
		this.db.prepare("UPDATE media_video_polling SET lease_until = 0 WHERE job_id = ?").run(jobId);
	}
}

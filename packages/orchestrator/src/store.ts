import { type SessionEvent, SessionEventSchema } from "@wuming/domain";
import {
	type CommandResult,
	CommandResultSchema,
	type SessionSnapshot,
	SessionSnapshotSchema,
} from "@wuming/protocol";
import { DatabaseSync } from "node:sqlite";
import { Compile } from "typebox/compile";
import { OrchestratorError } from "./errors.js";
import type { ApprovalExecutionMode, ApprovalExecutionState, DurableApprovalExecution, DurableGoal, DurableOperation, OperationPayload, OperationStatus, WriterLease } from "./types.js";

const checkEvent = Compile(SessionEventSchema);
const checkSnapshot = Compile(SessionSnapshotSchema);
const checkCommandResult = Compile(CommandResultSchema);

interface MutationIdempotency {
	principalId: string;
	key: string;
	commandHash: string;
	result: CommandResult;
	expiresAt: number;
}

export interface CommitMutationOptions {
	sessionId: string;
	expectedRevision: number;
	events: SessionEvent[];
	snapshot: SessionSnapshot;
	idempotency?: MutationIdempotency;
	operation?: DurableOperation;
	attachGoalRun?: {
		goalId: string;
		parentSessionId: string;
		runSessionId: string;
		expectedUpdatedAt: number;
		updatedAt: number;
	};
	settleOperation?: { id: string; status: "completed" | "failed" | "interrupted"; error?: string; usage?: DurableOperation["usage"]; tools?: DurableOperation["tools"]; failureKind?: DurableOperation["failureKind"]; retryHistory?: DurableOperation["retryHistory"] };
	retryOperation?: { id: string; error: string; retryAfter: number; retryHistory: NonNullable<DurableOperation["retryHistory"]>; usage?: DurableOperation["usage"]; tools?: DurableOperation["tools"]; failureKind?: DurableOperation["failureKind"] };
	approvalExecution?: DurableApprovalExecution;
	settleApprovalExecution?: { approvalId: string; state: "approved" | "cancelled" };
	lease?: WriterLease;
}

interface SessionRow {
	snapshot_json: string;
	revision: number;
}

interface IdempotencyRow {
	command_hash: string;
	result_json: string;
	expires_at: number;
}

interface OperationRow {
	operation_id: string;
	session_id: string;
	type: OperationPayload["type"];
	status: OperationStatus;
	payload_json: string;
	attempt: number;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	finished_at: number | null;
	abort_requested: number;
	trace_id: string | null;
	error: string | null;
	retry_after: number | null;
	usage_json: string | null;
	tools_json: string | null;
	failure_kind: NonNullable<DurableOperation["failureKind"]> | null;
	retry_history_json: string | null;
	approval_id: string | null;
	approval_tool_call_id: string | null;
}

interface ApprovalExecutionRow {
	approval_id: string;
	session_id: string;
	operation_id: string | null;
	tool_call_id: string;
	mode: ApprovalExecutionMode;
	state: ApprovalExecutionState;
	created_at: number;
	updated_at: number;
}

interface GoalRow {
	goal_id: string;
	parent_session_id: string;
	title: string;
	objective: string;
	run_session_id: string | null;
	created_at: number;
	updated_at: number;
	cancelled_at: number | null;
}

export interface CommitGoalMutationOptions {
	goal: DurableGoal;
	expectedUpdatedAt?: number;
	idempotency: MutationIdempotency;
}

export interface RequestOperationAbortOptions {
	principalId: string;
	idempotencyKey: string;
	commandHash: string;
	sessionId: string;
	result: CommandResult;
	now: number;
	expiresAt: number;
}

interface LeaseRow {
	session_id: string;
	owner_id: string;
	fence: number;
	expires_at: number;
}

export interface StoredSessionEvent {
	cursor: string;
	event: SessionEvent;
}

export interface ListSnapshotsOptions {
	query?: string;
	archived?: boolean;
	limit?: number;
}

function parseChecked<T>(json: string, check: { Check(value: unknown): boolean }, label: string): T {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new OrchestratorError("corrupt_storage", `${label} contains invalid JSON`);
	}

	if (!check.Check(value)) throw new OrchestratorError("corrupt_storage", `${label} does not match its schema`);
	return value as T;
}

function mapOperation(row: OperationRow): DurableOperation {
	return {
		id: row.operation_id,
		sessionId: row.session_id,
		type: row.type,
		status: row.status,
		payload: JSON.parse(row.payload_json) as OperationPayload,
		attempt: row.attempt,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.started_at === null ? {} : { startedAt: row.started_at }),
		...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
		abortRequested: row.abort_requested !== 0,
		...(row.trace_id === null ? {} : { traceId: row.trace_id }),
		...(row.retry_after === null ? {} : { retryAfter: row.retry_after }),
		...(row.error === null ? {} : { error: row.error }),
		...(row.usage_json === null ? {} : { usage: JSON.parse(row.usage_json) as NonNullable<DurableOperation["usage"]> }),
		...(row.tools_json === null ? {} : { tools: JSON.parse(row.tools_json) as NonNullable<DurableOperation["tools"]> }),
		...(row.failure_kind === null ? {} : { failureKind: row.failure_kind }),
		...(row.retry_history_json === null ? {} : { retryHistory: JSON.parse(row.retry_history_json) as NonNullable<DurableOperation["retryHistory"]> }),
		...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
		...(row.approval_tool_call_id === null ? {} : { approvalToolCallId: row.approval_tool_call_id }),
	};
}

function mapApprovalExecution(row: ApprovalExecutionRow): DurableApprovalExecution {
	return {
		approvalId: row.approval_id,
		sessionId: row.session_id,
		...(row.operation_id === null ? {} : { operationId: row.operation_id }),
		toolCallId: row.tool_call_id,
		mode: row.mode,
		state: row.state,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapGoal(row: GoalRow): DurableGoal {
	return {
		id: row.goal_id,
		parentSessionId: row.parent_session_id,
		title: row.title,
		objective: row.objective,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.run_session_id === null ? {} : { runSessionId: row.run_session_id }),
		...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
	};
}

export class SqliteOrchestratorStore implements Disposable {
	readonly #db: DatabaseSync;
	readonly #eventListeners = new Set<(event: StoredSessionEvent) => void>();

	constructor(path: string) {
		this.#db = new DatabaseSync(path);
		this.#db.exec("PRAGMA foreign_keys = ON");
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS session_snapshots (
				session_id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL,
				name TEXT,
				archived_at INTEGER,
				parent_session_id TEXT,
				revision INTEGER NOT NULL,
				snapshot_json TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_events (
				global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				event_id TEXT NOT NULL UNIQUE,
				event_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE (session_id, revision),
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS goals (
				goal_id TEXT PRIMARY KEY,
				parent_session_id TEXT NOT NULL,
				title TEXT NOT NULL,
				objective TEXT NOT NULL,
				run_session_id TEXT UNIQUE,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				cancelled_at INTEGER,
				FOREIGN KEY (parent_session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE,
				FOREIGN KEY (run_session_id) REFERENCES session_snapshots(session_id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS goals_parent ON goals(parent_session_id, updated_at DESC);
			CREATE TABLE IF NOT EXISTS idempotency_results (
				principal_id TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				command_hash TEXT NOT NULL,
				result_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				PRIMARY KEY (principal_id, idempotency_key)
			);
			CREATE TABLE IF NOT EXISTS operations (
				operation_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				type TEXT NOT NULL,
				status TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				abort_requested INTEGER NOT NULL DEFAULT 0,
				trace_id TEXT,
				error TEXT,
				retry_after INTEGER,
				usage_json TEXT,
				tools_json TEXT,
				failure_kind TEXT,
				retry_history_json TEXT,
				approval_id TEXT,
				approval_tool_call_id TEXT,
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS operations_queue ON operations(session_id, status, created_at);
			CREATE TABLE IF NOT EXISTS approval_executions (
				approval_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				operation_id TEXT,
				tool_call_id TEXT NOT NULL,
				mode TEXT NOT NULL,
				state TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE,
				FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS approval_executions_tool ON approval_executions(session_id, tool_call_id, state, created_at DESC);
			CREATE TABLE IF NOT EXISTS writer_leases (
				session_id TEXT PRIMARY KEY,
				owner_id TEXT NOT NULL,
				fence INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				FOREIGN KEY (session_id) REFERENCES session_snapshots(session_id) ON DELETE CASCADE
			);
		`);
		const sessionColumns = this.#db.prepare("PRAGMA table_info(session_snapshots)").all() as unknown as Array<{ name: string }>;
		let backfillSessionIndex = false;
		if (!sessionColumns.some((column) => column.name === "name")) {
			this.#db.exec("ALTER TABLE session_snapshots ADD COLUMN name TEXT");
			backfillSessionIndex = true;
		}
		if (!sessionColumns.some((column) => column.name === "archived_at")) {
			this.#db.exec("ALTER TABLE session_snapshots ADD COLUMN archived_at INTEGER");
			backfillSessionIndex = true;
		}
		if (!sessionColumns.some((column) => column.name === "parent_session_id")) {
			this.#db.exec("ALTER TABLE session_snapshots ADD COLUMN parent_session_id TEXT");
			backfillSessionIndex = true;
		}
		if (backfillSessionIndex) {
			const rows = this.#db.prepare("SELECT session_id, snapshot_json FROM session_snapshots").all() as unknown as Array<{ session_id: string; snapshot_json: string }>;
			const update = this.#db.prepare("UPDATE session_snapshots SET name = ?, archived_at = ?, parent_session_id = ? WHERE session_id = ?");
			for (const row of rows) {
				const snapshot = parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${row.session_id}`);
				update.run(snapshot.session.name ?? null, snapshot.session.archivedAt ?? null, snapshot.session.parentSessionId ?? null, row.session_id);
			}
		}
		this.#db.exec("CREATE INDEX IF NOT EXISTS session_snapshots_list ON session_snapshots(workspace_id, archived_at, updated_at DESC)");
		this.#db.exec("CREATE INDEX IF NOT EXISTS session_snapshots_parent ON session_snapshots(parent_session_id, updated_at DESC)");
		const operationColumns = this.#db.prepare("PRAGMA table_info(operations)").all() as unknown as Array<{ name: string }>;
		if (!operationColumns.some((column) => column.name === "abort_requested")) {
			this.#db.exec("ALTER TABLE operations ADD COLUMN abort_requested INTEGER NOT NULL DEFAULT 0");
		}
		if (!operationColumns.some((column) => column.name === "started_at")) {
			this.#db.exec("ALTER TABLE operations ADD COLUMN started_at INTEGER");
		}
		if (!operationColumns.some((column) => column.name === "finished_at")) {
			this.#db.exec("ALTER TABLE operations ADD COLUMN finished_at INTEGER");
		}
		if (!operationColumns.some((column) => column.name === "retry_after")) this.#db.exec("ALTER TABLE operations ADD COLUMN retry_after INTEGER");
		if (!operationColumns.some((column) => column.name === "usage_json")) this.#db.exec("ALTER TABLE operations ADD COLUMN usage_json TEXT");
		if (!operationColumns.some((column) => column.name === "tools_json")) this.#db.exec("ALTER TABLE operations ADD COLUMN tools_json TEXT");
		if (!operationColumns.some((column) => column.name === "failure_kind")) this.#db.exec("ALTER TABLE operations ADD COLUMN failure_kind TEXT");
		if (!operationColumns.some((column) => column.name === "retry_history_json")) this.#db.exec("ALTER TABLE operations ADD COLUMN retry_history_json TEXT");
		if (!operationColumns.some((column) => column.name === "approval_id")) this.#db.exec("ALTER TABLE operations ADD COLUMN approval_id TEXT");
		if (!operationColumns.some((column) => column.name === "approval_tool_call_id")) this.#db.exec("ALTER TABLE operations ADD COLUMN approval_tool_call_id TEXT");
		if (!operationColumns.some((column) => column.name === "trace_id")) this.#db.exec("ALTER TABLE operations ADD COLUMN trace_id TEXT");
	}

	[Symbol.dispose](): void {
		this.#db.close();
	}

	close(): void {
		this.#db.close();
	}

	subscribeEvents(listener: (event: StoredSessionEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	loadSnapshot(sessionId: string): SessionSnapshot | undefined {
		const row = this.#db
			.prepare("SELECT snapshot_json, revision FROM session_snapshots WHERE session_id = ?")
			.get(sessionId) as unknown as SessionRow | undefined;
		return row ? parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${sessionId}`) : undefined;
	}

	loadEvents(sessionId: string, afterRevision = 0): SessionEvent[] {
		const rows = this.#db
			.prepare("SELECT event_json FROM session_events WHERE session_id = ? AND revision > ? ORDER BY revision")
			.all(sessionId, afterRevision) as unknown as Array<{ event_json: string }>;
		return rows.map((row, index) =>
			parseChecked<SessionEvent>(row.event_json, checkEvent, `Event ${sessionId}/${afterRevision + index + 1}`),
		);
	}

	loadEventFeed(afterCursor = "0", limit = 1000): StoredSessionEvent[] {
		const cursor = Number(afterCursor);
		if (!Number.isSafeInteger(cursor) || cursor < 0) {
			throw new OrchestratorError("conflict", `Invalid event cursor ${afterCursor}`);
		}
		const rows = this.#db
			.prepare(
				"SELECT global_seq, event_json FROM session_events WHERE global_seq > ? ORDER BY global_seq LIMIT ?",
			)
			.all(cursor, limit) as unknown as Array<{ global_seq: number; event_json: string }>;
		return rows.map((row) => ({
			cursor: String(row.global_seq),
			event: parseChecked<SessionEvent>(row.event_json, checkEvent, `Event cursor ${row.global_seq}`),
		}));
	}

	listSnapshots(workspaceId: string, options: ListSnapshotsOptions = {}): SessionSnapshot[] {
		const conditions = ["workspace_id = ?", "parent_session_id IS NULL", options.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
		const parameters: Array<string | number> = [workspaceId];
		const query = options.query?.trim().toLocaleLowerCase();
		if (query) {
			const escaped = query.replace(/[!%_]/g, "!$&");
			conditions.push("(LOWER(COALESCE(name, '')) LIKE ? ESCAPE '!' OR LOWER(session_id) LIKE ? ESCAPE '!')");
			parameters.push(`%${escaped}%`, `%${escaped}%`);
		}
		parameters.push(Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100))));
		const rows = this.#db
			.prepare(`SELECT session_id, snapshot_json FROM session_snapshots WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
			.all(...parameters) as unknown as Array<{ session_id: string; snapshot_json: string }>;
		return rows.map((row) =>
			parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${row.session_id}`),
		);
	}

	listChildSnapshots(parentSessionId: string, limit = 100): SessionSnapshot[] {
		const rows = this.#db
			.prepare("SELECT session_id, snapshot_json FROM session_snapshots WHERE parent_session_id = ? ORDER BY updated_at DESC LIMIT ?")
			.all(parentSessionId, Math.max(1, Math.min(100, Math.trunc(limit)))) as unknown as Array<{ session_id: string; snapshot_json: string }>;
		return rows.map((row) => parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${row.session_id}`));
	}

	listAllChildSnapshots(limit = 1000, offset = 0): SessionSnapshot[] {
		const rows = this.#db
			.prepare("SELECT session_id, snapshot_json FROM session_snapshots WHERE parent_session_id IS NOT NULL ORDER BY updated_at ASC LIMIT ? OFFSET ?")
			.all(Math.max(1, Math.min(10_000, Math.trunc(limit))), Math.max(0, Math.trunc(offset))) as unknown as Array<{ session_id: string; snapshot_json: string }>;
		return rows.map((row) => parseChecked<SessionSnapshot>(row.snapshot_json, checkSnapshot, `Snapshot ${row.session_id}`));
	}

	loadGoal(goalId: string): DurableGoal | undefined {
		const row = this.#db
			.prepare("SELECT goal_id, parent_session_id, title, objective, run_session_id, created_at, updated_at, cancelled_at FROM goals WHERE goal_id = ?")
			.get(goalId) as unknown as GoalRow | undefined;
		return row ? mapGoal(row) : undefined;
	}

	listGoals(parentSessionId: string, limit = 100): DurableGoal[] {
		const rows = this.#db
			.prepare("SELECT goal_id, parent_session_id, title, objective, run_session_id, created_at, updated_at, cancelled_at FROM goals WHERE parent_session_id = ? ORDER BY updated_at DESC, goal_id DESC LIMIT ?")
			.all(parentSessionId, Math.max(1, Math.min(100, Math.trunc(limit)))) as unknown as GoalRow[];
		return rows.map(mapGoal);
	}

	commitGoalMutation(options: CommitGoalMutationOptions): { deduplicated: boolean; result: CommandResult } {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#db
				.prepare("SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?")
				.get(options.idempotency.principalId, options.idempotency.key) as unknown as IdempotencyRow | undefined;
			if (existing && existing.expires_at <= options.goal.updatedAt) {
				this.#db.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?")
					.run(options.idempotency.principalId, options.idempotency.key);
			} else if (existing) {
				if (existing.command_hash !== options.idempotency.commandHash) {
					throw new OrchestratorError("idempotency_conflict", `Idempotency key ${options.idempotency.key} was used for another command`);
				}
				const result = parseChecked<CommandResult>(existing.result_json, checkCommandResult, `Idempotency result ${options.idempotency.key}`);
				this.#db.exec("COMMIT");
				return { deduplicated: true, result };
			}

			if (!checkCommandResult.Check(options.idempotency.result)) {
				throw new OrchestratorError("conflict", "Goal mutation contains an invalid command result");
			}
			if (options.expectedUpdatedAt === undefined) {
				this.#db.prepare("INSERT INTO goals(goal_id, parent_session_id, title, objective, run_session_id, created_at, updated_at, cancelled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
					.run(options.goal.id, options.goal.parentSessionId, options.goal.title, options.goal.objective, options.goal.runSessionId ?? null, options.goal.createdAt, options.goal.updatedAt, options.goal.cancelledAt ?? null);
			} else {
				const updated = this.#db.prepare("UPDATE goals SET title = ?, objective = ?, run_session_id = ?, updated_at = ?, cancelled_at = ? WHERE goal_id = ? AND parent_session_id = ? AND updated_at = ?")
					.run(options.goal.title, options.goal.objective, options.goal.runSessionId ?? null, options.goal.updatedAt, options.goal.cancelledAt ?? null, options.goal.id, options.goal.parentSessionId, options.expectedUpdatedAt);
				if (Number(updated.changes) !== 1) throw new OrchestratorError("conflict", `Goal ${options.goal.id} changed concurrently`);
			}
			this.#db.prepare("INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
				.run(options.idempotency.principalId, options.idempotency.key, options.idempotency.commandHash, JSON.stringify(options.idempotency.result), options.goal.updatedAt, options.idempotency.expiresAt);
			this.#db.exec("COMMIT");
			return { deduplicated: false, result: options.idempotency.result };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	getIdempotencyResult(
		principalId: string,
		key: string,
		commandHash: string,
		now: number,
	): CommandResult | undefined {
		const existing = this.#db
			.prepare(
				"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?",
			)
			.get(principalId, key) as unknown as IdempotencyRow | undefined;
		if (!existing) return undefined;
		if (existing.expires_at <= now) {
			this.#db
				.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ? AND expires_at <= ?")
				.run(principalId, key, now);
			return undefined;
		}
		if (existing.command_hash !== commandHash) {
			throw new OrchestratorError("idempotency_conflict", `Idempotency key ${key} was used for another command`);
		}
		return parseChecked<CommandResult>(existing.result_json, checkCommandResult, `Idempotency result ${key}`);
	}

	commitMutation(options: CommitMutationOptions): { deduplicated: boolean; result?: CommandResult } {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			if (options.idempotency) {
				const existing = this.#db
					.prepare(
						"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?",
					)
					.get(options.idempotency.principalId, options.idempotency.key) as unknown as IdempotencyRow | undefined;
				if (existing && existing.expires_at <= options.snapshot.session.updatedAt) {
					this.#db
						.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?")
						.run(options.idempotency.principalId, options.idempotency.key);
				} else if (existing) {
					if (existing.command_hash !== options.idempotency.commandHash) {
						throw new OrchestratorError(
							"idempotency_conflict",
							`Idempotency key ${options.idempotency.key} was used for another command`,
						);
					}
					const result = parseChecked<CommandResult>(
						existing.result_json,
						checkCommandResult,
						`Idempotency result ${options.idempotency.key}`,
					);
					this.#db.exec("COMMIT");
					return { deduplicated: true, result };
				}
			}

			const current = this.#db
				.prepare("SELECT snapshot_json, revision FROM session_snapshots WHERE session_id = ?")
				.get(options.sessionId) as unknown as SessionRow | undefined;
			const currentRevision = current?.revision ?? 0;
			if (currentRevision !== options.expectedRevision) {
				throw new OrchestratorError(
					"conflict",
					`Session ${options.sessionId} is at revision ${currentRevision}, expected ${options.expectedRevision}`,
				);
			}
			if (options.events.length === 0 || options.snapshot.revision !== currentRevision + options.events.length) {
				throw new OrchestratorError("conflict", "Mutation events and final snapshot revision do not align");
			}
			if (options.lease) {
				const lease = this.#db
					.prepare("SELECT session_id, owner_id, fence, expires_at FROM writer_leases WHERE session_id = ?")
					.get(options.sessionId) as unknown as LeaseRow | undefined;
				if (
					!lease ||
					lease.owner_id !== options.lease.ownerId ||
					lease.fence !== options.lease.fence ||
					lease.expires_at <= options.snapshot.session.updatedAt
				) {
					throw new OrchestratorError("lease_lost", `Writer lease for ${options.sessionId} was lost`);
				}
			}
			for (const [index, event] of options.events.entries()) {
				if (!checkEvent.Check(event)) throw new OrchestratorError("conflict", "Mutation contains an invalid event");
				if (event.sessionId !== options.sessionId || event.revision !== currentRevision + index + 1) {
					throw new OrchestratorError("conflict", "Mutation event sequence is not contiguous");
				}
			}
			if (!checkSnapshot.Check(options.snapshot) || options.snapshot.session.id !== options.sessionId) {
				throw new OrchestratorError("conflict", "Mutation contains an invalid snapshot");
			}

			if (current) {
				this.#db
					.prepare("UPDATE session_snapshots SET revision = ?, snapshot_json = ?, name = ?, archived_at = ?, parent_session_id = ?, updated_at = ? WHERE session_id = ?")
					.run(
						options.snapshot.revision,
						JSON.stringify(options.snapshot),
						options.snapshot.session.name ?? null,
						options.snapshot.session.archivedAt ?? null,
						options.snapshot.session.parentSessionId ?? null,
						options.snapshot.session.updatedAt,
						options.sessionId,
					);
			} else {
				this.#db
					.prepare(
						"INSERT INTO session_snapshots(session_id, workspace_id, name, archived_at, parent_session_id, revision, snapshot_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						options.sessionId,
						options.snapshot.session.workspaceId,
						options.snapshot.session.name ?? null,
						options.snapshot.session.archivedAt ?? null,
						options.snapshot.session.parentSessionId ?? null,
						options.snapshot.revision,
						JSON.stringify(options.snapshot),
						options.snapshot.session.updatedAt,
					);
			}

			const insertEvent = this.#db.prepare(
				"INSERT INTO session_events(session_id, revision, event_id, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
			);
			const storedEvents: StoredSessionEvent[] = [];
			for (const event of options.events) {
				const inserted = insertEvent.run(
					event.sessionId,
					event.revision,
					event.eventId,
					JSON.stringify(event),
					event.timestamp,
				);
				storedEvents.push({ cursor: String(inserted.lastInsertRowid), event });
			}

			if (options.operation) {
				const operation = options.operation;
				this.#db
					.prepare(
						"INSERT INTO operations(operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						operation.id,
						operation.sessionId,
						operation.type,
						operation.status,
						JSON.stringify(operation.payload),
						operation.attempt,
						operation.createdAt,
						operation.updatedAt,
						operation.startedAt ?? null,
						operation.finishedAt ?? null,
						operation.abortRequested ? 1 : 0,
						operation.traceId ?? null,
						operation.error ?? null,
						operation.retryAfter ?? null,
						operation.usage ? JSON.stringify(operation.usage) : null,
						operation.tools ? JSON.stringify(operation.tools) : null,
						operation.failureKind ?? null,
						operation.retryHistory ? JSON.stringify(operation.retryHistory) : null,
						operation.approvalId ?? null,
						operation.approvalToolCallId ?? null,
					);
			}
			if (options.attachGoalRun) {
				const attached = this.#db
					.prepare("UPDATE goals SET run_session_id = ?, updated_at = ? WHERE goal_id = ? AND parent_session_id = ? AND run_session_id IS NULL AND cancelled_at IS NULL AND updated_at = ?")
					.run(
						options.attachGoalRun.runSessionId,
						options.attachGoalRun.updatedAt,
						options.attachGoalRun.goalId,
						options.attachGoalRun.parentSessionId,
						options.attachGoalRun.expectedUpdatedAt,
					);
				if (Number(attached.changes) !== 1) {
					throw new OrchestratorError("conflict", `Goal ${options.attachGoalRun.goalId} cannot attach run ${options.attachGoalRun.runSessionId}`);
				}
			}

			if (options.approvalExecution) {
				const approval = options.approvalExecution;
				this.#db.prepare("INSERT INTO approval_executions(approval_id, session_id, operation_id, tool_call_id, mode, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
					.run(approval.approvalId, approval.sessionId, approval.operationId ?? null, approval.toolCallId, approval.mode, approval.state, approval.createdAt, approval.updatedAt);
			}
			if (options.settleApprovalExecution) {
				const settled = this.#db.prepare("UPDATE approval_executions SET state = ?, updated_at = ? WHERE approval_id = ? AND state = 'waiting'")
					.run(options.settleApprovalExecution.state, options.snapshot.session.updatedAt, options.settleApprovalExecution.approvalId);
				if (Number(settled.changes) !== 1) throw new OrchestratorError("conflict", `Approval execution ${options.settleApprovalExecution.approvalId} is not waiting`);
			}

			if (options.settleOperation) {
				const settled = this.#db
					.prepare("UPDATE operations SET status = ?, updated_at = ?, finished_at = ?, error = ?, retry_after = NULL, usage_json = COALESCE(?, usage_json), tools_json = COALESCE(?, tools_json), failure_kind = ?, retry_history_json = COALESCE(?, retry_history_json) WHERE operation_id = ? AND status = 'running'")
					.run(
						options.settleOperation.status,
						options.snapshot.session.updatedAt,
						options.snapshot.session.updatedAt,
						options.settleOperation.error ?? null,
						options.settleOperation.usage ? JSON.stringify(options.settleOperation.usage) : null,
						options.settleOperation.tools ? JSON.stringify(options.settleOperation.tools) : null,
						options.settleOperation.failureKind ?? null,
						options.settleOperation.retryHistory ? JSON.stringify(options.settleOperation.retryHistory) : null,
						options.settleOperation.id,
					);
				if (Number(settled.changes) !== 1) {
					throw new OrchestratorError("conflict", `Operation ${options.settleOperation.id} is not running`);
				}
			}
			if (options.retryOperation) {
				const updated = this.#db
				.prepare("UPDATE operations SET updated_at = ?, error = ?, retry_after = ?, retry_history_json = ?, usage_json = COALESCE(?, usage_json), tools_json = COALESCE(?, tools_json), failure_kind = ? WHERE operation_id = ? AND status = 'running'")
					.run(
						options.snapshot.session.updatedAt,
						options.retryOperation.error,
						options.retryOperation.retryAfter,
						JSON.stringify(options.retryOperation.retryHistory),
						options.retryOperation.usage ? JSON.stringify(options.retryOperation.usage) : null,
						options.retryOperation.tools ? JSON.stringify(options.retryOperation.tools) : null,
						options.retryOperation.failureKind ?? "provider",
						options.retryOperation.id,
					);
				if (Number(updated.changes) !== 1) {
					throw new OrchestratorError("conflict", `Operation ${options.retryOperation.id} cannot record retry metadata`);
				}
			}

			if (options.idempotency) {
				if (!checkCommandResult.Check(options.idempotency.result)) {
					throw new OrchestratorError("conflict", "Mutation contains an invalid command result");
				}
				this.#db
					.prepare(
						"INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(
						options.idempotency.principalId,
						options.idempotency.key,
						options.idempotency.commandHash,
						JSON.stringify(options.idempotency.result),
						options.snapshot.session.updatedAt,
						options.idempotency.expiresAt,
					);
			}

			this.#db.exec("COMMIT");
			if (this.#eventListeners.size > 0) {
				setImmediate(() => {
					for (const stored of storedEvents) {
						for (const listener of this.#eventListeners) listener(stored);
					}
				});
			}
			return { deduplicated: false, ...(options.idempotency ? { result: options.idempotency.result } : {}) };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	startOperationRetry(operationId: string, attempt: number, now: number): boolean {
		const result = this.#db.prepare("UPDATE operations SET attempt = ?, updated_at = ?, retry_after = NULL WHERE operation_id = ? AND status = 'running' AND attempt = ?")
			.run(attempt + 1, now, operationId, attempt);
		return Number(result.changes) === 1;
	}

	recordOperationRetry(operationId: string, attempt: number, now: number, error: string): void {
		const updated = this.#db
				.prepare("UPDATE operations SET attempt = ?, updated_at = ?, error = ? WHERE operation_id = ? AND status = 'running' AND attempt < ?")
			.run(attempt, now, error, operationId, attempt);
		if (Number(updated.changes) !== 1) {
			throw new OrchestratorError("conflict", `Operation ${operationId} cannot record retry attempt ${attempt}`);
		}
	}

	claimNextOperation(sessionId: string, now: number, traceId?: string): DurableOperation | undefined {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.#db
				.prepare(
					"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id FROM operations WHERE session_id = ? AND status = 'queued' ORDER BY created_at, operation_id LIMIT 1",
				)
				.get(sessionId) as unknown as OperationRow | undefined;
			if (!row) {
				this.#db.exec("COMMIT");
				return undefined;
			}
			if (row.retry_after !== null && row.retry_after > now) {
				this.#db.exec("COMMIT");
				return undefined;
			}
			this.#db
				.prepare("UPDATE operations SET status = 'running', attempt = attempt + 1, updated_at = ?, started_at = ?, finished_at = NULL, trace_id = COALESCE(trace_id, ?) WHERE operation_id = ?")
				.run(now, now, traceId ?? null, row.operation_id);
			this.#db.exec("COMMIT");
			return mapOperation({ ...row, status: "running", attempt: row.attempt + 1, updated_at: now, started_at: now, finished_at: null, trace_id: row.trace_id ?? traceId ?? null });
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	getOperation(operationId: string): DurableOperation | undefined {
		const row = this.#db
			.prepare(
				"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id FROM operations WHERE operation_id = ?",
			)
			.get(operationId) as unknown as OperationRow | undefined;
		return row ? mapOperation(row) : undefined;
	}

	listOperationsByStatus(status: OperationStatus): DurableOperation[] {
		const rows = this.#db
			.prepare(
				"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id FROM operations WHERE status = ? ORDER BY created_at, operation_id",
			)
			.all(status) as unknown as OperationRow[];
		return rows.map(mapOperation);
	}

	listOperations(sessionId: string, limit = 20): DurableOperation[] {
		const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
		const rows = this.#db
			.prepare(
				"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id FROM operations WHERE session_id = ? ORDER BY created_at DESC, operation_id DESC LIMIT ?",
			)
			.all(sessionId, boundedLimit) as unknown as OperationRow[];
		return rows.map(mapOperation);
	}

	getRunningOperation(sessionId: string): DurableOperation | undefined {
		const row = this.#db.prepare(
			"SELECT operation_id, session_id, type, status, payload_json, attempt, created_at, updated_at, started_at, finished_at, abort_requested, trace_id, error, retry_after, usage_json, tools_json, failure_kind, retry_history_json, approval_id, approval_tool_call_id FROM operations WHERE session_id = ? AND status = 'running' ORDER BY created_at, operation_id LIMIT 1",
		).get(sessionId) as unknown as OperationRow | undefined;
		return row ? mapOperation(row) : undefined;
	}

	getApprovalExecution(approvalId: string): DurableApprovalExecution | undefined {
		const row = this.#db.prepare(
			"SELECT approval_id, session_id, operation_id, tool_call_id, mode, state, created_at, updated_at FROM approval_executions WHERE approval_id = ?",
		).get(approvalId) as unknown as ApprovalExecutionRow | undefined;
		return row ? mapApprovalExecution(row) : undefined;
	}

	listApprovalExecutionsForOperation(operationId: string): DurableApprovalExecution[] {
		const rows = this.#db.prepare(
			"SELECT approval_id, session_id, operation_id, tool_call_id, mode, state, created_at, updated_at FROM approval_executions WHERE operation_id = ? ORDER BY created_at, approval_id",
		).all(operationId) as unknown as ApprovalExecutionRow[];
		return rows.map(mapApprovalExecution);
	}

	claimApprovedApprovalExecution(sessionId: string, toolCallId: string, now: number): DurableApprovalExecution | undefined {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.#db.prepare(
				"SELECT approval_id, session_id, operation_id, tool_call_id, mode, state, created_at, updated_at FROM approval_executions WHERE session_id = ? AND tool_call_id = ? AND state = 'approved' ORDER BY created_at DESC, approval_id DESC LIMIT 1",
			).get(sessionId, toolCallId) as unknown as ApprovalExecutionRow | undefined;
			if (!row) {
				this.#db.exec("COMMIT");
				return undefined;
			}
			const claimed = this.#db.prepare("UPDATE approval_executions SET state = 'executing', updated_at = ? WHERE approval_id = ? AND state = 'approved'")
				.run(now, row.approval_id);
			if (Number(claimed.changes) !== 1) throw new OrchestratorError("conflict", `Approval execution ${row.approval_id} could not be claimed`);
			this.#db.exec("COMMIT");
			return mapApprovalExecution({ ...row, state: "executing", updated_at: now });
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	completeApprovalExecution(approvalId: string, now: number): boolean {
		const result = this.#db.prepare("UPDATE approval_executions SET state = 'completed', updated_at = ? WHERE approval_id = ? AND state = 'executing'")
			.run(now, approvalId);
		return Number(result.changes) === 1;
	}

	interruptApprovalExecution(approvalId: string, now: number): boolean {
		const result = this.#db.prepare("UPDATE approval_executions SET state = 'interrupted', updated_at = ? WHERE approval_id = ? AND state IN ('waiting', 'approved', 'executing')")
			.run(now, approvalId);
		return Number(result.changes) === 1;
	}

	requeueOperationForApproval(operationId: string, approvalId: string, now: number): boolean {
		const approval = this.getApprovalExecution(approvalId);
		if (!approval || approval.operationId !== operationId) return false;
		const result = this.#db.prepare("UPDATE operations SET status = 'queued', updated_at = ?, finished_at = NULL, error = NULL, retry_after = NULL, approval_id = ?, approval_tool_call_id = ? WHERE operation_id = ? AND status = 'running'")
			.run(now, approvalId, approval.toolCallId, operationId);
		return Number(result.changes) === 1;
	}

	requeueOperation(operationId: string, now: number, error?: string): boolean {
		const result = this.#db
			.prepare("UPDATE operations SET status = 'queued', updated_at = ?, finished_at = NULL, retry_after = NULL, error = ? WHERE operation_id = ? AND status = 'running'")
			.run(now, error ?? null, operationId);
		return Number(result.changes) === 1;
	}

	recoverRetryOperation(operationId: string, now: number): boolean {
		const result = this.#db
			.prepare("UPDATE operations SET status = 'queued', updated_at = ?, finished_at = NULL WHERE operation_id = ? AND status = 'running' AND retry_after IS NOT NULL")
			.run(now, operationId);
		return Number(result.changes) === 1;
	}

	requestOperationAbort(options: RequestOperationAbortOptions): CommandResult {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#db
				.prepare(
					"SELECT command_hash, result_json, expires_at FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?",
				)
				.get(options.principalId, options.idempotencyKey) as unknown as IdempotencyRow | undefined;
			if (existing && existing.expires_at > options.now) {
				if (existing.command_hash !== options.commandHash) {
					throw new OrchestratorError("idempotency_conflict", `Idempotency key ${options.idempotencyKey} was used for another command`);
				}
				const result = parseChecked<CommandResult>(existing.result_json, checkCommandResult, `Idempotency result ${options.idempotencyKey}`);
				this.#db.exec("COMMIT");
				return result;
			}
			if (existing) {
				this.#db.prepare("DELETE FROM idempotency_results WHERE principal_id = ? AND idempotency_key = ?").run(
					options.principalId,
					options.idempotencyKey,
				);
			}
			const operation = this.#db
				.prepare(
					"SELECT operation_id FROM operations WHERE session_id = ? AND status IN ('running', 'queued') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at, operation_id LIMIT 1",
				)
				.get(options.sessionId) as unknown as { operation_id: string } | undefined;
			if (!operation) throw new OrchestratorError("conflict", `Session ${options.sessionId} has no active turn`);
			this.#db.prepare("UPDATE operations SET abort_requested = 1, updated_at = ? WHERE operation_id = ?").run(
				options.now,
				operation.operation_id,
			);
			if (!checkCommandResult.Check(options.result)) throw new OrchestratorError("conflict", "Invalid abort result");
			this.#db
				.prepare(
					"INSERT INTO idempotency_results(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					options.principalId,
					options.idempotencyKey,
					options.commandHash,
					JSON.stringify(options.result),
					options.now,
					options.expiresAt,
				);
			this.#db.exec("COMMIT");
			return options.result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	countQueuedOperations(sessionId: string): number {
		const row = this.#db
			.prepare("SELECT COUNT(*) AS count FROM operations WHERE session_id = ? AND status = 'queued'")
			.get(sessionId) as unknown as { count: number };
		return Number(row.count);
	}

	markRunningOperationsInterrupted(now: number): number {
		const result = this.#db
			.prepare("UPDATE operations SET status = 'interrupted', updated_at = ?, finished_at = ?, error = 'worker interrupted' WHERE status = 'running'")
			.run(now, now);
		return Number(result.changes);
	}

	clearWriterLeases(): number {
		return Number(this.#db.prepare("DELETE FROM writer_leases").run().changes);
	}

	acquireWriterLease(sessionId: string, ownerId: string, now: number, ttlMs: number): WriterLease {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const session = this.#db.prepare("SELECT 1 FROM session_snapshots WHERE session_id = ?").get(sessionId);
			if (!session) throw new OrchestratorError("not_found", `Session ${sessionId} does not exist`);
			const current = this.#db
				.prepare("SELECT session_id, owner_id, fence, expires_at FROM writer_leases WHERE session_id = ?")
				.get(sessionId) as unknown as LeaseRow | undefined;
			if (current && current.owner_id !== ownerId && current.expires_at > now) {
				throw new OrchestratorError("lease_conflict", `Session ${sessionId} already has an active writer`);
			}
			const fence = (current?.fence ?? 0) + 1;
			const expiresAt = now + ttlMs;
			this.#db
				.prepare(
					"INSERT INTO writer_leases(session_id, owner_id, fence, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET owner_id = excluded.owner_id, fence = excluded.fence, expires_at = excluded.expires_at",
				)
				.run(sessionId, ownerId, fence, expiresAt);
			this.#db.exec("COMMIT");
			return { sessionId, ownerId, fence, expiresAt };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	renewWriterLease(lease: WriterLease, now: number, ttlMs: number): WriterLease {
		const expiresAt = now + ttlMs;
		const result = this.#db
			.prepare(
				"UPDATE writer_leases SET expires_at = ? WHERE session_id = ? AND owner_id = ? AND fence = ? AND expires_at > ?",
			)
			.run(expiresAt, lease.sessionId, lease.ownerId, lease.fence, now);
		if (Number(result.changes) !== 1) throw new OrchestratorError("lease_lost", `Writer lease for ${lease.sessionId} was lost`);
		return { ...lease, expiresAt };
	}

	releaseWriterLease(lease: WriterLease): void {
		this.#db
			.prepare("DELETE FROM writer_leases WHERE session_id = ? AND owner_id = ? AND fence = ?")
			.run(lease.sessionId, lease.ownerId, lease.fence);
	}
}

import {
	type CommandResult,
	CommandResultSchema,
	type EvaluationAttestation,
	EvaluationAttestationSchema,
	type EvaluationDataset,
	EvaluationDatasetSchema,
	type RunEvaluation,
	RunEvaluationSchema,
} from "@wuming/protocol";
import { DatabaseSync } from "node:sqlite";
import { Compile } from "typebox/compile";
import { verifyEvaluationAttestation } from "./attestation.js";
import { verifyEvaluationDataset } from "./dataset.js";
import { EvaluationError } from "./errors.js";
import { verifyRunEvaluation } from "./evaluator.js";

const checkCommandResult = Compile(CommandResultSchema);
const checkDataset = Compile(EvaluationDatasetSchema);
const checkEvaluation = Compile(RunEvaluationSchema);
const checkAttestation = Compile(EvaluationAttestationSchema);

interface IdempotencyInput {
	principalId: string;
	key: string;
	commandHash: string;
	expiresAt: number;
	now: number;
}

interface StoredJsonRow {
	json: string;
	digest: string;
}

interface IdempotencyRow {
	command_hash: string;
	result_json: string;
	expires_at: number;
}

function parse<T>(json: string, label: string): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		throw new EvaluationError("corrupt_storage", `${label} contains invalid JSON`);
	}
}

export class EvaluationStore implements Disposable {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		this.#db = new DatabaseSync(path);
		this.#db.exec("PRAGMA foreign_keys = ON");
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS evaluation_datasets (
				dataset_id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL,
				dataset_json TEXT NOT NULL,
				dataset_digest TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS evaluation_datasets_workspace ON evaluation_datasets(workspace_id, updated_at DESC, dataset_id DESC);
			CREATE TABLE IF NOT EXISTS run_evaluations (
				evaluation_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				workspace_id TEXT NOT NULL,
				dataset_id TEXT,
				evaluation_json TEXT NOT NULL,
				evaluation_digest TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				finished_at INTEGER NOT NULL,
				FOREIGN KEY (dataset_id) REFERENCES evaluation_datasets(dataset_id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS run_evaluations_run ON run_evaluations(session_id, run_id, created_at DESC, evaluation_id DESC);
			CREATE TABLE IF NOT EXISTS evaluation_attestations (
				attestation_id TEXT PRIMARY KEY,
				evaluation_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				attestation_json TEXT NOT NULL,
				payload_digest TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (evaluation_id) REFERENCES run_evaluations(evaluation_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS evaluation_attestations_evaluation ON evaluation_attestations(evaluation_id, created_at DESC);
			CREATE TABLE IF NOT EXISTS evaluation_idempotency (
				principal_id TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				command_hash TEXT NOT NULL,
				result_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				PRIMARY KEY (principal_id, idempotency_key)
			);
		`);
	}

	#existing(input: IdempotencyInput): CommandResult | undefined {
		const row = this.#db
			.prepare(
				"SELECT command_hash, result_json, expires_at FROM evaluation_idempotency WHERE principal_id = ? AND idempotency_key = ?"
			)
			.get(input.principalId, input.key) as unknown as IdempotencyRow | undefined;
		if (!row) return undefined;
		if (row.expires_at <= input.now) {
			this.#db
				.prepare("DELETE FROM evaluation_idempotency WHERE principal_id = ? AND idempotency_key = ?")
				.run(input.principalId, input.key);
			return undefined;
		}
		if (row.command_hash !== input.commandHash)
			throw new EvaluationError("conflict", `Idempotency key ${input.key} was used for another command`);
		const result = parse<CommandResult>(row.result_json, `Idempotency result ${input.key}`);
		if (!checkCommandResult.Check(result))
			throw new EvaluationError("corrupt_storage", `Idempotency result ${input.key} failed schema validation`);
		return result;
	}

	#remember(input: IdempotencyInput, result: CommandResult): void {
		if (!checkCommandResult.Check(result))
			throw new EvaluationError("conflict", "Evaluation mutation produced an invalid protocol result");
		this.#db
			.prepare(
				"INSERT INTO evaluation_idempotency(principal_id, idempotency_key, command_hash, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
			)
			.run(input.principalId, input.key, input.commandHash, JSON.stringify(result), input.now, input.expiresAt);
	}

	getIdempotentResult(input: IdempotencyInput): CommandResult | undefined {
		return this.#existing(input);
	}

	createDataset(
		dataset: EvaluationDataset,
		idempotency: IdempotencyInput
	): Extract<CommandResult, { type: "evaluation.dataset.created" }> {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#existing(idempotency);
			if (existing) {
				this.#db.exec("COMMIT");
				return existing as Extract<CommandResult, { type: "evaluation.dataset.created" }>;
			}
			if (!checkDataset.Check(dataset) || !verifyEvaluationDataset(dataset))
				throw new EvaluationError("conflict", "Evaluation dataset is invalid");
			this.#db
				.prepare(
					"INSERT INTO evaluation_datasets(dataset_id, workspace_id, dataset_json, dataset_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
				)
				.run(
					dataset.id,
					dataset.workspaceId,
					JSON.stringify(dataset),
					dataset.digest,
					dataset.createdAt,
					dataset.updatedAt
				);
			const result = { type: "evaluation.dataset.created", dataset } as const;
			this.#remember(idempotency, result);
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	getDataset(datasetId: string): EvaluationDataset | undefined {
		const row = this.#db
			.prepare("SELECT dataset_json AS json, dataset_digest AS digest FROM evaluation_datasets WHERE dataset_id = ?")
			.get(datasetId) as unknown as StoredJsonRow | undefined;
		if (!row) return undefined;
		const dataset = parse<EvaluationDataset>(row.json, `Evaluation dataset ${datasetId}`);
		if (!checkDataset.Check(dataset) || dataset.digest !== row.digest || !verifyEvaluationDataset(dataset))
			throw new EvaluationError("corrupt_storage", `Evaluation dataset ${datasetId} failed integrity validation`);
		return dataset;
	}

	listDatasets(workspaceId: string, limit = 100): EvaluationDataset[] {
		const rows = this.#db
			.prepare(
				"SELECT dataset_json AS json, dataset_digest AS digest FROM evaluation_datasets WHERE workspace_id = ? ORDER BY updated_at DESC, dataset_id DESC LIMIT ?"
			)
			.all(workspaceId, Math.max(1, Math.min(100, Math.trunc(limit)))) as unknown as StoredJsonRow[];
		return rows.map((row) => {
			const dataset = parse<EvaluationDataset>(row.json, `Evaluation dataset in ${workspaceId}`);
			if (!checkDataset.Check(dataset) || dataset.digest !== row.digest || !verifyEvaluationDataset(dataset))
				throw new EvaluationError("corrupt_storage", `Evaluation dataset ${dataset.id} failed integrity validation`);
			return dataset;
		});
	}

	deleteDataset(
		workspaceId: string,
		datasetId: string,
		idempotency: IdempotencyInput
	): Extract<CommandResult, { type: "evaluation.dataset.deleted" }> {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#existing(idempotency);
			if (existing) {
				this.#db.exec("COMMIT");
				return existing as Extract<CommandResult, { type: "evaluation.dataset.deleted" }>;
			}
			const deleted = this.#db
				.prepare("DELETE FROM evaluation_datasets WHERE dataset_id = ? AND workspace_id = ?")
				.run(datasetId, workspaceId);
			if (Number(deleted.changes) !== 1)
				throw new EvaluationError(
					"not_found",
					`Evaluation dataset ${datasetId} does not exist in workspace ${workspaceId}`
				);
			const result = { type: "evaluation.dataset.deleted", workspaceId, datasetId } as const;
			this.#remember(idempotency, result);
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	saveEvaluation(
		evaluation: RunEvaluation,
		idempotency: IdempotencyInput
	): Extract<CommandResult, { type: "session.run.evaluated" }> {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#existing(idempotency);
			if (existing) {
				this.#db.exec("COMMIT");
				return existing as Extract<CommandResult, { type: "session.run.evaluated" }>;
			}
			if (!checkEvaluation.Check(evaluation) || !verifyRunEvaluation(evaluation))
				throw new EvaluationError("conflict", "Run evaluation is invalid");
			this.#db
				.prepare(
					"INSERT INTO run_evaluations(evaluation_id, session_id, run_id, workspace_id, dataset_id, evaluation_json, evaluation_digest, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
				)
				.run(
					evaluation.id,
					evaluation.sessionId,
					evaluation.runId,
					evaluation.workspaceId,
					evaluation.datasetId ?? null,
					JSON.stringify(evaluation),
					evaluation.digest,
					evaluation.createdAt,
					evaluation.finishedAt
				);
			const result = { type: "session.run.evaluated", evaluation } as const;
			this.#remember(idempotency, result);
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	getEvaluation(evaluationId: string): RunEvaluation | undefined {
		const row = this.#db
			.prepare(
				"SELECT evaluation_json AS json, evaluation_digest AS digest FROM run_evaluations WHERE evaluation_id = ?"
			)
			.get(evaluationId) as unknown as StoredJsonRow | undefined;
		if (!row) return undefined;
		const evaluation = parse<RunEvaluation>(row.json, `Run evaluation ${evaluationId}`);
		if (!checkEvaluation.Check(evaluation) || evaluation.digest !== row.digest || !verifyRunEvaluation(evaluation))
			throw new EvaluationError("corrupt_storage", `Run evaluation ${evaluationId} failed integrity validation`);
		return evaluation;
	}

	listEvaluations(sessionId: string, runId: string, limit = 20): RunEvaluation[] {
		const rows = this.#db
			.prepare(
				"SELECT evaluation_json AS json, evaluation_digest AS digest FROM run_evaluations WHERE session_id = ? AND run_id = ? ORDER BY created_at DESC, evaluation_id DESC LIMIT ?"
			)
			.all(sessionId, runId, Math.max(1, Math.min(20, Math.trunc(limit)))) as unknown as StoredJsonRow[];
		return rows.map((row) => {
			const evaluation = parse<RunEvaluation>(row.json, `Run evaluation for ${runId}`);
			if (!checkEvaluation.Check(evaluation) || evaluation.digest !== row.digest || !verifyRunEvaluation(evaluation))
				throw new EvaluationError("corrupt_storage", `Run evaluation ${evaluation.id} failed integrity validation`);
			return evaluation;
		});
	}

	saveAttestation(
		attestation: EvaluationAttestation,
		idempotency: IdempotencyInput
	): Extract<CommandResult, { type: "session.run.attested" }> {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#existing(idempotency);
			if (existing) {
				this.#db.exec("COMMIT");
				return existing as Extract<CommandResult, { type: "session.run.attested" }>;
			}
			if (!checkAttestation.Check(attestation) || !verifyEvaluationAttestation(attestation))
				throw new EvaluationError("conflict", "Evaluation attestation is invalid");
			const evaluation = this.getEvaluation(attestation.evaluationId);
			if (
				!evaluation ||
				evaluation.digest !== attestation.evaluationDigest ||
				evaluation.sessionId !== attestation.sessionId ||
				evaluation.runId !== attestation.runId
			) {
				throw new EvaluationError("conflict", "Attestation does not match its stored evaluation");
			}
			this.#db
				.prepare(
					"INSERT INTO evaluation_attestations(attestation_id, evaluation_id, session_id, run_id, attestation_json, payload_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
				)
				.run(
					attestation.id,
					attestation.evaluationId,
					attestation.sessionId,
					attestation.runId,
					JSON.stringify(attestation),
					attestation.payloadDigest,
					attestation.issuedAt
				);
			const result = { type: "session.run.attested", attestation } as const;
			this.#remember(idempotency, result);
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.#db.close();
	}
	[Symbol.dispose](): void {
		this.close();
	}
}

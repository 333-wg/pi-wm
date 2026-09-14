import { randomUUID } from "node:crypto";
import {
	AttestationSigner,
	createEvaluationDataset,
	evaluateRun,
	EvaluationError,
	EvaluationStore,
} from "@wuming/evaluation";
import type {
	ArtifactRef,
	CommandResult,
	EvaluationGrader,
	RunEvaluation,
	SessionSnapshot,
	TrajectoryReport,
} from "@wuming/protocol";
import type { ProcessSandbox } from "@wuming/sandbox";
import { trajectoryDigest } from "@wuming/trajectory";

export interface EvaluationArtifactService {
	read(id: string): Promise<{
		record: {
			ref: ArtifactRef;
			workspaceId: string;
			sha256: string;
			kind: "binary" | "image" | "text";
		};
		content: Buffer;
	}>;
	resolve(ref: ArtifactRef, snapshot: SessionSnapshot): Promise<{ extractedText?: string; extractionNotice?: string }>;
}

export interface GatewayEvaluationManagerOptions {
	store: EvaluationStore;
	signer: AttestationSigner;
	artifacts: EvaluationArtifactService;
	resolveProcess: (workspaceId: string) => ProcessSandbox | undefined;
	idFactory?: () => string;
	clock?: () => number;
	idempotencyTtlMs?: number;
}

export class GatewayEvaluationManager {
	readonly #store: EvaluationStore;
	readonly #signer: AttestationSigner;
	readonly #artifacts: EvaluationArtifactService;
	readonly #resolveProcess: (workspaceId: string) => ProcessSandbox | undefined;
	readonly #idFactory: () => string;
	readonly #clock: () => number;
	readonly #idempotencyTtlMs: number;
	readonly #pendingEvaluations = new Map<
		string,
		{
			commandHash: string;
			promise: Promise<Extract<CommandResult, { type: "session.run.evaluated" }>>;
		}
	>();

	constructor(options: GatewayEvaluationManagerOptions) {
		this.#store = options.store;
		this.#signer = options.signer;
		this.#artifacts = options.artifacts;
		this.#resolveProcess = options.resolveProcess;
		this.#idFactory = options.idFactory ?? randomUUID;
		this.#clock = options.clock ?? Date.now;
		this.#idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
	}

	listDatasets(workspaceId: string) {
		return this.#store.listDatasets(workspaceId);
	}

	createDataset(input: {
		principalId: string;
		idempotencyKey: string;
		workspaceId: string;
		name: string;
		graders: EvaluationGrader[];
	}): Extract<CommandResult, { type: "evaluation.dataset.created" }> {
		const now = this.#clock();
		const dataset = createEvaluationDataset({
			id: this.#idFactory(),
			workspaceId: input.workspaceId,
			name: input.name,
			graders: input.graders,
			createdAt: now,
			updatedAt: now,
		});
		const idempotency = this.#idempotency(
			input.principalId,
			input.idempotencyKey,
			{
				type: "evaluation.dataset.create",
				workspaceId: input.workspaceId,
				name: dataset.name,
				graders: dataset.graders,
			},
			now
		);
		this.#assertNoPendingEvaluation(input.principalId, input.idempotencyKey);
		return this.#store.createDataset(dataset, idempotency);
	}

	deleteDataset(input: {
		principalId: string;
		idempotencyKey: string;
		workspaceId: string;
		datasetId: string;
	}): Extract<CommandResult, { type: "evaluation.dataset.deleted" }> {
		const now = this.#clock();
		const idempotency = this.#idempotency(
			input.principalId,
			input.idempotencyKey,
			{
				type: "evaluation.dataset.delete",
				workspaceId: input.workspaceId,
				datasetId: input.datasetId,
			},
			now
		);
		this.#assertNoPendingEvaluation(input.principalId, input.idempotencyKey);
		return this.#store.deleteDataset(input.workspaceId, input.datasetId, idempotency);
	}

	async evaluate(input: {
		principalId: string;
		idempotencyKey: string;
		snapshot: SessionSnapshot;
		runId: string;
		trajectory: TrajectoryReport;
		datasetId?: string;
		name?: string;
		graders?: EvaluationGrader[];
	}): Promise<Extract<CommandResult, { type: "session.run.evaluated" }>> {
		if ((input.datasetId === undefined) === (input.graders === undefined))
			throw new EvaluationError("conflict", "Provide exactly one of datasetId or graders");
		const now = this.#clock();
		const inlineName = input.name?.trim() || "Run evaluation";
		const command = {
			type: "session.run.evaluate",
			sessionId: input.snapshot.session.id,
			runId: input.runId,
			...(input.datasetId === undefined
				? { name: inlineName, graders: input.graders! }
				: { datasetId: input.datasetId, name: input.name }),
		};
		const idempotency = this.#idempotency(input.principalId, input.idempotencyKey, command, now);
		const existing = this.#store.getIdempotentResult(idempotency);
		if (existing) {
			if (existing.type !== "session.run.evaluated")
				throw new EvaluationError("corrupt_storage", "Evaluation idempotency result has the wrong type");
			return existing;
		}

		const pendingKey = this.#pendingKey(input.principalId, input.idempotencyKey);
		const pending = this.#pendingEvaluations.get(pendingKey);
		if (pending) {
			if (pending.commandHash !== idempotency.commandHash)
				throw new EvaluationError(
					"conflict",
					`Idempotency key ${input.idempotencyKey} is already evaluating another command`
				);
			return pending.promise;
		}

		const promise = (async () => {
			const dataset = input.datasetId === undefined ? undefined : this.#store.getDataset(input.datasetId);
			if (input.datasetId !== undefined && !dataset)
				throw new EvaluationError("not_found", `Evaluation dataset ${input.datasetId} does not exist`);
			if (dataset && dataset.workspaceId !== input.snapshot.session.workspaceId)
				throw new EvaluationError("conflict", "Evaluation dataset belongs to another workspace");
			const graders = dataset?.graders ?? input.graders!;
			const name = input.name?.trim() || dataset?.name || "Run evaluation";
			const process =
				input.snapshot.sandboxMode === "read_only"
					? undefined
					: this.#resolveProcess(input.snapshot.session.workspaceId);
			const evaluation = await evaluateRun({
				id: this.#idFactory(),
				sessionId: input.snapshot.session.id,
				runId: input.runId,
				workspaceId: input.snapshot.session.workspaceId,
				name,
				...(dataset === undefined ? {} : { datasetId: dataset.id }),
				graders,
				trajectory: input.trajectory,
				createdAt: now,
				clock: this.#clock,
				resolveArtifact: async (artifactId) => {
					const { record, content } = await this.#artifacts.read(artifactId);
					if (record.workspaceId !== input.snapshot.session.workspaceId)
						throw new EvaluationError("conflict", `Artifact ${artifactId} belongs to another workspace`);
					let text: string | undefined;
					let extractionNotice: string | undefined;
					if (record.kind === "text") text = content.toString("utf8");
					else if (record.kind === "binary") {
						const resolved = await this.#artifacts.resolve(record.ref, input.snapshot);
						text = resolved.extractedText;
						extractionNotice = resolved.extractionNotice;
					}
					return {
						id: record.ref.id,
						name: record.ref.name,
						mimeType: record.ref.mimeType,
						size: record.ref.size,
						sha256: record.sha256,
						...(text === undefined ? {} : { text: text.slice(0, 200_000) }),
						...(extractionNotice === undefined ? {} : { extractionNotice }),
					};
				},
				...(process === undefined
					? {}
					: {
							executeCommand: (commandValue: string, timeoutMs: number) => process.exec(commandValue, { timeoutMs }),
						}),
			});
			return this.#store.saveEvaluation(evaluation, idempotency);
		})();
		this.#pendingEvaluations.set(pendingKey, { commandHash: idempotency.commandHash, promise });
		try {
			return await promise;
		} finally {
			if (this.#pendingEvaluations.get(pendingKey)?.promise === promise) this.#pendingEvaluations.delete(pendingKey);
		}
	}

	listEvaluations(sessionId: string, runId: string, limit = 20): RunEvaluation[] {
		return this.#store.listEvaluations(sessionId, runId, limit);
	}

	attest(input: {
		principalId: string;
		idempotencyKey: string;
		sessionId: string;
		runId: string;
		evaluationId: string;
	}): Extract<CommandResult, { type: "session.run.attested" }> {
		const now = this.#clock();
		const idempotency = this.#idempotency(
			input.principalId,
			input.idempotencyKey,
			{
				type: "session.run.attestation.create",
				sessionId: input.sessionId,
				runId: input.runId,
				evaluationId: input.evaluationId,
			},
			now
		);
		this.#assertNoPendingEvaluation(input.principalId, input.idempotencyKey);
		const evaluation = this.#store.getEvaluation(input.evaluationId);
		if (!evaluation || evaluation.sessionId !== input.sessionId || evaluation.runId !== input.runId)
			throw new EvaluationError("not_found", `Evaluation ${input.evaluationId} does not exist for run ${input.runId}`);
		const attestation = this.#signer.create({ id: this.#idFactory(), evaluation, issuedAt: now });
		return this.#store.saveAttestation(attestation, idempotency);
	}

	#pendingKey(principalId: string, idempotencyKey: string): string {
		return `${principalId}\0${idempotencyKey}`;
	}

	#assertNoPendingEvaluation(principalId: string, idempotencyKey: string): void {
		if (this.#pendingEvaluations.has(this.#pendingKey(principalId, idempotencyKey))) {
			throw new EvaluationError("conflict", `Idempotency key ${idempotencyKey} is already evaluating another command`);
		}
	}

	#idempotency(principalId: string, key: string, command: unknown, now: number) {
		return {
			principalId,
			key,
			commandHash: trajectoryDigest(command),
			now,
			expiresAt: now + this.#idempotencyTtlMs,
		};
	}
}

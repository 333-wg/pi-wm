import { createHash, generateKeyPairSync } from "node:crypto";
import { EvaluationStore, AttestationSigner, verifyEvaluationAttestation } from "@wuming/evaluation";
import type { SessionSnapshot } from "@wuming/protocol";
import { createTrajectoryEvent, trajectoryReport } from "@wuming/trajectory";
import { describe, expect, it } from "vitest";
import { GatewayEvaluationManager } from "../src/evaluation.js";

const usage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
};

function snapshot(sandboxMode: SessionSnapshot["sandboxMode"] = "workspace_write"): SessionSnapshot {
	return {
		session: {
			id: "session-1",
			workspaceId: "workspace-1",
			phase: "idle",
			createdAt: 1,
			updatedAt: 1,
		},
		revision: 1,
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		sandboxMode,
		approvalPolicy: "on_risk",
		transcript: [],
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		pendingApprovals: [],
		usage,
	};
}

function completedTrajectory() {
	const accepted = createTrajectoryEvent({
		operationId: "run-1",
		sequence: 1,
		timestamp: 1,
		previousDigest: null,
		data: { type: "operation.accepted", mode: "prompt" },
	});
	const finished = createTrajectoryEvent({
		operationId: "run-1",
		sequence: 2,
		timestamp: 2,
		previousDigest: accepted.digest,
		data: { type: "operation.finished", status: "completed" },
	});
	return trajectoryReport("run-1", [accepted, finished]);
}

describe("GatewayEvaluationManager", () => {
	it("evaluates workspace artifacts and isolated commands without retaining raw output", async () => {
		const store = new EvaluationStore(":memory:");
		try {
			let sequence = 0;
			let processCalls = 0;
			const content = Buffer.from("release verified");
			const sha256 = createHash("sha256").update(content).digest("hex");
			const manager = new GatewayEvaluationManager({
				store,
				signer: new AttestationSigner(
					generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })
				),
				artifacts: {
					read: async (id) => ({
						record: {
							ref: { id, name: "result.txt", mimeType: "text/plain", size: content.length },
							workspaceId: "workspace-1",
							sha256,
							kind: "text",
						},
						content,
					}),
					resolve: async () => ({}),
				},
				resolveProcess: () => ({
					exec: async () => {
						processCalls += 1;
						return {
							exitCode: 0,
							stdout: "private-token 12 passed",
							stderr: "",
							truncated: false,
							timedOut: false,
						};
					},
				}),
				idFactory: () => `generated-${++sequence}`,
				clock: () => 100 + sequence,
			});
			const graders = [
				{
					id: "artifact",
					label: "Artifact contains result",
					type: "artifact" as const,
					artifactId: "artifact-1",
					assertion: { kind: "text_contains" as const, value: "verified" },
				},
				{
					id: "command",
					label: "Regression tests",
					type: "command" as const,
					command: "npm test",
					stdoutContains: "12 passed",
				},
			];
			const created = manager.createDataset({
				principalId: "user-1",
				idempotencyKey: "dataset-key",
				workspaceId: "workspace-1",
				name: "Release gates",
				graders,
			});
			const result = await manager.evaluate({
				principalId: "user-1",
				idempotencyKey: "evaluation-key",
				snapshot: snapshot(),
				runId: "run-1",
				trajectory: completedTrajectory(),
				datasetId: created.dataset.id,
			});
			expect(result.evaluation.status).toBe("pass");
			expect(processCalls).toBe(1);
			expect(JSON.stringify(result.evaluation)).not.toContain("private-token");
			expect(result.evaluation.checks[1]?.outputDigest).toMatch(/^sha256:/);
			const attested = manager.attest({
				principalId: "user-1",
				idempotencyKey: "attest-key",
				sessionId: "session-1",
				runId: "run-1",
				evaluationId: result.evaluation.id,
			});
			expect(verifyEvaluationAttestation(attested.attestation)).toBe(true);
			manager.deleteDataset({
				principalId: "user-1",
				idempotencyKey: "delete-key",
				workspaceId: "workspace-1",
				datasetId: created.dataset.id,
			});
			const replayed = await manager.evaluate({
				principalId: "user-1",
				idempotencyKey: "evaluation-key",
				snapshot: snapshot(),
				runId: "run-1",
				trajectory: completedTrajectory(),
				datasetId: created.dataset.id,
			});
			expect(replayed).toEqual(result);
			expect(processCalls).toBe(1);
		} finally {
			store.close();
		}
	});

	it("fails closed when a command executor is unavailable and rejects cross-workspace datasets", async () => {
		const store = new EvaluationStore(":memory:");
		try {
			let sequence = 0;
			const manager = new GatewayEvaluationManager({
				store,
				signer: new AttestationSigner(
					generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })
				),
				artifacts: {
					read: async () => {
						throw new Error("unused");
					},
					resolve: async () => ({}),
				},
				resolveProcess: () => undefined,
				idFactory: () => `generated-${++sequence}`,
				clock: () => 100 + sequence,
			});
			const commandGrader = [
				{ id: "command", label: "Regression tests", type: "command" as const, command: "npm test" },
			];
			const unavailable = await manager.evaluate({
				principalId: "user-1",
				idempotencyKey: "read-only-key",
				snapshot: snapshot("read_only"),
				runId: "run-1",
				trajectory: completedTrajectory(),
				name: "Read-only gates",
				graders: commandGrader,
			});
			expect(unavailable.evaluation).toMatchObject({
				status: "error",
				checks: [{ status: "error", evidence: expect.stringContaining("no isolated process executor") }],
			});

			const foreign = manager.createDataset({
				principalId: "user-1",
				idempotencyKey: "foreign-dataset-key",
				workspaceId: "workspace-2",
				name: "Foreign gates",
				graders: commandGrader,
			});
			await expect(
				manager.evaluate({
					principalId: "user-1",
					idempotencyKey: "foreign-evaluation-key",
					snapshot: snapshot(),
					runId: "run-1",
					trajectory: completedTrajectory(),
					datasetId: foreign.dataset.id,
				})
			).rejects.toThrow("another workspace");
		} finally {
			store.close();
		}
	});

	it("coalesces concurrent evaluation retries before executing command graders", async () => {
		const store = new EvaluationStore(":memory:");
		try {
			let sequence = 0;
			let processCalls = 0;
			let releaseCommand!: () => void;
			const commandGate = new Promise<void>((resolve) => {
				releaseCommand = resolve;
			});
			const manager = new GatewayEvaluationManager({
				store,
				signer: new AttestationSigner(
					generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })
				),
				artifacts: {
					read: async () => {
						throw new Error("unused");
					},
					resolve: async () => ({}),
				},
				resolveProcess: () => ({
					exec: async () => {
						processCalls += 1;
						await commandGate;
						return { exitCode: 0, stdout: "passed", stderr: "", truncated: false, timedOut: false };
					},
				}),
				idFactory: () => `generated-${++sequence}`,
				clock: () => 100 + sequence,
			});
			const base = {
				principalId: "user-1",
				idempotencyKey: "concurrent-key",
				snapshot: snapshot(),
				runId: "run-1",
				trajectory: completedTrajectory(),
				name: "Concurrent gates",
			};
			const first = manager.evaluate({
				...base,
				graders: [{ id: "command", label: "Tests", type: "command", command: "npm test" }],
			});
			const second = manager.evaluate({
				...base,
				graders: [{ id: "command", label: "Tests", type: "command", command: "npm test" }],
			});
			await expect(
				manager.evaluate({
					...base,
					graders: [{ id: "command", label: "Different", type: "command", command: "npm run lint" }],
				})
			).rejects.toThrow("already evaluating another command");
			expect(processCalls).toBe(1);
			releaseCommand();
			expect(await second).toEqual(await first);
			expect(processCalls).toBe(1);
		} finally {
			store.close();
		}
	});
});

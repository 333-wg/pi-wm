import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrajectoryEvent, trajectoryReport } from "@wuming/trajectory";
import { afterEach, describe, expect, it } from "vitest";
import {
	AttestationSigner,
	createEvaluationDataset,
	evaluateRun,
	EvaluationStore,
	verifyEvaluationAttestation,
	verifyEvaluationDataset,
	verifyRunEvaluation,
} from "../src/index.js";

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function report() {
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

const graders = [
	{
		id: "trajectory",
		label: "Trajectory is intact",
		type: "trajectory" as const,
		requireIntegrity: true,
		minStructuralScore: 50,
	},
	{
		id: "artifact-hash",
		label: "Artifact digest",
		type: "artifact" as const,
		artifactId: "artifact-1",
		assertion: { kind: "sha256" as const, expected: "a".repeat(64) },
	},
	{
		id: "artifact-text",
		label: "Contains result",
		type: "artifact" as const,
		artifactId: "artifact-1",
		assertion: { kind: "text_contains" as const, value: "verified result" },
	},
	{
		id: "artifact-json",
		label: "JSON assertion",
		type: "artifact" as const,
		artifactId: "artifact-2",
		assertion: { kind: "json_equals" as const, pointer: "/checks/0/status", expected: "pass" },
	},
	{
		id: "tests",
		label: "Tests pass",
		type: "command" as const,
		command: "npm test",
		expectedExitCode: 0,
		stdoutContains: "4 passed",
		stderrNotContains: "fatal",
	},
];

describe("run evaluation", () => {
	it("evaluates structural, artifact, JSON, and isolated command graders without persisting raw command output", async () => {
		let tick = 100;
		const evaluation = await evaluateRun({
			id: "evaluation-1",
			sessionId: "session-1",
			runId: "run-1",
			workspaceId: "workspace-1",
			name: "Release gates",
			graders,
			trajectory: report(),
			createdAt: tick,
			clock: () => ++tick,
			resolveArtifact: async (id) =>
				id === "artifact-1"
					? {
							id,
							name: "result.txt",
							mimeType: "text/plain",
							size: 15,
							sha256: "a".repeat(64),
							text: "Verified result",
						}
					: {
							id,
							name: "report.json",
							mimeType: "application/json",
							size: 30,
							sha256: "b".repeat(64),
							text: '{"checks":[{"status":"pass"}]}',
						},
			executeCommand: async () => ({
				exitCode: 0,
				stdout: "secret-token 4 passed",
				stderr: "",
				truncated: false,
				timedOut: false,
			}),
		});
		expect(evaluation).toMatchObject({
			status: "pass",
			specDigest: expect.stringMatching(/^sha256:/),
			trajectoryHeadDigest: report().replay.headDigest,
		});
		expect(evaluation.checks).toHaveLength(5);
		expect(evaluation.checks.every((check) => check.status === "pass")).toBe(true);
		expect(JSON.stringify(evaluation)).not.toContain("secret-token");
		expect(evaluation.checks.at(-1)?.outputDigest).toMatch(/^sha256:/);
		expect(verifyRunEvaluation(evaluation)).toBe(true);
		expect(verifyRunEvaluation({ ...evaluation, status: "fail" })).toBe(false);
	});

	it("reports unavailable execution and missing artifact evidence as errors", async () => {
		const evaluation = await evaluateRun({
			id: "evaluation-errors",
			sessionId: "session-1",
			runId: "run-1",
			workspaceId: "workspace-1",
			name: "Unavailable gates",
			graders: [graders[2]!, graders[4]!],
			trajectory: report(),
			createdAt: 1,
			clock: () => 2,
			resolveArtifact: async () => {
				throw new Error("Artifact belongs to another workspace");
			},
		});
		expect(evaluation.status).toBe("error");
		expect(evaluation.checks.map((check) => check.status)).toEqual(["error", "error"]);
	});
});

describe("evaluation persistence and attestations", () => {
	it("persists reusable datasets and signed evaluations across restart with idempotent mutations", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wuming-evaluation-"));
		cleanup.push(directory);
		const path = join(directory, "evaluations.sqlite");
		const dataset = createEvaluationDataset({
			id: "dataset-1",
			workspaceId: "workspace-1",
			name: "Release regression",
			graders,
			createdAt: 10,
			updatedAt: 10,
		});
		expect(verifyEvaluationDataset(dataset)).toBe(true);
		const evaluation = await evaluateRun({
			id: "evaluation-1",
			sessionId: "session-1",
			runId: "run-1",
			workspaceId: "workspace-1",
			name: dataset.name,
			datasetId: dataset.id,
			graders,
			trajectory: report(),
			createdAt: 20,
			clock: () => 21,
			resolveArtifact: async (id) =>
				id === "artifact-1"
					? {
							id,
							name: "result.txt",
							mimeType: "text/plain",
							size: 1,
							sha256: "a".repeat(64),
							text: "verified result",
						}
					: {
							id,
							name: "report.json",
							mimeType: "application/json",
							size: 1,
							sha256: "b".repeat(64),
							text: '{"checks":[{"status":"pass"}]}',
						},
			executeCommand: async () => ({
				exitCode: 0,
				stdout: "4 passed",
				stderr: "",
				truncated: false,
				timedOut: false,
			}),
		});
		const privateKey = generateKeyPairSync("ed25519").privateKey.export({
			type: "pkcs8",
			format: "pem",
		});
		const signer = new AttestationSigner(privateKey);
		const attestation = signer.create({ id: "attestation-1", evaluation, issuedAt: 30 });
		expect(verifyEvaluationAttestation(attestation)).toBe(true);
		expect(verifyEvaluationAttestation({ ...attestation, evaluationDigest: `sha256:${"f".repeat(64)}` })).toBe(false);

		const idempotency = {
			principalId: "user-1",
			key: "dataset-key",
			commandHash: "dataset-command",
			now: 10,
			expiresAt: 1000,
		};
		const store = new EvaluationStore(path);
		const created = store.createDataset(dataset, idempotency);
		expect(store.createDataset(dataset, idempotency)).toEqual(created);
		store.saveEvaluation(evaluation, {
			...idempotency,
			key: "evaluation-key",
			commandHash: "evaluation-command",
			now: 20,
		});
		store.saveAttestation(attestation, {
			...idempotency,
			key: "attestation-key",
			commandHash: "attestation-command",
			now: 30,
		});
		store.close();

		const reopened = new EvaluationStore(path);
		try {
			expect(reopened.listDatasets("workspace-1")).toEqual([dataset]);
			expect(reopened.listEvaluations("session-1", "run-1")).toEqual([evaluation]);
			expect(() => reopened.createDataset(dataset, { ...idempotency, commandHash: "different" })).toThrow(
				"Idempotency key"
			);
		} finally {
			reopened.close();
		}
	});
});

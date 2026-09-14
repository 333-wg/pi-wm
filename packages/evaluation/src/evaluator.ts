import type {
	EvaluationGrader,
	JsonValue,
	RunEvaluation,
	RunEvaluationCheck,
	TrajectoryReport,
} from "@wuming/protocol";
import { trajectoryDigest } from "@wuming/trajectory";
import { assertGraders } from "./dataset.js";

export interface EvaluationArtifactEvidence {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	sha256: string;
	text?: string;
	extractionNotice?: string;
}

export interface EvaluationCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
}

export interface EvaluateRunInput {
	id: string;
	sessionId: string;
	runId: string;
	workspaceId: string;
	name: string;
	graders: EvaluationGrader[];
	datasetId?: string;
	trajectory: TrajectoryReport;
	resolveArtifact: (artifactId: string) => Promise<EvaluationArtifactEvidence>;
	executeCommand?: (command: string, timeoutMs: number) => Promise<EvaluationCommandResult>;
	createdAt: number;
	clock?: () => number;
}

function bounded(value: string, max = 2000): string {
	const normalized = value.replaceAll("\0", "").trim();
	return (normalized || "No evidence was produced.").slice(0, max);
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
	return trajectoryDigest(left) === trajectoryDigest(right);
}

function jsonPointer(value: JsonValue, pointer: string): { found: boolean; value?: JsonValue } {
	if (pointer === "") return { found: true, value };
	let current: JsonValue = value;
	for (const raw of pointer.slice(1).split("/")) {
		const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
		if (Array.isArray(current)) {
			if (!/^(?:0|[1-9]\d*)$/.test(segment)) return { found: false };
			const index = Number(segment);
			if (index >= current.length) return { found: false };
			current = current[index]!;
			continue;
		}
		if (current === null || typeof current !== "object" || !(segment in current)) return { found: false };
		current = current[segment]!;
	}
	return { found: true, value: current };
}

async function evaluateGrader(input: EvaluateRunInput, grader: EvaluationGrader): Promise<RunEvaluationCheck> {
	const startedAt = input.clock?.() ?? Date.now();
	const finish = (
		value: Omit<RunEvaluationCheck, "graderId" | "label" | "type" | "durationMs">
	): RunEvaluationCheck => ({
		graderId: grader.id,
		label: grader.label.trim(),
		type: grader.type,
		...value,
		durationMs: Math.max(0, (input.clock?.() ?? Date.now()) - startedAt),
	});
	try {
		if (grader.type === "trajectory") {
			const integrityPass = grader.requireIntegrity === false || input.trajectory.replay.integrity;
			const score = input.trajectory.evaluation.score;
			const scorePass = grader.minStructuralScore === undefined || score >= grader.minStructuralScore;
			return finish({
				status: integrityPass && scorePass ? "pass" : "fail",
				evidence: bounded(
					`Trajectory integrity=${input.trajectory.replay.integrity}; structural score=${score}; required integrity=${grader.requireIntegrity !== false}; minimum score=${grader.minStructuralScore ?? "none"}.`
				),
				outputDigest: input.trajectory.evaluation.digest,
			});
		}
		if (grader.type === "artifact") {
			const artifact = await input.resolveArtifact(grader.artifactId);
			const base = { artifactId: artifact.id, artifactSha256: artifact.sha256 };
			switch (grader.assertion.kind) {
				case "exists":
					return finish({
						status: "pass",
						evidence: bounded(
							`Artifact ${artifact.name} exists, is readable, and passed SHA-256 object verification (${artifact.size} bytes).`
						),
						...base,
					});
				case "sha256": {
					const pass = artifact.sha256 === grader.assertion.expected;
					return finish({
						status: pass ? "pass" : "fail",
						evidence: bounded(`Artifact SHA-256 ${pass ? "matched" : "did not match"} the expected digest.`),
						...base,
					});
				}
				case "text_contains":
				case "text_not_contains": {
					if (artifact.text === undefined)
						return finish({
							status: "error",
							evidence: bounded(artifact.extractionNotice ?? "Artifact has no safely extractable text."),
							...base,
						});
					const source = grader.assertion.caseSensitive ? artifact.text : artifact.text.toLocaleLowerCase();
					const needle = grader.assertion.caseSensitive
						? grader.assertion.value
						: grader.assertion.value.toLocaleLowerCase();
					const contains = source.includes(needle);
					const pass = grader.assertion.kind === "text_contains" ? contains : !contains;
					return finish({
						status: pass ? "pass" : "fail",
						evidence: bounded(
							`Artifact text ${contains ? "contains" : "does not contain"} the configured ${grader.assertion.caseSensitive ? "case-sensitive" : "case-insensitive"} value.`
						),
						...base,
					});
				}
				case "json_equals": {
					if (artifact.text === undefined)
						return finish({
							status: "error",
							evidence: bounded(artifact.extractionNotice ?? "Artifact has no safely extractable text."),
							...base,
						});
					let parsed: JsonValue;
					try {
						parsed = JSON.parse(artifact.text) as JsonValue;
					} catch {
						return finish({ status: "error", evidence: "Artifact is not valid JSON.", ...base });
					}
					const selected = jsonPointer(parsed, grader.assertion.pointer);
					const pass = selected.found && sameJson(selected.value!, grader.assertion.expected);
					return finish({
						status: pass ? "pass" : "fail",
						evidence: bounded(
							selected.found
								? `JSON value at ${grader.assertion.pointer || "/"} ${pass ? "matched" : "did not match"} the expected value.`
								: `JSON pointer ${grader.assertion.pointer || "/"} was not found.`
						),
						...base,
					});
				}
			}
		}
		if (!input.executeCommand)
			return finish({
				status: "error",
				evidence: "Command evaluation is unavailable because no isolated process executor is configured.",
			});
		const result = await input.executeCommand(grader.command, grader.timeoutMs ?? 120_000);
		const outputDigest = trajectoryDigest({
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			truncated: result.truncated,
			timedOut: result.timedOut,
		});
		if (result.timedOut)
			return finish({
				status: "error",
				evidence: "Command evaluation exceeded its time limit.",
				outputDigest,
			});
		const exitPass = result.exitCode === (grader.expectedExitCode ?? 0);
		const stdoutPass = grader.stdoutContains === undefined || result.stdout.includes(grader.stdoutContains);
		const stderrPass = grader.stderrNotContains === undefined || !result.stderr.includes(grader.stderrNotContains);
		return finish({
			status: exitPass && stdoutPass && stderrPass ? "pass" : "fail",
			evidence: bounded(
				`Command exited ${result.exitCode ?? "without a code"}; expected ${grader.expectedExitCode ?? 0}; stdout assertion=${stdoutPass}; stderr assertion=${stderrPass}; output truncated=${result.truncated}.`
			),
			outputDigest,
		});
	} catch (error) {
		return finish({
			status: "error",
			evidence: bounded(error instanceof Error ? error.message : String(error)),
		});
	}
}

export async function evaluateRun(input: EvaluateRunInput): Promise<RunEvaluation> {
	assertGraders(input.graders);
	const name = input.name.trim();
	if (!name) throw new Error("Evaluation name cannot be empty");
	const spec = {
		name,
		graders: input.graders,
		...(input.datasetId === undefined ? {} : { datasetId: input.datasetId }),
	};
	const specDigest = trajectoryDigest(spec);
	const checks: RunEvaluationCheck[] = [];
	for (const grader of input.graders) checks.push(await evaluateGrader(input, grader));
	const status: RunEvaluation["status"] = checks.some((check) => check.status === "error")
		? "error"
		: checks.some((check) => check.status === "fail")
			? "fail"
			: "pass";
	const unsigned = {
		id: input.id,
		sessionId: input.sessionId,
		runId: input.runId,
		workspaceId: input.workspaceId,
		name,
		...(input.datasetId === undefined ? {} : { datasetId: input.datasetId }),
		graders: [...input.graders],
		specDigest,
		status,
		checks,
		trajectoryHeadDigest: input.trajectory.replay.headDigest,
		trajectoryEventCount: input.trajectory.replay.eventCount,
		createdAt: input.createdAt,
		finishedAt: input.clock?.() ?? Date.now(),
	};
	return Object.freeze({ ...unsigned, digest: trajectoryDigest(unsigned) });
}

export function verifyRunEvaluation(evaluation: RunEvaluation): boolean {
	try {
		const { digest, ...unsigned } = evaluation;
		return digest === trajectoryDigest(unsigned);
	} catch {
		return false;
	}
}

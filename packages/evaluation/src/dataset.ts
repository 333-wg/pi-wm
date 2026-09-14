import type { EvaluationDataset, EvaluationGrader } from "@wuming/protocol";
import { trajectoryDigest } from "@wuming/trajectory";

export function assertGraders(graders: readonly EvaluationGrader[]): void {
	if (graders.length < 1 || graders.length > 20) throw new Error("An evaluation requires between 1 and 20 graders");
	const ids = new Set<string>();
	for (const grader of graders) {
		if (ids.has(grader.id)) throw new Error(`Duplicate grader ID: ${grader.id}`);
		ids.add(grader.id);
		if (!grader.label.trim()) throw new Error(`Grader ${grader.id} has an empty label`);
		if (grader.type === "trajectory" && grader.requireIntegrity === false && grader.minStructuralScore === undefined) {
			throw new Error(`Trajectory grader ${grader.id} has no assertion`);
		}
	}
}

export function createEvaluationDataset(input: Omit<EvaluationDataset, "digest">): EvaluationDataset {
	const name = input.name.trim();
	if (!name) throw new Error("Evaluation dataset name cannot be empty");
	assertGraders(input.graders);
	const unsigned = { ...input, name, graders: [...input.graders] };
	return Object.freeze({ ...unsigned, digest: trajectoryDigest(unsigned) });
}

export function verifyEvaluationDataset(dataset: EvaluationDataset): boolean {
	try {
		const { digest, ...unsigned } = dataset;
		return digest === trajectoryDigest(unsigned) && createEvaluationDataset(unsigned).digest === digest;
	} catch {
		return false;
	}
}

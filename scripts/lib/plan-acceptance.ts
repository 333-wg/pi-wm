import { relative, resolve } from "node:path";

interface ToolEvidence {
	toolName: string;
	status: string;
	isError?: boolean;
	input: unknown;
}

function requireProof(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function record(value: unknown): Record<string, unknown> {
	requireProof(value !== null && typeof value === "object" && !Array.isArray(value), "Artifact must be a JSON object");
	return value as Record<string, unknown>;
}

export function verifyPlanArtifacts(leftValue: unknown, rightValue: unknown, reportValue: unknown): void {
	const left = record(leftValue),
		right = record(rightValue),
		report = record(reportValue);
	requireProof(left.value === 17 && right.value === 25 && report.sum === 42, "Plan artifact values do not match");
	requireProof(
		Object.keys(left).length === 1 && Object.keys(right).length === 1 && Object.keys(report).length === 2,
		"Unexpected artifact fields"
	);
	requireProof(
		JSON.stringify(report.sources) === JSON.stringify(["left.json", "right.json"]),
		"Report source references do not match"
	);
}

export function verifyPlanTools(stepId: string, tools: ToolEvidence[], workspace: string): void {
	requireProof(["left", "right", "merge"].includes(stepId), "Unknown acceptance step");
	const expected = stepId === "merge" ? "report.json" : stepId + ".json";
	const evidence = tools.map((tool) => {
		requireProof(["read_file", "write_file"].includes(tool.toolName), "Tool outside file-only acceptance scope");
		requireProof(tool.status === "complete" && !tool.isError, "Unsuccessful tool call");
		const input = record(tool.input);
		requireProof(typeof input.path === "string", "Tool path is missing");
		const path = relative(resolve(workspace), resolve(workspace, input.path));
		requireProof(["left.json", "right.json", "report.json"].includes(path), "Unexpected tool path");
		if (tool.toolName === "write_file") requireProof(path === expected, "Step wrote an unrelated artifact");
		return { name: tool.toolName, path };
	});
	let writeIndex = -1;
	for (let index = 0; index < evidence.length; index++) {
		if (evidence[index].name === "write_file" && evidence[index].path === expected) writeIndex = index;
	}
	requireProof(writeIndex >= 0, "Step lacks a successful expected file write");
	if (stepId === "merge") {
		for (const source of ["left.json", "right.json"])
			requireProof(
				evidence.slice(0, writeIndex).some((tool) => tool.name === "read_file" && tool.path === source),
				"Merge did not read both inputs before writing"
			);
		requireProof(
			evidence.slice(writeIndex + 1).some((tool) => tool.name === "read_file" && tool.path === "report.json"),
			"Merge did not verify its final output"
		);
	}
}

export class EvaluationError extends Error {
	constructor(
		readonly code: "not_found" | "conflict" | "corrupt_storage",
		message: string
	) {
		super(message);
		this.name = "EvaluationError";
	}
}

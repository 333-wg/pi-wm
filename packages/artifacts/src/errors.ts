export class ArtifactError extends Error {
	constructor(
		readonly code: "not_found" | "forbidden" | "invalid" | "too_large" | "corrupt",
		message: string,
	) {
		super(message);
		this.name = "ArtifactError";
	}
}

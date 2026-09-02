export class OrchestratorError extends Error {
	constructor(
		readonly code:
			| "not_found"
			| "conflict"
			| "idempotency_conflict"
			| "lease_conflict"
			| "lease_lost"
			| "budget_exceeded"
			| "corrupt_storage",
		message: string,
	) {
		super(message);
		this.name = "OrchestratorError";
	}
}

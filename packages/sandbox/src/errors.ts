export class SandboxError extends Error {
	constructor(
		readonly code:
			| "path_invalid"
			| "path_escape"
			| "file_too_large"
			| "edit_conflict"
			| "process_unavailable"
			| "process_failed"
			| "process_timeout"
			| "network_denied"
			| "network_failed"
			| "network_timeout"
			| "response_too_large"
			| "content_unsupported"
			| "approval_denied",
		message: string,
	) {
		super(message);
		this.name = "SandboxError";
	}
}

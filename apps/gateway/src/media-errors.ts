import { readMediaBody, type MediaConnection } from "./media-models.js";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Only diagnostic fields are retained; provider bodies may echo credentials or media. */
export function mediaErrorDetail(payload: unknown, config: MediaConnection): string {
	const root = record(payload);
	const detail =
		typeof payload === "string"
			? payload
			: typeof root.detail === "string"
				? root.detail
				: typeof root.error === "string"
					? root.error
					: typeof record(root.error).message === "string"
						? record(root.error).message
						: typeof root.message === "string"
							? root.message
							: "";
	if (typeof detail !== "string" || /<!doctype|<html|<script/i.test(detail)) return "";
	let safe = detail;
	for (const secret of [
		config.apiKey,
		encodeURIComponent(config.apiKey),
		Buffer.from(config.apiKey).toString("base64"),
		...(config.apiSecret
			? [config.apiSecret, encodeURIComponent(config.apiSecret), Buffer.from(config.apiSecret).toString("base64")]
			: []),
	])
		if (secret) safe = safe.split(secret).join("[redacted]");
	return safe
		.replace(/https?:\/\/[^\s"'<>]+/gi, "[url omitted]")
		.replace(/data:[^\s"'<>]+/gi, "[media omitted]")
		.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
		.replace(/\bToken\s+[^\s,;"']+/gi, "Token [redacted]")
		.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt redacted]")
		.replace(/\b(Signature|Credential)=[^\s,]+/gi, "$1=[redacted]")
		.replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)/g, "[redacted]")
		.replace(
			/\b(api[_-]?key|authorization|token|password|secret|cookie)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			"$1=[redacted]"
		)
		.replace(/\p{Cc}/gu, " ")
		.slice(0, 800)
		.trim();
}

export function mediaRetryAfter(value: string | null, now = Date.now()): number | undefined {
	if (!value?.trim()) return undefined;
	const text = value.trim();
	const ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
	return Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 - now ? ms : undefined;
}

export async function mediaResponseError(
	response: Response,
	config: MediaConnection,
	submission: boolean
): Promise<Error> {
	let detail = "";
	try {
		const text = (await readMediaBody(response, 32 * 1024)).toString("utf8");
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			payload = text;
		}
		detail = mediaErrorDetail(payload, config);
	} catch {
		/* The HTTP status remains useful when the body is oversized or unreadable. */
	}
	const guidance =
		response.status === 400 || response.status === 422
			? "Request parameters or API protocol are incompatible. Inspect the model capabilities and provider detail."
			: response.status === 401 || response.status === 403
				? "Check the saved credentials and model access."
				: response.status === 429
					? "Provider rate limit or quota exceeded."
					: "Check the provider status and API compatibility.";
	return Object.assign(
		new Error(
			"Media service returned HTTP " +
				response.status +
				". " +
				guidance +
				(detail ? " Provider detail (untrusted): " + detail : "") +
				(submission
					? " Do not automatically retry a billable generation or switch protocols. Report the failure before another submission."
					: " Retrieve this same job later; do not submit a new generation.")
		),
		{
			code: submission ? "media_submission_failed" : "media_retrieval_failed",
			details: {
				httpStatus: response.status,
				retryable: !submission && [429, 500, 502, 503, 504].includes(response.status),
				retryAfterMs: mediaRetryAfter(response.headers.get("retry-after")),
			},
		}
	);
}

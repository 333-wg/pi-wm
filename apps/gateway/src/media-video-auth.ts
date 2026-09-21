import { createHash, createHmac } from "node:crypto";
import type { MediaConnection } from "./media-models.js";
import type { VideoHttpRequest, VideoProtocol } from "./media-video-types.js";

export function validateVideoCredentials(config: MediaConnection, protocol: VideoProtocol): void {
	if (["jimeng", "kling"].includes(protocol) && !config.apiSecret?.trim())
		throw new Error(
			"This native video API requires Access Key and Secret Key in Settings; a chat API key is not sufficient"
		);
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();

export function videoAuthHeaders(
	config: MediaConnection,
	protocol: VideoProtocol,
	request: VideoHttpRequest,
	now = Date.now()
): Record<string, string> {
	validateVideoCredentials(config, protocol);
	if (protocol === "google-veo" || protocol === "google-omni")
		return {
			"x-goog-api-key": config.apiKey,
			...(protocol === "google-omni" &&
			request.resource instanceof URL &&
			request.resource.pathname.startsWith("/v1beta/interactions")
				? { "Api-Revision": "2026-05-20" }
				: {}),
		};
	if (protocol === "vidu") return { Authorization: "Token " + config.apiKey };
	if (protocol === "kling") {
		const seconds = Math.floor(now / 1000);
		const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
		const payload = Buffer.from(JSON.stringify({ iss: config.apiKey, exp: seconds + 1800, nbf: seconds - 5 })).toString(
			"base64url"
		);
		const content = header + "." + payload;
		return { Authorization: "Bearer " + content + "." + hmac(config.apiSecret!, content).toString("base64url") };
	}
	if (protocol !== "jimeng") return {};
	if (!(request.resource instanceof URL) || typeof request.body !== "string")
		throw new Error("Jimeng signing requires an explicit URL and JSON body");
	const url = request.resource;
	const timestamp = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, "");
	const date = timestamp.slice(0, 8);
	const hash = sha256(request.body);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Date": timestamp,
		"X-Content-Sha256": hash,
	};
	const signedHeaders = "content-type;host;x-content-sha256;x-date";
	const canonicalHeaders =
		"content-type:application/json\nhost:" + url.host + "\nx-content-sha256:" + hash + "\nx-date:" + timestamp + "\n";
	const query = [...url.searchParams.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
		.join("&");
	const canonical = ["POST", url.pathname, query, canonicalHeaders, signedHeaders, hash].join("\n");
	const scope = date + "/cn-north-1/cv/request";
	const toSign = ["HMAC-SHA256", timestamp, scope, sha256(canonical)].join("\n");
	const signingKey = hmac(hmac(hmac(hmac(config.apiSecret!, date), "cn-north-1"), "cv"), "request");
	return {
		...headers,
		Authorization:
			"HMAC-SHA256 Credential=" +
			config.apiKey +
			"/" +
			scope +
			", SignedHeaders=" +
			signedHeaders +
			", Signature=" +
			hmac(signingKey, toSign).toString("hex"),
	};
}

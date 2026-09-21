import type { VideoAdapter, VideoConnection, VideoParams, VideoProtocol, VideoResult } from "./media-video-types.js";
import { nativeVideoUrl } from "./media-video-native.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const origin = (config: VideoConnection, host: string) => new URL(config.baseUrl).origin === "https://" + host;
const google = (config: VideoConnection) => origin(config, "generativelanguage.googleapis.com");
export const isGoogleVideo = (protocol: VideoProtocol) => protocol === "google-veo" || protocol === "google-omni";
const note =
	"Native API contract tested with local fixtures, not a paid generation verification. No automatic model/protocol fallback.";
function checked(payload: Json): Json {
	if (payload.error)
		throw new Error(
			"Video provider rejected the request; inspect credentials/model permissions. Do not automatically resubmit."
		);
	return payload;
}
function size(params: VideoParams, supported: string[]): string | undefined {
	const value = params.size?.toUpperCase();
	if (value && !supported.includes(value))
		throw new Error("Unsupported video resolution; choose " + supported.join(", ") + ". No request submitted.");
	return value;
}
function ratio(params: VideoParams, supported: string[]): string | undefined {
	if (params.aspectRatio && !supported.includes(params.aspectRatio))
		throw new Error("Unsupported video aspect ratio; choose " + supported.join(", "));
	return params.aspectRatio;
}
function urlResult(value: unknown): VideoResult {
	if (typeof value !== "string" || !value.trim())
		throw new Error("Completed video has no output; retrieve this same job again, do not resubmit");
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Unsafe video output URL");
	return { status: "completed", url: value };
}
function opaqueId(value: string): string {
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid video task ID; do not resubmit");
	return value;
}

const veoModel = (model: string) => /^veo-3\.[01]-(?:(?:fast|lite)-)?generate-(?:preview|001)$/.test(model);
const veoSizes = (model: string) =>
	model.startsWith("veo-3.1-") && !model.includes("-lite-") ? ["720P", "1080P", "4K"] : ["720P", "1080P"];
const operationId = (value: string) =>
	/^models\/veo-3\.[01]-(?:(?:fast|lite)-)?generate-(?:preview|001)\/operations\/[A-Za-z0-9_-]{1,200}$/.test(value);
const veo: VideoAdapter = {
	protocol: "google-veo",
	// Unknown models on this native host are rejected below, never sent to /videos.
	matches: (config) => google(config) && !config.model.startsWith("gemini-omni-"),
	capabilities: (config) => ({
		protocol: "google-veo",
		validation: "documented",
		generationModes: ["text", "image"],
		durations: config.model.startsWith("veo-3.1-") ? [4, 6, 8] : [8],
		sizes: veoSizes(config.model),
		aspectRatios: ["16:9", "9:16"],
		referenceInputs: ["artifact"],
		artifactTransport: "base64",
		note:
			"Gemini Developer API key, not Vertex AI OAuth. Single local first frame only; public image URLs, extension and multiple references are not exposed. 1080P/4K requires 8 seconds. " +
			note,
	}),
	request(config, params, reference) {
		if (!veoModel(config.model))
			throw new Error(
				"Choose a supported Veo 3/3.1 model ID for Google Veo; other Google models need a different protocol"
			);
		const seconds = params.seconds ?? 8;
		if (!(config.model.startsWith("veo-3.1-") ? [4, 6, 8] : [8]).includes(seconds))
			throw new Error("Unsupported Veo duration for this model");
		const resolution = size(params, veoSizes(config.model));
		if (resolution && resolution !== "720P" && seconds !== 8)
			throw new Error("Veo 1080P/4K requires 8 seconds; duration was not changed");
		const aspect = ratio(params, ["16:9", "9:16"]);
		if (config.model.startsWith("veo-3.0-") && resolution === "1080P" && aspect === "9:16")
			throw new Error("Veo 3.0 1080P requires 16:9");
		if (reference && !["image/png", "image/jpeg"].includes(reference.mimeType))
			throw new Error("Veo first frame must be PNG or JPEG");
		return {
			protocol: "google-veo",
			json: true,
			resource: nativeVideoUrl(config, "/v1beta", "/models/" + config.model + ":predictLongRunning"),
			body: JSON.stringify({
				instances: [
					{
						prompt: params.prompt,
						...(reference
							? {
									image: {
										bytesBase64Encoded: Buffer.from(reference.content).toString("base64"),
										mimeType: reference.mimeType,
									},
								}
							: {}),
					},
				],
				parameters: {
					sampleCount: 1,
					durationSeconds: seconds,
					...(resolution ? { resolution: resolution.toLowerCase() } : {}),
					...(aspect ? { aspectRatio: aspect } : {}),
				},
			}),
			parameters: { seconds, ...(resolution ? { size: resolution } : {}), ...(aspect ? { aspectRatio: aspect } : {}) },
		};
	},
	remoteId: (payload) => checked(payload).name,
	validRemoteId: operationId,
	resultResource: (config, taskId) => {
		if (!operationId(taskId) || !taskId.startsWith("models/" + config.model + "/operations/"))
			throw new Error("Invalid or mismatched Veo operation name; do not guess a task URL");
		return nativeVideoUrl(config, "/v1beta", "/" + taskId);
	},
	result: (payload) => {
		if (payload.error) return { status: "failed" };
		if (payload.done === false || (payload.done === undefined && typeof payload.name === "string"))
			return { status: "pending" };
		if (payload.done !== true) throw new Error("Unsupported Veo operation state; do not resubmit");
		const generated = object(object(payload.response).generateVideoResponse);
		if (Number(generated.raiMediaFilteredCount) > 0 && !array(generated.generatedSamples).length)
			return { status: "failed" };
		return urlResult(object(object(array(generated.generatedSamples)[0]).video).uri);
	},
};

function omniVideo(payload: Json): Json {
	// SDK convenience output and raw Interactions REST steps are both recognized.
	if (payload.output_video) return object(payload.output_video);
	const content = array(payload.steps).flatMap((value) => {
		const step = object(value);
		return step.type === "model_output" ? array(step.content) : [];
	});
	return object(content.find((value) => object(value).type === "video"));
}
const interactionId = (value: string) => /^[A-Za-z0-9_-]{1,4096}$/.test(value);
const omni: VideoAdapter = {
	protocol: "google-omni",
	matches: (config) => google(config) && config.model.startsWith("gemini-omni-"),
	capabilities: () => ({
		protocol: "google-omni",
		validation: "documented",
		generationModes: ["text", "image"],
		durations: [3, 4, 5, 6, 7, 8, 9, 10],
		sizes: ["360P", "720P", "1080P", "4K"],
		aspectRatios: ["16:9", "9:16"],
		referenceInputs: ["artifact"],
		artifactTransport: "base64",
		note:
			"Gemini Interactions API with background=true/store=true. Single local image only. Video editing, extension and multi-reference inputs are not exposed. 1080P/4K are upscaled. " +
			note,
	}),
	request(config, params, reference) {
		if (config.model !== "gemini-omni-1.1-flash")
			throw new Error("Choose gemini-omni-1.1-flash for the documented Omni video adapter");
		const seconds = params.seconds;
		if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 3 || seconds > 10))
			throw new Error("Omni duration must be 3-10 integer seconds; duration was not changed");
		const resolution = size(params, ["360P", "720P", "1080P", "4K"]);
		const aspect = ratio(params, ["16:9", "9:16"]);
		return {
			protocol: "google-omni",
			json: true,
			resource: nativeVideoUrl(config, "/v1beta", "/interactions"),
			body: JSON.stringify({
				model: config.model,
				background: true,
				store: true,
				input: reference
					? [
							{ type: "image", data: Buffer.from(reference.content).toString("base64"), mime_type: reference.mimeType },
							{ type: "text", text: params.prompt },
						]
					: params.prompt,
				response_format: {
					type: "video",
					delivery: "uri",
					...(seconds !== undefined ? { duration: String(seconds) + "s" } : {}),
					...(resolution ? { resolution: resolution.toLowerCase() } : {}),
					...(aspect ? { aspect_ratio: aspect } : {}),
				},
			}),
			parameters: {
				...(seconds !== undefined ? { seconds } : {}),
				...(resolution ? { size: resolution } : {}),
				...(aspect ? { aspectRatio: aspect } : {}),
			},
		};
	},
	remoteId: (payload) => checked(payload).id,
	validRemoteId: interactionId,
	resultResource: (config, taskId) => {
		if (!interactionId(taskId)) throw new Error("Invalid Google interaction ID");
		return nativeVideoUrl(config, "/v1beta", "/interactions/" + taskId);
	},
	result: (payload) => {
		if (payload.error || ["failed", "cancelled", "canceled", "incomplete"].includes(String(payload.status)))
			return { status: "failed" };
		if (["in_progress", "queued"].includes(String(payload.status))) return { status: "pending" };
		if (payload.status !== "completed") throw new Error("Unsupported Omni interaction state; do not resubmit");
		const video = omniVideo(payload);
		if (typeof video.uri === "string") return urlResult(video.uri);
		if (typeof video.data === "string" && video.data && ["video/mp4", "video/webm"].includes(String(video.mime_type)))
			return { status: "completed", inlineData: { data: video.data, mimeType: String(video.mime_type) } };
		throw new Error("Completed Omni interaction has no video output; retrieve the same interaction, do not resubmit");
	},
};

const grok15Models = ["grok-imagine-video-1.5", "grok-imagine-video-1.5-preview", "grok-imagine-video-1.5-2026-05-30"];
const grok: VideoAdapter = {
	protocol: "grok",
	matches: (config) => origin(config, "api.x.ai"),
	capabilities: (config) => ({
		protocol: "grok",
		validation: "documented",
		generationModes: ["text", "image"],
		seconds: { min: 1, max: 15, default: 6 },
		sizes: grok15Models.includes(config.model) ? ["480P", "720P", "1080P"] : ["480P", "720P"],
		aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
		referenceInputs: ["artifact", "public-url"],
		artifactTransport: "data-url",
		note:
			"Text and single-image animation via videos/generations; reference-to-video, start/end frames, editing and audio controls are not exposed. An explicit aspectRatio stretches an image. " +
			note,
	}),
	request(config, params, reference) {
		if (!["grok-imagine-video", ...grok15Models].includes(config.model))
			throw new Error("Choose a Grok Imagine video model, not a Grok chat/image model");
		const seconds = params.seconds;
		if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > 15))
			throw new Error("Grok video duration must be 1-15 integer seconds");
		const resolution = size(params, grok.capabilities(config).sizes!);
		const aspect = ratio(params, grok.capabilities(config).aspectRatios!);
		const image = reference
			? "data:" + reference.mimeType + ";base64," + Buffer.from(reference.content).toString("base64")
			: params.referenceImageUrl;
		return {
			protocol: "grok",
			json: true,
			resource: nativeVideoUrl(config, "/v1", "/videos/generations"),
			body: JSON.stringify({
				model: config.model,
				prompt: params.prompt,
				...(seconds !== undefined ? { duration: seconds } : {}),
				...(resolution ? { resolution: resolution.toLowerCase() } : {}),
				...(aspect ? { aspect_ratio: aspect } : {}),
				...(image ? { image: { url: image } } : {}),
			}),
			parameters: {
				...(seconds !== undefined ? { seconds } : {}),
				...(resolution ? { size: resolution } : {}),
				...(aspect ? { aspectRatio: aspect } : {}),
			},
		};
	},
	remoteId: (payload) => checked(payload).request_id,
	resultResource: (config, taskId) => nativeVideoUrl(config, "/v1", "/videos/" + opaqueId(taskId)),
	result: (payload) => {
		if (payload.error || ["failed", "expired"].includes(String(payload.status))) return { status: "failed" };
		if (payload.status === "pending") return { status: "pending" };
		if (payload.status !== "done") throw new Error("Unsupported Grok video status; do not resubmit");
		const video = object(payload.video);
		if (video.respect_moderation === false) return { status: "failed" };
		return urlResult(video.url);
	},
};

export const internationalVideoAdapters: VideoAdapter[] = [omni, veo, grok];

/** Restrict API-key-bearing downloads to the configured Files API, never arbitrary URLs. */
export function googleVideoFile(config: VideoConnection, value: string): { download: URL; metadata: URL } | undefined {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Unsafe Google video URL");
	if (url.origin !== new URL(config.baseUrl).origin) return undefined;
	const match = /^\/(?:download\/)?(?:v1beta\/)?files\/([A-Za-z0-9_-]{1,200})(?::download)?$/.exec(url.pathname);
	if (!match || [...url.searchParams].some(([key, value]) => key !== "alt" || value !== "media"))
		throw new Error("Google credentials may only be sent to a validated Files API URL");
	return {
		metadata: nativeVideoUrl(config, "/v1beta", "/files/" + match[1]),
		download:
			url.pathname.endsWith(":download") && url.pathname.includes("/v1beta/")
				? url
				: nativeVideoUrl(config, "/v1beta", "/files/" + match[1] + ":download", { alt: "media" }),
	};
}

export function decodeInlineVideo(data: string, maxBytes: number): Buffer {
	if (
		!data ||
		data.length > Math.ceil(maxBytes / 3) * 4 ||
		data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(data)
	)
		throw new Error("Inline video is invalid or exceeds size limit");
	const bytes = Buffer.from(data, "base64");
	if (bytes.length > maxBytes || bytes.toString("base64") !== data)
		throw new Error("Inline video is invalid or exceeds size limit");
	return bytes;
}

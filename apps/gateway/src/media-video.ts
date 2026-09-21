import type {
	VideoProtocol,
	VideoConnection,
	VideoParams,
	VideoReference,
	VideoCapabilities,
	VideoRequest,
	VideoAdapter,
	VideoJobContext,
	VideoHttpRequest,
	VideoResult,
} from "./media-video-types.js";
import { nativeVideoAdapters } from "./media-video-native.js";
import { internationalVideoAdapters } from "./media-video-international.js";
export type { VideoProtocol, VideoParams, VideoReference, VideoCapabilities } from "./media-video-types.js";

const ratios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const officialAgnes = (config: VideoConnection) => {
	const url = new URL(config.baseUrl);
	return url.origin === "https://apihub.agnes-ai.com" && ["", "/v1"].includes(url.pathname.replace(/\/+$/, ""));
};
const agnes25 = (model: string) => /^agnes-video-2\.5(?:-flash)?$/.test(model);
const sora = (model: string) => /^sora-2(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
const flash = (model: string) => model === "agnes-video-2.5-flash";
// Verified by a completed reference-image generation, not just HTTP acceptance.
const verifiedAgnesDataUrl = (config: VideoConnection) => officialAgnes(config) && flash(config.model);
const agnesDataUrl = (config: VideoConnection) =>
	verifiedAgnesDataUrl(config) || config.videoReferenceFormat === "data-url";
const pixels = (size: string) => /^(\d{2,4})x(\d{2,4})$/.exec(size);

function aspectRatio(size: string): string {
	const match = pixels(size);
	if (!match || Number(match[1]) < 1 || Number(match[2]) < 1)
		throw new Error("Invalid video size; expected WIDTHxHEIGHT");
	const value = Number(match[1]) / Number(match[2]);
	const ratio = ratios.find((candidate) => {
		const [width, height] = candidate.split(":").map(Number);
		return Math.abs(value / (width! / height!) - 1) < 0.04;
	});
	if (!ratio) throw new Error("Unsupported video aspect ratio. Choose " + ratios.join(", "));
	return ratio;
}

function requestedRatio(params: VideoParams, fallback = "16:9"): string {
	const fromSize = params.size && pixels(params.size) ? aspectRatio(params.size) : undefined;
	if (params.aspectRatio && !ratios.includes(params.aspectRatio)) throw new Error("Unsupported video aspect ratio");
	if (fromSize && params.aspectRatio && fromSize !== params.aspectRatio)
		throw new Error("Video size and aspectRatio conflict; use one matching aspect ratio");
	return params.aspectRatio ?? fromSize ?? fallback;
}

function publicImageUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid reference image URL; use a publicly accessible HTTPS image");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname) ||
		/\.(local|localhost|internal)$/i.test(url.hostname)
	)
		throw new Error("Reference image requires a publicly accessible HTTPS URL, without credentials or fragments");
	return url.toString();
}

function validateReference(params: VideoParams, capabilities: VideoCapabilities): void {
	if (params.referenceArtifactId && params.referenceImageUrl)
		throw new Error("Choose referenceArtifactId or referenceImageUrl, not both");
	if (params.referenceArtifactId && !capabilities.referenceInputs.includes("artifact"))
		throw new Error(
			capabilities.referenceInputs.includes("public-url")
				? "This video API requires a public referenceImageUrl and cannot upload local attachments. Do not silently switch to text-only generation or publish the image to a third party. Use an existing public image URL or a model supporting artifact input."
				: "This video model does not support reference images. Choose an image-to-video model; do not silently discard the reference."
		);
	if (params.referenceImageUrl) {
		if (!capabilities.referenceInputs.includes("public-url"))
			throw new Error("This video adapter does not support public reference image URLs");
		publicImageUrl(params.referenceImageUrl);
	}
}

function referenceDataUrl(reference: VideoReference): string {
	return "data:" + reference.mimeType + ";base64," + Buffer.from(reference.content).toString("base64");
}

function agnesResult(config: VideoConnection, id: string): URL {
	const url = new URL("/agnesapi", config.baseUrl);
	url.searchParams.set("video_id", id);
	url.searchParams.set("model_name", config.model);
	return url;
}

const legacyAgnes: VideoAdapter = {
	protocol: "agnes",
	matches: (config) => officialAgnes(config) && config.model === "agnes-video-v2.0",
	capabilities: () => ({
		protocol: "agnes",
		validation: "documented",
		seconds: { min: 1, max: 18, default: 5 },
		referenceInputs: [],
		note: "Legacy Agnes adapter supports text-to-video only.",
	}),
	request(config, params) {
		const seconds = params.seconds ?? 5;
		if (!Number.isInteger(seconds) || seconds < 1 || seconds > 18)
			throw new Error("Agnes video supports 1-18 seconds at 24 fps. Choose a shorter duration before submitting.");
		const ratio = params.aspectRatio ? requestedRatio(params) : "3:2";
		const size =
			params.size ??
			{
				"16:9": "1280x720",
				"9:16": "720x1280",
				"1:1": "768x768",
				"4:3": "1024x768",
				"3:4": "768x1024",
				"21:9": "1344x576",
			}[ratio] ??
			"1152x768";
		const dimensions = pixels(size);
		if (!dimensions || Number(dimensions[1]) < 1 || Number(dimensions[2]) < 1)
			throw new Error("Invalid Agnes video size; expected WIDTHxHEIGHT");
		return {
			protocol: "agnes",
			json: true,
			parameters: { size, seconds },
			body: JSON.stringify({
				model: config.model,
				prompt: params.prompt,
				width: Number(dimensions[1]),
				height: Number(dimensions[2]),
				num_frames: seconds * 24 + 1,
				frame_rate: 24,
			}),
		};
	},
	resultResource: agnesResult,
	remoteId: (payload) => payload.video_id,
};

const modernAgnes: VideoAdapter = {
	protocol: "agnes-v2.5",
	matches: (config) => officialAgnes(config) && agnes25(config.model),
	capabilities: (config) => ({
		protocol: "agnes-v2.5",
		validation: verifiedAgnesDataUrl(config)
			? "verified"
			: config.videoReferenceFormat === "data-url"
				? "compatibility"
				: "documented",
		seconds: { min: 4, max: 12, default: 5 },
		sizes: flash(config.model) ? ["720P"] : ["720P", "1080P", "1K", "2K"],
		aspectRatios: [...ratios],
		referenceInputs: agnesDataUrl(config) ? ["artifact", "public-url"] : ["public-url"],
		...(agnesDataUrl(config) ? { artifactTransport: "data-url" as const } : {}),
		note: verifiedAgnesDataUrl(config)
			? "Base64 Data URL reference generation verified with official Flash on 2026-09-14. Local image artifacts are encoded automatically. Pixel sizes map to aspect ratio; resolution tiers do not guarantee exact output dimensions."
			: "Pixel dimensions are mapped to aspect ratio; omit size for 720P. Public reference URLs are documented. Base64 Data URL on this connection is an explicit compatibility override, not verified provider support.",
	}),
	request(config, params, reference) {
		const seconds = params.seconds ?? 5;
		if (!Number.isInteger(seconds) || seconds < 4 || seconds > 12)
			throw new Error("Agnes 2.5 video supports 4-12 seconds; duration was not changed or submitted");
		const ratio = requestedRatio(params);
		const size = params.size && !pixels(params.size) ? params.size.toUpperCase() : "720P";
		if (!modernAgnes.capabilities(config).sizes!.includes(size))
			throw new Error(
				"Unsupported video resolution for " +
					config.model +
					"; supported: " +
					modernAgnes.capabilities(config).sizes!.join(", ") +
					". No generation submitted."
			);
		if (params.referenceArtifactId && !reference) throw new Error("Reference image must be resolved before submission");
		const image = reference
			? referenceDataUrl(reference)
			: params.referenceImageUrl
				? publicImageUrl(params.referenceImageUrl)
				: undefined;
		const mode = image ? "reference" : "text";
		return {
			protocol: "agnes-v2.5",
			json: true,
			parameters: { size, aspectRatio: ratio, seconds, mode },
			body: JSON.stringify({
				model: config.model,
				prompt: params.prompt,
				seconds: String(seconds),
				size,
				aspect_ratio: ratio,
				mode,
				...(image ? { images: [image] } : {}),
			}),
		};
	},
	resultResource: agnesResult,
	remoteId: (payload) => payload.video_id,
};

function compatibleRequest(
	config: VideoConnection,
	params: VideoParams,
	protocol: "openai" | "openai-json",
	reference?: VideoReference
): VideoRequest {
	const known = sora(config.model);
	let size = params.size;
	const ratio = params.aspectRatio ? requestedRatio(params) : undefined;
	if (ratio || (size && !pixels(size))) {
		if (!known)
			throw new Error(
				"This compatible model has no declared resolution mapping. Use an explicit WIDTHxHEIGHT size instead of aspectRatio or a resolution tier."
			);
		if (size && !pixels(size) && size.toUpperCase() !== "720P")
			throw new Error("Unsupported Sora resolution tier; use a supported pixel size");
		if (ratio && ratio !== "16:9" && ratio !== "9:16")
			throw new Error("Sora supports landscape 16:9 or portrait 9:16; the requested aspect ratio was not changed");
		size = size && pixels(size) ? size : ratio === "16:9" ? "1280x720" : "720x1280";
	}
	if (size && (!pixels(size) || Number(pixels(size)![1]) < 1 || Number(pixels(size)![2]) < 1))
		throw new Error("Invalid video size; use WIDTHxHEIGHT");
	if (known && size && !["720x1280", "1280x720", "1024x1792", "1792x1024"].includes(size))
		throw new Error("Unsupported Sora size; choose 720x1280, 1280x720, 1024x1792 or 1792x1024");
	if (
		params.seconds !== undefined &&
		(!Number.isInteger(params.seconds) ||
			params.seconds < 1 ||
			params.seconds > 120 ||
			(known && ![4, 8, 12].includes(params.seconds)))
	)
		throw new Error(
			known
				? "Sora supports only 4, 8 or 12 seconds; duration was not changed"
				: "Invalid video duration; expected 1-120 integer seconds"
		);
	const fields = {
		model: config.model,
		prompt: params.prompt,
		...(size ? { size } : {}),
		...(params.seconds !== undefined ? { seconds: String(params.seconds) } : {}),
	};
	const parameters = {
		...(size ? { size } : {}),
		...(params.seconds !== undefined ? { seconds: params.seconds } : {}),
	};
	if (params.referenceArtifactId && !reference)
		throw new Error("Reference image must be resolved from an accessible workspace artifact before submission");
	if (protocol === "openai-json" || config.videoReferenceFormat === "data-url" || params.referenceImageUrl) {
		const image = reference
			? referenceDataUrl(reference)
			: params.referenceImageUrl
				? publicImageUrl(params.referenceImageUrl)
				: undefined;
		return {
			protocol,
			json: true,
			parameters,
			body: JSON.stringify({ ...fields, ...(image ? { input_reference: { image_url: image } } : {}) }),
		};
	}
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	if (params.referenceArtifactId && !reference)
		throw new Error("Reference image must be resolved from an accessible workspace artifact before submission");
	if (reference)
		form.set("input_reference", new Blob([reference.content], { type: reference.mimeType }), reference.name);
	return { protocol, body: form, json: false, parameters };
}

const compatible = (protocol: "openai" | "openai-json"): VideoAdapter => ({
	protocol,
	matches: () => false,
	capabilities: (config) => ({
		protocol,
		validation: sora(config.model) ? "documented" : "compatibility",
		...(sora(config.model)
			? {
					durations: [4, 8, 12],
					sizes: ["720x1280", "1280x720", "1024x1792", "1792x1024"],
					aspectRatios: ["16:9", "9:16"],
				}
			: {
					note: "OpenAI Videos-compatible transport, not proof of provider support. Omit optional parameters unless the provider supports them. Native provider APIs require a dedicated adapter.",
				}),
		referenceInputs: ["artifact", "public-url"],
		artifactTransport:
			protocol === "openai-json" || config.videoReferenceFormat === "data-url" ? "data-url" : "multipart",
	}),
	request: (config, params, reference) => compatibleRequest(config, params, protocol, reference),
	resultResource: (_config, id) => "videos/" + encodeURIComponent(id),
	remoteId: (payload) => payload.id,
});

// Transport selection is local and deterministic. Never probe by creating paid jobs.
const adapters: VideoAdapter[] = [
	...internationalVideoAdapters,
	...nativeVideoAdapters,
	legacyAgnes,
	modernAgnes,
	compatible("openai"),
	compatible("openai-json"),
];
export function videoProtocol(config: VideoConnection): VideoProtocol {
	if (config.videoProtocol && config.videoProtocol !== "auto") return config.videoProtocol;
	return adapters.find((adapter) => adapter.matches(config))?.protocol ?? "openai";
}
function adapterFor(protocol: VideoProtocol): VideoAdapter {
	const adapter = adapters.find((value) => value.protocol === protocol);
	if (!adapter) throw new Error("Unsupported saved video job protocol; do not create another job");
	return adapter;
}
export function videoCapabilities(config: VideoConnection): VideoCapabilities {
	const capabilities = adapterFor(videoProtocol(config)).capabilities(config);
	if (
		officialAgnes(config) &&
		config.model.startsWith("agnes-video") &&
		(!config.videoProtocol || config.videoProtocol === "auto") &&
		!adapters.some((adapter) => adapter.matches(config))
	)
		return {
			...capabilities,
			note: "This Agnes model has no known adapter. Generation is blocked until its API contract is supported or an explicit protocol is chosen in Settings.",
		};
	return capabilities;
}
export function validateVideoRequest(config: VideoConnection, params: VideoParams): void {
	if (
		officialAgnes(config) &&
		config.model.startsWith("agnes-video") &&
		(!config.videoProtocol || config.videoProtocol === "auto") &&
		!adapters.some((adapter) => adapter.matches(config))
	)
		throw new Error(
			"Unsupported Agnes video model; no automatic API guesses or paid requests were made. Check the model contract before selecting a protocol override in Settings."
		);
	validateReference(params, videoCapabilities(config));
	// Parameter validation is shared with serialization, before approval or file reads.
	// Native image-only models must see artifact intent even before the file is read.
	const adapter = adapterFor(videoProtocol(config));
	if (adapter.result) adapter.request(config, params);
	else {
		const { referenceArtifactId: _artifact, ...parameters } = params;
		adapter.request(config, parameters);
	}
}
export function videoRequest(config: VideoConnection, params: VideoParams, reference?: VideoReference): VideoRequest {
	validateVideoRequest(config, params);
	if (params.referenceArtifactId && !reference) throw new Error("Reference image must be resolved before submission");
	return adapterFor(videoProtocol(config)).request(config, params, reference);
}
export function videoRemoteId(protocol: VideoProtocol, payload: Record<string, unknown>): string {
	const adapter = adapterFor(protocol);
	const id = adapter.remoteId(payload);
	if (
		typeof id !== "string" ||
		!(adapter.validRemoteId ? adapter.validRemoteId(id) : /^[A-Za-z0-9_-]{1,200}$/.test(id))
	)
		throw new Error("Unsupported video response: expected a video task id. Do not resubmit automatically.");
	return id;
}
export function videoResultResource(config: VideoConnection, protocol: VideoProtocol, remoteId: string): string | URL {
	return adapterFor(protocol).resultResource(config, remoteId);
}
export function videoPollRequest(
	config: VideoConnection,
	protocol: VideoProtocol,
	remoteId: string,
	context?: VideoJobContext
): VideoHttpRequest {
	const adapter = adapterFor(protocol);
	return (
		adapter.pollRequest?.(config, remoteId, context) ?? { resource: adapter.resultResource(config, remoteId, context) }
	);
}
export function videoResult(protocol: VideoProtocol, payload: Record<string, unknown>): VideoResult {
	const adapter = adapterFor(protocol);
	if (adapter.result) return adapter.result(payload);
	const status = String(payload.status).toLowerCase();
	if (["failed", "cancelled", "canceled", "error"].includes(status)) return { status: "failed" };
	const agnes = protocol === "agnes" || protocol === "agnes-v2.5";
	if (status === "completed" || (agnes && ["succeeded", "success", "done"].includes(status))) {
		const metadata =
			payload.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>) : {};
		// Agnes also returns top-level url in live responses, despite its documented metadata.url contract.
		const url = agnes
			? (metadata.url ?? payload.url)
			: protocol === "openai-json"
				? (payload.url ?? metadata.url)
				: undefined;
		if (agnes && (typeof url !== "string" || !url.trim()))
			throw new Error(
				"Unsupported Agnes video result: expected metadata.url or url. Retrieve this job again; do not resubmit."
			);
		return { status: "completed", ...(typeof url === "string" && url.trim() ? { url } : {}) };
	}
	if (["queued", "in_progress", "pending", "processing"].includes(status)) return { status: "pending" };
	throw new Error("Unsupported video job status; do not resubmit");
}

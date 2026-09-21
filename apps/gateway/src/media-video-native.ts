import type {
	VideoAdapter,
	VideoConnection,
	VideoParams,
	VideoReference,
	VideoRequest,
	VideoResult,
	VideoJobContext,
} from "./media-video-types.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const first = (value: unknown): Json => object(Array.isArray(value) ? value[0] : undefined);
const imageIntent = (params: VideoParams) => Boolean(params.referenceArtifactId || params.referenceImageUrl);
const modelNote =
	"Native API contract, not a live generation verification. Model availability and optional parameter limits depend on the provider. No automatic model or protocol fallback.";
const hosts: Record<string, string[]> = {
	seedance: ["ark.cn-beijing.volces.com", "ark.ap-southeast.bytepluses.com"],
	jimeng: ["visual.volcengineapi.com"],
	kling: ["api.klingai.com", "api-beijing.klingai.com", "api-singapore.klingai.com"],
	wan: ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"],
	minimax: ["api.minimaxi.com", "api.minimax.io", "api.minimax.chat"],
	vidu: ["api.vidu.cn", "api.vidu.com"],
};
const matches = (protocol: string) => (config: VideoConnection) => {
	const url = new URL(config.baseUrl);
	return url.protocol === "https:" && !url.port && hosts[protocol]!.includes(url.hostname);
};

// Native API prefixes are explicit; never append /v1 to arbitrary native paths.
export function nativeVideoUrl(
	config: VideoConnection,
	prefix: string,
	path: string,
	query?: Record<string, string>
): URL {
	const url = new URL(config.baseUrl);
	const current = url.pathname.replace(/\/+$/, "");
	if (current && current !== prefix)
		throw new Error(
			"Native video Base URL must end at " +
				(prefix || "the origin") +
				"; do not use a chat/completions or compatibility endpoint"
		);
	url.pathname = prefix + path;
	url.search = new URLSearchParams(query).toString();
	return url;
}
function id(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value))
		throw new Error("Unsupported native video task/file ID; retrieve the same job, do not resubmit");
	return value;
}
function checked(payload: Json, successCode: number | undefined = undefined): Json {
	const base = object(payload.base_resp);
	if (
		(successCode !== undefined && payload.code !== undefined && String(payload.code) !== String(successCode)) ||
		(base.status_code !== undefined && String(base.status_code) !== "0") ||
		payload.error ||
		object(payload.ResponseMetadata).Error
	) {
		throw new Error(
			"Native video API rejected the request; check credentials, model permissions and parameters. Do not resubmit automatically."
		);
	}
	return payload;
}
function result(
	status: unknown,
	url: unknown,
	pending: string[],
	completed: string[],
	failed: string[],
	fileId?: unknown
): VideoResult {
	const value = String(status).toLowerCase();
	if (failed.includes(value)) return { status: "failed" };
	if (pending.includes(value)) return { status: "pending" };
	if (completed.includes(value)) {
		if (fileId !== undefined && fileId !== "") return { status: "completed", fileId: id(fileId) };
		if (typeof url !== "string" || !url.trim())
			throw new Error("Completed native video has no download URL; retrieve this job again, do not resubmit");
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || parsed.username || parsed.password)
			throw new Error("Unsafe video download URL");
		return { status: "completed", url };
	}
	throw new Error("Unsupported native video job status; do not resubmit");
}
function duration(params: VideoParams, choices?: number[], max = 120): number | undefined {
	const value = params.seconds;
	if (
		value !== undefined &&
		(!Number.isInteger(value) || value < 1 || value > max || (choices && !choices.includes(value)))
	)
		throw new Error(
			"Unsupported duration; supported: " + (choices?.join(", ") ?? "1-" + max) + " seconds. No request submitted."
		);
	return value;
}
function ratio(params: VideoParams, supported = ["16:9", "9:16", "1:1"], fallback?: string): string | undefined {
	if (params.aspectRatio && !supported.includes(params.aspectRatio))
		throw new Error("Unsupported native video aspect ratio");
	return params.aspectRatio ?? fallback;
}
function tier(params: VideoParams, supported: string[], fallback?: string): string | undefined {
	const value = params.size?.toUpperCase();
	if (value && !supported.includes(value))
		throw new Error(
			"Use a supported native resolution tier: " +
				supported.join(", ") +
				". Pixel dimensions are not silently converted."
		);
	return value ?? fallback;
}
function image(params: VideoParams, reference?: VideoReference, raw = false): string | undefined {
	if (!reference) return params.referenceImageUrl;
	const encoded = Buffer.from(reference.content).toString("base64");
	return raw ? encoded : "data:" + reference.mimeType + ";base64," + encoded;
}
function noRatio(params: VideoParams): void {
	if (params.aspectRatio)
		throw new Error(
			"This API mode derives aspect ratio from its input/default and has no aspectRatio parameter; omit it or use another supported mode"
		);
}
function request(
	protocol: VideoRequest["protocol"],
	resource: URL,
	body: Json,
	parameters: VideoRequest["parameters"],
	context?: VideoJobContext,
	headers?: Record<string, string>
): VideoRequest {
	return {
		protocol,
		resource,
		body: JSON.stringify(body),
		json: true,
		parameters,
		...(context ? { context } : {}),
		...(headers ? { headers } : {}),
	};
}

const seedance: VideoAdapter = {
	protocol: "seedance",
	matches: matches("seedance"),
	capabilities: () => ({
		protocol: "seedance",
		validation: "documented",
		sizes: ["480P", "720P", "1080P"],
		aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
		referenceInputs: ["artifact", "public-url"],
		artifactTransport: "data-url",
		note: modelNote,
	}),
	request(config, params, reference) {
		const seconds = duration(params);
		const resolution = tier(params, ["480P", "720P", "1080P"]);
		const aspect = ratio(params, ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
		const ref = image(params, reference);
		return request(
			"seedance",
			nativeVideoUrl(config, "/api/v3", "/contents/generations/tasks"),
			{
				model: config.model,
				content: [
					{ type: "text", text: params.prompt },
					...(ref ? [{ type: "image_url", image_url: { url: ref }, role: "first_frame" }] : []),
				],
				...(seconds !== undefined ? { duration: seconds } : {}),
				...(resolution ? { resolution: resolution.toLowerCase() } : {}),
				...(aspect ? { ratio: aspect } : {}),
			},
			{
				...(seconds !== undefined ? { seconds } : {}),
				...(resolution ? { size: resolution } : {}),
				...(aspect ? { aspectRatio: aspect } : {}),
			}
		);
	},
	remoteId: (payload) => checked(payload).id,
	resultResource: (config, taskId) => nativeVideoUrl(config, "/api/v3", "/contents/generations/tasks/" + id(taskId)),
	result: (payload) => {
		checked(payload);
		return result(
			payload.status,
			object(payload.content).video_url,
			["queued", "running"],
			["succeeded"],
			["failed", "cancelled", "canceled", "expired"]
		);
	},
};

const jimengModels = [
	"jimeng_t2v_v30",
	"jimeng_t2v_v30_1080p",
	"jimeng_i2v_first_v30",
	"jimeng_i2v_first_v30_1080",
	"jimeng_ti2v_v30_pro",
];
const jimengAction = (config: VideoConnection, action: string) =>
	nativeVideoUrl(config, "", "/", { Action: action, Version: "2022-08-31" });
const jimeng: VideoAdapter = {
	protocol: "jimeng",
	matches: matches("jimeng"),
	capabilities: (config) => ({
		protocol: "jimeng",
		validation: "documented",
		durations: [5, 10],
		referenceInputs: config.model.startsWith("jimeng_t2v_") ? [] : ["artifact", "public-url"],
		artifactTransport: "base64",
		note:
			"Model ID must be the exact req_key, e.g. jimeng_ti2v_v30_pro. Resolution is fixed by req_key. Static Access Key / Secret Key, cn-north-1 / cv signing. " +
			modelNote,
	}),
	request(config, params, reference) {
		if (!jimengModels.includes(config.model))
			throw new Error("Unsupported Jimeng req_key; select a documented video 3.0 text/first-frame/Pro model");
		const hasImage = imageIntent(params);
		if (config.model.startsWith("jimeng_i2v_") && !hasImage)
			throw new Error("This Jimeng model requires a reference image");
		if (config.model.startsWith("jimeng_t2v_") && hasImage)
			throw new Error("This Jimeng model supports text-to-video only");
		const seconds = duration(params, [5, 10]) ?? 5;
		const resolution = config.model.includes("1080") || config.model.endsWith("pro") ? "1080P" : "720P";
		tier(params, [resolution]);
		if (hasImage) noRatio(params);
		const aspect = hasImage ? undefined : ratio(params, ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
		const ref = image(params, reference, true);
		return request(
			"jimeng",
			jimengAction(config, "CVSync2AsyncSubmitTask"),
			{
				req_key: config.model,
				prompt: params.prompt,
				frames: seconds * 24 + 1,
				...(aspect ? { aspect_ratio: aspect } : {}),
				...(ref ? (reference ? { binary_data_base64: [ref] } : { image_urls: [ref] }) : {}),
			},
			{ seconds, size: resolution, mode: hasImage ? "image" : "text", ...(aspect ? { aspectRatio: aspect } : {}) }
		);
	},
	remoteId: (payload) => object(checked(payload, 10000).data).task_id,
	resultResource: (config) => jimengAction(config, "CVSync2AsyncGetResult"),
	pollRequest: (config, taskId) => ({
		resource: jimengAction(config, "CVSync2AsyncGetResult"),
		json: true,
		body: JSON.stringify({ req_key: config.model, task_id: id(taskId) }),
	}),
	result: (payload) => {
		const data = object(checked(payload, 10000).data);
		return result(
			data.status,
			data.video_url,
			["in_queue", "generating"],
			["done"],
			["not_found", "expired", "failed"]
		);
	},
};

const kling: VideoAdapter = {
	protocol: "kling",
	matches: matches("kling"),
	capabilities: () => ({
		protocol: "kling",
		validation: "documented",
		durations: [5, 10],
		aspectRatios: ["16:9", "9:16", "1:1"],
		referenceInputs: ["artifact", "public-url"],
		artifactTransport: "base64",
		note:
			"Standard text2video/image2video endpoints, pro mode. Omni, multi-shot, motion control and audio are not exposed. " +
			modelNote,
	}),
	request(config, params, reference) {
		if (!/^kling-v[123](?:[-.][\w-]+)?$/.test(config.model))
			throw new Error("Unsupported Kling model for text2video/image2video; Omni/O-series needs a separate contract");
		if (params.size)
			throw new Error("Kling native API uses quality mode, not pixel size or resolution tier; omit size");
		const hasImage = imageIntent(params);
		if (hasImage) noRatio(params);
		const seconds = duration(params, [5, 10]) ?? 5;
		const aspect = hasImage ? undefined : ratio(params);
		const ref = image(params, reference, true);
		return request(
			"kling",
			nativeVideoUrl(config, "/v1", "/videos/" + (hasImage ? "image2video" : "text2video")),
			{
				model_name: config.model,
				prompt: params.prompt,
				mode: "pro",
				duration: String(seconds),
				...(ref ? { image: ref } : {}),
				...(aspect ? { aspect_ratio: aspect } : {}),
			},
			{ seconds, mode: "pro", ...(aspect ? { aspectRatio: aspect } : {}) },
			{ mode: hasImage ? "image" : "text" }
		);
	},
	remoteId: (payload) => object(checked(payload, 0).data).task_id,
	resultResource: (config, taskId, context) => {
		if (!context?.mode || !["image", "text"].includes(context.mode))
			throw new Error("Missing saved Kling task mode; do not guess a polling endpoint");
		return nativeVideoUrl(
			config,
			"/v1",
			"/videos/" + (context.mode === "image" ? "image2video/" : "text2video/") + id(taskId)
		);
	},
	result: (payload) => {
		const data = object(checked(payload, 0).data);
		return result(
			data.task_status,
			first(object(data.task_result).videos).url,
			["submitted", "processing"],
			["succeed"],
			["failed"]
		);
	},
};

const wanSizes: Record<string, Record<string, string>> = {
	"480P": { "16:9": "832*480", "9:16": "480*832", "1:1": "624*624" },
	"720P": { "16:9": "1280*720", "9:16": "720*1280", "1:1": "960*960" },
	"1080P": { "16:9": "1920*1080", "9:16": "1080*1920", "1:1": "1440*1440" },
};
const wan: VideoAdapter = {
	protocol: "wan",
	matches: matches("wan"),
	capabilities: (config) => ({
		protocol: "wan",
		validation: "documented",
		generationModes: config.model.includes("-i2v") ? ["image"] : ["text"],
		sizes: ["480P", "720P", "1080P"],
		aspectRatios: config.model.includes("-i2v") ? [] : ["16:9", "9:16", "1:1"],
		referenceInputs: config.model.includes("-i2v") ? ["artifact", "public-url"] : [],
		artifactTransport: "data-url",
		note:
			"Wan text-to-video and first-frame image-to-video only; choose a matching -t2v/-i2v model. R2V, editing and first/last-frame models are not exposed. " +
			modelNote,
	}),
	request(config, params, reference) {
		if (!/^wan[\d.]+-(t2v|i2v)(?:-|$)/.test(config.model))
			throw new Error("Choose a Wan -t2v or -i2v model; other generation modes require a separate adapter");
		const hasImage = imageIntent(params);
		if (config.model.includes("-i2v") !== hasImage)
			throw new Error("Wan model/input mismatch: -i2v requires a reference image; -t2v does not accept one");
		const seconds = duration(params);
		const resolution = tier(params, ["480P", "720P", "1080P"]);
		if (hasImage) noRatio(params);
		const aspect = hasImage ? undefined : ratio(params);
		const ref = image(params, reference);
		const size = !hasImage && (resolution || aspect) ? wanSizes[resolution ?? "720P"]![aspect ?? "16:9"] : undefined;
		return request(
			"wan",
			nativeVideoUrl(config, "/api/v1", "/services/aigc/video-generation/video-synthesis"),
			{
				model: config.model,
				input: { prompt: params.prompt, ...(ref ? { img_url: ref } : {}) },
				parameters: {
					...(seconds !== undefined ? { duration: seconds } : {}),
					...(hasImage && resolution ? { resolution } : {}),
					...(size ? { size } : {}),
				},
			},
			{
				...(seconds !== undefined ? { seconds } : {}),
				...(resolution ? { size: resolution } : {}),
				...(aspect ? { aspectRatio: aspect } : {}),
			},
			undefined,
			{ "X-DashScope-Async": "enable" }
		);
	},
	remoteId: (payload) => {
		if (payload.code) throw new Error("Wan rejected submission; do not resubmit");
		return object(payload.output).task_id;
	},
	resultResource: (config, taskId) => nativeVideoUrl(config, "/api/v1", "/tasks/" + id(taskId)),
	result: (payload) => {
		if (payload.code) throw new Error("Wan query failed; retrieve the same job later");
		const data = object(payload.output);
		return result(
			data.task_status,
			data.video_url,
			["pending", "running"],
			["succeeded"],
			["failed", "canceled", "cancelled", "unknown"]
		);
	},
};

const h3 = (model: string) => model === "MiniMax-H3" || model === "MiniMax-H3-Max";
function minimaxUrl(config: VideoConnection, path: string, query?: Record<string, string>): URL {
	const url = new URL(config.baseUrl);
	if (!["", "/v1", "/v2"].includes(url.pathname.replace(/\/+$/, "")))
		throw new Error("MiniMax Base URL must end at the origin, /v1 or /v2");
	return nativeVideoUrl({ ...config, baseUrl: url.origin }, "", path, query);
}
const minimaxSizes = (model: string): string[] =>
	model === "MiniMax-H3"
		? ["768P", "2K"]
		: model === "MiniMax-H3-Max"
			? ["480P", "768P"]
			: model.startsWith("MiniMax-Hailuo-")
				? ["768P", "1080P"]
				: ["720P"];
const minimax: VideoAdapter = {
	protocol: "minimax",
	matches: matches("minimax"),
	capabilities: (config) => ({
		protocol: "minimax",
		validation: "documented",
		generationModes: config.model.startsWith("T2V-")
			? ["text"]
			: config.model.startsWith("I2V-") || config.model.endsWith("-Fast")
				? ["image"]
				: ["text", "image"],
		sizes: minimaxSizes(config.model),
		...(h3(config.model)
			? {
					seconds: { min: config.model.endsWith("Max") ? 5 : 4, max: 15, default: 5 },
					aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
				}
			: { durations: config.model.startsWith("MiniMax-Hailuo-") ? [6, 10] : [6], aspectRatios: [] }),
		referenceInputs: config.model.startsWith("T2V-") ? [] : ["artifact", "public-url"],
		artifactTransport: "data-url",
		note:
			"H3 uses V2 content/tasks; Hailuo/T2V/I2V uses V1 plus file retrieval. Only text and first-frame generation are exposed. " +
			modelNote,
	}),
	request(config, params, reference) {
		if (h3(config.model)) {
			const hasImage = imageIntent(params);
			if (hasImage) noRatio(params);
			const seconds = duration(params, undefined, 15) ?? 5;
			if (seconds < (config.model.endsWith("Max") ? 5 : 4)) throw new Error("Unsupported H3 duration for this model");
			const resolution = tier(params, minimaxSizes(config.model), "768P")!;
			const aspect = hasImage ? "adaptive" : ratio(params, ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "16:9")!;
			const ref = image(params, reference);
			return request(
				"minimax",
				minimaxUrl(config, "/v2/video_generation"),
				{
					model: config.model,
					content: [
						{ type: "text", text: params.prompt },
						...(ref ? [{ type: "image_url", image_url: { url: ref }, role: "first_frame" }] : []),
					],
					resolution,
					duration: seconds,
					ratio: aspect,
				},
				{ seconds, size: resolution, aspectRatio: aspect }
			);
		}
		if (!/^(MiniMax-Hailuo-|T2V-01|I2V-01)/.test(config.model))
			throw new Error("Unsupported MiniMax video_generation model; select a documented Hailuo/T2V/I2V model");
		const hasImage = imageIntent(params);
		if ((config.model.startsWith("I2V-") || config.model.endsWith("-Fast")) && !hasImage)
			throw new Error("This MiniMax model requires a reference image");
		if (config.model.startsWith("T2V-") && hasImage)
			throw new Error("This MiniMax T2V model does not accept a reference image");
		noRatio(params);
		if (params.prompt.length > 2000) throw new Error("MiniMax V1 prompt exceeds 2000 characters");
		const seconds = duration(params, config.model.startsWith("MiniMax-Hailuo-") ? [6, 10] : [6]);
		const resolution = tier(params, minimaxSizes(config.model));
		if (resolution === "1080P" && seconds === 10) throw new Error("MiniMax 1080P supports 6 seconds, not 10");
		const ref = image(params, reference);
		return request(
			"minimax",
			minimaxUrl(config, "/v1/video_generation"),
			{
				model: config.model,
				prompt: params.prompt,
				...(seconds !== undefined ? { duration: seconds } : {}),
				...(resolution ? { resolution } : {}),
				...(ref ? { first_frame_image: ref } : {}),
			},
			{ ...(seconds !== undefined ? { seconds } : {}), ...(resolution ? { size: resolution } : {}) }
		);
	},
	remoteId: (payload) => checked(payload).task_id,
	resultResource: (config, taskId) =>
		h3(config.model)
			? minimaxUrl(config, "/v2/query/video_generation/" + id(taskId))
			: minimaxUrl(config, "/v1/query/video_generation", { task_id: id(taskId) }),
	result: (payload) => {
		checked(payload);
		if (payload.task) {
			const task = object(payload.task);
			return result(
				task.status,
				object(task.content).url,
				["queued", "running"],
				["succeeded"],
				["failed", "cancelled"]
			);
		}
		return result(
			payload.status,
			undefined,
			["preparing", "queueing", "processing"],
			["success"],
			["fail", "failed"],
			payload.file_id
		);
	},
};
export function minimaxFileRequest(config: VideoConnection, fileId: string): URL {
	return minimaxUrl(config, "/v1/files/retrieve", { file_id: id(fileId) });
}
export function minimaxFileUrl(payload: Json): string {
	checked(payload);
	return result("completed", object(payload.file).download_url, [], ["completed"], []).url!;
}

const viduTextModels = ["viduq3-pro", "viduq3-turbo", "viduq2", "viduq1"];
const viduImageModels = [
	"viduq3-pro",
	"viduq3-turbo",
	"viduq3-pro-fast",
	"viduq2-pro-fast",
	"viduq2-pro",
	"viduq2-turbo",
	"viduq1",
	"viduq1-classic",
	"vidu2.0",
];
const viduSizes = (model: string, seconds?: number): string[] =>
	model.startsWith("viduq1")
		? ["1080P"]
		: model === "vidu2.0"
			? seconds === 8
				? ["720P"]
				: ["360P", "720P", "1080P"]
			: model.endsWith("-fast")
				? ["720P", "1080P"]
				: ["540P", "720P", "1080P"];
const vidu: VideoAdapter = {
	protocol: "vidu",
	matches: matches("vidu"),
	capabilities: (config) => ({
		protocol: "vidu",
		validation: "documented",
		generationModes: [
			...(viduTextModels.includes(config.model) ? ["text" as const] : []),
			...(viduImageModels.includes(config.model) ? ["image" as const] : []),
		],
		sizes: viduSizes(config.model),
		aspectRatios: config.model.startsWith("viduq1") ? ["16:9", "9:16", "1:1"] : ["16:9", "9:16", "1:1", "3:4", "4:3"],
		referenceInputs: viduImageModels.includes(config.model) ? ["artifact", "public-url"] : [],
		artifactTransport: "data-url",
		note:
			"Text-to-video and single-image animation. Reference-to-video, templates and start/end frames are not exposed. " +
			modelNote,
	}),
	request(config, params, reference) {
		const hasImage = imageIntent(params);
		if (!(hasImage ? viduImageModels : viduTextModels).includes(config.model))
			throw new Error(
				"This Vidu model does not support the requested text/image endpoint; choose a matching model, do not silently switch it"
			);
		if (params.prompt.length > 5000) throw new Error("Vidu prompt exceeds 5000 characters");
		if (hasImage) noRatio(params);
		const seconds = duration(
			params,
			config.model.startsWith("viduq1") ? [5] : config.model === "vidu2.0" ? [4, 8] : undefined,
			config.model.startsWith("viduq3") ? 16 : 10
		);
		const resolution = tier(params, viduSizes(config.model, seconds));
		const aspect = hasImage
			? undefined
			: ratio(
					params,
					config.model.startsWith("viduq1") ? ["16:9", "9:16", "1:1"] : ["16:9", "9:16", "1:1", "3:4", "4:3"]
				);
		const ref = image(params, reference);
		return request(
			"vidu",
			nativeVideoUrl(config, "/ent/v2", hasImage ? "/img2video" : "/text2video"),
			{
				model: config.model,
				prompt: params.prompt,
				...(ref ? { images: [ref] } : {}),
				...(seconds !== undefined ? { duration: seconds } : {}),
				...(resolution ? { resolution: resolution.toLowerCase() } : {}),
				...(aspect ? { aspect_ratio: aspect } : {}),
			},
			{
				...(seconds !== undefined ? { seconds } : {}),
				...(resolution ? { size: resolution } : {}),
				...(aspect ? { aspectRatio: aspect } : {}),
			}
		);
	},
	remoteId: (payload) => checked(payload).task_id,
	resultResource: (config, taskId) => nativeVideoUrl(config, "/ent/v2", "/tasks/" + id(taskId) + "/creations"),
	result: (payload) => {
		checked(payload);
		return result(
			payload.state,
			first(payload.creations).url,
			["created", "queueing", "processing"],
			["success"],
			["failed"]
		);
	},
};

export const nativeVideoAdapters: VideoAdapter[] = [seedance, jimeng, kling, wan, minimax, vidu];

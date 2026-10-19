import type { MediaModelSettings } from "@wuming/protocol";

type ImageConnection = Pick<MediaModelSettings, "baseUrl" | "model" | "imageProtocol">;
export interface ImageParams {
	prompt: string;
	size?: string;
	quality?: string;
	aspectRatio?: string;
	resolution?: string;
	referenceArtifactId?: string;
}
export interface ImageReference {
	content: Buffer;
	mimeType: string;
	name: string;
}
const ratios = [
	"auto",
	"1:1",
	"16:9",
	"9:16",
	"4:3",
	"3:4",
	"3:2",
	"2:3",
	"2:1",
	"1:2",
	"19.5:9",
	"9:19.5",
	"20:9",
	"9:20",
	"21:9",
	"5:2",
];

export function imageProtocol(config: ImageConnection): "openai" | "grok" {
	if (config.imageProtocol && config.imageProtocol !== "auto") return config.imageProtocol;
	// A relay's model name does not prove its transport. Explicit selection is available in settings.
	return new URL(config.baseUrl).hostname === "api.x.ai" ? "grok" : "openai";
}

export function imageCapabilities(config: ImageConnection): {
	protocol: "openai" | "grok";
	validation: "documented";
	generationModes: string[];
	aspectRatios?: string[];
	resolutions?: string[];
	qualities?: string[];
	referenceTransport: string;
	note: string;
} {
	const protocol = imageProtocol(config);
	const legacy = /(?:^|\/)grok-2-image(?:-|$)/i.test(config.model);
	return {
		protocol,
		validation: "documented",
		generationModes: protocol === "grok" && legacy ? ["text"] : ["text", "reference"],
		...(protocol === "grok"
			? {
					aspectRatios: legacy ? [] : ratios,
					resolutions: legacy ? [] : ["1k", "2k"],
					qualities: config.model === "grok-imagine-image-2.0" ? ["auto", "low", "medium"] : [],
					referenceTransport: "data-url",
					note: "Use aspectRatio/resolution, not pixel size. Quality is model-specific. Relay compatibility requires provider confirmation; no paid probe or automatic fallback.",
				}
			: {
					referenceTransport: "multipart",
					note: "OpenAI Images-compatible; size, quality and editing support depend on the selected model/service.",
				}),
	};
}

export function validateImageRequest(config: ImageConnection, params: ImageParams): void {
	if (imageProtocol(config) === "openai") {
		if (params.aspectRatio !== undefined || params.resolution !== undefined)
			throw new Error("OpenAI Images uses size; aspectRatio/resolution require the Grok image protocol in Settings");
		return;
	}
	const capabilities = imageCapabilities(config);
	if (params.size !== undefined)
		throw new Error(
			"Grok images use aspectRatio and resolution, not size; omit size rather than silently converting pixel dimensions"
		);
	if (params.aspectRatio !== undefined && !capabilities.aspectRatios?.includes(params.aspectRatio))
		throw new Error("Unsupported Grok image aspectRatio for this model");
	if (params.resolution !== undefined && !capabilities.resolutions?.includes(params.resolution))
		throw new Error("Unsupported Grok image resolution for this model; use 1k or 2k");
	if (params.quality !== undefined && !capabilities.qualities?.includes(params.quality))
		throw new Error("Unsupported Grok image quality for this model; omit quality to use the provider default");
	if (params.referenceArtifactId && !capabilities.generationModes.includes("reference"))
		throw new Error("This Grok image model does not support reference-image editing");
}

export function imageRequest(
	config: ImageConnection,
	params: ImageParams,
	reference?: ImageReference
): { resource: string; body: BodyInit; json: boolean } {
	validateImageRequest(config, params);
	const resource = reference ? "images/edits" : "images/generations";
	if (imageProtocol(config) === "grok") {
		if (reference && !["image/png", "image/jpeg", "image/webp"].includes(reference.mimeType))
			throw new Error("Grok reference images must be PNG, JPEG or WebP");
		return {
			resource,
			json: true,
			body: JSON.stringify({
				model: config.model,
				prompt: params.prompt,
				n: 1,
				...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
				...(params.resolution ? { resolution: params.resolution } : {}),
				...(params.quality ? { quality: params.quality } : {}),
				...(reference
					? {
							image: {
								url: `data:${reference.mimeType};base64,${reference.content.toString("base64")}`,
								type: "image_url",
							},
						}
					: {}),
			}),
		};
	}
	const fields = {
		model: config.model,
		prompt: params.prompt,
		n: 1,
		...(params.size ? { size: params.size } : {}),
		...(params.quality ? { quality: params.quality } : {}),
	};
	if (!reference) return { resource, json: true, body: JSON.stringify(fields) };
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
	form.set("image", new Blob([new Uint8Array(reference.content)], { type: reference.mimeType }), reference.name);
	return { resource, json: false, body: form };
}

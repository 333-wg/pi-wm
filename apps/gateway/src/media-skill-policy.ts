import { createHash } from "node:crypto";
import type { ContextFragment } from "@wuming/context-engine";
import type { MediaModelSettings } from "@wuming/protocol";
import { videoCapabilities } from "./media-video.js";

export type MediaDefaults = ReadonlyArray<
	Pick<MediaModelSettings, "kind"> &
		Partial<
			Pick<
				MediaModelSettings,
				"model" | "models" | "baseUrl" | "videoProtocol" | "videoReferenceFormat" | "provider" | "availableModels"
			>
		>
>;

const allMediaTools: ReadonlySet<string> = new Set([
	"media_model_status",
	"generate_image",
	"get_generated_image",
	"generate_video",
	"get_generated_video",
]);

function mediaInvocationGuidance(tools: ReadonlySet<string>): string {
	const available = ["generate_image", "generate_video", "get_generated_video", "get_generated_image"].filter((name) =>
		tools.has(name)
	);
	return available.length
		? `Use only registered media tools: ${available.join(" / ")}. Use existing host defaults subject to session permissions. Missing generation or retrieval controls are unavailable; report the limitation instead of substituting provider scripts or another billable submission.`
		: "Media execution is unavailable in this session. Report the limitation; do not obtain credentials, run provider scripts or use another tool to bypass the restriction.";
}

export function mediaSkillRoutingPolicy(tools: ReadonlySet<string> = allMediaTools): string {
	return [
		"WUMING MANAGED MEDIA: model configuration is owned by this host, not by individual skills. This integration rule applies to every installed/local/learned/authored skill, including manually selected skills and their references.",
		"For image/video model calls only, preserve the skill's creative workflow, prompt construction, style, composition, storyboard and relevant generation parameters. Replace ONLY its media-provider setup and model invocation steps with available host controls. The user does not need to modify or configure the skill for this adaptation. Do not generate media for unrelated tasks or alter configuration rules for unrelated services.",
		mediaInvocationGuidance(tools),
		"Do not ask the user for another API key, endpoint, model or provider account. Do not configure environment variables, .env files, SDK credentials or skill-specific model settings. Do not run or rewrite a skill's provider API script merely to generate media. Never expose the host's secrets to a skill or subprocess.",
		...(tools.has("generate_image")
			? [
					`All added image models are available across services, not only the default service. Omit generate_image.model and provider to use the default; when the user requests another model, select its model ID and provider from ${tools.has("media_model_status") ? "media_model_status.availableModels" : "the current host defaults in context; if unavailable, report that model selection cannot be verified"}. IDs may repeat across services, so include provider to disambiguate. A skill's hard-coded model is not a user override. Never fan out to every available model or retry with another model automatically; each generation may incur charges.`,
				]
			: []),
		...(tools.has("generate_video")
			? [
					"All added video models are also available across services. Omit generate_video.model and provider for the default, or select an available model and provider when requested. Check that specific model's videoCapabilities. Existing jobs remain tied to the service that accepted them even if the default changes. Never resubmit or switch services automatically after an error.",
					"Video defaults include the actual defaultModel and videoCapabilities. Configured means saved, not tested. Respect supported durations, sizes and referenceInputs. Use aspectRatio only when supported for the requested generation mode; otherwise omit it. Native image-to-video modes may inherit the image shape. Prefer the default resolution. Check generationModes before choosing text or image input. Pass referenceArtifactId for the user's attached/generated image; the host handles file upload or Base64. Do not put Base64 in prompts or tool arguments, invent public URLs, publish private images, or replace image-to-video with text-only generation.",
				]
			: []),
		...(tools.has("generate_image") || tools.has("get_generated_image")
			? [
					"Image retrieval_pending means the provider returned a result but downloading or saving it failed, not that generation failed. " +
						(tools.has("get_generated_image")
							? "Use get_generated_image with the saved jobId once to recover without another generation charge; after an interruption it can recover the latest result without a jobId. "
							: "Image retrieval is unavailable in this session; report the limitation. ") +
						"If retrieval is still pending, explain the download problem and wait for user direction. Never resubmit image generation, change the prompt/model, or bypass network safety checks as a recovery strategy.",
				]
			: []),
		...(tools.has("get_generated_video")
			? [
					"Use get_generated_video with the returned jobId until completed or failed, rather than starting another billable job.",
				]
			: []),
		"A skill's missing API-key environment variable is NOT a missing host model. " +
			(tools.has("media_model_status")
				? "Use media_model_status to check current defaults if uncertain or settings changed. "
				: "Use current host defaults in context; if unavailable, report that configuration cannot be verified. ") +
			"If a default is genuinely missing, ask only for that kind in Wuming Settings > Models. If the model/tool lacks a required feature, explain the specific incompatibility; do not pretend success or request duplicate credentials.",
		"Only send supported tool arguments. Do not silently drop required creative constraints or change the user's desired result. Keep ordinary local preparation/postprocessing under normal permissions. Host artifacts display in chat; never invent media links. A successful settings lookup does not recover a failed generation. After a submitted generation fails, report the error and wait for user direction; do not retry with a different prompt, duration or protocol.",
	].join("\n");
}

export function mediaModelStatus(defaults: MediaDefaults, tools: ReadonlySet<string> = allMediaTools) {
	return (["image", "video"] as const).map((kind) => {
		const config = defaults.find((value) => value.kind === kind);
		return {
			kind,
			configured: Boolean(config),
			...(tools.has(`generate_${kind}`) ? { generationTool: `generate_${kind}` } : { generationAvailable: false }),
			...(config?.model
				? {
						defaultModel: config.model,
						models: [...(config.models ?? [config.model])],
					}
				: {}),
			...(config?.availableModels
				? {
						defaultProvider: config.provider,
						availableModels: config.availableModels.map((item) => ({
							provider: item.provider,
							model: item.id,
							name: item.name,
							service: new URL(item.baseUrl).host,
							...(kind === "video"
								? {
										videoCapabilities: videoCapabilities({
											baseUrl: item.baseUrl,
											model: item.id,
											...(item.videoProtocol ? { videoProtocol: item.videoProtocol } : {}),
											...(item.videoReferenceFormat ? { videoReferenceFormat: item.videoReferenceFormat } : {}),
										}),
									}
								: {}),
						})),
					}
				: {}),
			...(kind === "video" && config?.model && config.baseUrl
				? {
						videoCapabilities: videoCapabilities({
							baseUrl: config.baseUrl,
							model: config.model,
							...(config.videoProtocol ? { videoProtocol: config.videoProtocol } : {}),
							...(config.videoReferenceFormat ? { videoReferenceFormat: config.videoReferenceFormat } : {}),
						}),
					}
				: {}),
		};
	});
}

export function mediaSkillRoutingFragment(tools: ReadonlySet<string> = allMediaTools): ContextFragment {
	const content = mediaSkillRoutingPolicy(tools);
	return {
		id: "media:skill-routing",
		version: createHash("sha256").update(content).digest("hex"),
		kind: "policy",
		source: "wuming:managed-media",
		content,
		label: "Host-managed image and video generation",
		priority: 600,
		required: true,
		cacheScope: "stable",
		truncation: "none",
	};
}

export function mediaStatusFragment(
	defaults: MediaDefaults,
	tools: ReadonlySet<string> = allMediaTools
): ContextFragment {
	const content = JSON.stringify(mediaModelStatus(defaults, tools));
	return {
		id: "media:status",
		version: createHash("sha256").update(content).digest("hex"),
		kind: "workspace",
		source: "wuming:media-status",
		content,
		label: "Current media defaults (configured, not verified)",
		priority: 600,
		required: true,
		cacheScope: "turn",
		delivery: "user",
		truncation: "none",
	};
}

/** Adapt the invocation, never rewrite the user's installed package or its source digest. */
export function adaptMediaSkillContent(
	content: string,
	defaults: MediaDefaults,
	options: { includeStatus?: boolean; availableTools?: ReadonlySet<string> } = {}
): string {
	const tools = options.availableTools ?? allMediaTools;
	return [
		"Wuming host integration for this skill: for image/video generation steps only, use the configured media tools. Keep the creative workflow below; its media-provider credentials/setup/API scripts are superseded by the host-managed media policy. No per-skill media configuration is required. Unrelated services and tasks are unchanged.",
		...(options.includeStatus === false
			? []
			: [`Current host defaults: ${JSON.stringify(mediaModelStatus(defaults, tools))}`]),
		"--- Original skill/reference content ---",
		content,
		"--- End original content ---",
		"Host integration reminder for image/video steps only: do not follow the source's requests for media-provider API keys or setup. " +
			mediaInvocationGuidance(tools) +
			(tools.has("media_model_status")
				? " Check media_model_status only if needed; do not request or configure duplicate credentials."
				: " Do not request or configure duplicate credentials."),
	].join("\n\n");
}

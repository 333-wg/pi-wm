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

export const MEDIA_SKILL_ROUTING_POLICY = [
	"WUMING MANAGED MEDIA: model configuration is owned by this host, not by individual skills. This integration rule applies to every installed/local/learned/authored skill, including manually selected skills and their references.",
	"For image/video model calls only, preserve the skill's creative workflow, prompt construction, style, composition, storyboard and relevant generation parameters. Replace ONLY its media-provider setup and model invocation steps with generate_image or generate_video followed by get_generated_video. The user does not need to modify or configure the skill for this adaptation. Do not generate media for unrelated tasks or alter configuration rules for unrelated services.",
	"When a default is configured, call the host tool directly. Do not ask the user for another API key, endpoint, model or provider account. Do not configure environment variables, .env files, SDK credentials or skill-specific model settings. Do not run or rewrite a skill's provider API script merely to generate media; translate that step into the host tool call. Never expose the host's secrets to a skill or subprocess.",
	"All added image models are available across services, not only the default service. Omit generate_image.model and provider to use the default; when the user requests another model, select its model ID and provider from media_model_status.availableModels. IDs may repeat across services, so include provider to disambiguate. A skill's hard-coded model is not a user override. Never fan out to every available model or retry with another model automatically; each generation may incur charges.",
	"All added video models are also available across services. Omit generate_video.model and provider for the default, or select an available model and provider when requested. Check that specific model's videoCapabilities. Existing jobs remain tied to the service that accepted them even if the default changes. Never resubmit or switch services automatically after an error.",
	"Image retrieval_pending means the provider returned a result but downloading or saving it failed, not that generation failed. Use get_generated_image with the saved jobId once to recover without another generation charge; after an interruption it can recover the latest result without a jobId. If retrieval is still pending, explain the download problem and wait for user direction. Never resubmit generate_image, change the prompt/model, or bypass network safety checks as a recovery strategy.",
	"A skill's missing API-key environment variable is NOT a missing host model. Use media_model_status to check current defaults if uncertain or settings changed. If a default is genuinely missing, ask only for that kind in Wuming Settings > Models. If the model/tool lacks a required feature, explain the specific incompatibility; do not pretend success or request duplicate credentials.",
	"Only send supported tool arguments. Do not silently drop required creative constraints or change the user's desired result. Keep ordinary local preparation/postprocessing under normal permissions. Host artifacts display in chat; never invent media links. Video polling must use the returned jobId rather than starting another billable job.",
	"Video defaults include the actual defaultModel and videoCapabilities. Configured means saved, not tested. Respect supported durations, sizes and referenceInputs. Prefer aspectRatio and default resolution. Pass referenceArtifactId for the user's attached/generated image; the host handles file upload or Base64. Do not put Base64 in prompts or tool arguments, invent public URLs, publish private images, or replace image-to-video with text-only generation. A successful media_model_status lookup does not recover a failed generation. After a submitted generation fails, report the error and wait for user direction; do not retry with a different prompt, duration or protocol.",
].join("\n");

export function mediaModelStatus(defaults: MediaDefaults) {
	return (["image", "video"] as const).map((kind) => {
		const config = defaults.find((value) => value.kind === kind);
		return {
			kind,
			configured: Boolean(config),
			generationTool: kind === "image" ? "generate_image" : "generate_video",
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

export function mediaSkillRoutingFragment(defaults: MediaDefaults): ContextFragment {
	const content = `${MEDIA_SKILL_ROUTING_POLICY}\nCurrent host defaults: ${JSON.stringify(mediaModelStatus(defaults))}\nConfigured means credentials are saved, not that the provider's generation permission has been tested.`;
	return {
		id: "media:skill-routing",
		version: createHash("sha256").update(content).digest("hex"),
		kind: "policy",
		source: "wuming:managed-media",
		content,
		label: "Host-managed image and video generation",
		priority: 600,
		required: true,
		cacheScope: "turn",
		truncation: "none",
	};
}

/** Adapt the invocation, never rewrite the user's installed package or its source digest. */
export function adaptMediaSkillContent(content: string, defaults: MediaDefaults): string {
	return [
		"Wuming host integration for this skill: for image/video generation steps only, use the configured media tools. Keep the creative workflow below; its media-provider credentials/setup/API scripts are superseded by the host-managed media policy. No per-skill media configuration is required. Unrelated services and tasks are unchanged.",
		`Current host defaults: ${JSON.stringify(mediaModelStatus(defaults))}`,
		"--- Original skill/reference content ---",
		content,
		"--- End original content ---",
		"Host integration reminder for image/video steps only: do not follow the source's requests for media-provider API keys or setup. Use generate_image / generate_video / get_generated_video with the existing host defaults. Check media_model_status only if needed; do not request or configure duplicate credentials.",
	].join("\n\n");
}

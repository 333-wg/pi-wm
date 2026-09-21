import type { CustomModelCandidate, CustomModelKind, MediaKind } from "@wuming/protocol";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
	return (Array.isArray(value) ? value : [value])
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.toLowerCase().trim().replace(/_/g, "-"));
}

const tasks: Record<MediaKind, Set<string>> = {
	image: new Set(["image-generation", "text-to-image", "image-to-image", "images/generations", "images/edits"]),
	video: new Set(["video-generation", "text-to-video", "image-to-video", "video-to-video", "videos"]),
};
const families: Record<MediaKind, RegExp> = {
	image:
		/(?:^|[/:._-])(?:agnes-image|gpt-image(?:-\d+)?|dall-e|flux|stable-diffusion|sdxl|sd3(?:\.\d+)?|imagen|ideogram|recraft|seedream|qwen-image|hunyuan-image|hunyuanimage|nano-banana)(?:$|[/:._-])|(?:^|\/)gemini-[\w.-]*-image(?:$|-)/i,
	video:
		/(?:^|[/:._-])(?:agnes-video|jimeng|gemini-omni|grok-imagine-video|sora|veo(?:\d)?|kling|seedance|hailuo|hunyuan-video|hunyuanvideo|cogvideo[x]?|ltx-video|vidu|pika|wan(?:\d+(?:\.\d+)?)?|ray-[23]|runway-gen[\w.-]*)(?:$|[/:._-])/i,
};

/** Prefer declared output capabilities; image/video input alone is never generation. */
function matches(model: Record<string, unknown>, id: string, kind: MediaKind): boolean {
	const architecture = record(model.architecture);
	const outputs = strings(model.output_modalities ?? architecture.output_modalities);
	if (outputs.length) return outputs.includes(kind);
	const modality = typeof architecture.modality === "string" ? architecture.modality.split("->") : [];
	if (modality.length === 2)
		return modality[1]!
			.split("+")
			.map((value) => value.trim())
			.includes(kind);
	const capabilities = record(model.capabilities);
	const declared = capabilities[`${kind}_generation`] ?? capabilities[`${kind}-generation`];
	if (typeof declared === "boolean") return declared;
	const declarations = [
		model.task,
		model.tasks,
		model.pipeline_tag,
		model.type,
		model.capabilities,
		model.supported_endpoint_types,
	].flatMap(strings);
	if (declarations.some((value) => tasks[kind].has(value))) return true;
	if (
		declarations.some((value) =>
			[
				...tasks.image,
				...tasks.video,
				"text-generation",
				"chat",
				"image-classification",
				"image-to-text",
				"video-to-text",
			].includes(value)
		)
	)
		return false;
	return families[kind].test(id);
}

export function classifyModel(value: unknown, id: string): CustomModelKind {
	const model = record(value);
	if (matches(model, id, "video")) return "video";
	if (matches(model, id, "image")) return "image";
	return "chat";
}

export function parseMediaModelCatalog(payload: unknown, kind: MediaKind): CustomModelCandidate[] {
	const data = record(payload).data;
	if (!Array.isArray(data)) throw new Error("模型列表格式不受支持，需要包含 data 数组");
	const models = new Map<string, CustomModelCandidate>();
	for (const entry of data) {
		const model = record(entry);
		const id = typeof model.id === "string" ? model.id.trim() : "";
		if (!id || id.length > 200 || models.has(id) || !matches(model, id, kind)) continue;
		const label = model.display_name ?? model.name;
		models.set(id, { id, name: typeof label === "string" ? label.trim().slice(0, 500) || id : id });
		if (models.size === 1000) break;
	}
	return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

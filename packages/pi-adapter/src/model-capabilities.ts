import { getSupportedThinkingLevels, type Api, type Model, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { CustomModelApi, CustomModelThinkingOverride, ModelMetadata, ThinkingLevel } from "@wuming/protocol";

export interface ModelThinkingDeclaration {
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface CustomModelCapabilities {
	input: Array<"text" | "image">;
	reasoning: boolean;
	thinkingLevels: readonly ThinkingLevel[];
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Model<Api>["compat"];
	thinking: NonNullable<ModelMetadata["thinking"]>;
}

const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const NATIVE_PROVIDERS = [
	"openai",
	"anthropic",
	"google",
	"deepseek",
	"moonshotai",
	"zai",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"xai",
];
let catalog: Map<string, Model<Api>> | undefined;

function canonicalId(id: string): string {
	return id.toLowerCase().split("/").at(-1)!.replace(/[._]/g, "-");
}

function builtinModel(id: string): Model<Api> | undefined {
	if (!catalog) {
		catalog = new Map();
		const providers = [...getBuiltinProviders()].sort((a, b) => {
			const rank = (provider: string) => {
				const index = NATIVE_PROVIDERS.indexOf(provider);
				return index < 0 ? NATIVE_PROVIDERS.length : index;
			};
			return rank(a) - rank(b) || a.localeCompare(b);
		});
		for (const provider of providers) {
			for (const model of getBuiltinModels(provider)) {
				const key = canonicalId(model.id);
				if (!catalog.has(key)) catalog.set(key, model);
			}
		}
	}
	return catalog.get(canonicalId(id));
}

export type ModelInputDeclaration = Array<"text" | "image">;

function levelMap(levels: readonly ThinkingLevel[]): ThinkingLevelMap {
	return Object.fromEntries(
		LEVELS.map((level) => [level, levels.includes(level) ? (level === "off" ? "none" : level) : null])
	);
}

type ThinkingProfile = Pick<Model<Api>, "id" | "api" | "reasoning" | "thinkingLevelMap" | "compat">;

// Official corrections supplement the installed catalog; see docs/model-thinking-capabilities.md.
const DOCUMENTED_PROFILES: ThinkingProfile[] = [
	{
		id: "gpt-6-astra",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: levelMap(["low", "medium", "high", "xhigh", "max"]),
	},
	...(["deepseek-flash", "deepseek-v4-pro"] as const).map((id): ThinkingProfile => ({
		id,
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: levelMap(["off", "low", "high", "max"]),
		compat: {
			thinkingFormat: "deepseek",
			supportsReasoningEffort: true,
			requiresReasoningContentOnAssistantMessages: true,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	})),
];

interface ThinkingFamily {
	provider: "openai" | "anthropic";
	key: string;
	version: number;
}

function thinkingFamily(id: string): ThinkingFamily | undefined {
	const canonical = canonicalId(id);
	if (/(?:^|-)(?:non-reasoning|image|audio|realtime|search|tts|transcribe|embedding)(?:-|$)/.test(canonical))
		return undefined;
	const gpt = /^gpt-(\d+)(?:-(\d{1,2})(?=-|$))?(?:-|$)/.exec(canonical);
	if (gpt && Number(gpt[1]) >= 5) {
		const variant = /-(codex-spark|codex|pro|mini|nano|chat)(?:-|$)/.exec(canonical)?.[1] ?? "base";
		return { provider: "openai", key: `gpt-${variant}`, version: Number(gpt[1]) * 100 + Number(gpt[2] ?? 0) };
	}
	const o = /^o([1-9]\d*)(?:-|$)/.exec(canonical);
	if (o)
		return {
			provider: "openai",
			key: `o-${/-(mini|pro)(?:-|$)/.exec(canonical)?.[1] ?? "base"}`,
			version: Number(o[1]) * 100,
		};
	const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?=-|$))?(?:-|$)/.exec(canonical);
	if (claude)
		return {
			provider: "anthropic",
			key: `claude-${claude[1]}`,
			version: Number(claude[2]) * 100 + Number(claude[3] ?? 0),
		};
	return undefined;
}

/** New releases inherit the closest earlier member of the same product line, not a reduced generic menu. */
function familyThinking(id: string): ThinkingProfile | undefined {
	const family = thinkingFamily(id);
	if (!family) return undefined;
	const candidates = [...getBuiltinModels(family.provider), ...DOCUMENTED_PROFILES]
		.flatMap((model) => {
			const candidate = thinkingFamily(model.id);
			return model.reasoning && candidate?.key === family.key && candidate.version <= family.version
				? [{ model, version: candidate.version }]
				: [];
		})
		.sort((left, right) => right.version - left.version || left.model.id.localeCompare(right.model.id));
	const parent = candidates[0]?.model;
	if (!parent) return undefined;
	// Do not inherit unrelated tool flags or a provider's fallback-model routing.
	const compat =
		parent.compat &&
		"forceAdaptiveThinking" in parent.compat &&
		typeof parent.compat.forceAdaptiveThinking === "boolean"
			? { forceAdaptiveThinking: parent.compat.forceAdaptiveThinking }
			: undefined;
	return {
		id: parent.id,
		api: parent.api,
		reasoning: true,
		...(parent.thinkingLevelMap ? { thinkingLevelMap: parent.thinkingLevelMap } : {}),
		...(compat ? { compat } : {}),
	};
}

/** Only input capabilities count; generating images does not imply understanding them. */
export function parseModelInputDeclaration(value: unknown): ModelInputDeclaration | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const capabilities =
		record.capabilities && typeof record.capabilities === "object"
			? (record.capabilities as Record<string, unknown>)
			: {};
	const modalities =
		record.modalities && typeof record.modalities === "object" ? (record.modalities as Record<string, unknown>) : {};
	for (const input of [record.input_modalities, record.input, modalities.input, capabilities.input_modalities]) {
		if (!Array.isArray(input) || !input.length || !input.every((item) => typeof item === "string")) continue;
		const types = input.map((item) => item.toLowerCase());
		if (types.includes("image")) return ["text", "image"];
		if (types.includes("text")) return ["text"];
	}
	for (const vision of [capabilities.vision, capabilities.image_input, record.vision]) {
		if (typeof vision === "boolean") return vision ? ["text", "image"] : ["text"];
	}
	return undefined;
}

/** Parse only explicit catalog declarations, never the editable display name. */
export function parseModelThinkingDeclaration(value: unknown): ModelThinkingDeclaration | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const capabilities =
		record.capabilities && typeof record.capabilities === "object"
			? (record.capabilities as Record<string, unknown>)
			: {};
	const reasoning = typeof record.reasoning === "boolean" ? record.reasoning : capabilities.reasoning;
	if (reasoning === false) return { reasoning: false };
	const map: ThinkingLevelMap = {};
	const declaredLevels = record.supported_reasoning_levels ?? capabilities.supported_reasoning_levels;
	if (Array.isArray(declaredLevels)) {
		for (const level of LEVELS) map[level] = null;
		for (const entry of declaredLevels) {
			const effort: unknown = typeof entry === "string" ? entry : entry?.effort;
			const level = effort === "none" ? "off" : effort;
			if (typeof level === "string" && LEVELS.includes(level as ThinkingLevel)) {
				map[level as ThinkingLevel] = level === "off" ? "none" : level;
			}
		}
	} else if (record.thinkingLevelMap && typeof record.thinkingLevelMap === "object") {
		for (const level of LEVELS) {
			const mapped = (record.thinkingLevelMap as Record<string, unknown>)[level];
			if (mapped === null || (typeof mapped === "string" && mapped.length > 0 && mapped.length <= 64)) {
				map[level] = mapped;
			}
		}
	}
	if (
		Object.keys(map).length > 0 &&
		getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: map } as Model<Api>).length > 0
	) {
		return { reasoning: true, thinkingLevelMap: map };
	}
	return reasoning === true ||
		(Array.isArray(record.supported_parameters) && record.supported_parameters.includes("reasoning_effort"))
		? { reasoning: true }
		: undefined;
}

/** The UI and Pi registration must share both the level map and wire format. */
export function resolveCustomModelCapabilities(
	id: string,
	api: CustomModelApi,
	declaration?: ModelThinkingDeclaration,
	inputDeclaration?: ModelInputDeclaration,
	override?: CustomModelThinkingOverride
): CustomModelCapabilities {
	const known = builtinModel(id);
	const documented = DOCUMENTED_PROFILES.find((profile) => canonicalId(profile.id) === canonicalId(id));
	const exact = documented ?? known;
	const family = exact ? undefined : familyThinking(id);
	const profile = exact ?? family;
	const manual =
		override && override !== "auto"
			? override === "disabled"
				? { reasoning: false }
				: { reasoning: override.levels.some((level) => level !== "off"), thinkingLevelMap: levelMap(override.levels) }
			: undefined;
	const effectiveDeclaration = manual ?? declaration;
	// Old UI checkboxes defaulted to text-only, so they are not capability evidence.
	// Unknown relay aliases must reach the provider instead of silently losing images.
	const input: ModelInputDeclaration = inputDeclaration ?? (known ? [...known.input] : ["text", "image"]);
	const reasoning = effectiveDeclaration?.reasoning ?? profile?.reasoning ?? false;
	const source = manual ? "manual" : declaration ? "endpoint" : exact ? "catalog" : family ? "family" : "unknown";
	if (!reasoning) {
		return {
			input,
			reasoning: false,
			thinkingLevels: ["off"],
			thinking: { mode: source === "unknown" ? "unknown" : "none", source },
		};
	}
	// Provider-specific compatibility flags only apply to the matching API.
	let compat: CustomModelCapabilities["compat"] = profile?.api === api ? profile.compat : undefined;
	let thinkingLevelMap = effectiveDeclaration?.thinkingLevelMap ?? profile?.thinkingLevelMap;
	let mode: NonNullable<ModelMetadata["thinking"]>["mode"] = "effort";
	if (api === "anthropic-messages") {
		mode = compat && "forceAdaptiveThinking" in compat && compat.forceAdaptiveThinking ? "adaptive" : "budget";
	} else if (api === "openai-completions") {
		if (effectiveDeclaration?.thinkingLevelMap) {
			// An explicit effort declaration takes precedence over a toggle-only catalog entry.
			compat = { ...compat, supportsReasoningEffort: true };
		} else if (compat && "supportsReasoningEffort" in compat && compat.supportsReasoningEffort === false) {
			mode = "toggle";
			thinkingLevelMap = { ...thinkingLevelMap, minimal: null, low: null, medium: null, xhigh: null, max: null };
		}
	}
	const effective = { reasoning, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) } as Model<Api>;
	return {
		input,
		reasoning,
		thinkingLevels: getSupportedThinkingLevels(effective),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(compat ? { compat } : {}),
		thinking: { mode, source },
	};
}

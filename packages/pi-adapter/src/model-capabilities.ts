import { getSupportedThinkingLevels, type Api, type Model, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { CustomModelApi, ModelMetadata, ThinkingLevel } from "@wuming/protocol";

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
const NATIVE_PROVIDERS = ["openai", "anthropic", "google", "deepseek", "moonshotai", "zai", "xai"];
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
	if (record.reasoning === false) return { reasoning: false };
	const map: ThinkingLevelMap = {};
	if (Array.isArray(record.supported_reasoning_levels)) {
		for (const level of LEVELS) map[level] = null;
		for (const entry of record.supported_reasoning_levels) {
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
	return record.reasoning === true ? { reasoning: true } : undefined;
}

/** The UI and Pi registration must share both the level map and wire format. */
export function resolveCustomModelCapabilities(
	id: string,
	api: CustomModelApi,
	declaration?: ModelThinkingDeclaration,
	inputDeclaration?: ModelInputDeclaration
): CustomModelCapabilities {
	const known = builtinModel(id);
	// Old UI checkboxes defaulted to text-only, so they are not capability evidence.
	// Unknown relay aliases must reach the provider instead of silently losing images.
	const input: ModelInputDeclaration = inputDeclaration ?? (known ? [...known.input] : ["text", "image"]);
	const reasoning = declaration?.reasoning ?? known?.reasoning ?? false;
	const source = declaration ? "endpoint" : known ? "catalog" : "unknown";
	if (!reasoning) {
		return {
			input,
			reasoning: false,
			thinkingLevels: ["off"],
			thinking: { mode: source === "unknown" ? "unknown" : "none", source },
		};
	}
	// Provider-specific compatibility flags only apply to the matching API.
	let compat: CustomModelCapabilities["compat"] = known?.api === api ? known.compat : undefined;
	let thinkingLevelMap = declaration?.thinkingLevelMap ?? known?.thinkingLevelMap;
	let mode: NonNullable<ModelMetadata["thinking"]>["mode"] = "effort";
	if (api === "anthropic-messages") {
		mode = compat && "forceAdaptiveThinking" in compat && compat.forceAdaptiveThinking ? "adaptive" : "budget";
	} else if (api === "openai-completions") {
		if (declaration?.thinkingLevelMap) {
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

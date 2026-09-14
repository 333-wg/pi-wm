import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CustomModelRegistry } from "../../apps/gateway/src/custom-models.js";
import type { PiProviderRegistration } from "../../packages/pi-adapter/src/types.js";

export function smokeRegistrations(
	registrations: PiProviderRegistration[],
	provider: string,
	modelId: string
): PiProviderRegistration[] {
	const selected = registrations.find((entry) => entry.provider === provider);
	const model = selected?.config.models?.find((entry) => entry.id === modelId);
	if (!selected || !model) throw new Error("Selected smoke model registration is missing");
	return [
		{
			...selected,
			config: {
				...selected.config,
				models: [{ ...model, maxTokens: Math.min(model.maxTokens, 256) }],
			},
		},
	];
}

/** Reads existing credentials in memory only; never creates keys or migrates the source. */
export async function loadSavedModelSource(directory: string, configuredKey?: string) {
	const root = resolve(directory);
	const encryptionKey = configuredKey ?? (await readFile(join(root, "custom-models.key"), "utf8")).trim();
	if (!encryptionKey.trim()) throw new Error("Saved model encryption key is empty");
	const registry = new CustomModelRegistry({
		filePath: join(root, "custom-models.enc"),
		encryptionKey,
	});
	await registry.load({ migrateLegacy: false });
	return { models: registry.list(), registrations: registry.registrations() };
}

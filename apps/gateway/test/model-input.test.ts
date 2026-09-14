import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomModelRegistry } from "../src/custom-models.js";
import { parseModelInputDeclaration, resolveCustomModelCapabilities } from "../src/model-capabilities.js";

const config = {
	provider: "vision-test",
	id: "kimi-k2.6",
	name: "Kimi",
	api: "openai-completions" as const,
	baseUrl: "http://127.0.0.1:9000/v1",
	apiKey: "fixture-key",
	input: ["text"] as Array<"text" | "image">,
	contextWindow: 128000,
	maxOutputTokens: 2048,
};
afterEach(() => vi.restoreAllMocks());

describe("automatic model image input", () => {
	it("repairs legacy text-only defaults without rewriting saved settings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-vision-model-"));
		try {
			const options = { filePath: join(directory, "models.enc"), encryptionKey: "fixture-master" };
			const registry = new CustomModelRegistry(options);
			await registry.set(config);
			const loaded = new CustomModelRegistry(options);
			await loaded.load();
			expect(loaded.list()[0]?.input).toEqual(["text", "image"]);
			expect(loaded.get(config).input).toEqual(["text", "image"]);
			expect(loaded.registrations()[0]?.config.models?.[0]?.input).toEqual(["text", "image"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("uses explicit input declarations for aliases, including text-only models, across reloads", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-vision-alias-"));
		try {
			const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [
							{ id: "relay-vision", input_modalities: ["text", "image"] },
							{ id: "relay-text", capabilities: { vision: false } },
						],
					})
				)
			);
			const options = { filePath: join(directory, "models.enc"), encryptionKey: "fixture-master" };
			const registry = new CustomModelRegistry(options);
			const discovery = await registry.discover(config);
			expect(discovery).not.toHaveProperty("inputDeclarations");
			for (const id of ["relay-vision", "relay-text"])
				await registry.set({ ...config, provider: discovery.provider, id });
			const loaded = new CustomModelRegistry(options);
			await loaded.load();
			expect(loaded.list().map((model) => model.input)).toEqual([["text", "image"], ["text"]]);
			expect(loaded.registrations()[0]?.config.models?.map((model) => model.input)).toEqual([
				["text", "image"],
				["text"],
			]);
			fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "relay-text", input: ["text", "image"] }] })));
			await loaded.refreshService(discovery.provider);
			expect(loaded.get({ provider: discovery.provider, id: "relay-text" }).input).toEqual(["text", "image"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("lets unknown aliases attempt image input but respects known text-only models", () => {
		expect(resolveCustomModelCapabilities("new-private-alias", "openai-completions").input).toEqual(["text", "image"]);
		expect(resolveCustomModelCapabilities("gpt-3.5-turbo", "openai-completions").input).toEqual(["text"]);
		expect(resolveCustomModelCapabilities("kimi-k2.6", "openai-completions", undefined, ["text"]).input).toEqual([
			"text",
		]);
	});

	it.each([
		[{ input_modalities: ["text", "image"] }, ["text", "image"]],
		[{ input: ["text"] }, ["text"]],
		[{ modalities: { input: ["TEXT", "IMAGE"] } }, ["text", "image"]],
		[{ capabilities: { vision: false } }, ["text"]],
		[{ capabilities: { image_input: true } }, ["text", "image"]],
		[{ output_modalities: ["image"], capabilities: { image_generation: true } }, undefined],
		[{ input: [], capabilities: { vision: "false" } }, undefined],
		[{ name: "vision model", input: [null] }, undefined],
	])("reads only declared image inputs from %j", (value, expected) => {
		expect(parseModelInputDeclaration(value)).toEqual(expected);
	});
});

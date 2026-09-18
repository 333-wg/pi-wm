import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomModelRegistry } from "../src/custom-models.js";
import { MediaModelRegistry } from "../src/media-models.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const config = {
	provider: "relay",
	id: "gpt-image-2",
	name: "Image model",
	api: "openai-completions" as const,
	baseUrl: "https://relay.invalid/v1",
	apiKey: "private-test-key",
	input: ["text" as const],
	contextWindow: 32000,
	maxOutputTokens: 4096,
};

describe("custom model classification", () => {
	it("routes legacy image/video entries out of chat after encrypted reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "model-kinds-"));
		roots.push(root);
		const options = { filePath: join(root, "custom.enc"), encryptionKey: "test-encryption-key" };
		const registry = new CustomModelRegistry(options);
		for (const id of ["gpt-image-2", "sora-2", "gemini-2.5-pro", "qwen-vl"]) await registry.set({ ...config, id });
		const loaded = new CustomModelRegistry(options);
		await loaded.load();
		expect(loaded.list().map((item) => item.model.id)).toEqual(["gemini-2.5-pro", "qwen-vl"]);
		expect(loaded.registrations()[0]?.config.models?.map((item) => item.id)).toEqual(["gemini-2.5-pro", "qwen-vl"]);
		expect(loaded.listMedia().map((item) => [item.model.id, item.kind])).toEqual([
			["gpt-image-2", "image"],
			["sora-2", "video"],
		]);
		expect(loaded.services()[0]?.modelCount).toBe(4);
		expect(JSON.stringify(loaded.listMedia())).not.toContain(config.apiKey);
		await expect(loaded.test({ provider: config.provider, id: "sora-2" })).rejects.toThrow("对话接口");
		await expect(loaded.removeService(config.provider)).rejects.toThrow("Remove the models");
	});

	it("uses declared output capabilities and preserves manual overrides through refresh and reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "model-kinds-"));
		roots.push(root);
		const options = { filePath: join(root, "custom.enc"), encryptionKey: "test-encryption-key" };
		const registry = new CustomModelRegistry(options);
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "opaque-image", output_modalities: ["image"] },
							{ id: "opaque-video", pipeline_tag: "text-to-video" },
							{ id: "gpt-image-caption", output_modalities: ["text"], input_modalities: ["image"] },
							{ id: "unknown", input_modalities: ["image", "video"] },
						],
					})
				)
		);
		const result = await registry.discover({ baseUrl: config.baseUrl, apiKey: config.apiKey });
		expect(result.models.find((item) => item.id === "opaque-image")?.kind).toBe("image");
		expect(result.models.find((item) => item.id === "opaque-video")?.kind).toBe("video");
		for (const item of result.models) await registry.set({ ...config, provider: result.provider, id: item.id });
		await registry.set({ ...config, provider: result.provider, id: "unknown", kind: "image" });
		await registry.refreshService(result.provider);
		const loaded = new CustomModelRegistry(options);
		await loaded.load();
		expect(loaded.list().map((item) => item.model.id)).toEqual(["gpt-image-caption"]);
		expect(loaded.listMedia()).toHaveLength(3);
		await loaded.set({ ...config, provider: result.provider, id: "opaque-image", kind: "chat" });
		await loaded.refreshService(result.provider);
		expect(loaded.list().map((item) => item.model.id)).toContain("opaque-image");
	});

	it("reclassifies already-added opaque models when the service is refreshed", async () => {
		const registry = new CustomModelRegistry();
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "opaque" }] })));
		const discovered = await registry.discover({ baseUrl: config.baseUrl, apiKey: config.apiKey });
		await registry.set({ ...config, provider: discovered.provider, id: "opaque" });
		expect(registry.list()).toHaveLength(1);
		fetcher.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "opaque", output_modalities: ["video"] }] })));
		await registry.refreshService(discovered.provider);
		expect(registry.list()).toEqual([]);
		expect(registry.listMedia()[0]?.kind).toBe("video");
	});

	it("reuses saved credentials only for matching media models and never replaces defaults just by adding", async () => {
		const root = await mkdtemp(join(tmpdir(), "model-kinds-"));
		roots.push(root);
		const registry = new CustomModelRegistry();
		const media = new MediaModelRegistry({
			filePath: join(root, "media.enc"),
			encryptionKey: "test-key",
			imageModels: registry,
		});
		await media.set({
			kind: "image",
			baseUrl: "https://previous.invalid/v1",
			model: "previous",
			apiKey: "previous-key",
		});
		await registry.set(config);
		expect(media.resolve("image").model).toBe("previous");
		const selection = { provider: config.provider, kind: "image" as const, baseUrl: config.baseUrl, model: config.id };
		await media.set(registry.resolveMedia(selection));
		expect(media.resolve("image").apiKey).toBe(config.apiKey);
		expect(JSON.stringify(media.list())).not.toContain(config.apiKey);
		expect(() => registry.resolveMedia({ ...selection, baseUrl: "https://other.invalid" })).toThrow("不匹配");
		expect(() => registry.resolveMedia({ ...selection, kind: "video" })).toThrow("不匹配");
		expect(() => registry.resolveMedia({ ...selection, models: [config.id, "unadded"] })).toThrow("已添加");
	});
});

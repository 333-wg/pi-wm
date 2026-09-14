import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMediaModelCatalog } from "../src/media-model-discovery.js";
import { MediaModelRegistry } from "../src/media-models.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function registry() {
	const root = await mkdtemp(join(tmpdir(), "wuming-media-discovery-"));
	roots.push(root);
	const filePath = join(root, "models.enc");
	return { models: new MediaModelRegistry({ filePath, encryptionKey: "test-key" }), filePath };
}
const json = (data: unknown) => new Response(JSON.stringify({ data }));

describe("media catalog filtering", () => {
	it("separates common image and video families from vision/chat models", () => {
		const images = [
			"agnes-image-2.0-flash",
			"agnes-image-2.1-flash",
			"gpt-image-1",
			"gpt-image-2",
			"dall-e-3",
			"vendor/FLUX.1-dev",
			"imagen-4.0-generate-001",
			"gemini-2.5-flash-image-preview",
			"seedream-4-0",
			"qwen-image",
			"nano-banana-pro",
		];
		const videos = [
			"agnes-video-v2.0",
			"vendor/agnes-video-v2.0",
			"sora-2-pro",
			"veo3.1",
			"kling-v2-1",
			"seedance-1-5-pro",
			"wan2.2-i2v",
			"hunyuan-video",
			"hailuo-02",
			"ray-2",
		];
		const others = [
			"agnes-2.5-flash",
			"agnes-videography",
			"agnes-imagery",
			"gpt-4o",
			"gemini-2.5-pro",
			"claude-sonnet",
			"qwen-vl",
			"image-embedding",
			"video-caption",
			"fluxion-chat",
			"waning-chat",
		];
		const data = [...images, ...videos, ...others].map((id) => ({ id }));
		expect(
			parseMediaModelCatalog({ data }, "image")
				.map((value) => value.id)
				.sort()
		).toEqual(images.sort());
		expect(
			parseMediaModelCatalog({ data }, "video")
				.map((value) => value.id)
				.sort()
		).toEqual(videos.sort());
	});
	it("uses declared output/tasks, never input-only vision or misleading names", () => {
		const data = [
			{ id: "opaque-a", output_modalities: ["image"] },
			{ id: "opaque-b", architecture: { output_modalities: ["video"] } },
			{ id: "opaque-c", capabilities: { image_generation: true } },
			{ id: "opaque-d", pipeline_tag: "text-to-video" },
			{ id: "opaque-e", supported_endpoint_types: ["image-generation"] },
			{ id: "opaque-f", architecture: { modality: "text+image->image" } },
			{ id: "opaque-g", capabilities: ["video_generation"] },
			{ id: "gpt-image-input-only", output_modalities: ["text"], input_modalities: ["image"] },
			{ id: "sora-disabled", capabilities: { video_generation: false } },
			{ id: "agnes-video-v2.0", output_modalities: ["text"] },
			{ id: "agnes-image-disabled", capabilities: { image_generation: false } },
			{ id: "vision", input: ["text", "image", "video"], name: "gpt-image-1" },
			{ id: "gpt-image-caption", task: "image-to-text" },
		];
		expect(parseMediaModelCatalog({ data }, "image").map((value) => value.id)).toEqual([
			"opaque-a",
			"opaque-c",
			"opaque-e",
			"opaque-f",
		]);
		expect(parseMediaModelCatalog({ data }, "video").map((value) => value.id)).toEqual([
			"opaque-b",
			"opaque-d",
			"opaque-g",
		]);
	});
	it("deduplicates, bounds and validates catalogs, allowing empty filtered results", () => {
		expect(
			parseMediaModelCatalog(
				{ data: [null, {}, { id: 1 }, { id: "gpt-image-1", name: "Favorite" }, { id: "gpt-image-1" }] },
				"image"
			)
		).toEqual([{ id: "gpt-image-1", name: "Favorite" }]);
		expect(parseMediaModelCatalog({ data: [{ id: "chat" }] }, "image")).toEqual([]);
		expect(() => parseMediaModelCatalog({ models: [] }, "image")).toThrow("data");
		expect(
			parseMediaModelCatalog({ data: Array.from({ length: 1100 }, (_, i) => ({ id: `gpt-image-${i}` })) }, "image")
		).toHaveLength(1000);
	});
});

describe("media discovery connection", () => {
	it("uses draft credentials without saving, with official and custom path prefixes", async () => {
		const { models, filePath } = await registry();
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => json([{ id: "gpt-image-1" }, { id: "sora-2" }, { id: "gpt-4o" }]));
		const found = await models.discover({ kind: "image", baseUrl: "https://api.openai.com", apiKey: "draft-key" });
		expect(found).toEqual([{ id: "gpt-image-1", name: "gpt-image-1" }]);
		expect(fetcher).toHaveBeenCalledWith(
			"https://api.openai.com/v1/models",
			expect.objectContaining({ headers: { Authorization: "Bearer draft-key" }, redirect: "error" })
		);
		await models.discover({ kind: "video", baseUrl: "https://relay.example/api/v1/", apiKey: "draft-key" });
		expect(fetcher.mock.calls[1]?.[0]).toBe("https://relay.example/api/v1/models");
		expect(models.list()).toEqual([]);
		await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("reuses saved keys only for the same kind and endpoint, never mutating settings", async () => {
		const { models, filePath } = await registry();
		await models.set({ kind: "image", baseUrl: "https://relay.example/v1", model: "gpt-image-1", apiKey: "saved-key" });
		const original = await readFile(filePath);
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json([]));
		await models.discover({ kind: "image", baseUrl: "https://relay.example/v1/" });
		expect(fetcher).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ headers: { Authorization: "Bearer saved-key" } })
		);
		for (const connection of [
			{ kind: "image" as const, baseUrl: "https://other.example/v1" },
			{ kind: "video" as const, baseUrl: "https://relay.example/v1" },
		])
			await expect(models.discover(connection)).rejects.toThrow("API Key");
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(await readFile(filePath)).toEqual(original);
	});
	it("rejects invalid endpoints, HTTP failures, malformed/oversize bodies without leaking responses", async () => {
		const { models } = await registry();
		const connection = { kind: "image" as const, baseUrl: "https://relay.example/v1", apiKey: "private-key" };
		const fetcher = vi.spyOn(globalThis, "fetch");
		await expect(models.discover({ ...connection, baseUrl: "http://remote.example" })).rejects.toThrow("HTTPS");
		expect(fetcher).not.toHaveBeenCalled();
		fetcher.mockResolvedValueOnce(new Response("private-key", { status: 401 }));
		await expect(models.discover(connection)).rejects.toThrow("HTTP 401");
		fetcher.mockResolvedValueOnce(new Response("private-key"));
		await expect(models.discover(connection)).rejects.toThrow("有效 JSON");
		fetcher.mockResolvedValueOnce(new Response("{}", { headers: { "content-length": "3000000" } }));
		await expect(models.discover(connection)).rejects.toThrow("size limit");
		fetcher.mockRejectedValueOnce(new Error("private-key redirect failed"));
		await expect(models.discover(connection)).rejects.toThrow("获取模型失败，请检查 Base URL");
	});
});

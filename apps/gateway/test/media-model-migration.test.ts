import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MediaModelRegistry, mediaConnectionHash } from "../src/media-models.js";
import { CustomModelRegistry } from "../src/custom-models.js";

it.each([
	{ kind: "image" as const, version: 1, matchingKey: true },
	{ kind: "image" as const, version: 1, matchingKey: false },
	{ kind: "video" as const, version: 1, matchingKey: true },
	{ kind: "video" as const, version: 1, matchingKey: false },
	{ kind: "video" as const, version: 2, matchingKey: true },
	{ kind: "video" as const, version: 2, matchingKey: false },
])(
	"preserves v$version $kind source identity with matching credentials: $matchingKey",
	async ({ kind, version, matchingKey }) => {
		const root = await mkdtemp(join(tmpdir(), "wuming-media-source-migration-"));
		try {
			const custom = new CustomModelRegistry();
			await custom.set({
				provider: "relay-source",
				kind,
				id: "shared-image",
				name: "Image",
				api: "openai-completions",
				baseUrl: "https://relay.example/v1",
				apiKey: "source-key",
				input: ["text"],
				contextWindow: 32000,
				maxOutputTokens: 4096,
			});
			const options = { filePath: join(root, "models.enc"), encryptionKey: "migration-key", imageModels: custom };
			const previous = {
				kind,
				baseUrl: "https://relay.example/v1",
				model: "shared-image",
				apiKey: matchingKey ? "source-key" : "legacy-key",
				...(kind === "video" ? { videoProtocol: "openai-json", videoReferenceFormat: "data-url" } : {}),
			};
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(options.encryptionKey).digest(), iv);
			const data = Buffer.concat([
				cipher.update(JSON.stringify({ version, models: [previous], ...(version === 2 ? { imageServices: [] } : {}) })),
				cipher.final(),
			]);
			await writeFile(
				options.filePath,
				JSON.stringify({
					iv: iv.toString("base64url"),
					tag: cipher.getAuthTag().toString("base64url"),
					data: data.toString("base64url"),
				})
			);
			const models = new MediaModelRegistry(options);
			await models.load();
			expect(models.resolve(kind).apiKey).toBe(previous.apiKey);
			expect(models.list()[0]?.availableModels).toHaveLength(matchingKey ? 1 : 2);
			const selected = models.list()[0]!;
			const ref = { provider: selected.provider!, id: selected.model };
			if (kind === "image") await models.setImageDefault(ref);
			else await models.setVideoDefault(ref);
			const restarted = new MediaModelRegistry(options);
			await restarted.load();
			expect(restarted.resolve(kind).apiKey).toBe(previous.apiKey);
			if (kind === "video")
				expect(restarted.resolve(kind)).toMatchObject({
					videoProtocol: "openai-json",
					videoReferenceFormat: "data-url",
				});
			await custom.remove({ provider: "relay-source", id: "shared-image" });
			if (matchingKey) expect(() => restarted.resolve(kind)).toThrow("not configured");
			else expect(restarted.resolve(kind).apiKey).toBe("legacy-key");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
);

it("loads legacy single-model settings without changing video-job fingerprints", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-media-migration-"));
	try {
		const options = { filePath: join(root, "models.enc"), encryptionKey: "migration-key" };
		const oldImage = { kind: "image", baseUrl: "https://relay.example/v1", model: "old-image", apiKey: "image-key" };
		const oldVideo = { kind: "video", baseUrl: "https://relay.example/v1", model: "old-video", apiKey: "video-key" };
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(options.encryptionKey).digest(), iv);
		const data = Buffer.concat([
			cipher.update(JSON.stringify({ version: 1, models: [oldImage, oldVideo] })),
			cipher.final(),
		]);
		await writeFile(
			options.filePath,
			JSON.stringify({
				iv: iv.toString("base64url"),
				tag: cipher.getAuthTag().toString("base64url"),
				data: data.toString("base64url"),
			})
		);
		const registry = new MediaModelRegistry(options);
		await registry.load();
		expect(registry.list().find((value) => value.kind === "image")).toMatchObject({
			model: "old-image",
			models: ["old-image"],
		});
		expect(registry.resolve("video")).toMatchObject(oldVideo);
		expect(mediaConnectionHash(registry.resolve("video"))).toBe(
			createHash("sha256").update(JSON.stringify(oldVideo)).digest("hex")
		);
		await registry.set({
			kind: "image",
			baseUrl: oldImage.baseUrl,
			model: "new-image",
			models: ["old-image", "new-image"],
		});
		const restarted = new MediaModelRegistry(options);
		await restarted.load();
		expect(restarted.resolve("image").model).toBe("new-image");
		expect(restarted.resolve("image", "old-image").apiKey).toBe(oldImage.apiKey);
		expect(restarted.resolve("video")).toMatchObject(oldVideo);
		await restarted.set({
			kind: "video",
			baseUrl: oldVideo.baseUrl,
			model: oldVideo.model,
			videoProtocol: "openai-json",
			videoReferenceFormat: "data-url",
		});
		const withPreferences = new MediaModelRegistry(options);
		await withPreferences.load();
		expect(withPreferences.resolve("video")).toMatchObject({
			...oldVideo,
			videoProtocol: "openai-json",
			videoReferenceFormat: "data-url",
		});
		expect(JSON.stringify(withPreferences.list())).not.toContain("video-key");
		await expect(
			withPreferences.set({
				kind: "image",
				baseUrl: oldImage.baseUrl,
				model: "new-image",
				videoReferenceFormat: "data-url",
			})
		).rejects.toThrow("only to video");
		await withPreferences.set({
			kind: "video",
			baseUrl: oldVideo.baseUrl,
			model: oldVideo.model,
			videoProtocol: "auto",
			videoReferenceFormat: "auto",
		});
		expect(withPreferences.resolve("video")).toMatchObject(oldVideo);
		expect(mediaConnectionHash(withPreferences.resolve("video"))).toBe(
			createHash("sha256").update(JSON.stringify(oldVideo)).digest("hex")
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

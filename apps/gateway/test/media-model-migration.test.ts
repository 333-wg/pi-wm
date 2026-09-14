import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MediaModelRegistry } from "../src/media-models.js";

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
		expect(JSON.stringify(registry.resolve("video"))).toBe(JSON.stringify(oldVideo));
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
		expect(JSON.stringify(restarted.resolve("video"))).toBe(JSON.stringify(oldVideo));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

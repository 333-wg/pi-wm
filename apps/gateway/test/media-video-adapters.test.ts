import { describe, expect, it } from "vitest";
import type { MediaConnection } from "../src/media-models.js";
import {
	videoCapabilities,
	videoProtocol,
	videoRequest,
	videoRemoteId,
	videoResult,
	videoResultResource,
	validateVideoRequest,
} from "../src/media-video.js";

const config: MediaConnection = {
	kind: "video",
	baseUrl: "https://apihub.agnes-ai.com/v1",
	model: "agnes-video-2.5-flash",
	apiKey: "fixture-key",
};
const body = (request: ReturnType<typeof videoRequest>) => JSON.parse(request.body as string);
const reference = { content: new Uint8Array([1, 2, 3]), name: "reference.png", mimeType: "image/png" };

describe("video adapter capability contracts", () => {
	it.each(["agnes-video-2.5", "agnes-video-2.5-flash"])(
		"automatically handles the complete %s task lifecycle",
		(model) => {
			const connection = { ...config, model };
			expect(videoProtocol(connection)).toBe("agnes-v2.5");
			const request = videoRequest(connection, { prompt: "scene", size: "1024x1024", seconds: 8 });
			expect(request.json).toBe(true);
			expect(body(request)).toEqual({
				model,
				prompt: "scene",
				seconds: "8",
				size: "720P",
				aspect_ratio: "1:1",
				mode: "text",
			});
			expect(request.parameters).toEqual({ size: "720P", aspectRatio: "1:1", seconds: 8, mode: "text" });
			expect(videoRemoteId(request.protocol, { video_id: "video_123", id: "task_123" })).toBe("video_123");
			expect(String(videoResultResource(connection, request.protocol, "video_123"))).toContain(
				"/agnesapi?video_id=video_123&model_name=" + model
			);
			expect(
				videoResult(request.protocol, { status: "completed", metadata: { url: "https://cdn.example/video.mp4" } })
			).toEqual({ status: "completed", url: "https://cdn.example/video.mp4" });
		}
	);
	it.each([4, 5, 8, 12])("accepts Agnes duration %s", (seconds) =>
		expect(body(videoRequest(config, { prompt: "scene", seconds })).seconds).toBe(String(seconds))
	);
	it.each([0, 3, 13, 120, 4.5])("rejects Agnes duration %s instead of silently changing it", (seconds) =>
		expect(() => videoRequest(config, { prompt: "scene", seconds })).toThrow("4-12")
	);
	it("maps aspect ratios, uses model defaults and never downgrades an explicit resolution tier", () => {
		expect(body(videoRequest(config, { prompt: "scene", aspectRatio: "9:16" }))).toMatchObject({
			size: "720P",
			aspect_ratio: "9:16",
			seconds: "5",
		});
		expect(() => videoRequest(config, { prompt: "scene", size: "1080P" })).toThrow("Unsupported video resolution");
		expect(body(videoRequest({ ...config, model: "agnes-video-2.5" }, { prompt: "scene", size: "2K" }))).toMatchObject({
			size: "2K",
		});
		expect(() => videoRequest(config, { prompt: "scene", size: "1280x720", aspectRatio: "9:16" })).toThrow("conflict");
	});
	it("never guesses new native Agnes protocols or probes using paid generation", () => {
		expect(() => videoRequest({ ...config, model: "agnes-video-unknown" }, { prompt: "scene" })).toThrow(
			"Unsupported Agnes"
		);
		expect(videoCapabilities({ ...config, model: "agnes-video-unknown" }).note).toContain("blocked");
	});
	it("does not infer a relay protocol from its model name, but supports a saved override", () => {
		const relay = { ...config, baseUrl: "https://relay.example/custom/v1" };
		expect(videoProtocol(relay)).toBe("openai");
		expect(videoRequest(relay, { prompt: "scene" }).body).toBeInstanceOf(FormData);
		expect(videoRequest({ ...relay, videoProtocol: "agnes-v2.5" }, { prompt: "scene" }).json).toBe(true);
	});
	it("automatically uses verified Data URLs for official Flash while preserving public image references", () => {
		const request = videoRequest(config, {
			prompt: "Animate <Picture 1>",
			referenceImageUrl: "https://cdn.example/reference.png",
		});
		expect(body(request)).toMatchObject({ mode: "reference", images: ["https://cdn.example/reference.png"] });
		const base64Config = config;
		expect(videoCapabilities(base64Config)).toMatchObject({
			validation: "verified",
			artifactTransport: "data-url",
			referenceInputs: ["artifact", "public-url"],
		});
		expect(videoCapabilities(base64Config).note).toContain("2026-09-14");
		validateVideoRequest(base64Config, { prompt: "scene", referenceArtifactId: "local-image" });
		expect(
			body(videoRequest(base64Config, { prompt: "scene", referenceArtifactId: "local-image" }, reference))
		).toMatchObject({ mode: "reference", images: ["data:image/png;base64,AQID"] });
	});
	it("does not extend Flash reference verification to standard 2.5 or relays", () => {
		for (const connection of [
			{ ...config, model: "agnes-video-2.5" },
			{ ...config, baseUrl: "https://relay.example/v1", videoProtocol: "agnes-v2.5" as const },
		]) {
			expect(videoCapabilities(connection).validation).not.toBe("verified");
			expect(() => videoRequest(connection, { prompt: "scene", referenceArtifactId: "ref" }, reference)).toThrow(
				"public referenceImageUrl"
			);
			const explicit = { ...connection, videoReferenceFormat: "data-url" as const };
			expect(videoCapabilities(explicit).validation).toBe("compatibility");
			expect(body(videoRequest(explicit, { prompt: "scene", referenceArtifactId: "ref" }, reference)).images).toEqual([
				"data:image/png;base64,AQID",
			]);
		}
	});
	it.each(["agnes", "agnes-v2.5"] as const)("normalizes live top-level url results for %s", (protocol) => {
		expect(videoResult(protocol, { status: "completed", url: "https://cdn.example/video.mp4" })).toEqual({
			status: "completed",
			url: "https://cdn.example/video.mp4",
		});
		expect(() => videoResult(protocol, { status: "completed", url: 123 })).toThrow("metadata.url or url");
	});
	it.each([
		"http://cdn.example/image.png",
		"https://127.0.0.1/image.png",
		"https://169.254.169.254/image.png",
		"https://user:password@cdn.example/image.png",
		"data:image/png;base64,AQID",
	])("rejects unsafe or invented public image inputs: %s", (referenceImageUrl) => {
		expect(() => videoRequest(config, { prompt: "scene", referenceImageUrl })).toThrow();
	});
	it("uploads a local image using the compatible multipart contract", () => {
		const request = videoRequest(
			{ ...config, baseUrl: "https://relay.example/v1", model: "wan-custom" },
			{ prompt: "scene", referenceArtifactId: "artifact" },
			reference
		);
		expect((request.body as FormData).get("input_reference")).toBeInstanceOf(Blob);
	});
	it("automatically Base64-encodes references for JSON transport without returning image bytes in metadata", () => {
		const request = videoRequest(
			{ ...config, baseUrl: "https://relay.example/v1", model: "custom", videoProtocol: "openai-json" },
			{ prompt: "scene", referenceArtifactId: "artifact" },
			reference
		);
		expect(body(request).input_reference).toEqual({ image_url: "data:image/png;base64,AQID" });
		expect(JSON.stringify(request.parameters)).not.toContain("AQID");
	});
	it("supports Base64 JSON references on OpenAI without changing its retrieval protocol", () => {
		const request = videoRequest(
			{ ...config, baseUrl: "https://api.openai.com/v1", model: "sora-2", videoReferenceFormat: "data-url" },
			{ prompt: "scene", referenceArtifactId: "artifact" },
			reference
		);
		expect(request).toMatchObject({ protocol: "openai", json: true });
		expect(body(request).input_reference.image_url).toBe("data:image/png;base64,AQID");
	});
	it("validates known Sora constraints without imposing them on unrelated relay models", () => {
		const connection = { ...config, baseUrl: "https://relay.example/v1", model: "sora-2" };
		expect(() => videoRequest(connection, { prompt: "scene", seconds: 6 })).toThrow("4, 8 or 12");
		expect(() => videoRequest(connection, { prompt: "scene", aspectRatio: "1:1" })).toThrow("landscape");
		expect((videoRequest(connection, { prompt: "scene", aspectRatio: "16:9" }).body as FormData).get("size")).toBe(
			"1280x720"
		);
		expect(
			(videoRequest({ ...connection, model: "another-video" }, { prompt: "scene", seconds: 6 }).body as FormData).get(
				"seconds"
			)
		).toBe("6");
	});
	it("rejects ambiguous references and malformed task responses", () => {
		expect(() =>
			videoRequest(config, {
				prompt: "scene",
				referenceArtifactId: "id",
				referenceImageUrl: "https://cdn.example/ref.png",
			})
		).toThrow("not both");
		expect(() => videoRemoteId("agnes-v2.5", { id: "wrong_id" })).toThrow("Do not resubmit");
		expect(() => videoResult("agnes-v2.5", { status: "completed" })).toThrow("metadata.url");
		expect(videoResult("openai-json", { status: "completed", url: "https://cdn.example/video.mp4" })).toEqual({
			status: "completed",
			url: "https://cdn.example/video.mp4",
		});
	});
});

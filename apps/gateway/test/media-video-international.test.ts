import { describe, expect, it } from "vitest";
import {
	videoCapabilities,
	videoProtocol,
	videoRemoteId,
	videoRequest,
	videoResult,
	videoPollRequest,
	validateVideoRequest,
} from "../src/media-video.js";
import { videoAuthHeaders } from "../src/media-video-auth.js";
import { decodeInlineVideo, googleVideoFile } from "../src/media-video-international.js";
import { classifyModel } from "../src/media-model-discovery.js";
import type { MediaConnection } from "../src/media-models.js";

const veo: MediaConnection = {
	kind: "video",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	model: "veo-3.1-generate-preview",
	apiKey: "private-google-key",
};
const omni: MediaConnection = { ...veo, model: "gemini-omni-1.1-flash" };
const grok: MediaConnection = {
	kind: "video",
	baseUrl: "https://api.x.ai/v1",
	model: "grok-imagine-video-1.5",
	apiKey: "private-grok-key",
};
const reference = { content: new Uint8Array([1, 2, 3]), mimeType: "image/png", name: "reference.png" };
const body = (request: ReturnType<typeof videoRequest>) => JSON.parse(String(request.body));
const operation = "models/veo-3.1-generate-preview/operations/operation-123";

describe("Google and Grok native video adapters", () => {
	it.each([
		[veo, "google-veo"],
		[omni, "google-omni"],
		[grok, "grok"],
	] as const)("detects %s only on the official origin", (config, protocol) => {
		expect(videoProtocol(config)).toBe(protocol);
		expect(videoProtocol({ ...config, baseUrl: "https://relay.example/v1" })).toBe("openai");
		expect(videoProtocol({ ...config, baseUrl: new URL(config.baseUrl).origin + ".evil.test" })).toBe("openai");
		expect(classifyModel({}, config.model)).toBe("video");
		expect(videoCapabilities(config).validation).toBe("documented");
		validateVideoRequest(config, { prompt: "scene", referenceArtifactId: "image" });
		expect(() => videoRequest(config, { prompt: "scene", referenceArtifactId: "image" })).toThrow("resolved");
	});
	it("does not classify Grok chat and image models as video", () => {
		expect(classifyModel({}, "grok-4")).toBe("chat");
		expect(classifyModel({}, "grok-imagine-image")).not.toBe("video");
	});
	it("serializes Veo REST instances/parameters and raw Base64 first-frame input", () => {
		const request = videoRequest(
			veo,
			{ prompt: "scene", seconds: 8, aspectRatio: "9:16", size: "1080P", referenceArtifactId: "image" },
			reference
		);
		expect(String(request.resource)).toBe(veo.baseUrl + "/models/veo-3.1-generate-preview:predictLongRunning");
		expect(body(request)).toEqual({
			instances: [{ prompt: "scene", image: { bytesBase64Encoded: "AQID", mimeType: "image/png" } }],
			parameters: { sampleCount: 1, durationSeconds: 8, resolution: "1080p", aspectRatio: "9:16" },
		});
		expect(JSON.stringify(request.parameters)).not.toContain("AQID");
		expect(videoAuthHeaders(veo, "google-veo", { ...request, resource: request.resource! })).toEqual({
			"x-goog-api-key": "private-google-key",
		});
	});
	it.each([
		{ seconds: 5 },
		{ seconds: 4, size: "1080P" },
		{ size: "1280x720" },
		{ aspectRatio: "1:1" },
		{ referenceImageUrl: "https://cdn.example/image.png" },
	])("rejects unsupported Veo parameters before submission: %j", (params) => {
		expect(() => videoRequest(veo, { prompt: "scene", ...params })).toThrow();
	});
	it("preserves and validates the full Google operation resource name", () => {
		expect(videoRemoteId("google-veo", { name: operation })).toBe(operation);
		expect(String(videoPollRequest(veo, "google-veo", operation).resource)).toBe(veo.baseUrl + "/" + operation);
		for (const name of [
			"https://evil.test/task",
			"models/../operations/task",
			operation + "?key=secret",
			operation + "/../../other",
		])
			expect(() => videoRemoteId("google-veo", { name })).toThrow();
		expect(() => videoPollRequest({ ...veo, model: "veo-3.1-fast-generate-preview" }, "google-veo", operation)).toThrow(
			"mismatched"
		);
		expect(() => videoRemoteId("openai", { id: operation })).toThrow();
	});
	it("normalizes Veo pending, completed, filtered and failed operations", () => {
		expect(videoResult("google-veo", { name: operation })).toEqual({ status: "pending" });
		expect(videoResult("google-veo", { done: false })).toEqual({ status: "pending" });
		expect(
			videoResult("google-veo", {
				done: true,
				response: {
					generateVideoResponse: {
						generatedSamples: [
							{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/video-123:download?alt=media" } },
						],
					},
				},
			}).status
		).toBe("completed");
		expect(videoResult("google-veo", { done: true, error: { code: 400 } })).toEqual({ status: "failed" });
		expect(
			videoResult("google-veo", { done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1 } } })
		).toEqual({ status: "failed" });
		expect(() => videoResult("google-veo", { done: true })).toThrow("no output");
	});
	it("submits Omni as a stored background video interaction", () => {
		const request = videoRequest(
			omni,
			{ prompt: "scene", size: "4K", aspectRatio: "16:9", referenceArtifactId: "image" },
			reference
		);
		expect(String(request.resource)).toBe(omni.baseUrl + "/interactions");
		expect(body(request)).toEqual({
			model: "gemini-omni-1.1-flash",
			background: true,
			store: true,
			input: [
				{ type: "image", data: "AQID", mime_type: "image/png" },
				{ type: "text", text: "scene" },
			],
			response_format: { type: "video", delivery: "uri", resolution: "4k", aspect_ratio: "16:9" },
		});
		const id = "v1_" + "a".repeat(300);
		expect(videoRemoteId("google-omni", { id })).toBe(id);
		expect(String(videoPollRequest(omni, "google-omni", id).resource)).toBe(omni.baseUrl + "/interactions/" + id);
		expect(body(videoRequest(omni, { prompt: "scene", seconds: 8 })).response_format.duration).toBe("8s");
		expect(() => videoRequest(omni, { prompt: "scene", seconds: 11 })).toThrow("3-10");
		expect(videoAuthHeaders(omni, "google-omni", { ...request, resource: request.resource! })).toMatchObject({
			"Api-Revision": "2026-05-20",
		});
		expect(() => videoRemoteId("google-omni", { id: "../files/secret" })).toThrow();
	});
	it("reads Omni model output only, never echoes the user's image/video input", () => {
		expect(videoResult("google-omni", { status: "in_progress" })).toEqual({ status: "pending" });
		expect(videoResult("google-omni", { status: "failed" })).toEqual({ status: "failed" });
		expect(
			videoResult("google-omni", {
				status: "completed",
				steps: [
					{
						type: "model_output",
						content: [
							{
								type: "video",
								uri: "https://generativelanguage.googleapis.com/v1beta/files/video-123",
								mime_type: "video/mp4",
							},
						],
					},
				],
			})
		).toEqual({ status: "completed", url: "https://generativelanguage.googleapis.com/v1beta/files/video-123" });
		expect(
			videoResult("google-omni", {
				status: "completed",
				steps: [{ type: "model_output", content: [{ type: "video", data: "AQID", mime_type: "video/mp4" }] }],
			}).inlineData
		).toEqual({ data: "AQID", mimeType: "video/mp4" });
		expect(() =>
			videoResult("google-omni", {
				status: "completed",
				steps: [{ type: "user_input", content: [{ type: "video", uri: "https://cdn.example/input.mp4" }] }],
			})
		).toThrow("no video output");
	});
	it("serializes Grok generations and normalizes request IDs/results", () => {
		const request = videoRequest(
			grok,
			{ prompt: "scene", seconds: 6, size: "720P", aspectRatio: "3:2", referenceArtifactId: "image" },
			reference
		);
		expect(String(request.resource)).toBe("https://api.x.ai/v1/videos/generations");
		expect(body(request)).toEqual({
			model: grok.model,
			prompt: "scene",
			duration: 6,
			resolution: "720p",
			aspect_ratio: "3:2",
			image: { url: "data:image/png;base64,AQID" },
		});
		expect(videoRemoteId("grok", { request_id: "request-123" })).toBe("request-123");
		expect(String(videoPollRequest(grok, "grok", "request-123").resource)).toBe(
			"https://api.x.ai/v1/videos/request-123"
		);
		expect(videoResult("grok", { status: "pending" })).toEqual({ status: "pending" });
		expect(videoResult("grok", { status: "expired" })).toEqual({ status: "failed" });
		expect(
			videoResult("grok", { status: "done", video: { url: "https://cdn.example/video.mp4", respect_moderation: true } })
		).toEqual({ status: "completed", url: "https://cdn.example/video.mp4" });
		expect(
			videoResult("grok", {
				status: "done",
				video: { url: "https://cdn.example/video.mp4", respect_moderation: false },
			})
		).toEqual({ status: "failed" });
	});
	it("supports 1080p across Grok 1.5 aliases without upgrading the original model", () => {
		for (const model of [
			"grok-imagine-video-1.5",
			"grok-imagine-video-1.5-preview",
			"grok-imagine-video-1.5-2026-05-30",
		])
			expect(body(videoRequest({ ...grok, model }, { prompt: "scene", size: "1080P" }))).toMatchObject({
				model,
				resolution: "1080p",
			});
		expect(() => videoRequest({ ...grok, model: "grok-imagine-video" }, { prompt: "scene", size: "1080P" })).toThrow(
			"resolution"
		);
	});
	it.each([{ seconds: 16 }, { seconds: 0 }, { seconds: 4.5 }, { size: "4K" }, { aspectRatio: "21:9" }])(
		"rejects incompatible Grok parameters: %j",
		(params) => {
			expect(() => videoRequest(grok, { prompt: "scene", ...params })).toThrow();
		}
	);
	it("never sends unrelated Google/Grok models to the generic Videos endpoint", () => {
		for (const config of [
			{ ...veo, model: "gemini-chat" },
			{ ...grok, model: "grok-4" },
		])
			expect(() => videoRequest(config, { prompt: "scene" })).toThrow();
		expect(() =>
			videoRequest({ ...veo, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }, { prompt: "scene" })
		).toThrow("Base URL");
	});
});

describe("Google download boundaries", () => {
	it("only sends credentials to a same-origin Files API resource", () => {
		const file = googleVideoFile(veo, veo.baseUrl + "/files/video-123")!;
		expect(String(file.metadata)).toBe(veo.baseUrl + "/files/video-123");
		expect(String(file.download)).toBe(veo.baseUrl + "/files/video-123:download?alt=media");
		expect(videoAuthHeaders(omni, "google-omni", { resource: file.download })).toEqual({
			"x-goog-api-key": omni.apiKey,
		});
		expect(
			String(googleVideoFile(veo, "https://generativelanguage.googleapis.com/files/video-123:download")!.download)
		).toBe(String(file.download));
		expect(googleVideoFile(veo, "https://cdn.example/output.mp4")).toBeUndefined();
		expect(String(googleVideoFile(veo, "https://generativelanguage.googleapis.com/files/video-123")!.metadata)).toBe(
			veo.baseUrl + "/files/video-123"
		);
		for (const uri of [
			veo.baseUrl + "/models/private",
			veo.baseUrl + "/files/x?key=secret",
			"http://cdn.example/output.mp4",
			"https://user:pass@cdn.example/output.mp4",
		])
			expect(() => googleVideoFile(veo, uri)).toThrow();
	});
	it("bounds and validates inline media before decoding", () => {
		expect(decodeInlineVideo("AQID", 3)).toEqual(Buffer.from([1, 2, 3]));
		for (const data of ["AQID", "not base64", "!!!!", "data:video/mp4;base64,AQID"])
			expect(() => decodeInlineVideo(data, 2)).toThrow();
	});
});

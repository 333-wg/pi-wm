import { describe, expect, it } from "vitest";
import { imageCapabilities, imageProtocol, imageRequest, validateImageRequest } from "../src/media-image.js";

const official = { baseUrl: "https://api.x.ai/v1", model: "grok-imagine-image-2.0" };
const relay = { baseUrl: "https://relay.example/api/v1", model: "grok-imagine-image" };
describe("image protocol adapters", () => {
	it("detects official xAI only and honors explicit relay overrides", () => {
		expect(imageProtocol(official)).toBe("grok");
		expect(imageProtocol(relay)).toBe("openai");
		expect(imageProtocol({ ...relay, imageProtocol: "grok" })).toBe("grok");
		expect(imageProtocol({ ...official, imageProtocol: "openai" })).toBe("openai");
		expect(imageProtocol({ ...official, baseUrl: "https://api.x.ai.attacker.example" })).toBe("openai");
	});
	it("serializes Grok ratios, resolution and model-specific quality without OpenAI size", () => {
		const request = imageRequest(official, {
			prompt: "landscape",
			aspectRatio: "16:9",
			resolution: "2k",
			quality: "low",
		});
		expect(request.resource).toBe("images/generations");
		expect(request.json).toBe(true);
		expect(JSON.parse(String(request.body))).toEqual({
			model: official.model,
			prompt: "landscape",
			n: 1,
			aspect_ratio: "16:9",
			resolution: "2k",
			quality: "low",
		});
	});
	it.each([{ size: "1024x1024" }, { size: "auto" }, { aspectRatio: "7:3" }, { resolution: "4k" }, { quality: "high" }])(
		"rejects unsupported explicit constraints rather than silently dropping them: %j",
		(params) => {
			expect(() => validateImageRequest(official, { prompt: "image", ...params })).toThrow();
		}
	);
	it("does not grant legacy models editing or modern controls", () => {
		const config = { ...official, model: "grok-2-image-1212" };
		expect(imageCapabilities(config).generationModes).toEqual(["text"]);
		for (const params of [
			{ referenceArtifactId: "ref" },
			{ aspectRatio: "1:1" },
			{ resolution: "2k" },
			{ quality: "auto" },
		])
			expect(() => validateImageRequest(config, { prompt: "image", ...params })).toThrow();
		expect(() => imageRequest(config, { prompt: "image" })).not.toThrow();
	});
	it("keeps reference bytes in the request, not a public upload or metadata", () => {
		const reference = { content: Buffer.from("fixture"), mimeType: "image/png", name: "private.png" };
		const request = imageRequest(
			{ ...relay, imageProtocol: "grok" },
			{ prompt: "edit", referenceArtifactId: "ref" },
			reference
		);
		expect(request.resource).toBe("images/edits");
		expect(request.json).toBe(true);
		expect(JSON.parse(String(request.body)).image).toEqual({
			url: "data:image/png;base64,Zml4dHVyZQ==",
			type: "image_url",
		});
		expect(() => imageRequest(official, { prompt: "edit" }, { ...reference, mimeType: "image/gif" })).toThrow("PNG");
	});
	it("preserves OpenAI generation and multipart editing while rejecting Grok-only options", () => {
		const params = { prompt: "image", size: "1024x1024", quality: "high" };
		expect(JSON.parse(String(imageRequest(relay, params).body))).toEqual({ model: relay.model, n: 1, ...params });
		const request = imageRequest(relay, params, {
			content: Buffer.from("fixture"),
			mimeType: "image/png",
			name: "ref.png",
		});
		expect(request.json).toBe(false);
		expect((request.body as FormData).get("image")).toBeInstanceOf(Blob);
		expect((request.body as FormData).get("size")).toBe("1024x1024");
		for (const extra of [{ aspectRatio: "1:1" }, { resolution: "1k" }])
			expect(() => imageRequest(relay, { prompt: "image", ...extra })).toThrow("Settings");
	});
});

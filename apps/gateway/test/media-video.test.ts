import { describe, expect, it } from "vitest";
import { videoProtocol, videoRequest, videoResultResource } from "../src/media-video.js";
import type { MediaConnection } from "../src/media-models.js";

const config: MediaConnection = {
	kind: "video",
	baseUrl: "https://apihub.agnes-ai.com/v1",
	model: "agnes-video-v2.0",
	apiKey: "fixture-key",
};

describe("Agnes video protocol", () => {
	it.each(["https://apihub.agnes-ai.com", "https://apihub.agnes-ai.com/", "https://apihub.agnes-ai.com/v1/"])(
		"recognizes only the documented official connection: %s",
		(baseUrl) => expect(videoProtocol({ ...config, baseUrl })).toBe("agnes")
	);
	it.each([
		{ baseUrl: "https://relay.example/v1" },
		{ baseUrl: "https://apihub.agnes-ai.com.example/v1" },
		{ baseUrl: "https://apihub.agnes-ai.com/custom/v1" },
		{ baseUrl: "https://apihub.agnes-ai.com:8443/v1" },
		{ model: "sora-2" },
		{ model: "agnes-video-unknown" },
	])("preserves the existing transport for other connections: %j", (change) => {
		const request = videoRequest({ ...config, ...change }, { prompt: "scene", size: "1280x720", seconds: 4 });
		expect(request.protocol).toBe("openai");
		expect(request.json).toBe(false);
		expect(Object.fromEntries((request.body as FormData).entries())).toEqual({
			model: change.model ?? config.model,
			prompt: "scene",
			size: "1280x720",
			seconds: "4",
		});
	});
	it("uses documented JSON defaults without leaking the key into the body", () => {
		const request = videoRequest(config, { prompt: "scene" });
		expect(request.protocol).toBe("agnes");
		expect(request.json).toBe(true);
		expect(JSON.parse(request.body as string)).toEqual({
			model: config.model,
			prompt: "scene",
			width: 1152,
			height: 768,
			num_frames: 121,
			frame_rate: 24,
		});
	});
	it.each([1, 4, 10, 18])("maps %i seconds to valid 8n+1 frames", (seconds) => {
		const request = videoRequest(config, { prompt: "scene", size: "720x1280", seconds });
		const body = JSON.parse(request.body as string);
		expect(body).toMatchObject({ width: 720, height: 1280, num_frames: seconds * 24 + 1 });
		expect((body.num_frames - 1) % 8).toBe(0);
		expect(body.num_frames).toBeLessThanOrEqual(441);
	});
	it.each([0, 19, 120, 1.5])("rejects unsupported duration %s before a request", (seconds) => {
		expect(() => videoRequest(config, { prompt: "scene", seconds })).toThrow("1-18 seconds");
	});
	it("builds a same-origin result query, not a v1/videos/content URL", () => {
		const resource = videoResultResource(config, "agnes", "video_123") as URL;
		expect(resource.origin + resource.pathname).toBe("https://apihub.agnes-ai.com/agnesapi");
		expect(Object.fromEntries(resource.searchParams)).toEqual({ video_id: "video_123", model_name: config.model });
		expect(videoResultResource(config, "openai", "task_123")).toBe("videos/task_123");
	});
});

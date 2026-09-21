import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
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
import { minimaxFileRequest, minimaxFileUrl } from "../src/media-video-native.js";
import { mediaErrorDetail } from "../src/media-errors.js";
import type { MediaConnection } from "../src/media-models.js";

const connections: MediaConnection[] = [
	{
		kind: "video",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		model: "doubao-seedance-1-5-pro-251215",
		apiKey: "test-key",
		videoProtocol: "seedance",
	},
	{
		kind: "video",
		baseUrl: "https://visual.volcengineapi.com",
		model: "jimeng_ti2v_v30_pro",
		apiKey: "test-ak",
		apiSecret: "test-sk",
		videoProtocol: "jimeng",
	},
	{
		kind: "video",
		baseUrl: "https://api-beijing.klingai.com/v1",
		model: "kling-v2-6",
		apiKey: "test-ak",
		apiSecret: "test-sk",
		videoProtocol: "kling",
	},
	{
		kind: "video",
		baseUrl: "https://dashscope.aliyuncs.com/api/v1",
		model: "wan2.6-t2v",
		apiKey: "test-key",
		videoProtocol: "wan",
	},
	{
		kind: "video",
		baseUrl: "https://api.minimaxi.com/v1",
		model: "MiniMax-Hailuo-2.3",
		apiKey: "test-key",
		videoProtocol: "minimax",
	},
	{
		kind: "video",
		baseUrl: "https://api.vidu.cn/ent/v2",
		model: "viduq3-pro",
		apiKey: "test-key",
		videoProtocol: "vidu",
	},
];
const connection = (protocol: string) => connections.find((config) => config.videoProtocol === protocol)!;
const body = (request: ReturnType<typeof videoRequest>) => JSON.parse(request.body as string);
const reference = { content: new Uint8Array([1, 2, 3]), mimeType: "image/png", name: "reference.png" };

describe("native video contracts", () => {
	it.each(connections)("recognizes $videoProtocol by official origin, not a relay model name", (config) => {
		expect(videoProtocol({ ...config, videoProtocol: "auto" })).toBe(config.videoProtocol);
		expect(videoProtocol({ ...config, baseUrl: "https://relay.example/v1", videoProtocol: "auto" })).toBe("openai");
		expect(
			videoProtocol({ ...config, baseUrl: new URL(config.baseUrl).origin + ".evil.test", videoProtocol: "auto" })
		).toBe("openai");
		expect(videoCapabilities(config).validation).toBe("documented");
	});
	it.each(connections)("rejects a chat URL and unresolved reference for $videoProtocol", (config) => {
		expect(() =>
			videoRequest({ ...config, baseUrl: new URL(config.baseUrl).origin + "/chat/completions" }, { prompt: "scene" })
		).toThrow("Base URL");
		const imageConfig = config.videoProtocol === "wan" ? { ...config, model: "wan2.6-i2v" } : config;
		expect(() => videoRequest(imageConfig, { prompt: "scene", referenceArtifactId: "artifact" })).toThrow("resolved");
		expect(() => validateVideoRequest(imageConfig, { prompt: "scene", referenceArtifactId: "artifact" })).not.toThrow();
		expect(() =>
			videoRequest(imageConfig, { prompt: "scene", referenceImageUrl: "https://127.0.0.1/private.png" })
		).toThrow();
	});
	it("serializes Seedance text, resolution, duration and a Data URL first frame", () => {
		const request = videoRequest(
			connection("seedance"),
			{ prompt: "scene", seconds: 5, size: "720P", aspectRatio: "9:16", referenceArtifactId: "artifact" },
			reference
		);
		expect(String(request.resource)).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
		expect(body(request)).toMatchObject({
			duration: 5,
			resolution: "720p",
			ratio: "9:16",
			content: [
				{ type: "text", text: "scene" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" }, role: "first_frame" },
			],
		});
		expect(videoRemoteId("seedance", { id: "task-123" })).toBe("task-123");
		expect(
			videoResult("seedance", { status: "succeeded", content: { video_url: "https://cdn.example/video.mp4" } }).url
		).toBe("https://cdn.example/video.mp4");
	});
	it("uses Jimeng req_key, frames and separately signed POST polling", () => {
		const config = connection("jimeng");
		const request = videoRequest(config, { prompt: "scene", seconds: 10, referenceArtifactId: "artifact" }, reference);
		expect(body(request)).toEqual({
			req_key: config.model,
			prompt: "scene",
			frames: 241,
			binary_data_base64: ["AQID"],
		});
		expect((request.resource as URL).searchParams.get("Action")).toBe("CVSync2AsyncSubmitTask");
		const poll = videoPollRequest(config, "jimeng", "task-123");
		expect(JSON.parse(String(poll.body))).toEqual({ req_key: config.model, task_id: "task-123" });
		expect((poll.resource as URL).searchParams.get("Action")).toBe("CVSync2AsyncGetResult");
		expect(videoRemoteId("jimeng", { code: 10000, data: { task_id: "task-123" } })).toBe("task-123");
		expect(
			videoResult("jimeng", { code: 10000, data: { status: "done", video_url: "https://cdn.example/video.mp4" } })
				.status
		).toBe("completed");
		expect(() => videoRequest(config, { prompt: "scene", seconds: 6 })).toThrow("duration");
		expect(() => videoRequest({ ...config, model: "jimeng-unknown" }, { prompt: "scene" })).toThrow("req_key");
	});
	it("persists Kling query mode and never confuses image and text tasks", () => {
		const config = connection("kling");
		const request = videoRequest(config, { prompt: "scene", referenceArtifactId: "artifact" }, reference);
		expect(body(request)).toMatchObject({ model_name: "kling-v2-6", mode: "pro", duration: "5", image: "AQID" });
		expect(request.context).toEqual({ mode: "image" });
		expect(String(videoPollRequest(config, "kling", "task-123", request.context).resource)).toBe(
			"https://api-beijing.klingai.com/v1/videos/image2video/task-123"
		);
		expect(String(videoPollRequest(config, "kling", "task-123", { mode: "text" }).resource)).toBe(
			"https://api-beijing.klingai.com/v1/videos/text2video/task-123"
		);
		expect(() => videoPollRequest(config, "kling", "task-123")).toThrow("mode");
		expect(
			videoResult("kling", {
				code: 0,
				data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.example/video.mp4" }] } },
			}).status
		).toBe("completed");
	});
	it("maps Wan text size separately from image resolution and requires matching input", () => {
		const config = connection("wan");
		const text = videoRequest(config, { prompt: "scene", seconds: 5, size: "1080P", aspectRatio: "9:16" });
		expect(text.headers).toEqual({ "X-DashScope-Async": "enable" });
		expect(body(text)).toMatchObject({ parameters: { size: "1080*1920", duration: 5 } });
		const image = videoRequest(
			{ ...config, model: "wan2.6-i2v" },
			{ prompt: "scene", size: "720P", referenceArtifactId: "artifact" },
			reference
		);
		expect(body(image)).toMatchObject({
			input: { img_url: "data:image/png;base64,AQID" },
			parameters: { resolution: "720P" },
		});
		expect(() => videoRequest(config, { prompt: "scene", referenceArtifactId: "artifact" }, reference)).toThrow(
			"reference images"
		);
		expect(() => videoRequest({ ...config, model: "wan2.6-i2v" }, { prompt: "scene" })).toThrow("mismatch");
		expect(String(videoPollRequest(config, "wan", "task-123").resource)).toBe(
			"https://dashscope.aliyuncs.com/api/v1/tasks/task-123"
		);
	});
	it("retrieves MiniMax by file ID instead of assuming a video content endpoint", () => {
		const config = connection("minimax");
		expect(
			body(
				videoRequest(config, { prompt: "scene", seconds: 6, size: "1080P", referenceArtifactId: "artifact" }, reference)
			)
		).toMatchObject({ duration: 6, resolution: "1080P", first_frame_image: "data:image/png;base64,AQID" });
		expect(videoResult("minimax", { status: "Success", file_id: "123456", base_resp: { status_code: 0 } })).toEqual({
			status: "completed",
			fileId: "123456",
		});
		expect(String(minimaxFileRequest(config, "123456"))).toBe(
			"https://api.minimaxi.com/v1/files/retrieve?file_id=123456"
		);
		expect(minimaxFileUrl({ file: { download_url: "https://cdn.example/video.mp4" } })).toBe(
			"https://cdn.example/video.mp4"
		);
		expect(() => videoRequest(config, { prompt: "scene", seconds: 10, size: "1080P" })).toThrow("6 seconds");
	});
	it("uses Vidu img2video and creations contract", () => {
		const config = connection("vidu");
		const request = videoRequest(config, { prompt: "scene", size: "720P", referenceArtifactId: "artifact" }, reference);
		expect(String(request.resource)).toBe("https://api.vidu.cn/ent/v2/img2video");
		expect(body(request)).toMatchObject({ images: ["data:image/png;base64,AQID"], resolution: "720p" });
		expect(
			videoResult("vidu", { state: "success", creations: [{ url: "https://cdn.example/video.mp4" }] }).status
		).toBe("completed");
		expect(videoAuthHeaders(config, "vidu", { ...request, resource: request.resource! })).toEqual({
			Authorization: "Token test-key",
		});
	});
	it("routes H3 through V2 content/tasks instead of legacy file IDs", () => {
		const config = { ...connection("minimax"), model: "MiniMax-H3" };
		const request = videoRequest(
			config,
			{ prompt: "scene", seconds: 4, size: "2K", referenceArtifactId: "artifact" },
			reference
		);
		expect(String(request.resource)).toBe("https://api.minimaxi.com/v2/video_generation");
		expect(body(request)).toMatchObject({
			duration: 4,
			resolution: "2K",
			ratio: "adaptive",
			content: [
				{ type: "text", text: "scene" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" }, role: "first_frame" },
			],
		});
		expect(String(videoPollRequest(config, "minimax", "task-123").resource)).toBe(
			"https://api.minimaxi.com/v2/query/video_generation/task-123"
		);
		expect(
			videoResult("minimax", { task: { status: "succeeded", content: { url: "https://cdn.example/video.mp4" } } })
		).toEqual({ status: "completed", url: "https://cdn.example/video.mp4" });
		expect(() => videoRequest({ ...config, model: "MiniMax-H3-Max" }, { prompt: "scene", seconds: 4 })).toThrow(
			"duration"
		);
	});
	it("enforces Vidu mode and model-specific duration/resolution contracts", () => {
		const config = connection("vidu");
		expect(() =>
			videoRequest({ ...config, model: "viduq2" }, { prompt: "scene", referenceArtifactId: "artifact" }, reference)
		).toThrow("reference images");
		expect(() => videoRequest({ ...config, model: "viduq2-pro" }, { prompt: "scene" })).toThrow("endpoint");
		expect(() => videoRequest({ ...config, model: "viduq1" }, { prompt: "scene", seconds: 6 })).toThrow("duration");
		expect(() =>
			videoRequest(
				{ ...config, model: "vidu2.0" },
				{ prompt: "scene", seconds: 8, size: "1080P", referenceArtifactId: "artifact" },
				reference
			)
		).toThrow("720P");
	});
	it.each([
		["seedance", { status: "running" }, { status: "failed" }],
		["jimeng", { code: 10000, data: { status: "in_queue" } }, { code: 10000, data: { status: "expired" } }],
		["kling", { code: 0, data: { task_status: "processing" } }, { code: 0, data: { task_status: "failed" } }],
		["wan", { output: { task_status: "PENDING" } }, { output: { task_status: "FAILED" } }],
		["minimax", { status: "Queueing" }, { status: "Fail" }],
		["vidu", { state: "queueing" }, { state: "failed" }],
	] as const)("normalizes %s pending/failed and rejects unknown states", (protocol, pending, failed) => {
		expect(videoResult(protocol, pending)).toEqual({ status: "pending" });
		expect(videoResult(protocol, failed)).toEqual({ status: "failed" });
		expect(() => videoResult(protocol, {})).toThrow();
	});
	it("rejects HTTP-200 business errors and incomplete completions", () => {
		expect(() => videoRemoteId("kling", { code: 1001, data: { task_id: "not-a-job" } })).toThrow();
		expect(() => videoRemoteId("jimeng", { code: 50400, data: { task_id: "not-a-job" } })).toThrow();
		expect(() => videoRemoteId("minimax", { base_resp: { status_code: 1004 }, task_id: "not-a-job" })).toThrow();
		expect(() => videoRemoteId("wan", { code: "InvalidApiKey", output: { task_id: "not-a-job" } })).toThrow();
		expect(() => videoResult("vidu", { state: "success", creations: [] })).toThrow("no download URL");
		expect(() => videoRemoteId("seedance", { id: "../another-task" })).toThrow();
		expect(() =>
			videoResult("seedance", {
				status: "succeeded",
				content: { video_url: "https://user:pass@cdn.example/video.mp4" },
			})
		).toThrow("Unsafe");
	});
});

describe("native video authentication", () => {
	it("signs Kling JWT locally with short expiry and clock-skew tolerance", () => {
		const config = connection("kling");
		const now = Date.UTC(2026, 8, 21, 0, 0, 0);
		const token = videoAuthHeaders(config, "kling", { resource: "unused" }, now).Authorization!.slice(7);
		const [header, payload, signature] = token.split(".");
		expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
		expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
			iss: "test-ak",
			exp: now / 1000 + 1800,
			nbf: now / 1000 - 5,
		});
		expect(signature).toBe(
			createHmac("sha256", "test-sk")
				.update(header + "." + payload)
				.digest("base64url")
		);
		const { apiSecret: _secret, ...withoutSecret } = config;
		expect(() => videoAuthHeaders(withoutSecret, "kling", { resource: "unused" })).toThrow("Secret Key");
	});
	it("signs Jimeng exact body and query, refreshing signatures for polling", () => {
		const config = connection("jimeng");
		const request = videoRequest(config, { prompt: "scene" });
		const now = Date.UTC(2026, 8, 21);
		const headers = videoAuthHeaders(config, "jimeng", { ...request, resource: request.resource! }, now);
		expect(headers["X-Date"]).toBe("20260921T000000Z");
		expect(headers.Authorization).toMatch(
			new RegExp(
				"^HMAC-SHA256 Credential=test-ak/20260921/cn-north-1/cv/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[a-f0-9]{64}$"
			)
		);
		expect(headers.Authorization).not.toContain("test-sk");
		expect(
			videoAuthHeaders(config, "jimeng", videoPollRequest(config, "jimeng", "task-123"), now).Authorization
		).not.toBe(headers.Authorization);
		expect(
			videoAuthHeaders(config, "jimeng", { ...request, resource: request.resource! }, now + 1000).Authorization
		).not.toBe(headers.Authorization);
	});
	it("redacts both credentials and generated authentication material", () => {
		const config = connection("jimeng");
		const detail = mediaErrorDetail(
			{
				message:
					"test-ak test-sk Token transient-token Signature=abc Credential=foo eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJhIn0.abc",
			},
			config
		);
		for (const secret of ["test-ak", "test-sk", "transient-token", "Signature=abc", "Credential=foo", "eyJ"])
			expect(detail).not.toContain(secret);
	});
});

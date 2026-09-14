import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore, validateArtifact } from "@wuming/artifacts";
import type { ArtifactRef, SessionSnapshot } from "@wuming/protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SafeWebClient, type ApprovalBroker } from "@wuming/sandbox";
import { MediaModelRegistry, mediaResourceUrl, readMediaBody } from "../src/media-models.js";
import { MediaGenerationService } from "../src/media-generation.js";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=",
	"base64"
);
const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32000000086d646174", "hex");
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const snapshot = (session = "session"): SessionSnapshot => ({
	session: { id: session, workspaceId: "workspace", phase: "turn", createdAt: 1, updatedAt: 1 },
	revision: 1,
	model: { provider: "chat", id: "not-the-image-model" },
	thinkingLevel: "off",
	sandboxMode: "workspace_write",
	approvalPolicy: "never",
	transcript: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	pendingApprovals: [],
	usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
});
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "wuming-media-test-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const options = { filePath: join(root, "models.enc"), encryptionKey: "test-encryption-key" };
	const models = new MediaModelRegistry(options);
	const artifacts = await ArtifactStore.open(join(root, "artifacts.db"), join(root, "objects"), {
		maxVideoBytes: 100 * 1024 * 1024,
	});
	cleanup.push(() => artifacts.close());
	const fetchMock = vi.fn<typeof fetch>();
	const download = vi.fn().mockResolvedValue(png);
	const approvals = { authorize: vi.fn().mockResolvedValue(undefined), completeAuthorization: vi.fn() };
	const services: MediaGenerationService[] = [];
	const service = () => {
		const value = new MediaGenerationService({
			models,
			artifacts,
			databasePath: join(root, "jobs.db"),
			fetch: fetchMock,
			download,
			pollMs: 1,
		});
		services.push(value);
		return value;
	};
	cleanup.push(() => {
		for (const value of services) value.close();
	});
	const invoke = (
		name: string,
		params: Record<string, unknown>,
		state = snapshot(),
		signal?: AbortSignal,
		instance = service()
	) => {
		const tool = instance
			.createTools(state, approvals as unknown as ApprovalBroker)
			.find((value) => value.name === name)!;
		return tool.execute(
			"call",
			params,
			signal,
			undefined,
			undefined as unknown as Parameters<ToolDefinition["execute"]>[4]
		);
	};
	const configure = (
		kind: "image" | "video" = "image",
		baseUrl = "https://relay.example/v1",
		model = `${kind}-custom-id`
	) => models.set({ kind, baseUrl, model, apiKey: "private-media-key" });
	return { root, options, models, artifacts, fetchMock, download, approvals, service, invoke, configure };
}

describe("media model settings", () => {
	it("persists selected image models, validates the default and limits selection to saved IDs", async () => {
		const f = await fixture();
		await f.models.set({
			kind: "image",
			baseUrl: "https://relay.example/v1",
			model: "first",
			models: ["first", "second"],
			apiKey: "private-media-key",
		});
		const reloaded = new MediaModelRegistry(f.options);
		await reloaded.load();
		expect(reloaded.list()[0]).toMatchObject({ model: "first", models: ["first", "second"] });
		expect(reloaded.resolve("image").model).toBe("first");
		expect(reloaded.resolve("image", "second").model).toBe("second");
		expect(() => reloaded.resolve("image", "not-selected")).toThrow("已选");
		reloaded.list()[0]!.models!.push("injected");
		reloaded.resolve("image").models!.push("injected");
		expect(() => reloaded.resolve("image", "injected")).toThrow("已选");
		for (const models of [
			[],
			["other"],
			["first", " first "],
			Array.from({ length: 51 }, (_, i) => (i === 0 ? "first" : `id-${i}`)),
		]) {
			await expect(
				reloaded.set({ kind: "image", baseUrl: "https://relay.example/v1", model: "first", models })
			).rejects.toThrow();
		}
		await expect(
			reloaded.set({
				kind: "video",
				baseUrl: "https://relay.example/v1",
				model: "first",
				models: ["first", "second"],
				apiKey: "key",
			})
		).rejects.toThrow("不支持多选");
		expect(reloaded.list()[0]!.models).toEqual(["first", "second"]);
		await reloaded.set({ kind: "image", baseUrl: "https://relay.example/v1", model: "second", models: ["second"] });
		expect(reloaded.resolve("image").model).toBe("second");
		expect(() => reloaded.resolve("image", "first")).toThrow("已选");
	});
	it("generates once with the default or one explicitly selected model and rejects other IDs before billing", async () => {
		const f = await fixture();
		await f.models.set({
			kind: "image",
			baseUrl: "https://relay.example/v1",
			model: "first",
			models: ["first", "second"],
			apiKey: "private-media-key",
		});
		f.fetchMock.mockImplementation(async () => json({ data: [{ b64_json: png.toString("base64") }] }));
		await f.invoke("generate_image", { prompt: "default" });
		await f.invoke("generate_image", { prompt: "explicit", model: "second" });
		expect(f.fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model)).toEqual(["first", "second"]);
		expect(f.approvals.authorize).toHaveBeenCalledTimes(2);
		await expect(f.invoke("generate_image", { prompt: "blocked", model: "skill-vendor-model" })).rejects.toThrow(
			"已选"
		);
		expect(f.fetchMock).toHaveBeenCalledTimes(2);
		expect(f.approvals.authorize).toHaveBeenCalledTimes(2);
		const status = await f.invoke("media_model_status", {});
		expect(status.content[0]).toMatchObject({
			text: expect.stringContaining('"defaultModel":"first","models":["first","second"]'),
		});
		expect(JSON.stringify(status)).not.toContain("private-media-key");
	});
	it("lets any skill inspect live defaults without exposing credentials or making requests", async () => {
		const f = await fixture();
		const instance = f.service();
		const state = { ...snapshot(), sandboxMode: "read_only" as const };
		const inspect = async () => {
			const result = await f.invoke("media_model_status", {}, state, undefined, instance);
			const part = result.content[0];
			if (part?.type !== "text") throw new Error("No media status");
			return JSON.parse(part.text);
		};
		expect(await inspect()).toMatchObject({
			defaults: [
				{ kind: "image", configured: false },
				{ kind: "video", configured: false },
			],
			perSkillSetupRequired: false,
		});
		await f.configure();
		const value = await inspect();
		expect(value.defaults[0]).toMatchObject({ kind: "image", configured: true });
		const configured = JSON.stringify(value);
		expect(configured).not.toContain("private-media-key");
		expect(configured).not.toContain("relay.example");
		await f.models.remove("image");
		expect((await inspect()).defaults[0]).toMatchObject({ kind: "image", configured: false });
		expect(f.fetchMock).not.toHaveBeenCalled();
		expect(f.approvals.authorize).not.toHaveBeenCalled();
	});
	it("encrypts secrets, reloads independent defaults, and never returns keys in settings", async () => {
		const f = await fixture();
		await Promise.all([f.configure(), f.configure("video")]);
		const raw = await readFile(f.options.filePath, "utf8");
		expect(raw).not.toContain("private-media-key");
		expect(raw).not.toContain("custom-id");
		const reloaded = new MediaModelRegistry(f.options);
		await reloaded.load();
		expect(reloaded.list()).toHaveLength(2);
		expect(JSON.stringify(reloaded.list())).not.toContain("apiKey");
		await reloaded.set({ kind: "image", baseUrl: "https://relay.example/v1/", model: "updated-model" });
		expect(reloaded.resolve("image").apiKey).toBe("private-media-key");
		await reloaded.remove("image");
		expect(reloaded.list().map((value) => value.kind)).toEqual(["video"]);
	});

	it("does not reuse a secret on a changed endpoint and rejects insecure settings", async () => {
		const f = await fixture();
		await f.configure();
		await expect(f.models.set({ kind: "image", baseUrl: "https://other.example/v1", model: "x" })).rejects.toThrow(
			"API Key"
		);
		expect(f.models.resolve("image").baseUrl).toBe("https://relay.example/v1");
		for (const url of [
			"http://relay.example/v1",
			"https://key:secret@relay.example/v1",
			"https://relay.example/?key=secret",
			"file:///secret",
		])
			expect(() => mediaResourceUrl(url, "images/generations")).toThrow();
		expect(mediaResourceUrl("https://api.openai.com", "images/generations")).toBe(
			"https://api.openai.com/v1/images/generations"
		);
		expect(mediaResourceUrl("https://relay.example/api/v1/", "images/generations")).toBe(
			"https://relay.example/api/v1/images/generations"
		);
		expect(mediaResourceUrl("http://127.0.0.1:8000/v1", "images/generations")).toContain(":8000/v1/images/generations");
	});

	it("does not mutate memory if persistence fails", async () => {
		const f = await fixture();
		const invalid = new MediaModelRegistry({ ...f.options, filePath: f.root });
		await expect(
			invalid.set({ kind: "image", baseUrl: "https://relay.example", model: "x", apiKey: "key" })
		).rejects.toThrow();
		expect(invalid.list()).toEqual([]);
	});
});

describe("image generation via official and relay endpoints", () => {
	for (const baseUrl of ["https://api.openai.com/v1", "https://relay.example/custom/v1"]) {
		it(`uses the saved default and Base64 response at ${baseUrl}`, async () => {
			const f = await fixture();
			await f.configure("image", baseUrl);
			f.fetchMock.mockResolvedValueOnce(json({ data: [{ b64_json: png.toString("base64") }] }));
			const result = await f.invoke("generate_image", { prompt: "A red square" });
			expect(f.fetchMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/images/generations`);
			const init = f.fetchMock.mock.calls[0]?.[1];
			expect(JSON.parse(String(init?.body))).toEqual({ model: "image-custom-id", prompt: "A red square", n: 1 });
			expect(init?.redirect).toBe("error");
			expect(init?.headers).toMatchObject({ Authorization: "Bearer private-media-key" });
			const artifact = (result.details as { artifact: ArtifactRef }).artifact;
			expect(artifact.mimeType).toBe("image/png");
			expect((await f.artifacts.read(artifact.id)).content).toEqual(png);
			expect(JSON.stringify(result)).not.toContain("private-media-key");
		});
	}

	it("downloads URL responses without forwarding provider credentials", async () => {
		const f = await fixture();
		await f.configure();
		f.fetchMock.mockResolvedValueOnce(json({ data: [{ url: "https://cdn.example/generated.png?signature=opaque" }] }));
		const result = await f.invoke("generate_image", { prompt: "image" });
		expect(f.download).toHaveBeenCalledWith("https://cdn.example/generated.png?signature=opaque", {
			maxBytes: 10 * 1024 * 1024,
			signal: expect.any(AbortSignal),
		});
		expect(JSON.stringify(result)).not.toContain("signature");
	});

	it("rejects private result URLs before making a network connection", async () => {
		const client = new SafeWebClient();
		for (const url of ["http://127.0.0.1/secret", "http://169.254.169.254/latest/meta-data", "file:///secret"])
			await expect(client.download(url, { maxBytes: 1000 })).rejects.toThrow();
	});

	it("edits a workspace image with multipart form data", async () => {
		const f = await fixture();
		await f.configure();
		const ref = (await f.artifacts.create({ workspaceId: "workspace", ownerId: "user", name: "ref.png", content: png }))
			.ref;
		f.fetchMock.mockResolvedValueOnce(json({ data: [{ b64_json: png.toString("base64") }] }));
		await f.invoke("generate_image", { prompt: "make it green", referenceArtifactId: ref.id });
		expect(f.fetchMock.mock.calls[0]?.[0]).toBe("https://relay.example/v1/images/edits");
		const form = f.fetchMock.mock.calls[0]?.[1]?.body as FormData;
		expect(form.get("model")).toBe("image-custom-id");
		expect(form.get("image")).toBeInstanceOf(Blob);
	});

	it("does not leak provider errors, auto retry, or produce fake artifacts", async () => {
		const f = await fixture();
		await f.configure();
		f.fetchMock.mockResolvedValueOnce(json({ error: "private-media-key" }, 401));
		await expect(f.invoke("generate_image", { prompt: "image" })).rejects.toThrow("HTTP 401");
		expect(f.fetchMock).toHaveBeenCalledTimes(1);
		f.fetchMock.mockResolvedValueOnce(json({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }));
		await expect(f.invoke("generate_image", { prompt: "image" })).rejects.toThrow("supported image");
	});

	it("respects missing config, read-only mode, approvals and cancellation before sending requests", async () => {
		const f = await fixture();
		await expect(f.invoke("generate_image", { prompt: "image" })).rejects.toThrow("not configured");
		await f.configure();
		await expect(
			f.invoke("generate_image", { prompt: "image" }, { ...snapshot(), sandboxMode: "read_only" })
		).rejects.toThrow("read-only");
		f.approvals.authorize.mockRejectedValueOnce(new Error("denied"));
		await expect(f.invoke("generate_image", { prompt: "image" })).rejects.toThrow("denied");
		await expect(f.invoke("generate_image", { prompt: "image" }, snapshot(), AbortSignal.abort())).rejects.toThrow();
		expect(f.fetchMock).not.toHaveBeenCalled();
	});
});

describe("durable video generation", () => {
	it("submits Agnes JSON once, prefers video_id, and retrieves a durable attachment without forwarding credentials", async () => {
		const f = await fixture();
		await f.configure("video", "https://apihub.agnes-ai.com/v1", "agnes-video-v2.0");
		f.fetchMock.mockResolvedValueOnce(json({ id: "legacy_task", video_id: "agnes_result", status: "queued" }));
		const submitted = await f.invoke("generate_video", { prompt: "Moving scene", size: "1280x720", seconds: 4 });
		const jobId = (submitted.details as { jobId: string }).jobId;
		expect(f.fetchMock.mock.calls[0]?.[0]).toBe("https://apihub.agnes-ai.com/v1/videos");
		expect(f.fetchMock.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			redirect: "error",
			headers: { Authorization: "Bearer private-media-key", "Content-Type": "application/json" },
		});
		expect(JSON.parse(f.fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
			model: "agnes-video-v2.0",
			prompt: "Moving scene",
			width: 1280,
			height: 720,
			num_frames: 97,
			frame_rate: 24,
		});
		f.fetchMock
			.mockResolvedValueOnce(json({ status: "in_progress" }))
			.mockResolvedValueOnce(json({ status: "completed", metadata: { url: "https://outputs.example/video.mp4" } }));
		f.download.mockResolvedValueOnce(mp4);
		const result = await f.invoke("get_generated_video", { jobId });
		const artifact = (result.details as { artifact: ArtifactRef }).artifact;
		expect(artifact.mimeType).toBe("video/mp4");
		expect((await f.artifacts.read(artifact.id)).content).toEqual(mp4);
		expect(f.fetchMock.mock.calls[1]?.[0]).toBe(
			"https://apihub.agnes-ai.com/agnesapi?video_id=agnes_result&model_name=agnes-video-v2.0"
		);
		expect(f.download).toHaveBeenCalledWith("https://outputs.example/video.mp4", {
			maxBytes: 100 * 1024 * 1024,
			signal: expect.any(AbortSignal),
		});
		expect((await f.invoke("get_generated_video", { jobId })).details).toEqual({ artifact });
		expect(f.fetchMock).toHaveBeenCalledTimes(3);
		expect(f.download).toHaveBeenCalledTimes(1);
	});

	it("migrates legacy jobs without changing their original polling protocol", async () => {
		const f = await fixture();
		await f.configure("video", "https://apihub.agnes-ai.com/v1", "agnes-video-v2.0");
		const db = new DatabaseSync(join(f.root, "jobs.db"));
		try {
			db.exec(
				"CREATE TABLE media_video_jobs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, remote_id TEXT NOT NULL, connection_hash TEXT NOT NULL, artifact TEXT)"
			);
			db.prepare("INSERT INTO media_video_jobs (id, session_id, remote_id, connection_hash) VALUES (?, ?, ?, ?)").run(
				"legacy-job",
				"session",
				"legacy-task",
				createHash("sha256")
					.update(JSON.stringify(f.models.resolve("video")))
					.digest("hex")
			);
		} finally {
			db.close();
		}
		f.fetchMock
			.mockResolvedValueOnce(json({ status: "completed" }))
			.mockResolvedValueOnce(new Response(new Uint8Array(mp4)));
		const result = await f.invoke("get_generated_video", { jobId: "legacy-job" });
		expect(result.details).toHaveProperty("artifact");
		expect(f.fetchMock.mock.calls.map(([url]) => url)).toEqual([
			"https://apihub.agnes-ai.com/v1/videos/legacy-task",
			"https://apihub.agnes-ai.com/v1/videos/legacy-task/content",
		]);
		expect(f.download).not.toHaveBeenCalled();
	});

	it("rejects invalid Agnes duration before authorization or network access", async () => {
		const f = await fixture();
		await f.configure("video", "https://apihub.agnes-ai.com/v1", "agnes-video-v2.0");
		await expect(f.invoke("generate_video", { prompt: "scene", seconds: 19 })).rejects.toThrow("1-18 seconds");
		expect(f.approvals.authorize).not.toHaveBeenCalled();
		expect(f.fetchMock).not.toHaveBeenCalled();
	});

	it.each([{}, { id: "task_only" }, { video_id: "../private" }])(
		"does not retry Agnes creation with an invalid video_id: %j",
		async (response) => {
			const f = await fixture();
			await f.configure("video", "https://apihub.agnes-ai.com/v1", "agnes-video-v2.0");
			f.fetchMock.mockResolvedValueOnce(json(response));
			await expect(f.invoke("generate_video", { prompt: "scene" })).rejects.toThrow("Do not resubmit");
			expect(f.fetchMock).toHaveBeenCalledTimes(1);
		}
	);

	it.each([
		{ status: "failed", error: "private-media-key" },
		{ status: "error", error: "private-media-key" },
		{ status: "completed", metadata: {} },
		{ status: "private-media-key" },
	])("fails closed on invalid Agnes results without resubmitting: %j", async (response) => {
		const f = await fixture();
		await f.configure("video", "https://apihub.agnes-ai.com/v1", "agnes-video-v2.0");
		f.fetchMock.mockResolvedValueOnce(json({ video_id: "video_123" })).mockResolvedValueOnce(json(response));
		const submitted = await f.invoke("generate_video", { prompt: "scene" });
		const result = f.invoke("get_generated_video", { jobId: (submitted.details as { jobId: string }).jobId });
		await expect(result).rejects.toThrow();
		await expect(result).rejects.not.toThrow("private-media-key");
		expect(f.fetchMock).toHaveBeenCalledTimes(2);
		expect(f.download).not.toHaveBeenCalled();
	});

	it("can retrieve the same Agnes job after a failed download without another submission", async () => {
		const f = await fixture();
		await f.configure("video", "https://apihub.agnes-ai.com/v1", "agnes-video-v2.0");
		f.fetchMock
			.mockResolvedValueOnce(json({ video_id: "video_123" }))
			.mockResolvedValueOnce(json({ status: "completed", metadata: { url: "https://outputs.example/video.mp4" } }))
			.mockResolvedValueOnce(json({ status: "completed", metadata: { url: "https://outputs.example/video.mp4" } }));
		f.download.mockRejectedValueOnce(new Error("Download interrupted")).mockResolvedValueOnce(mp4);
		const submitted = await f.invoke("generate_video", { prompt: "scene" });
		const params = { jobId: (submitted.details as { jobId: string }).jobId };
		await expect(f.invoke("get_generated_video", params)).rejects.toThrow("Download interrupted");
		expect((await f.invoke("get_generated_video", params)).details).toHaveProperty("artifact");
		expect(f.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
	});

	it("submits once, polls after service restart, persists media and reuses the same attachment", async () => {
		const f = await fixture();
		await f.configure("video");
		f.fetchMock.mockResolvedValueOnce(json({ id: "video_123", status: "queued" }));
		const submitted = await f.invoke("generate_video", { prompt: "Moving scene", seconds: 4 });
		const jobId = (submitted.details as { jobId: string }).jobId;
		const form = f.fetchMock.mock.calls[0]?.[1]?.body as FormData;
		expect(form.get("seconds")).toBe("4");
		expect(form.get("model")).toBe("video-custom-id");
		f.fetchMock
			.mockResolvedValueOnce(json({ status: "in_progress" }))
			.mockResolvedValueOnce(json({ status: "completed" }))
			.mockResolvedValueOnce(new Response(new Uint8Array(mp4), { headers: { "content-type": "video/mp4" } }));
		const result = await f.invoke("get_generated_video", { jobId });
		const artifact = (result.details as { artifact: ArtifactRef }).artifact;
		expect(artifact.mimeType).toBe("video/mp4");
		expect((await f.artifacts.read(artifact.id)).content).toEqual(mp4);
		const reused = await f.invoke("get_generated_video", { jobId });
		expect(reused.details).toEqual({ artifact });
		expect(f.fetchMock).toHaveBeenCalledTimes(4);
		await expect(f.invoke("get_generated_video", { jobId }, snapshot("another-session"))).rejects.toThrow(
			"does not exist"
		);
	});

	it("reports provider failure without downloading or resubmitting", async () => {
		const f = await fixture();
		await f.configure("video");
		f.fetchMock
			.mockResolvedValueOnce(json({ id: "video_failed" }))
			.mockResolvedValueOnce(json({ status: "failed", error: "private-media-key" }));
		const submit = await f.invoke("generate_video", { prompt: "scene" });
		await expect(
			f.invoke("get_generated_video", { jobId: (submit.details as { jobId: string }).jobId })
		).rejects.toThrow("Video generation failed");
		expect(f.fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects fake videos and applies a separate video byte limit", () => {
		expect(() =>
			validateArtifact({ name: "fake.mp4", suppliedMimeType: "video/mp4", content: Buffer.from("html error") })
		).toThrow("does not match");
		expect(
			validateArtifact({ name: "movie.mp4", content: mp4 }, { maxFileBytes: 1, maxVideoBytes: 100 }).mimeType
		).toBe("video/mp4");
		expect(() => validateArtifact({ name: "movie.mp4", content: mp4 }, { maxVideoBytes: 1 })).toThrow("limit");
	});

	it("bounds streamed responses even without Content-Length", async () => {
		await expect(readMediaBody(new Response(new Uint8Array(100)), 10)).rejects.toThrow("size limit");
	});
});

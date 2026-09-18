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
import { CustomModelRegistry } from "../src/custom-models.js";

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

async function fixture(imageModels?: CustomModelRegistry) {
	const root = await mkdtemp(join(tmpdir(), "wuming-media-test-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const options = { filePath: join(root, "models.enc"), encryptionKey: "test-encryption-key" };
	const models = new MediaModelRegistry({ ...options, ...(imageModels ? { imageModels } : {}) });
	const artifacts = await ArtifactStore.open(join(root, "artifacts.db"), join(root, "objects"), {
		maxVideoBytes: 100 * 1024 * 1024,
	});
	cleanup.push(() => artifacts.close());
	const fetchMock = vi.fn<typeof fetch>();
	const download = vi.fn().mockResolvedValue(png);
	const approvals = { authorize: vi.fn().mockResolvedValue(undefined), completeAuthorization: vi.fn() };
	const services: MediaGenerationService[] = [];
	const service = (
		timing: Pick<ConstructorParameters<typeof MediaGenerationService>[0], "pollMs" | "now" | "wait"> & {
			models?: MediaModelRegistry;
		} = {}
	) => {
		const value = new MediaGenerationService({
			models,
			artifacts,
			databasePath: join(root, "jobs.db"),
			fetch: fetchMock,
			download,
			pollMs: 1,
			...timing,
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
	const configure = async (
		kind: "image" | "video" = "image",
		baseUrl = "https://relay.example/v1",
		model = `${kind}-custom-id`
	) => {
		await models.set({ kind, baseUrl, model, apiKey: "private-media-key" });
		if (kind === "video")
			await models.setVideoDefault(
				models
					.list()
					.find((item) => item.kind === "video")!
					.availableModels!.find((item) => item.baseUrl === baseUrl && item.id === model)!
			);
	};
	return { root, options, models, artifacts, fetchMock, download, approvals, service, invoke, configure };
}

describe("media model settings", () => {
	it("routes added video models independently and retrieves jobs from their original service after restart", async () => {
		const source = new CustomModelRegistry();
		const common = {
			kind: "video" as const,
			id: "shared-video",
			name: "Video",
			api: "openai-completions" as const,
			input: ["text" as const],
			contextWindow: 32000,
			maxOutputTokens: 4096,
		};
		await source.set({ ...common, provider: "relay-a", baseUrl: "https://a.example/v1", apiKey: "key-a" });
		await source.set({ ...common, provider: "relay-b", baseUrl: "https://b.example/v1", apiKey: "key-b" });
		await source.set({
			...common,
			provider: "relay-b",
			baseUrl: "https://b.example/v1",
			id: "unique-video",
			apiKey: "key-b",
		});
		const f = await fixture(source);
		await f.models.set({
			kind: "video",
			provider: "relay-b",
			baseUrl: "https://b.example/v1",
			model: "shared-video",
			videoProtocol: "openai-json",
			videoReferenceFormat: "data-url",
		});
		await f.models.setVideoDefault({ provider: "relay-a", id: "shared-video" });
		f.fetchMock.mockImplementation(async () => json({ id: "remote-task" }));
		await f.invoke("generate_video", { prompt: "default" });
		await f.invoke("generate_video", { prompt: "unique", model: "unique-video" });
		const submitted = await f.invoke("generate_video", {
			prompt: "selected",
			model: "shared-video",
			provider: "relay-b",
		});
		const jobId = (submitted.details as { jobId: string }).jobId;
		expect(
			f.fetchMock.mock.calls.map(([url, init]) => [
				url,
				new Headers(init?.headers).get("Authorization"),
				init?.body instanceof FormData ? init.body.get("model") : JSON.parse(String(init?.body)).model,
			])
		).toEqual([
			["https://a.example/v1/videos", "Bearer key-a", "shared-video"],
			["https://b.example/v1/videos", "Bearer key-b", "unique-video"],
			["https://b.example/v1/videos", "Bearer key-b", "shared-video"],
		]);
		for (const params of [
			{ model: "shared-video" },
			{ model: "shared-video", provider: "missing" },
			{ provider: "relay-b" },
		])
			await expect(f.invoke("generate_video", { prompt: "blocked", ...params })).rejects.toThrow();
		expect(f.fetchMock).toHaveBeenCalledTimes(3);
		expect(f.approvals.authorize).toHaveBeenCalledTimes(3);
		await f.models.setVideoDefault({ provider: "relay-b", id: "unique-video" });
		const loaded = new MediaModelRegistry({ ...f.options, imageModels: source });
		await loaded.load();
		expect(loaded.list()[0]?.availableModels).toHaveLength(3);
		expect(loaded.resolve("video")).toMatchObject({ provider: "relay-b", model: "unique-video" });
		expect(loaded.resolve("video", "shared-video", "relay-b")).toMatchObject({
			videoProtocol: "openai-json",
			videoReferenceFormat: "data-url",
			apiKey: "key-b",
		});
		expect(loaded.resolve("video", "shared-video", "relay-a").videoProtocol).toBeUndefined();
		await loaded.setVideoDefault({ provider: "relay-a", id: "shared-video" });
		const resumed = f.service({ models: loaded });
		f.fetchMock
			.mockResolvedValueOnce(json({ status: "completed" }))
			.mockResolvedValueOnce(new Response(new Uint8Array(mp4)));
		const result = await f.invoke("get_generated_video", { jobId }, snapshot(), undefined, resumed);
		expect(result.details).toHaveProperty("artifact");
		expect(
			f.fetchMock.mock.calls.slice(3).map(([url, init]) => [url, new Headers(init?.headers).get("Authorization")])
		).toEqual([
			["https://b.example/v1/videos/remote-task", "Bearer key-b"],
			["https://b.example/v1/videos/remote-task/content", "Bearer key-b"],
		]);
		expect(f.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
		const pending = await f.invoke("generate_video", { prompt: "pending", model: "shared-video", provider: "relay-b" });
		await source.set({ ...common, provider: "relay-b", baseUrl: "https://b.example/v1", apiKey: "rotated-key" });
		expect(loaded.resolve("video", "shared-video", "relay-b").apiKey).toBe("rotated-key");
		await expect(
			f.invoke(
				"get_generated_video",
				{ jobId: (pending.details as { jobId: string }).jobId },
				snapshot(),
				undefined,
				resumed
			)
		).rejects.toThrow("settings changed");
		await source.remove({ provider: "relay-b", id: "shared-video" });
		await expect(
			f.invoke(
				"get_generated_video",
				{ jobId: (pending.details as { jobId: string }).jobId },
				snapshot(),
				undefined,
				resumed
			)
		).rejects.toThrow("settings changed");
		expect(f.fetchMock).toHaveBeenCalledTimes(6);
		expect(() => loaded.resolve("video", "shared-video", "relay-b")).toThrow("已添加");
	});
	it("retains manual video services, model preferences and individual removal across restart", async () => {
		const f = await fixture();
		await f.models.set({
			kind: "video",
			baseUrl: "https://a.example/v1",
			model: "shared",
			apiKey: "key-a",
			videoProtocol: "openai-json",
			videoReferenceFormat: "data-url",
		});
		await f.models.set({ kind: "video", baseUrl: "https://a.example/v1", model: "another" });
		await f.models.set({
			kind: "video",
			baseUrl: "https://b.example/v1",
			model: "shared",
			apiKey: "key-b",
			videoProtocol: "agnes",
		});
		const models = f.models.list()[0]!.availableModels!;
		const a = models.find((item) => item.id === "shared" && item.baseUrl === "https://a.example/v1")!;
		expect(f.models.resolve("video")).toMatchObject({ provider: a.provider, model: "shared" });
		await f.models.setVideoDefault(a);
		const loaded = new MediaModelRegistry(f.options);
		await loaded.load();
		expect(loaded.resolve("video")).toMatchObject({
			apiKey: "key-a",
			videoProtocol: "openai-json",
			videoReferenceFormat: "data-url",
		});
		expect(loaded.resolve("video", "another").videoProtocol).toBeUndefined();
		await loaded.removeVideo(a);
		expect(loaded.list()[0]?.availableModels).toHaveLength(2);
		expect(loaded.resolve("video").model).toBe("another");
		expect(loaded.resolve("video", "shared")).toMatchObject({ apiKey: "key-b", videoProtocol: "agnes" });
		expect(JSON.stringify(loaded.list())).not.toContain("key-b");
	});
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
		expect(() => reloaded.resolve("image", "not-selected")).toThrow("已添加");
		reloaded.list()[0]!.models!.push("injected");
		reloaded.resolve("image").models!.push("injected");
		expect(() => reloaded.resolve("image", "injected")).toThrow("已添加");
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
		expect(reloaded.resolve("image", "first").model).toBe("first");
		await reloaded.removeImage({ provider: reloaded.list()[0]!.provider!, id: "first" });
		expect(() => reloaded.resolve("image", "first")).toThrow("已添加");
	});
	it("routes every added image model to its own service and disambiguates duplicate IDs before billing", async () => {
		const source = new CustomModelRegistry();
		const config = {
			kind: "image" as const,
			id: "shared-image",
			name: "Shared image",
			api: "openai-completions" as const,
			input: ["text" as const],
			contextWindow: 32000,
			maxOutputTokens: 4096,
		};
		await source.set({ ...config, provider: "relay-a", baseUrl: "https://a.example/v1", apiKey: "key-a" });
		await source.set({ ...config, provider: "relay-b", baseUrl: "https://b.example/v1", apiKey: "key-b" });
		await source.set({
			...config,
			provider: "relay-b",
			baseUrl: "https://b.example/v1",
			id: "unique-image",
			apiKey: "key-b",
		});
		const f = await fixture(source);
		f.fetchMock.mockImplementation(async () => json({ data: [{ b64_json: png.toString("base64") }] }));
		await f.invoke("generate_image", { prompt: "default" });
		await f.invoke("generate_image", { prompt: "unique on another service", model: "unique-image" });
		await f.invoke("generate_image", { prompt: "duplicate on B", model: "shared-image", provider: "relay-b" });
		expect(
			f.fetchMock.mock.calls.map(([url, init]) => [
				url,
				new Headers(init?.headers).get("Authorization"),
				JSON.parse(String(init?.body)).model,
			])
		).toEqual([
			["https://a.example/v1/images/generations", "Bearer key-a", "shared-image"],
			["https://b.example/v1/images/generations", "Bearer key-b", "unique-image"],
			["https://b.example/v1/images/generations", "Bearer key-b", "shared-image"],
		]);
		for (const params of [
			{ model: "shared-image" },
			{ model: "shared-image", provider: "unadded" },
			{ provider: "relay-b" },
		])
			await expect(f.invoke("generate_image", { prompt: "blocked", ...params })).rejects.toThrow();
		expect(f.fetchMock).toHaveBeenCalledTimes(3);
		await f.models.setImageDefault({ provider: "relay-b", id: "shared-image" });
		expect(f.models.list()[0]?.availableModels).toHaveLength(3);
		const reloaded = new MediaModelRegistry({ ...f.options, imageModels: source });
		await reloaded.load();
		expect(reloaded.resolve("image")).toMatchObject({ provider: "relay-b", apiKey: "key-b" });
		await source.set({ ...config, provider: "relay-b", baseUrl: "https://b.example/v1", apiKey: "rotated-b" });
		expect(reloaded.resolve("image").apiKey).toBe("rotated-b");
		const status = JSON.stringify(await f.invoke("media_model_status", {}));
		expect(status).toContain("relay-a");
		expect(status).toContain("relay-b");
		expect(status).not.toContain("key-a");
		expect(status).not.toContain("rotated-b");
		await source.remove({ provider: "relay-b", id: "shared-image" });
		expect(reloaded.resolve("image").provider).toBe("relay-a");
		expect(() => reloaded.resolve("image", "shared-image", "relay-b")).toThrow();
	});
	it("retains manually added services when switching defaults and restores them after restart", async () => {
		const f = await fixture();
		await f.models.set({ kind: "image", baseUrl: "https://a.example/v1", model: "a", apiKey: "key-a" });
		await f.models.set({ kind: "image", baseUrl: "https://b.example/v1", model: "b", apiKey: "key-b" });
		const a = f.models.list()[0]!.availableModels!.find((item) => item.id === "a")!;
		await f.models.setImageDefault(a);
		const loaded = new MediaModelRegistry(f.options);
		await loaded.load();
		expect(loaded.resolve("image")).toMatchObject({ model: "a", apiKey: "key-a" });
		expect(loaded.resolve("image", "b")).toMatchObject({ baseUrl: "https://b.example/v1", apiKey: "key-b" });
		await loaded.removeImage(a);
		expect(loaded.resolve("image").model).toBe("b");
		expect(loaded.list()[0]?.availableModels).toHaveLength(1);
		await loaded.removeImage(loaded.list()[0]!.availableModels![0]!);
		expect(loaded.list()).toEqual([]);
		expect(() => loaded.resolve("image")).toThrow("not configured");
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
			"已添加"
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
		expect(configured).not.toContain("https://relay.example/v1");
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

	it("persists failed retrievals, resumes across service instances and never regenerates", async () => {
		const f = await fixture();
		await f.configure();
		f.fetchMock.mockResolvedValueOnce(json({ data: [{ url: "http://cdn.example/image.png?signature=opaque" }] }));
		f.download.mockRejectedValueOnce(
			Object.assign(new Error("private-media-key signature=opaque"), { code: "network_denied" })
		);
		const pending = await f.invoke("generate_image", { prompt: "image" });
		const { jobId } = pending.details as { jobId: string };
		expect(pending.details).toEqual({ jobId, status: "retrieval_pending" });
		const receipt = pending.content.find((part) => part.type === "text");
		expect(JSON.parse(receipt!.text)).toMatchObject({
			generationStatus: "result_received",
			reason: "network_denied",
			jobId,
		});
		expect(JSON.stringify(pending)).not.toMatch(/private-media-key|signature|cdn.example/);
		const db = new DatabaseSync(join(f.root, "jobs.db"));
		cleanup.push(() => db.close());
		expect(db.prepare("SELECT url, artifact FROM media_image_jobs WHERE id = ?").get(jobId)).toMatchObject({
			url: expect.stringContaining("signature=opaque"),
			artifact: null,
		});
		const resumed = f.service();
		const completed = await f.invoke("get_generated_image", { jobId }, snapshot(), undefined, resumed);
		const artifact = (completed.details as { artifact: ArtifactRef }).artifact;
		expect((await f.artifacts.read(artifact.id)).content).toEqual(png);
		expect(db.prepare("SELECT url FROM media_image_jobs WHERE id = ?").get(jobId)?.url).toBeNull();
		expect((await f.invoke("get_generated_image", { jobId })).details).toEqual(completed.details);
		expect(f.fetchMock).toHaveBeenCalledTimes(1);
		expect(f.download).toHaveBeenCalledTimes(2);
		expect(f.approvals.authorize.mock.calls.at(-1)![0].capabilities).toEqual([
			{ type: "network.connect", hosts: ["cdn.example"] },
		]);
	});

	it("reuses pending identical submissions instead of billing again", async () => {
		const f = await fixture();
		await f.configure();
		f.fetchMock.mockResolvedValueOnce(json({ data: [{ url: "https://cdn.example/image.png" }] }));
		f.download.mockRejectedValueOnce(new Error("interrupted"));
		const pending = await f.invoke("generate_image", { prompt: "same image", size: "1024x1536" });
		const completed = await f.invoke("generate_image", { prompt: "same image", size: "1024x1536" });
		expect(completed.details).toMatchObject({
			jobId: (pending.details as { jobId: string }).jobId,
			artifact: { mimeType: "image/png" },
		});
		expect(f.fetchMock).toHaveBeenCalledTimes(1);
	});

	it("recovers the latest interrupted result without provider credentials or another POST", async () => {
		const f = await fixture();
		await f.configure();
		const controller = new AbortController();
		f.fetchMock.mockResolvedValueOnce(json({ data: [{ url: "https://cdn.example/image.png" }] }));
		f.download.mockImplementationOnce(async () => {
			controller.abort();
			throw new Error("aborted");
		});
		const pending = await f.invoke("generate_image", { prompt: "image" }, snapshot(), controller.signal);
		expect(pending.details).toHaveProperty("status", "retrieval_pending");
		const unconfigured = new MediaModelRegistry({ ...f.options, filePath: join(f.root, "empty-models.enc") });
		const recovered = await f.invoke(
			"get_generated_image",
			{},
			snapshot(),
			undefined,
			f.service({ models: unconfigured })
		);
		expect(recovered.details).toHaveProperty("artifact");
		expect(f.fetchMock).toHaveBeenCalledTimes(1);
	});

	it("isolates recovery by session/workspace and respects approvals, read-only mode and cancellation", async () => {
		const f = await fixture();
		await f.configure();
		f.fetchMock.mockResolvedValueOnce(json({ data: [{ url: "https://cdn.example/image.png" }] }));
		f.download.mockRejectedValueOnce(new Error("interrupted"));
		const pending = await f.invoke("generate_image", { prompt: "image" });
		const params = { jobId: (pending.details as { jobId: string }).jobId };
		await expect(f.invoke("get_generated_image", params, snapshot("other"))).rejects.toThrow("this session");
		await expect(
			f.invoke("get_generated_image", params, {
				...snapshot(),
				session: { ...snapshot().session, workspaceId: "other" },
			})
		).rejects.toThrow("this session");
		await expect(f.invoke("get_generated_image", {}, snapshot("other"))).rejects.toThrow("this session");
		await expect(f.invoke("get_generated_image", params, { ...snapshot(), sandboxMode: "read_only" })).rejects.toThrow(
			"read-only"
		);
		await expect(f.invoke("get_generated_image", params, snapshot(), AbortSignal.abort())).rejects.toThrow();
		f.approvals.authorize.mockRejectedValueOnce(new Error("denied"));
		await expect(f.invoke("get_generated_image", params)).rejects.toThrow("denied");
		expect(f.fetchMock).toHaveBeenCalledTimes(1);
		expect(f.download).toHaveBeenCalledTimes(1);
	});

	it("keeps failed downloads and invalid files recoverable without claiming a completed attachment", async () => {
		const f = await fixture();
		await f.configure();
		f.fetchMock.mockResolvedValueOnce(json({ data: [{ url: "https://cdn.example/image.png" }] }));
		f.download.mockResolvedValueOnce(Buffer.from("not an image"));
		const pending = await f.invoke("generate_image", { prompt: "image" });
		expect(pending.details).not.toHaveProperty("artifact");
		f.download.mockRejectedValueOnce(Object.assign(new Error("expired signed URL"), { code: "network_failed" }));
		const failed = await f.invoke("get_generated_image", { jobId: (pending.details as { jobId: string }).jobId });
		expect(failed.details).toHaveProperty("status", "retrieval_pending");
		expect(failed.details).not.toHaveProperty("artifact");
		expect(f.fetchMock).toHaveBeenCalledTimes(1);
		expect(f.download).toHaveBeenCalledTimes(2);
	});

	it("enables secure proxy compatibility on the real downloader without forwarding API keys", async () => {
		const f = await fixture();
		await f.configure();
		const download = vi.spyOn(SafeWebClient.prototype, "download").mockResolvedValue(png);
		const service = new MediaGenerationService({
			models: f.models,
			artifacts: f.artifacts,
			databasePath: join(f.root, "real-download.db"),
			fetch: f.fetchMock,
		});
		cleanup.push(() => service.close());
		f.fetchMock.mockResolvedValueOnce(json({ data: [{ url: "http://cdn.example/image.png" }] }));
		await f.invoke("generate_image", { prompt: "image" }, snapshot(), undefined, service);
		expect(download).toHaveBeenCalledWith("http://cdn.example/image.png", {
			maxBytes: 10 * 1024 * 1024,
			signal: expect.any(AbortSignal),
			resolveProxyHttp: true,
		});
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
	it("uses Agnes 2.5 Flash automatically and preserves the submitted protocol across preference changes", async () => {
		const f = await fixture();
		await f.configure("video", "https://apihub.agnes-ai.com/v1", "agnes-video-2.5-flash");
		f.fetchMock.mockResolvedValueOnce(json({ id: "task_id", video_id: "video_id" }));
		const submitted = await f.invoke("generate_video", { prompt: "scene", size: "1024x1024", seconds: 8 });
		expect(JSON.parse(f.fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
			size: "720P",
			aspect_ratio: "1:1",
			mode: "text",
		});
		const jobId = (submitted.details as { jobId: string }).jobId;
		await f.models.set({
			kind: "video",
			baseUrl: "https://apihub.agnes-ai.com/v1",
			model: "agnes-video-2.5-flash",
			videoProtocol: "openai",
			videoReferenceFormat: "data-url",
		});
		f.fetchMock.mockResolvedValueOnce(
			json({ status: "completed", metadata: { url: "https://cdn.example/video.mp4" } })
		);
		f.download.mockResolvedValueOnce(mp4);
		expect((await f.invoke("get_generated_video", { jobId })).details).toHaveProperty("artifact");
		expect(String(f.fetchMock.mock.calls[1]![0])).toContain(
			"/agnesapi?video_id=video_id&model_name=agnes-video-2.5-flash"
		);
	});
	it.each(["openai", "openai-json"] as const)(
		"sends workspace image references using %s without exposing Base64 in results",
		async (videoProtocol) => {
			const f = await fixture();
			await f.configure("video");
			await f.models.set({
				kind: "video",
				baseUrl: "https://relay.example/v1",
				model: "video-custom-id",
				videoProtocol,
			});
			const artifact = await f.artifacts.create({
				workspaceId: "workspace",
				ownerId: "user",
				name: "reference.png",
				content: png,
			});
			f.fetchMock.mockResolvedValueOnce(json({ id: "video_123" }));
			const result = await f.invoke("generate_video", {
				prompt: "Animate reference",
				referenceArtifactId: artifact.ref.id,
			});
			const request = f.fetchMock.mock.calls[0]![1]!;
			if (videoProtocol === "openai") expect((request.body as FormData).get("input_reference")).toBeInstanceOf(Blob);
			else
				expect(JSON.parse(request.body as string).input_reference.image_url).toBe(
					"data:image/png;base64," + png.toString("base64")
				);
			expect(JSON.stringify(result)).not.toContain(png.toString("base64"));
			expect(JSON.stringify(result)).not.toContain("private-media-key");
		}
	);
	it("automatically encodes official Flash references and retrieves live top-level URL results", async () => {
		const f = await fixture();
		await f.configure("video", "https://apihub.agnes-ai.com/v1", "agnes-video-2.5-flash");
		const artifact = await f.artifacts.create({
			workspaceId: "workspace",
			ownerId: "user",
			name: "reference.png",
			content: png,
		});
		const params = { prompt: "Animate <Picture 1>", referenceArtifactId: artifact.ref.id };
		f.fetchMock.mockResolvedValueOnce(json({ video_id: "video_123" }));
		const submitted = await f.invoke("generate_video", params);
		expect(JSON.parse(f.fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
			mode: "reference",
			images: ["data:image/png;base64," + png.toString("base64")],
		});
		f.fetchMock.mockResolvedValueOnce(json({ status: "completed", url: "https://cdn.example/video.mp4" }));
		f.download.mockResolvedValueOnce(mp4);
		const result = await f.invoke("get_generated_video", { jobId: (submitted.details as { jobId: string }).jobId });
		expect(result.details).toHaveProperty("artifact");
		expect(f.fetchMock).toHaveBeenCalledTimes(2);
		expect(f.download).toHaveBeenCalledWith("https://cdn.example/video.mp4", {
			maxBytes: 100 * 1024 * 1024,
			signal: expect.any(AbortSignal),
		});
	});
	it("rejects inaccessible references and invalid parameters without submission", async () => {
		const f = await fixture();
		await f.configure("video");
		const artifact = await f.artifacts.create({
			workspaceId: "other-workspace",
			ownerId: "user",
			name: "private.png",
			content: png,
		});
		await expect(f.invoke("generate_video", { prompt: "scene", referenceArtifactId: artifact.ref.id })).rejects.toThrow(
			"not accessible"
		);
		await f.configure("video", "https://apihub.agnes-ai.com/v1", "agnes-video-2.5-flash");
		await expect(f.invoke("generate_video", { prompt: "scene", size: "1080P" })).rejects.toThrow(
			"Unsupported video resolution"
		);
		expect(f.fetchMock).not.toHaveBeenCalled();
	});
	it("returns useful sanitized provider errors without resubmitting or persisting a job", async () => {
		const f = await fixture();
		await f.configure("video");
		f.fetchMock.mockResolvedValueOnce(
			json({ detail: "size must be 720P; key=private-media-key; see https://example.com?token=signed-secret" }, 400)
		);
		const result = f.invoke("generate_video", { prompt: "scene" });
		await expect(result).rejects.toMatchObject({
			code: "media_submission_failed",
			details: { httpStatus: 400, retryable: false },
		});
		await expect(result).rejects.toThrow("size must be 720P");
		await expect(result).rejects.not.toThrow("private-media-key");
		await expect(result).rejects.not.toThrow("signed-secret");
		expect(f.fetchMock).toHaveBeenCalledTimes(1);
	});
	it("lists the actual video model and its capabilities without network access or secrets", async () => {
		const f = await fixture();
		await f.configure("video", "https://apihub.agnes-ai.com/v1", "agnes-video-2.5-flash");
		const result = await f.invoke("media_model_status", {});
		const status = JSON.parse((result.content[0] as { text: string }).text).defaults[1];
		expect(status).toMatchObject({
			configured: true,
			defaultModel: "agnes-video-2.5-flash",
			videoCapabilities: {
				protocol: "agnes-v2.5",
				validation: "verified",
				sizes: ["720P"],
				referenceInputs: ["artifact", "public-url"],
				artifactTransport: "data-url",
			},
		});
		expect(status.availableModels[0]).toMatchObject({
			service: "apihub.agnes-ai.com",
			model: "agnes-video-2.5-flash",
			videoCapabilities: status.videoCapabilities,
		});
		expect(JSON.stringify(result)).not.toContain("https://apihub.agnes-ai.com/v1");
		expect(JSON.stringify(result)).not.toContain("private-media-key");
		expect(f.fetchMock).not.toHaveBeenCalled();
	});
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
					.update(
						JSON.stringify({
							kind: "video",
							baseUrl: "https://apihub.agnes-ai.com/v1",
							model: "agnes-video-v2.0",
							apiKey: "private-media-key",
						})
					)
					.digest("hex")
			);
		} finally {
			db.close();
		}
		await f.configure("video", "https://other.example/v1", "other-video");
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

	it("waits gradually across retrieval calls and service restarts without resubmitting", async () => {
		const f = await fixture();
		await f.configure("video");
		let now = 1_800_000_000_000;
		const start = now;
		const waits: number[] = [];
		const timing = {
			pollMs: 30_000,
			now: () => now,
			wait: async (ms: number, signal: AbortSignal) => {
				signal.throwIfAborted();
				waits.push(ms);
				now += ms;
			},
		};
		f.fetchMock
			.mockResolvedValueOnce(json({ id: "video_slow" }))
			.mockResolvedValueOnce(json({ status: "pending" }))
			.mockResolvedValueOnce(json({ status: "completed" }))
			.mockResolvedValueOnce(new Response(new Uint8Array(mp4)));
		const submitted = await f.invoke("generate_video", { prompt: "scene" }, snapshot(), undefined, f.service(timing));
		const params = { jobId: (submitted.details as { jobId: string }).jobId };
		const first = await f.invoke("get_generated_video", params, snapshot(), undefined, f.service(timing));
		expect(first.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("pending") })])
		);
		expect(now - start).toBe(60_000);
		expect(f.fetchMock).toHaveBeenCalledTimes(2);
		const completed = await f.invoke("get_generated_video", params, snapshot(), undefined, f.service(timing));
		expect(completed.details).toHaveProperty("artifact");
		expect(waits).toEqual([30_000, 30_000, 15_000]);
		expect(f.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
	});

	it("returns pending for 429, persists Retry-After and later completes the same job", async () => {
		const f = await fixture();
		await f.configure("video");
		let now = 1_800_000_000_000;
		const start = now;
		const timing = {
			pollMs: 30_000,
			now: () => now,
			wait: async (ms: number, signal: AbortSignal) => {
				signal.throwIfAborted();
				now += ms;
			},
		};
		f.fetchMock
			.mockResolvedValueOnce(json({ id: "video_throttled" }))
			.mockResolvedValueOnce(
				new Response("too many video status queries", { status: 429, headers: { "retry-after": "120" } })
			)
			.mockResolvedValueOnce(json({ status: "completed" }))
			.mockResolvedValueOnce(new Response(new Uint8Array(mp4)));
		const submitted = await f.invoke("generate_video", { prompt: "scene" }, snapshot(), undefined, f.service(timing));
		const params = { jobId: (submitted.details as { jobId: string }).jobId };
		for (const elapsed of [60_000, 120_000]) {
			const pending = await f.invoke("get_generated_video", params, snapshot(), undefined, f.service(timing));
			expect(pending.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ text: expect.stringContaining("rate_limited_or_unavailable") }),
				])
			);
			expect(f.fetchMock).toHaveBeenCalledTimes(2);
			expect(now - start).toBe(elapsed);
		}
		expect(
			(await f.invoke("get_generated_video", params, snapshot(), undefined, f.service(timing))).details
		).toHaveProperty("artifact");
		expect(now - start).toBe(150_000);
		expect(f.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
	});

	it.each(["network", "503"])("defers transient %s errors without failing or resubmitting", async (failure) => {
		const f = await fixture();
		await f.configure("video");
		let now = 1_800_000_000_000;
		const timing = {
			pollMs: 30_000,
			now: () => now,
			wait: async (ms: number) => {
				now += ms;
			},
		};
		f.fetchMock.mockResolvedValueOnce(json({ id: "video_transient" }));
		if (failure === "network") f.fetchMock.mockRejectedValueOnce(new Error("connection reset"));
		else f.fetchMock.mockResolvedValueOnce(json({ error: "busy" }, 503));
		const submitted = await f.invoke("generate_video", { prompt: "scene" }, snapshot(), undefined, f.service(timing));
		const result = await f.invoke(
			"get_generated_video",
			{ jobId: (submitted.details as { jobId: string }).jobId },
			snapshot(),
			undefined,
			f.service(timing)
		);
		expect(result.details).toHaveProperty("jobId");
		expect(f.fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not duplicate in-flight retrieval across instances and can cancel the waiting caller", async () => {
		const f = await fixture();
		await f.configure("video");
		let resolveResponse!: (response: Response) => void;
		let started!: () => void;
		const queryStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		f.fetchMock
			.mockResolvedValueOnce(json({ id: "video_concurrent" }))
			.mockImplementationOnce(() => {
				started();
				return new Promise<Response>((resolve) => {
					resolveResponse = resolve;
				});
			})
			.mockResolvedValueOnce(new Response(new Uint8Array(mp4)));
		const submitted = await f.invoke("generate_video", { prompt: "scene" });
		const params = { jobId: (submitted.details as { jobId: string }).jobId };
		const first = f.invoke("get_generated_video", params);
		await queryStarted;
		const controller = new AbortController();
		const second = f.invoke("get_generated_video", params, snapshot(), controller.signal);
		const aborted = expect(second).rejects.toThrow();
		controller.abort();
		await aborted;
		expect(f.fetchMock).toHaveBeenCalledTimes(2);
		resolveResponse(json({ status: "completed" }));
		expect((await first).details).toHaveProperty("artifact");
		expect((await f.invoke("get_generated_video", params)).details).toHaveProperty("artifact");
		expect(f.fetchMock).toHaveBeenCalledTimes(3);
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

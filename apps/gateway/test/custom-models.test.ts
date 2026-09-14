import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomModelRegistry, loadOrCreateModelEncryptionKey } from "../src/custom-models.js";

const config = {
	provider: "local-openai",
	id: "qwen-test",
	name: "Qwen test",
	api: "openai-completions" as const,
	baseUrl: "http://127.0.0.1:9000/v1",
	apiKey: "secret-key",
	reasoning: false,
	input: ["text"] as Array<"text" | "image">,
	contextWindow: 32_000,
	maxOutputTokens: 4096,
};

// The same model with no credential supplied. `exactOptionalPropertyTypes` rejects
// `apiKey: undefined` on an optional field, and the registry reads the value
// rather than testing for the key, so leaving it out is the same input.
const { apiKey: _apiKey, ...anonymous } = config;

function encryptedCatalog(value: unknown, secret: string): string {
	const key = createHash("sha256").update(secret, "utf8").digest();
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
	return JSON.stringify({
		iv: iv.toString("base64url"),
		tag: cipher.getAuthTag().toString("base64url"),
		data: data.toString("base64url"),
	});
}

function decryptedCatalog(encoded: string, secret: string): unknown {
	const stored = JSON.parse(encoded) as { iv: string; tag: string; data: string };
	const key = createHash("sha256").update(secret, "utf8").digest();
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64url"));
	decipher.setAuthTag(Buffer.from(stored.tag, "base64url"));
	return JSON.parse(
		Buffer.concat([decipher.update(Buffer.from(stored.data, "base64url")), decipher.final()]).toString("utf8")
	);
}

describe("CustomModelRegistry", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("allows a slow model test to succeed after the old ten-second deadline", async () => {
		vi.useFakeTimers();
		const registry = new CustomModelRegistry();
		await registry.set(config);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input, init) =>
				new Promise<Response>((resolve, reject) => {
					const timer = setTimeout(() => resolve(new Response("{}")), 25_000);
					init?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(init.signal?.reason);
						},
						{ once: true }
					);
				})
		);
		const result = registry.test(config);
		const assertion = expect(result).resolves.toBe(25_000);
		await vi.advanceTimersByTimeAsync(25_000);
		await assertion;
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts model tests at sixty seconds with an actionable timeout error", async () => {
		vi.useFakeTimers();
		const registry = new CustomModelRegistry();
		await registry.set(config);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				})
		);
		const result = registry.test(config);
		const assertion = expect(result).rejects.toThrow(
			"Model test timed out after 60 seconds. The endpoint did not respond in time; please try again later."
		);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await assertion;
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves network failures and clears the model test deadline", async () => {
		vi.useFakeTimers();
		const registry = new CustomModelRegistry();
		await registry.set(config);
		const error = new TypeError("fetch failed");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
		await expect(registry.test(config)).rejects.toBe(error);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([401, 429, 503])("preserves HTTP %s failures instead of reporting a timeout", async (status) => {
		vi.useFakeTimers();
		const registry = new CustomModelRegistry();
		await registry.set(config);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status }));
		await expect(registry.test(config)).rejects.toThrow(`Model endpoint returned HTTP ${status}`);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses endpoint capabilities for aliases and persists them without exposing internal declarations", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-thinking-catalog-"));
		try {
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [{ id: "relay-alias", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }],
					})
				)
			);
			const filePath = join(root, "models.enc");
			const registry = new CustomModelRegistry({ filePath, encryptionKey: "master-key" });
			const discovery = await registry.discover({ baseUrl: config.baseUrl, apiKey: config.apiKey });
			expect(discovery).not.toHaveProperty("thinkingDeclarations");
			const selected = await registry.set({ ...anonymous, provider: discovery.provider, id: "relay-alias" });
			expect(selected).toMatchObject({
				reasoning: true,
				thinkingLevels: ["low", "high"],
				thinking: { source: "endpoint" },
			});
			expect(registry.registrations()[0]?.config.models?.[0]).toMatchObject({
				reasoning: true,
				thinkingLevelMap: { off: null, low: "low", medium: null, high: "high" },
			});
			const loaded = new CustomModelRegistry({ filePath, encryptionKey: "master-key" });
			await loaded.load();
			expect(loaded.list()).toEqual(registry.list());
			await loaded.set({ ...anonymous, provider: discovery.provider, id: "relay-alias", name: "Renamed" });
			expect(loaded.list()[0]?.thinkingLevels).toEqual(["low", "high"]);
			fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "relay-alias" }] })));
			await loaded.refreshService(discovery.provider);
			expect(loaded.list()[0]).toMatchObject({ reasoning: false, thinking: { mode: "unknown" } });
			expect(loaded.registrations()[0]?.config.models?.[0]?.reasoning).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not treat an editable display name or legacy checkbox as capability evidence", async () => {
		const registry = new CustomModelRegistry();
		const model = await registry.set({ ...config, name: "gpt-5.5", reasoning: true });
		expect(model).toMatchObject({ reasoning: false, thinking: { mode: "unknown" } });
	});

	it("keeps keys out of metadata and provider catalog summaries", async () => {
		const registry = new CustomModelRegistry();
		await registry.set(config);
		expect(registry.list()).toEqual([
			{
				model: { provider: config.provider, id: config.id },
				name: config.name,
				reasoning: false,
				thinking: { mode: "unknown", source: "unknown" },
				input: ["text", "image"],
				contextWindow: 32_000,
				maxOutputTokens: 4096,
				authenticated: true,
				custom: true,
			},
		]);
		expect(JSON.stringify(registry.list())).not.toContain(config.apiKey);
		expect(registry.get(config)).toEqual({
			model: { provider: config.provider, id: config.id },
			name: config.name,
			api: config.api,
			baseUrl: config.baseUrl,
			reasoning: config.reasoning,
			input: ["text", "image"],
			contextWindow: config.contextWindow,
			maxOutputTokens: config.maxOutputTokens,
		});
		expect(JSON.stringify(registry.get(config))).not.toContain(config.apiKey);
		expect(registry.registrations()[0]?.config).toMatchObject({
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
		});
	});

	it("creates and reuses a local encryption key when no environment key is configured", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-model-key-"));
		try {
			const filePath = join(root, "custom-models.key");
			const first = await loadOrCreateModelEncryptionKey(filePath);
			const second = await loadOrCreateModelEncryptionKey(filePath);
			expect(first).toHaveLength(43);
			expect(second).toBe(first);
			expect((await readFile(filePath, "utf8")).trim()).toBe(first);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses an explicit encryption key without writing a local key file", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-model-key-explicit-"));
		try {
			const filePath = join(root, "custom-models.key");
			expect(await loadOrCreateModelEncryptionKey(filePath, "configured-master-key")).toBe("configured-master-key");
			await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("persists encrypted configuration when a key is supplied", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-custom-model-"));
		try {
			const filePath = join(root, "models.enc");
			const first = new CustomModelRegistry({ filePath, encryptionKey: "master-key" });
			await first.set(config);
			const raw = await readFile(filePath, "utf8");
			expect(raw).not.toContain(config.apiKey);
			const second = new CustomModelRegistry({ filePath, encryptionKey: "master-key" });
			await second.load();
			expect(second.list()[0]?.model).toEqual({ provider: config.provider, id: config.id });
			expect(second.registrations()[0]?.config).toMatchObject({ apiKey: config.apiKey });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("persists a reusable service before any model is selected", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-model-service-"));
		try {
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
				async () =>
					new Response(JSON.stringify({ data: [{ id: "model-a", name: "Model A" }] }), {
						status: 200,
					})
			);
			const filePath = join(root, "models.enc");
			const first = new CustomModelRegistry({ filePath, encryptionKey: "master-key" });
			const discovery = await first.discover({
				baseUrl: "https://gateway.example/v1",
				apiKey: "service-key",
			});
			expect(first.services()).toEqual([
				{
					provider: discovery.provider,
					baseUrl: discovery.baseUrl,
					api: discovery.api,
					authenticated: true,
					modelCount: 0,
				},
			]);
			const raw = await readFile(filePath, "utf8");
			expect(raw).not.toContain("service-key");
			expect(raw).not.toContain("gateway.example");

			const second = new CustomModelRegistry({ filePath, encryptionKey: "master-key" });
			await second.load();
			await second.refreshService(discovery.provider);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			await second.set({
				...anonymous,
				provider: discovery.provider,
				id: "model-a",
				name: "Model A",
				api: discovery.api,
				baseUrl: discovery.baseUrl,
			});
			expect(second.registrations()[0]?.config.apiKey).toBe("service-key");
			expect(second.services()[0]?.modelCount).toBe(1);
			await second.discover({ baseUrl: discovery.baseUrl, apiKey: "rotated-key" });
			expect(second.registrations()[0]?.config.apiKey).toBe("rotated-key");
			await expect(second.removeService(discovery.provider)).rejects.toMatchObject({
				protocolCode: "conflict",
			});
			await second.remove({ provider: discovery.provider, id: "model-a" });
			expect(second.services()[0]?.modelCount).toBe(0);
			await second.removeService(discovery.provider);
			expect(second.services()).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("migrates legacy model arrays into reusable services", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-model-migration-"));
		try {
			const filePath = join(root, "models.enc");
			await writeFile(filePath, encryptedCatalog([config], "master-key"), "utf8");
			const registry = new CustomModelRegistry({ filePath, encryptionKey: "master-key" });
			await registry.load();
			expect(registry.services()).toEqual([
				{
					provider: config.provider,
					baseUrl: config.baseUrl,
					api: config.api,
					authenticated: true,
					modelCount: 1,
				},
			]);
			expect(decryptedCatalog(await readFile(filePath, "utf8"), "master-key")).toMatchObject({
				version: 2,
				services: [{ provider: config.provider, apiKey: config.apiKey }],
				models: [{ provider: config.provider, id: config.id }],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reuses an encrypted key for metadata-only updates", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-custom-model-update-"));
		try {
			const filePath = join(root, "models.enc");
			const first = new CustomModelRegistry({ filePath, encryptionKey: "master-key" });
			await first.set(config);
			const updated = await first.set({
				...anonymous,
				name: "Renamed model",
				contextWindow: 64_000,
			});
			expect(updated).toMatchObject({ name: "Renamed model", contextWindow: 64_000 });

			const second = new CustomModelRegistry({ filePath, encryptionKey: "master-key" });
			await second.load();
			expect(second.registrations()[0]?.config.apiKey).toBe(config.apiKey);
			expect(second.get(config)).toMatchObject({ name: "Renamed model", contextWindow: 64_000 });
			expect(JSON.stringify(second.get(config))).not.toContain(config.apiKey);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires credentials for new models and endpoint changes", async () => {
		const registry = new CustomModelRegistry();
		await expect(registry.set({ ...anonymous })).rejects.toThrow("required when adding");
		await registry.set(config);
		await expect(registry.set({ ...anonymous, baseUrl: "https://other.example/v1" })).rejects.toThrow(
			"required when changing"
		);
	});

	it("rejects credential-bearing or unsupported endpoints", async () => {
		const registry = new CustomModelRegistry();
		await expect(registry.set({ ...config, baseUrl: "ftp://example.test" })).rejects.toThrow("http or https");
		await expect(registry.set({ ...config, baseUrl: "https://user:pass@example.test/v1" })).rejects.toThrow(
			"credentials"
		);
	});

	it("does not merge models from the same provider when connection settings differ", async () => {
		const registry = new CustomModelRegistry();
		await registry.set(config);
		await expect(registry.set({ ...config, id: "other-model", apiKey: "different-key" })).rejects.toThrow(
			"share base URL"
		);
	});

	it("discovers OpenAI-compatible gateway models with bearer authentication", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [{ id: "model-b", name: "Model B" }, { id: "model-a" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			)
		);
		const registry = new CustomModelRegistry();
		const result = await registry.discover({
			baseUrl: "https://gateway.example/v1",
			apiKey: "gateway-key",
		});
		expect(result.api).toBe("openai-completions");
		expect(result.baseUrl).toBe("https://gateway.example/v1");
		expect(result.provider).toMatch(/^custom-gateway-example-/);
		expect(result.models).toEqual([
			{ id: "model-b", name: "Model B" },
			{ id: "model-a", name: "model-a" },
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://gateway.example/v1/models",
			expect.objectContaining({
				headers: { authorization: "Bearer gateway-key" },
			})
		);
	});

	it("selects the Pi Responses adapter for the official OpenAI endpoint", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), { status: 200 })
		);
		const registry = new CustomModelRegistry();
		const result = await registry.discover({
			baseUrl: "https://api.openai.com/v1",
			apiKey: "official-key",
		});
		expect(result.api).toBe("openai-responses");
	});

	it("normalizes a root gateway URL when model discovery succeeds under v1", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("not found", { status: 404 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "root-model" }] }), { status: 200 }));
		const registry = new CustomModelRegistry();
		const result = await registry.discover({
			baseUrl: "https://root-gateway.example",
			apiKey: "gateway-key",
		});
		expect(result.baseUrl).toBe("https://root-gateway.example/v1");
	});

	it("uses the versioned Anthropic model and message endpoints", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ id: "claude-test", display_name: "Claude Test" }] }), { status: 200 })
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: [] }), { status: 200 }));
		const registry = new CustomModelRegistry();
		const discovery = await registry.discover({
			baseUrl: "https://api.anthropic.com",
			apiKey: "anthropic-key",
		});
		expect(discovery.api).toBe("anthropic-messages");
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/models");
		await registry.set({
			...config,
			provider: discovery.provider,
			id: "claude-test",
			name: "Claude Test",
			api: discovery.api,
			baseUrl: discovery.baseUrl,
			apiKey: "anthropic-key",
		});
		await registry.test({ provider: discovery.provider, id: "claude-test" });
		expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.anthropic.com/v1/messages");
	});
});

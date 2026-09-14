import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	CustomModelApi,
	CustomModelCandidate,
	CustomModelConfig,
	CustomModelConnection,
	CustomModelService,
	CustomModelSettings,
	ModelMetadata,
	ModelRef,
} from "@wuming/protocol";
import type { PiProviderRegistration } from "@wuming/pi-adapter";
import {
	parseModelThinkingDeclaration,
	parseModelInputDeclaration,
	resolveCustomModelCapabilities,
	type CustomModelCapabilities,
	type ModelThinkingDeclaration,
	type ModelInputDeclaration,
} from "./model-capabilities.js";

type StoredConfig = Omit<CustomModelConfig, "apiKey"> & { apiKey: string };
type StoredModel = Omit<StoredConfig, "api" | "baseUrl" | "apiKey">;
type StoredService = Omit<CustomModelService, "authenticated" | "modelCount"> & {
	apiKey: string;
	thinkingDeclarations?: Record<string, ModelThinkingDeclaration>;
	inputDeclarations?: Record<string, ModelInputDeclaration>;
};

interface StoredCatalog {
	version: 2;
	services: StoredService[];
	models: StoredModel[];
}

export interface CustomModelDiscovery {
	provider: string;
	baseUrl: string;
	api: CustomModelApi;
	models: CustomModelCandidate[];
	latencyMs: number;
}

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERED_MODELS = 1000;
const MODEL_TEST_TIMEOUT_MS = 60_000;

function keyFor(model: ModelRef): string {
	return `${model.provider}\0${model.id}`;
}

function validateBaseUrl(baseUrl: string): URL {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Model base URL is invalid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Model base URL must use http or https");
	if (url.username || url.password) throw new Error("Model base URL must not contain credentials");
	return url;
}

function validateConfig(config: CustomModelConfig): void {
	validateBaseUrl(config.baseUrl);
	if (config.provider.startsWith("mcp__")) throw new Error("Model provider name is reserved");
}

function validateStoredConfig(config: StoredConfig): void {
	validateConfig(config);
	if (!config.apiKey.trim()) throw new Error("Stored model API key is invalid");
}

function validateStoredService(service: StoredService): void {
	validateBaseUrl(service.baseUrl);
	if (!service.provider || service.provider.startsWith("mcp__")) throw new Error("Stored model provider is invalid");
	if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(service.api))
		throw new Error("Stored model API type is invalid");
	if (!service.apiKey.trim()) throw new Error("Stored model API key is invalid");
}

function storedModel(config: StoredConfig): StoredModel {
	const { api: _api, baseUrl: _baseUrl, apiKey: _apiKey, ...model } = config;
	return model;
}

function resourceUrl(baseUrl: string, resource: string, preferV1: boolean): string {
	const url = validateBaseUrl(baseUrl);
	const basePath = url.pathname.replace(/\/+$/, "");
	const prefix = preferV1 && (basePath === "" || basePath === "/") ? "/v1" : basePath;
	url.pathname = `${prefix}/${resource}`.replace(/\/{2,}/g, "/");
	url.search = "";
	url.hash = "";
	return url.toString();
}

function providerId(baseUrl: string): string {
	const url = validateBaseUrl(baseUrl);
	const host =
		url.hostname
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 80) || "endpoint";
	const suffix = createHash("sha256").update(url.toString()).digest("hex").slice(0, 10);
	return `custom-${host}-${suffix}`;
}

function baseUrlFromModelsEndpoint(endpoint: string): string {
	const url = new URL(endpoint);
	url.pathname = url.pathname.replace(/\/models\/?$/, "") || "/";
	return url.toString().replace(/\/$/, "");
}

async function readBoundedJson(response: Response): Promise<unknown> {
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (declaredLength > MAX_CATALOG_BYTES) throw new Error("Model catalog response is too large");
	if (!response.body) return undefined;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_CATALOG_BYTES) {
			await reader.cancel();
			throw new Error("Model catalog response is too large");
		}
		chunks.push(value);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseModels(payload: unknown): {
	models: CustomModelCandidate[];
	thinkingDeclarations: Record<string, ModelThinkingDeclaration>;
	inputDeclarations: Record<string, ModelInputDeclaration>;
} {
	if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
		throw new Error("Model endpoint returned an unsupported catalog format");
	}
	const seen = new Set<string>();
	const models: CustomModelCandidate[] = [];
	const thinkingDeclarations: Record<string, ModelThinkingDeclaration> = Object.create(null);
	const inputDeclarations: Record<string, ModelInputDeclaration> = Object.create(null);
	for (const value of payload.data) {
		if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") continue;
		const id = value.id.trim();
		if (!id || id.length > 200 || seen.has(id)) continue;
		const candidateName =
			"display_name" in value && typeof value.display_name === "string"
				? value.display_name
				: "name" in value && typeof value.name === "string"
					? value.name
					: id;
		seen.add(id);
		models.push({ id, name: candidateName.trim().slice(0, 500) || id });
		const declaration = parseModelThinkingDeclaration(value);
		if (declaration) thinkingDeclarations[id] = declaration;
		const input = parseModelInputDeclaration(value);
		if (input) inputDeclarations[id] = input;
		if (models.length >= MAX_DISCOVERED_MODELS) break;
	}
	if (models.length === 0) throw new Error("Model endpoint returned no selectable models");
	return {
		models: models.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
		thinkingDeclarations,
		inputDeclarations,
	};
}

function metadata(config: StoredConfig, capabilities: CustomModelCapabilities): ModelMetadata {
	return {
		model: { provider: config.provider, id: config.id },
		name: config.name,
		reasoning: capabilities.reasoning,
		thinking: capabilities.thinking,
		...(capabilities.reasoning ? { thinkingLevels: [...capabilities.thinkingLevels] } : {}),
		input: capabilities.input,
		contextWindow: config.contextWindow,
		maxOutputTokens: config.maxOutputTokens,
		authenticated: true,
		custom: true,
	};
}

function providerRegistration(config: StoredConfig, capabilities: CustomModelCapabilities): PiProviderRegistration {
	return {
		provider: config.provider,
		config: {
			baseUrl: config.baseUrl,
			apiKey: config.apiKey,
			api: config.api,
			authHeader: config.api === "openai-completions" || config.api === "openai-responses",
			models: [
				{
					id: config.id,
					name: config.name,
					reasoning: capabilities.reasoning,
					...(capabilities.compat ? { compat: capabilities.compat } : {}),
					...(capabilities.thinkingLevelMap ? { thinkingLevelMap: capabilities.thinkingLevelMap } : {}),
					input: capabilities.input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: config.contextWindow,
					maxTokens: config.maxOutputTokens,
				},
			],
		},
	};
}

function deriveKey(secret: string): Buffer {
	return createHash("sha256").update(secret, "utf8").digest();
}

export async function loadOrCreateModelEncryptionKey(filePath: string, configuredKey?: string): Promise<string> {
	if (configuredKey !== undefined) {
		if (!configuredKey.trim()) throw new Error("WUMING_MODEL_CONFIG_KEY must not be empty");
		return configuredKey;
	}
	await mkdir(dirname(filePath), { recursive: true });
	const generated = randomBytes(32).toString("base64url");
	try {
		const handle = await open(filePath, "wx", 0o600);
		try {
			await handle.writeFile(`${generated}\n`, "utf8");
		} finally {
			await handle.close();
		}
		return generated;
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || (error as { code?: string }).code !== "EEXIST")
			throw error;
		const stored = (await readFile(filePath, "utf8")).trim();
		if (stored.length < 32) throw new Error("Custom model encryption key file is invalid");
		return stored;
	}
}

export class CustomModelRegistry {
	readonly #filePath: string | undefined;
	readonly #key: Buffer | undefined;
	readonly #configs = new Map<string, StoredConfig>();
	readonly #services = new Map<string, StoredService>();

	constructor(options: { filePath?: string; encryptionKey?: string } = {}) {
		this.#filePath = options.filePath;
		this.#key = options.encryptionKey ? deriveKey(options.encryptionKey) : undefined;
	}

	async load(options: { migrateLegacy?: boolean } = {}): Promise<void> {
		if (!this.#filePath || !this.#key) return;
		let encoded: string;
		try {
			encoded = await readFile(this.#filePath, "utf8");
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")
				return;
			throw error;
		}
		const stored = JSON.parse(encoded) as { iv: string; tag: string; data: string };
		const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(stored.iv, "base64url"));
		decipher.setAuthTag(Buffer.from(stored.tag, "base64url"));
		const catalog = JSON.parse(
			Buffer.concat([decipher.update(Buffer.from(stored.data, "base64url")), decipher.final()]).toString("utf8")
		) as unknown;
		this.#configs.clear();
		this.#services.clear();
		if (Array.isArray(catalog)) {
			for (const value of catalog) {
				if (!value || typeof value !== "object") continue;
				const config = value as StoredConfig;
				validateStoredConfig(config);
				const service: StoredService = {
					provider: config.provider,
					baseUrl: config.baseUrl,
					api: config.api,
					apiKey: config.apiKey,
				};
				const existing = this.#services.get(service.provider);
				if (
					existing &&
					(existing.baseUrl !== service.baseUrl || existing.api !== service.api || existing.apiKey !== service.apiKey)
				) {
					throw new Error("Custom model configuration has conflicting provider credentials");
				}
				this.#services.set(service.provider, service);
				this.#configs.set(keyFor(config), config);
			}
			if (options.migrateLegacy !== false) await this.#persist();
			return;
		}
		if (
			!catalog ||
			typeof catalog !== "object" ||
			!("version" in catalog) ||
			catalog.version !== 2 ||
			!("services" in catalog) ||
			!Array.isArray(catalog.services) ||
			!("models" in catalog) ||
			!Array.isArray(catalog.models)
		) {
			throw new Error("Custom model configuration is corrupt");
		}
		for (const value of catalog.services) {
			if (!value || typeof value !== "object") throw new Error("Custom model service configuration is corrupt");
			const service = value as StoredService;
			validateStoredService(service);
			this.#services.set(service.provider, service);
		}
		for (const value of catalog.models) {
			if (!value || typeof value !== "object") throw new Error("Custom model configuration is corrupt");
			const model = value as StoredModel;
			const service = this.#services.get(model.provider);
			if (!service) throw new Error(`Custom model service ${model.provider} does not exist`);
			const config: StoredConfig = {
				...model,
				api: service.api,
				baseUrl: service.baseUrl,
				apiKey: service.apiKey,
			};
			validateStoredConfig(config);
			this.#configs.set(keyFor(config), config);
		}
	}

	list(): ModelMetadata[] {
		return [...this.#configs.values()].map((config) => metadata(config, this.#capabilities(config)));
	}

	#capabilities(config: StoredConfig): CustomModelCapabilities {
		const declarations = this.#services.get(config.provider)?.thinkingDeclarations;
		const declaration = declarations && Object.hasOwn(declarations, config.id) ? declarations[config.id] : undefined;
		const inputs = this.#services.get(config.provider)?.inputDeclarations;
		const input = inputs && Object.hasOwn(inputs, config.id) ? inputs[config.id] : undefined;
		return resolveCustomModelCapabilities(config.id, config.api, declaration, input);
	}

	services(): CustomModelService[] {
		return [...this.#services.values()].map((service) => ({
			provider: service.provider,
			baseUrl: service.baseUrl,
			api: service.api,
			authenticated: true,
			modelCount: [...this.#configs.values()].filter((config) => config.provider === service.provider).length,
		}));
	}

	get(model: ModelRef): CustomModelSettings {
		const config = this.#configs.get(keyFor(model));
		if (!config) throw new Error(`Custom model ${model.provider}/${model.id} does not exist`);
		const capabilities = this.#capabilities(config);
		return {
			model: { provider: config.provider, id: config.id },
			name: config.name,
			api: config.api,
			baseUrl: config.baseUrl,
			reasoning: capabilities.reasoning,
			input: [...capabilities.input],
			contextWindow: config.contextWindow,
			maxOutputTokens: config.maxOutputTokens,
		};
	}

	registrations(): PiProviderRegistration[] {
		const providers = new Map<string, StoredConfig[]>();
		for (const config of this.#configs.values())
			providers.set(config.provider, [...(providers.get(config.provider) ?? []), config]);
		return [...providers].map(([provider, configs]) => {
			const first = configs[0]!;
			return {
				provider,
				config: {
					baseUrl: first.baseUrl,
					apiKey: first.apiKey,
					api: first.api,
					authHeader: first.api === "openai-completions" || first.api === "openai-responses",
					models: configs.map((config) => providerRegistration(config, this.#capabilities(config)).config.models![0]!),
				},
			};
		});
	}

	async set(config: CustomModelConfig): Promise<ModelMetadata> {
		const existing = this.#configs.get(keyFor(config));
		const suppliedApiKey = config.apiKey?.trim();
		const savedService = this.#services.get(config.provider);
		if (!suppliedApiKey && !savedService)
			throw new Error("API Key is required when adding a model to an unsaved service");
		if (
			!suppliedApiKey &&
			savedService &&
			(savedService.baseUrl !== config.baseUrl || savedService.api !== config.api)
		) {
			throw new Error("A new API Key is required when changing the Base URL or API protocol");
		}
		const service: StoredService = suppliedApiKey
			? {
					provider: config.provider,
					baseUrl: config.baseUrl,
					api: config.api,
					apiKey: suppliedApiKey,
					...(savedService?.baseUrl === config.baseUrl &&
					savedService.api === config.api &&
					savedService.apiKey === suppliedApiKey
						? {
								thinkingDeclarations: savedService.thinkingDeclarations ?? {},
								inputDeclarations: savedService.inputDeclarations ?? {},
							}
						: {}),
				}
			: savedService!;
		validateStoredService(service);
		const resolved: StoredConfig = {
			...config,
			baseUrl: service.baseUrl,
			api: service.api,
			apiKey: service.apiKey,
		};
		validateStoredConfig(resolved);
		if (
			savedService &&
			suppliedApiKey &&
			(savedService.baseUrl !== service.baseUrl ||
				savedService.api !== service.api ||
				savedService.apiKey !== service.apiKey)
		) {
			if (!existing) throw new Error("Models under one provider must share base URL, API type, and API key");
			for (const [key, candidate] of this.#configs) {
				if (candidate.provider === service.provider)
					this.#configs.set(key, {
						...candidate,
						baseUrl: service.baseUrl,
						api: service.api,
						apiKey: service.apiKey,
					});
			}
		}
		this.#services.set(service.provider, service);
		this.#configs.set(keyFor(resolved), resolved);
		await this.#persist();
		return metadata(resolved, this.#capabilities(resolved));
	}

	async discover(connection: CustomModelConnection): Promise<CustomModelDiscovery> {
		const { thinkingDeclarations, inputDeclarations, ...discovery } = await this.#discover(connection);
		const service: StoredService = {
			provider: discovery.provider,
			baseUrl: discovery.baseUrl,
			api: discovery.api,
			apiKey: connection.apiKey.trim(),
			thinkingDeclarations,
			inputDeclarations,
		};
		validateStoredService(service);
		this.#services.set(service.provider, service);
		for (const [key, config] of this.#configs) {
			if (config.provider === service.provider)
				this.#configs.set(key, {
					...config,
					baseUrl: service.baseUrl,
					api: service.api,
					apiKey: service.apiKey,
				});
		}
		await this.#persist();
		return discovery;
	}

	async refreshService(provider: string): Promise<CustomModelDiscovery> {
		const service = this.#services.get(provider);
		if (!service) throw new Error(`Custom model service ${provider} does not exist`);
		const { thinkingDeclarations, inputDeclarations, ...discovery } = await this.#discover({
			baseUrl: service.baseUrl,
			apiKey: service.apiKey,
		});
		const updated = {
			...service,
			baseUrl: discovery.baseUrl,
			api: discovery.api,
			thinkingDeclarations,
			inputDeclarations,
		};
		this.#services.set(provider, updated);
		for (const [key, config] of this.#configs) {
			if (config.provider === provider)
				this.#configs.set(key, { ...config, baseUrl: updated.baseUrl, api: updated.api });
		}
		await this.#persist();
		return { ...discovery, provider };
	}

	async removeService(provider: string): Promise<void> {
		if (!this.#services.has(provider)) return;
		if ([...this.#configs.values()].some((config) => config.provider === provider)) {
			throw Object.assign(new Error("Remove the models under this service before deleting the service"), {
				protocolCode: "conflict",
			});
		}
		this.#services.delete(provider);
		await this.#persist();
	}

	async #discover(connection: CustomModelConnection): Promise<
		CustomModelDiscovery & {
			thinkingDeclarations: Record<string, ModelThinkingDeclaration>;
			inputDeclarations: Record<string, ModelInputDeclaration>;
		}
	> {
		const url = validateBaseUrl(connection.baseUrl);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10_000);
		const started = Date.now();
		const prefersAnthropic = url.hostname.toLowerCase().includes("anthropic");
		const apiOrder: Array<"openai" | "anthropic"> = prefersAnthropic
			? ["anthropic", "openai"]
			: ["openai", "anthropic"];
		const errors: string[] = [];
		try {
			for (const family of apiOrder) {
				const headers: Record<string, string> =
					family === "openai"
						? { authorization: `Bearer ${connection.apiKey}` }
						: { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01" };
				const endpoints = [
					...new Set([
						resourceUrl(connection.baseUrl, "models", family === "anthropic"),
						resourceUrl(connection.baseUrl, "models", true),
					]),
				];
				for (const endpoint of endpoints) {
					try {
						const response = await fetch(endpoint, {
							method: "GET",
							headers,
							signal: controller.signal,
						});
						if (!response.ok) {
							errors.push(`${family}: HTTP ${response.status}`);
							continue;
						}
						const { models, thinkingDeclarations, inputDeclarations } = parseModels(await readBoundedJson(response));
						const api: CustomModelApi =
							family === "anthropic"
								? "anthropic-messages"
								: url.hostname.toLowerCase() === "api.openai.com"
									? "openai-responses"
									: "openai-completions";
						const discoveredBaseUrl = baseUrlFromModelsEndpoint(endpoint);
						return {
							provider: providerId(discoveredBaseUrl),
							baseUrl: discoveredBaseUrl,
							api,
							models,
							thinkingDeclarations,
							inputDeclarations,
							latencyMs: Math.max(0, Date.now() - started),
						};
					} catch (error) {
						if (controller.signal.aborted) throw error;
						errors.push(`${family}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
			throw new Error(`Unable to load models from this endpoint (${[...new Set(errors)].slice(0, 4).join("; ")})`);
		} catch (error) {
			if (controller.signal.aborted) throw new Error("Model endpoint timed out after 10 seconds");
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	async remove(model: ModelRef): Promise<void> {
		this.#configs.delete(keyFor(model));
		await this.#persist();
	}

	async test(model: ModelRef): Promise<number> {
		const config = this.#configs.get(keyFor(model));
		if (!config) throw new Error(`Custom model ${model.provider}/${model.id} does not exist`);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), MODEL_TEST_TIMEOUT_MS);
		const started = Date.now();
		try {
			const endpoint = resourceUrl(
				config.baseUrl,
				config.api === "openai-completions"
					? "chat/completions"
					: config.api === "openai-responses"
						? "responses"
						: "messages",
				config.api === "anthropic-messages"
			);
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (config.api === "openai-completions" || config.api === "openai-responses")
				headers.authorization = `Bearer ${config.apiKey}`;
			else {
				headers["x-api-key"] = config.apiKey;
				headers["anthropic-version"] = "2023-06-01";
			}
			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				signal: controller.signal,
				body: JSON.stringify(
					config.api === "openai-completions"
						? {
								model: config.id,
								messages: [{ role: "user", content: "ping" }],
								max_tokens: 1,
								stream: false,
							}
						: config.api === "openai-responses"
							? { model: config.id, input: "ping", max_output_tokens: 1, stream: false }
							: { model: config.id, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }
				),
			});
			if (!response.ok) throw new Error(`Model endpoint returned HTTP ${response.status}`);
			return Math.max(0, Date.now() - started);
		} catch (error) {
			if (controller.signal.aborted)
				throw new Error(
					`Model test timed out after ${MODEL_TEST_TIMEOUT_MS / 1000} seconds. The endpoint did not respond in time; please try again later.`
				);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	async #persist(): Promise<void> {
		if (!this.#filePath || !this.#key) return;
		await mkdir(dirname(this.#filePath), { recursive: true });
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
		const catalog: StoredCatalog = {
			version: 2,
			services: [...this.#services.values()],
			models: [...this.#configs.values()].map(storedModel),
		};
		const encrypted = Buffer.concat([cipher.update(JSON.stringify(catalog)), cipher.final()]);
		const payload = JSON.stringify({
			iv: iv.toString("base64url"),
			tag: cipher.getAuthTag().toString("base64url"),
			data: encrypted.toString("base64url"),
		});
		const temporary = `${this.#filePath}.${process.pid}.tmp`;
		await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, this.#filePath);
	}
}

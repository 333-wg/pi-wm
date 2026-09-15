import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Compile } from "typebox/compile";
import {
	MediaModelConfigSchema,
	MediaModelDiscoveryConnectionSchema,
	type MediaModelDiscoveryConnection,
	type MediaKind,
	type MediaModelConfig,
	type MediaModelSettings,
} from "@wuming/protocol";
import { parseMediaModelCatalog } from "./media-model-discovery.js";

export type MediaConnection = Omit<MediaModelConfig, "apiKey"> & { apiKey: string };
const checkConfig = Compile(MediaModelConfigSchema);
const checkDiscovery = Compile(MediaModelDiscoveryConnectionSchema);

function selectedModels(config: MediaModelConfig): string[] {
	if (config.kind !== "video" && (config.videoProtocol !== undefined || config.videoReferenceFormat !== undefined))
		throw new Error("Video protocol applies only to video models");
	const models = (config.models ?? [config.model]).map((model) => model.trim());
	if (models.some((model) => !model) || new Set(models).size !== models.length || !models.includes(config.model.trim()))
		throw new Error("默认模型必须包含在已选模型中，模型 ID 不能为空或重复");
	if (config.kind === "video" && models.length !== 1) throw new Error("视频模型暂不支持多选");
	return models;
}

export function mediaResourceUrl(baseUrl: string, resource: string): string {
	const url = new URL(baseUrl);
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
		throw new Error("Media Base URL must be HTTP(S), without credentials, query or fragment");
	if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		throw new Error("Media Base URL must use HTTPS except on loopback");
	url.pathname = `${url.pathname.replace(/\/+$/, "") || "/v1"}/${resource}`;
	return url.toString();
}

export async function readMediaBody(response: Response, maxBytes: number): Promise<Buffer> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Media service returned an empty response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Media response exceeds size limit");
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new Error("Media response exceeds size limit");
			chunks.push(value);
		}
		return Buffer.concat(chunks);
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Credentials remain host-owned; settings and tool results never expose them. */
export class MediaModelRegistry {
	readonly #key: Buffer;
	readonly #filePath: string;
	#configs = new Map<MediaKind, MediaConnection>();
	#tail: Promise<unknown> = Promise.resolve();

	constructor(options: { filePath: string; encryptionKey: string }) {
		this.#filePath = options.filePath;
		this.#key = createHash("sha256").update(options.encryptionKey).digest();
	}

	async load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.#filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const envelope = JSON.parse(raw);
		const cipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(envelope.iv, "base64url"));
		cipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
		const stored = JSON.parse(
			Buffer.concat([cipher.update(Buffer.from(envelope.data, "base64url")), cipher.final()]).toString("utf8")
		);
		if (stored.version !== 1 || !Array.isArray(stored.models) || stored.models.length > 2)
			throw new Error("Media model configuration is corrupt");
		const next = new Map<MediaKind, MediaConnection>();
		for (const config of stored.models) {
			if (!checkConfig.Check(config) || !config.apiKey?.trim() || next.has(config.kind))
				throw new Error("Media model configuration is corrupt");
			mediaResourceUrl(config.baseUrl, "models");
			const models = selectedModels(config);
			// Keep the video connection shape stable for persisted job fingerprints.
			next.set(config.kind, {
				kind: config.kind,
				baseUrl: config.baseUrl,
				model: config.model,
				apiKey: config.apiKey,
				...(config.kind === "image" ? { models } : {}),
				...(config.kind === "video" && config.videoProtocol && config.videoProtocol !== "auto"
					? { videoProtocol: config.videoProtocol }
					: {}),
				...(config.kind === "video" && config.videoReferenceFormat === "data-url"
					? { videoReferenceFormat: config.videoReferenceFormat }
					: {}),
			});
		}
		this.#configs = next;
	}

	list(): MediaModelSettings[] {
		return [...this.#configs.values()].map(({ kind, baseUrl, model, models, videoProtocol, videoReferenceFormat }) => ({
			kind,
			baseUrl,
			model,
			...(models ? { models: [...models] } : {}),
			...(videoProtocol ? { videoProtocol } : {}),
			...(videoReferenceFormat ? { videoReferenceFormat } : {}),
			authenticated: true,
		}));
	}

	resolve(kind: MediaKind, requestedModel?: string): MediaConnection {
		const config = this.#configs.get(kind);
		if (!config)
			throw new Error(
				`Default ${kind} model is not configured. Open Settings > Models to configure it; do not substitute a skill's provider or request its API key.`
			);
		if (
			requestedModel !== undefined &&
			(kind !== "image" || !(config.models ?? [config.model]).includes(requestedModel))
		)
			throw new Error("只能使用设置中已选的生图模型；请勿改用技能自带的模型或密钥");
		return {
			...config,
			model: requestedModel ?? config.model,
			...(config.models ? { models: [...config.models] } : {}),
		};
	}

	async set(config: MediaModelConfig): Promise<void> {
		if (!checkConfig.Check(config)) throw new Error("Invalid media model configuration");
		const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
		mediaResourceUrl(baseUrl, "models");
		const model = config.model.trim();
		if (!model) throw new Error("Media model ID is required");
		const models = selectedModels(config);
		await this.#mutate((next) => {
			const previous = next.get(config.kind);
			const apiKey = config.apiKey?.trim() || (previous?.baseUrl === baseUrl ? previous.apiKey : undefined);
			if (!apiKey) throw new Error("API Key is required for a new or changed Media Base URL");
			next.set(config.kind, {
				kind: config.kind,
				baseUrl,
				model,
				apiKey,
				...(config.kind === "image" ? { models } : {}),
				...(config.kind === "video" && config.videoProtocol && config.videoProtocol !== "auto"
					? { videoProtocol: config.videoProtocol }
					: {}),
				...(config.kind === "video" && config.videoReferenceFormat === "data-url"
					? { videoReferenceFormat: config.videoReferenceFormat }
					: {}),
			});
		});
	}

	async remove(kind: MediaKind): Promise<void> {
		await this.#mutate((next) => {
			next.delete(kind);
		});
	}

	async discover(connection: MediaModelDiscoveryConnection) {
		if (!checkDiscovery.Check(connection)) throw new Error("生成模型连接参数无效");
		const baseUrl = connection.baseUrl.trim().replace(/\/+$/, "");
		const url = mediaResourceUrl(baseUrl, "models");
		const saved = this.#configs.get(connection.kind);
		const apiKey = connection.apiKey?.trim() || (saved?.baseUrl === baseUrl ? saved.apiKey : undefined);
		if (!apiKey) throw new Error("请填写 API Key；更换 Base URL 后不能复用原地址的密钥");
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		}).catch(() => {
			throw new Error("获取模型失败，请检查 Base URL 和服务是否可用");
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`获取模型失败（HTTP ${response.status}），请检查地址、Key 和模型列表权限`);
		}
		const bytes = await readMediaBody(response, 2 * 1024 * 1024);
		let payload: unknown;
		try {
			payload = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new Error("模型列表返回的不是有效 JSON");
		}
		return parseMediaModelCatalog(payload, connection.kind);
	}

	async #mutate(change: (next: Map<MediaKind, MediaConnection>) => void): Promise<void> {
		const pending = this.#tail.then(async () => {
			const next = new Map(this.#configs);
			change(next);
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
			const data = Buffer.concat([
				cipher.update(JSON.stringify({ version: 1, models: [...next.values()] })),
				cipher.final(),
			]);
			await mkdir(dirname(this.#filePath), { recursive: true });
			const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
			try {
				await writeFile(
					temporary,
					JSON.stringify({
						iv: iv.toString("base64url"),
						tag: cipher.getAuthTag().toString("base64url"),
						data: data.toString("base64url"),
					}),
					{ mode: 0o600 }
				);
				await rename(temporary, this.#filePath);
				this.#configs = next;
			} finally {
				await rm(temporary, { force: true });
			}
		});
		this.#tail = pending.catch(() => {});
		await pending;
	}
}

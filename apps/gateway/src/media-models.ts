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
	type CustomModelSettings,
	type ImageModelOption,
	type ModelRef,
	type MediaModelOption,
} from "@wuming/protocol";
import { parseMediaModelCatalog } from "./media-model-discovery.js";
import { videoProtocol } from "./media-video.js";
import { validateVideoCredentials } from "./media-video-auth.js";
import { nativeVideoAdapters } from "./media-video-native.js";
import { internationalVideoAdapters } from "./media-video-international.js";

export type MediaConnection = Omit<MediaModelConfig, "apiKey"> & { apiKey: string };
const checkConfig = Compile(MediaModelConfigSchema);
const checkDiscovery = Compile(MediaModelDiscoveryConnectionSchema);
interface ImageModelSource {
	listMedia(): CustomModelSettings[];
	resolveMedia(config: MediaModelConfig): MediaModelConfig;
}
interface VideoModelEntry {
	custom: boolean;
	config: MediaConnection;
}
function videoKey(model: ModelRef): string {
	return JSON.stringify([model.provider, model.id]);
}
export function mediaConnectionHash(config: MediaConnection): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				kind: config.kind,
				baseUrl: config.baseUrl,
				model: config.model,
				apiKey: config.apiKey,
				...(config.apiSecret ? { apiSecret: config.apiSecret } : {}),
			})
		)
		.digest("hex");
}
function localProvider(baseUrl: string): string {
	return `media-${createHash("sha256").update(baseUrl).digest("hex").slice(0, 24)}`;
}

function selectedModels(config: MediaModelConfig): string[] {
	if (config.kind !== "video" && config.apiSecret !== undefined)
		throw new Error("Secret Key applies only to native video models");
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
	#imageServices = new Map<string, MediaConnection>();
	#videoModels = new Map<string, VideoModelEntry>();
	readonly #imageModels: ImageModelSource | undefined;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(options: { filePath: string; encryptionKey: string; imageModels?: ImageModelSource }) {
		this.#filePath = options.filePath;
		this.#key = createHash("sha256").update(options.encryptionKey).digest();
		this.#imageModels = options.imageModels;
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
		if (![1, 2, 3].includes(stored.version) || !Array.isArray(stored.models) || stored.models.length > 2)
			throw new Error("Media model configuration is corrupt");
		const next = new Map<MediaKind, MediaConnection>();
		for (const config of stored.models) {
			if (!checkConfig.Check(config) || !config.apiKey?.trim() || next.has(config.kind))
				throw new Error("Media model configuration is corrupt");
			mediaResourceUrl(config.baseUrl, "models");
			const models = selectedModels(config);
			next.set(config.kind, {
				kind: config.kind,
				...(config.provider ? { provider: config.provider } : {}),
				baseUrl: config.baseUrl,
				model: config.model,
				apiKey: config.apiKey,
				...(config.apiSecret ? { apiSecret: config.apiSecret } : {}),
				...(config.kind === "image" ? { models } : {}),
				...(config.kind === "video" && config.videoProtocol && config.videoProtocol !== "auto"
					? { videoProtocol: config.videoProtocol }
					: {}),
				...(config.kind === "video" && config.videoReferenceFormat === "data-url"
					? { videoReferenceFormat: config.videoReferenceFormat }
					: {}),
			});
		}
		const services = new Map<string, MediaConnection>();
		if (stored.version >= 2) {
			if (!Array.isArray(stored.imageServices)) throw new Error("Image model configuration is corrupt");
			for (const config of stored.imageServices) {
				if (!checkConfig.Check(config) || config.kind !== "image" || !config.apiKey?.trim())
					throw new Error("Image model configuration is corrupt");
				mediaResourceUrl(config.baseUrl, "models");
				const provider = localProvider(config.baseUrl);
				if (services.has(provider)) throw new Error("Duplicate image service");
				services.set(provider, { ...config, apiKey: config.apiKey, models: selectedModels(config) });
			}
		} else {
			const image = next.get("image");
			if (image) {
				// Older imports copied the key but lost the source identity. Rebind only on an exact credential match.
				const source = this.#imageModels
					?.listMedia()
					.find(
						(item) =>
							item.kind === "image" &&
							item.baseUrl === image.baseUrl &&
							item.model.id === image.model &&
							(image.models ?? [image.model]).every((id) =>
								this.#imageModels!.listMedia().some(
									(candidate) =>
										candidate.kind === "image" &&
										candidate.model.provider === item.model.provider &&
										candidate.model.id === id
								)
							)
					);
				if (
					source &&
					this.#imageModels!.resolveMedia({
						kind: "image",
						provider: source.model.provider,
						baseUrl: image.baseUrl,
						model: image.model,
					}).apiKey === image.apiKey
				)
					next.set("image", { ...image, provider: source.model.provider });
				else {
					const provider = localProvider(image.baseUrl);
					services.set(provider, image);
					next.set("image", { ...image, provider });
				}
			}
		}
		const image = next.get("image");
		if (image && !image.provider && services.has(localProvider(image.baseUrl)))
			next.set("image", { ...image, provider: localProvider(image.baseUrl) });
		const videos = new Map<string, VideoModelEntry>();
		if (stored.version === 3) {
			if (!Array.isArray(stored.videoModels)) throw new Error("Video model configuration is corrupt");
			for (const entry of stored.videoModels) {
				if (
					!entry ||
					typeof entry.custom !== "boolean" ||
					!checkConfig.Check(entry.config) ||
					entry.config.kind !== "video" ||
					!entry.config.provider ||
					!entry.config.apiKey?.trim()
				)
					throw new Error("Video model configuration is corrupt");
				mediaResourceUrl(entry.config.baseUrl, "models");
				selectedModels(entry.config);
				const key = videoKey({ provider: entry.config.provider, id: entry.config.model });
				if (videos.has(key)) throw new Error("Duplicate video model");
				videos.set(key, entry);
			}
		} else {
			const video = next.get("video");
			if (video) {
				const source = this.#imageModels
					?.listMedia()
					.find((item) => item.kind === "video" && item.baseUrl === video.baseUrl && item.model.id === video.model);
				const custom = Boolean(
					source &&
					this.#imageModels!.resolveMedia({
						kind: "video",
						provider: source.model.provider,
						baseUrl: video.baseUrl,
						model: video.model,
					}).apiKey === video.apiKey
				);
				const provider = custom ? source!.model.provider : localProvider(video.baseUrl);
				const config = { ...video, provider };
				videos.set(videoKey({ provider, id: video.model }), { custom, config });
				next.set("video", config);
			}
		}
		this.#imageServices = services;
		this.#videoModels = videos;
		this.#configs = next;
	}

	#availableVideos(): MediaModelOption[] {
		const models: MediaModelOption[] = (this.#imageModels?.listMedia() ?? [])
			.filter((item) => item.kind === "video")
			.map((item) => {
				const preferences = this.#videoModels.get(videoKey(item.model))?.config;
				return {
					...item.model,
					name: item.name,
					baseUrl: item.baseUrl,
					custom: true,
					...(preferences?.videoProtocol ? { videoProtocol: preferences.videoProtocol } : {}),
					...(preferences?.videoReferenceFormat ? { videoReferenceFormat: preferences.videoReferenceFormat } : {}),
				};
			});
		for (const { custom, config } of this.#videoModels.values()) {
			if (custom) continue;
			models.push({
				provider: config.provider!,
				id: config.model,
				name: config.model,
				baseUrl: config.baseUrl,
				custom: false,
				...(config.videoProtocol ? { videoProtocol: config.videoProtocol } : {}),
				...(config.videoReferenceFormat ? { videoReferenceFormat: config.videoReferenceFormat } : {}),
			});
		}
		return models;
	}

	#defaultVideo(models: MediaModelOption[]): MediaModelOption | undefined {
		const saved = this.#configs.get("video");
		return models.find((item) => item.provider === saved?.provider && item.id === saved.model) ?? models[0];
	}

	#availableImages(): ImageModelOption[] {
		const models: ImageModelOption[] = (this.#imageModels?.listMedia() ?? [])
			.filter((item) => item.kind === "image")
			.map((item) => ({ ...item.model, name: item.name, baseUrl: item.baseUrl, custom: true }));
		for (const [provider, config] of this.#imageServices)
			for (const id of config.models ?? [config.model])
				models.push({ provider, id, name: id, baseUrl: config.baseUrl, custom: false });
		return models;
	}

	#defaultImage(models: ImageModelOption[]): ImageModelOption | undefined {
		const saved = this.#configs.get("image");
		return (
			models.find(
				(item) =>
					item.id === saved?.model &&
					(saved.provider ? item.provider === saved.provider : item.baseUrl === saved.baseUrl)
			) ?? models[0]
		);
	}

	list(): MediaModelSettings[] {
		const settings: MediaModelSettings[] = [];
		const videoModels = this.#availableVideos();
		const video = this.#defaultVideo(videoModels);
		if (video)
			settings.push({
				kind: "video",
				provider: video.provider,
				baseUrl: video.baseUrl,
				model: video.id,
				models: [...new Set(videoModels.map((item) => item.id))],
				availableModels: videoModels,
				authenticated: true,
				...(video.videoProtocol ? { videoProtocol: video.videoProtocol } : {}),
				...(video.videoReferenceFormat ? { videoReferenceFormat: video.videoReferenceFormat } : {}),
			});
		const availableModels = this.#availableImages();
		const image = this.#defaultImage(availableModels);
		if (image)
			settings.unshift({
				kind: "image",
				provider: image.provider,
				baseUrl: image.baseUrl,
				model: image.id,
				models: [...new Set(availableModels.map((item) => item.id))],
				availableModels,
				authenticated: true,
			});
		return settings;
	}

	resolve(kind: MediaKind, requestedModel?: string, requestedProvider?: string): MediaConnection {
		if (kind === "image") {
			const models = this.#availableImages();
			if (requestedProvider && !requestedModel) throw new Error("指定生图服务时必须同时指定模型 ID");
			const matches = models.filter(
				(item) => item.id === requestedModel && (!requestedProvider || item.provider === requestedProvider)
			);
			if (requestedModel && matches.length > 1)
				throw new Error("多个中转站存在同名生图模型，请同时指定 provider 和 model");
			const selected = requestedModel ? matches[0] : this.#defaultImage(models);
			if (!selected)
				throw new Error(
					requestedModel
						? "只能使用已添加的生图模型；请检查服务和模型 ID"
						: "Default image model is not configured. Open Settings > Models to configure it."
				);
			if (selected.custom) {
				const config = this.#imageModels!.resolveMedia({
					kind,
					provider: selected.provider,
					baseUrl: selected.baseUrl,
					model: selected.id,
				});
				mediaResourceUrl(config.baseUrl, "models");
				if (!config.apiKey) throw new Error("Image service credentials are unavailable");
				return { ...config, apiKey: config.apiKey };
			}
			const config = this.#imageServices.get(selected.provider)!;
			return {
				...config,
				provider: selected.provider,
				model: selected.id,
				models: [...(config.models ?? [config.model])],
			};
		}
		const models = this.#availableVideos();
		if (requestedProvider && !requestedModel) throw new Error("指定视频服务时必须同时指定模型 ID");
		const matches = models.filter(
			(item) => item.id === requestedModel && (!requestedProvider || item.provider === requestedProvider)
		);
		if (requestedModel && matches.length > 1)
			throw new Error("多个中转站存在同名视频模型，请同时指定 provider 和 model");
		const selected = requestedModel ? matches[0] : this.#defaultVideo(models);
		if (!selected)
			throw new Error(
				requestedModel
					? "只能使用已添加的视频模型；请检查服务和模型 ID"
					: "Default video model is not configured. Open Settings > Models to configure it."
			);
		const config = selected.custom
			? this.#imageModels!.resolveMedia({
					kind,
					provider: selected.provider,
					baseUrl: selected.baseUrl,
					model: selected.id,
				})
			: this.#videoModels.get(videoKey(selected))!.config;
		mediaResourceUrl(config.baseUrl, "models");
		if (!config.apiKey) throw new Error("Video service credentials are unavailable");
		return {
			kind,
			provider: selected.provider,
			baseUrl: config.baseUrl,
			model: selected.id,
			apiKey: config.apiKey,
			...(config.apiSecret ? { apiSecret: config.apiSecret } : {}),
			...(selected.custom && this.#videoModels.get(videoKey(selected))?.config.apiSecret
				? { apiSecret: this.#videoModels.get(videoKey(selected))!.config.apiSecret! }
				: {}),
			...(selected.videoProtocol ? { videoProtocol: selected.videoProtocol } : {}),
			...(selected.videoReferenceFormat ? { videoReferenceFormat: selected.videoReferenceFormat } : {}),
		};
	}

	resolveVideoJob(hash: string, model?: ModelRef): MediaConnection {
		const candidates = this.#availableVideos().filter(
			(item) => !model || (item.provider === model.provider && item.id === model.id)
		);
		for (const candidate of candidates) {
			const config = this.resolve("video", candidate.id, candidate.provider);
			if (mediaConnectionHash(config) === hash) return config;
		}
		throw new Error("Video model settings changed; restore the original service and credentials to retrieve this job");
	}

	async set(config: MediaModelConfig): Promise<void> {
		if (!checkConfig.Check(config)) throw new Error("Invalid media model configuration");
		const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
		mediaResourceUrl(baseUrl, "models");
		const model = config.model.trim();
		if (!model) throw new Error("Media model ID is required");
		const models = selectedModels(config);
		if (config.kind === "video") {
			await this.#setVideo(config, baseUrl, model);
			return;
		}
		if (config.provider) {
			const selected = this.#availableImages().find(
				(item) => item.provider === config.provider && item.id === model && item.baseUrl === baseUrl
			);
			if (!selected) throw new Error("生成模型与已保存的服务不匹配");
			await this.setImageDefault(selected);
			return;
		}
		await this.#mutate((next, images) => {
			const previous = images.get(localProvider(baseUrl));
			const imageModels = [...new Set([...(previous?.models ?? (previous ? [previous.model] : [])), ...models])];
			if (imageModels.length > 50) throw new Error("每个手动添加的生图服务最多保存 50 个模型");
			const apiKey = config.apiKey?.trim() || (previous?.baseUrl === baseUrl ? previous.apiKey : undefined);
			if (!apiKey) throw new Error("API Key is required for a new or changed Media Base URL");
			next.set("image", {
				kind: "image",
				baseUrl,
				provider: localProvider(baseUrl),
				model,
				apiKey,
				models: imageModels,
			});
			images.set(localProvider(baseUrl), next.get("image")!);
		});
	}

	async #setVideo(config: MediaModelConfig, baseUrl: string, model: string): Promise<void> {
		const provider = config.provider ?? localProvider(baseUrl);
		const selected = config.provider
			? this.#availableVideos().find(
					(item) => item.provider === provider && item.id === model && item.baseUrl === baseUrl
				)
			: undefined;
		if (config.provider && !selected) throw new Error("视频模型与已保存的服务不匹配");
		const resolved = selected ? this.resolve("video", model, provider) : undefined;
		await this.#mutate((next, _images, videos) => {
			const currentDefault = this.#defaultVideo(this.#availableVideos());
			const previous = videos.get(videoKey({ provider, id: model }))?.config;
			const service = [...videos.values()].find((entry) => !entry.custom && entry.config.baseUrl === baseUrl)?.config;
			const apiKey = selected?.custom ? resolved?.apiKey : config.apiKey?.trim() || previous?.apiKey || service?.apiKey;
			if (!apiKey) throw new Error("API Key is required for a new or changed Media Base URL");
			const protocol = config.videoProtocol ?? previous?.videoProtocol;
			const apiSecret = config.apiSecret?.trim() || previous?.apiSecret || service?.apiSecret;
			const format = config.videoReferenceFormat ?? previous?.videoReferenceFormat;
			const saved: MediaConnection = {
				kind: "video",
				provider,
				baseUrl,
				model,
				apiKey,
				...(apiSecret ? { apiSecret } : {}),
				...(protocol && protocol !== "auto" ? { videoProtocol: protocol } : {}),
				...(format === "data-url" ? { videoReferenceFormat: format } : {}),
			};
			validateVideoCredentials(saved, videoProtocol(saved));
			if (!selected?.custom && (config.apiKey?.trim() || config.apiSecret?.trim())) {
				for (const [key, entry] of videos)
					if (!entry.custom && entry.config.provider === provider)
						videos.set(key, { ...entry, config: { ...entry.config, apiKey, ...(apiSecret ? { apiSecret } : {}) } });
			}
			videos.set(videoKey({ provider, id: model }), { custom: selected?.custom ?? false, config: saved });
			if (!currentDefault || (currentDefault.provider === provider && currentDefault.id === model))
				next.set("video", saved);
		});
	}

	async setVideoDefault(model: ModelRef): Promise<void> {
		const selected = this.resolve("video", model.id, model.provider);
		await this.#mutate((next) => {
			next.set("video", selected);
		});
	}

	async removeVideo(model: ModelRef): Promise<void> {
		await this.#mutate((next, _images, videos) => {
			const key = videoKey(model);
			const entry = videos.get(key);
			if (!entry || entry.custom) throw new Error("请从对应的已添加服务中删除此模型");
			videos.delete(key);
			const current = next.get("video");
			if (current?.provider === model.provider && current.model === model.id) next.delete("video");
		});
	}

	async setImageDefault(model: ModelRef): Promise<void> {
		const selected = this.resolve("image", model.id, model.provider);
		await this.#mutate((next) => {
			next.set("image", { ...selected, provider: model.provider });
		});
	}

	async removeImage(model: ModelRef): Promise<void> {
		await this.#mutate((next, images) => {
			const service = images.get(model.provider);
			if (!service) throw new Error("请从对应的已添加服务中删除此模型");
			const models = (service.models ?? [service.model]).filter((id) => id !== model.id);
			if (models.length)
				images.set(model.provider, {
					...service,
					model: models.includes(service.model) ? service.model : models[0]!,
					models,
				});
			else images.delete(model.provider);
			const current = next.get("image");
			if (current?.model === model.id && current.provider === model.provider) next.delete("image");
		});
	}

	async remove(kind: MediaKind): Promise<void> {
		await this.#mutate((next, images, videos) => {
			next.delete(kind);
			if (kind === "image") images.clear();
			else videos.clear();
		});
	}

	async discover(connection: MediaModelDiscoveryConnection) {
		if (!checkDiscovery.Check(connection)) throw new Error("生成模型连接参数无效");
		const baseUrl = connection.baseUrl.trim().replace(/\/+$/, "");
		if (
			connection.kind === "video" &&
			[...nativeVideoAdapters, ...internationalVideoAdapters].some((adapter) => adapter.matches({ baseUrl, model: "" }))
		)
			throw new Error("此原生视频服务不使用 OpenAI 模型列表；请填写供应商控制台的模型 ID（即梦填写 req_key）");
		const url = mediaResourceUrl(baseUrl, "models");
		let saved = this.#configs.get(connection.kind);
		if (connection.kind === "video") {
			const candidates = this.#availableVideos().filter(
				(item) => item.baseUrl === baseUrl && (!connection.provider || item.provider === connection.provider)
			);
			const selected =
				candidates.find((item) => item.provider === saved?.provider && item.id === saved.model) ?? candidates[0];
			saved = selected ? this.resolve("video", selected.id, selected.provider) : undefined;
			if (
				!connection.apiKey?.trim() &&
				new Set(candidates.map((item) => item.provider)).size > 1 &&
				!connection.provider
			)
				throw new Error("同一地址有多个视频服务，请指定 provider 或填写 API Key");
		}
		if (connection.kind === "image") {
			saved = this.#imageServices.get(localProvider(baseUrl));
			const fallback = this.#defaultImage(this.#availableImages());
			if (!saved && fallback?.baseUrl === baseUrl) saved = this.resolve("image", fallback.id, fallback.provider);
		}
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

	async #mutate(
		change: (
			next: Map<MediaKind, MediaConnection>,
			images: Map<string, MediaConnection>,
			videos: Map<string, VideoModelEntry>
		) => void
	): Promise<void> {
		const pending = this.#tail.then(async () => {
			const next = new Map(this.#configs);
			const images = new Map(this.#imageServices);
			const videos = new Map(this.#videoModels);
			change(next, images, videos);
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
			const data = Buffer.concat([
				cipher.update(
					JSON.stringify({
						version: 3,
						models: [...next.values()],
						imageServices: [...images.values()],
						videoModels: [...videos.values()],
					})
				),
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
				this.#imageServices = images;
				this.#videoModels = videos;
			} finally {
				await rm(temporary, { force: true });
			}
		});
		this.#tail = pending.catch(() => {});
		await pending;
	}
}

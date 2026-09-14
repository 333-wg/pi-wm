import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ArtifactStore } from "@wuming/artifacts";
import type { ArtifactRef, SessionSnapshot } from "@wuming/protocol";
import { SafeWebClient, type ApprovalBroker } from "@wuming/sandbox";
import { Type } from "typebox";
import { MediaModelRegistry, mediaResourceUrl, readMediaBody, type MediaConnection } from "./media-models.js";
import { MEDIA_SKILL_ROUTING_POLICY, mediaModelStatus } from "./media-skill-policy.js";
import { videoRequest, videoResultResource, type VideoProtocol } from "./media-video.js";

type Json = Record<string, unknown>;
interface VideoJob {
	id: string;
	session_id: string;
	remote_id: string;
	connection_hash: string;
	artifact: string | null;
	protocol: VideoProtocol;
}
const object = (value: unknown): Json =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const connectionHash = (config: MediaConnection) => createHash("sha256").update(JSON.stringify(config)).digest("hex");
const outputText = (text: string) => [{ type: "text" as const, text }];

export class MediaGenerationService {
	readonly #db: DatabaseSync;
	readonly #models: MediaModelRegistry;
	readonly #artifacts: ArtifactStore;
	readonly #download: (url: string, options: { maxBytes: number; signal?: AbortSignal }) => Promise<Buffer>;
	readonly #fetch: typeof fetch;
	readonly #maxImageBytes: number;
	readonly #maxVideoBytes: number;
	readonly #pollMs: number;

	constructor(options: {
		models: MediaModelRegistry;
		artifacts: ArtifactStore;
		databasePath: string;
		maxImageBytes?: number;
		maxVideoBytes?: number;
		pollMs?: number;
		fetch?: typeof fetch;
		download?: (url: string, options: { maxBytes: number; signal?: AbortSignal }) => Promise<Buffer>;
	}) {
		this.#models = options.models;
		this.#artifacts = options.artifacts;
		this.#db = new DatabaseSync(options.databasePath);
		this.#db.exec(
			"CREATE TABLE IF NOT EXISTS media_video_jobs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, remote_id TEXT NOT NULL, connection_hash TEXT NOT NULL, artifact TEXT)"
		);
		// Existing jobs retain their original transport when an adapter is added.
		if (
			!this.#db
				.prepare("PRAGMA table_info(media_video_jobs)")
				.all()
				.some((column) => column.name === "protocol")
		)
			this.#db.exec("ALTER TABLE media_video_jobs ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai'");
		this.#fetch = options.fetch ?? fetch;
		const web = new SafeWebClient({ timeoutMs: 120_000 });
		this.#download = options.download ?? ((url, limits) => web.download(url, limits));
		this.#maxImageBytes = options.maxImageBytes ?? 10 * 1024 * 1024;
		this.#maxVideoBytes = options.maxVideoBytes ?? 100 * 1024 * 1024;
		this.#pollMs = options.pollMs ?? 3000;
	}

	close(): void {
		this.#db.close();
	}

	async #request(
		config: MediaConnection,
		resource: string | URL,
		signal: AbortSignal,
		body?: BodyInit,
		json = false
	): Promise<Response> {
		signal.throwIfAborted();
		const url = resource instanceof URL ? resource.toString() : mediaResourceUrl(config.baseUrl, resource);
		if (new URL(url).origin !== new URL(config.baseUrl).origin)
			throw new Error("Media API requests must stay on the configured origin");
		let response: Response;
		try {
			response = await this.#fetch(url, {
				method: body === undefined ? "GET" : "POST",
				redirect: "error",
				signal,
				headers: { Authorization: `Bearer ${config.apiKey}`, ...(json ? { "Content-Type": "application/json" } : {}) },
				...(body === undefined ? {} : { body }),
			});
		} catch {
			signal.throwIfAborted();
			throw new Error(
				"Media service connection failed. Do not automatically resubmit a generation: the provider may already have accepted and billed it."
			);
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(
				`Media service returned HTTP ${response.status}. Check model access, balance, and API compatibility. Do not automatically retry a billable generation.`
			);
		}
		return response;
	}

	async #json(response: Response, maxBytes = 1024 * 1024): Promise<Json> {
		const bytes = await readMediaBody(response, maxBytes);
		try {
			return object(JSON.parse(bytes.toString("utf8")));
		} catch {
			throw new Error("Media service returned invalid JSON");
		}
	}

	async #save(snapshot: SessionSnapshot, content: Buffer, kind: "image" | "video"): Promise<ArtifactRef> {
		const { validateArtifact } = await import("@wuming/artifacts");
		const validated = validateArtifact(
			{ name: `generated-${kind}`, content },
			{
				maxFileBytes: this.#maxImageBytes,
				maxImageBytes: this.#maxImageBytes,
				maxVideoBytes: this.#maxVideoBytes,
			}
		);
		if (!validated.mimeType.startsWith(`${kind}/`))
			throw new Error(`Media service did not return a supported ${kind} file`);
		const extension = validated.mimeType.split("/")[1]!.replace("jpeg", "jpg");
		return (
			await this.#artifacts.create({
				workspaceId: snapshot.session.workspaceId,
				ownerId: `session:${snapshot.session.id}`,
				name: `${kind}-${randomUUID()}.${extension}`,
				suppliedMimeType: validated.mimeType,
				content,
			})
		).ref;
	}

	createTools(snapshot: SessionSnapshot, approvals: ApprovalBroker): ToolDefinition[] {
		const authorize = async (id: string, config: MediaConnection, signal?: AbortSignal) => {
			if (snapshot.sandboxMode === "read_only") throw new Error("Media generation is unavailable in read-only mode");
			return approvals.authorize({
				sessionId: snapshot.session.id,
				toolCallId: id,
				risk: "medium",
				summary: `Use configured ${config.kind} model ${config.model} (provider charges may apply)`,
				capabilities: [
					{ type: "network.connect", hosts: [new URL(config.baseUrl).hostname] },
					{ type: "secret.use", names: [`media.${config.kind}`] },
				],
				...(signal ? { signal } : {}),
			});
		};
		return [
			defineTool({
				name: "media_model_status",
				label: "Check configured media models",
				description:
					"Read whether the host already has default image/video models. No network calls, fees or secrets. Use when a third-party skill asks for provider credentials or when settings changed. Saved defaults require no skill-specific setup; configured does not claim generation access was tested.",
				promptSnippet: "Check existing image/video defaults without asking for per-skill configuration",
				promptGuidelines: [MEDIA_SKILL_ROUTING_POLICY],
				parameters: Type.Object({}, { additionalProperties: false }),
				execute: async (_id, _params, signal) => {
					signal?.throwIfAborted();
					return {
						content: outputText(
							JSON.stringify({
								defaults: mediaModelStatus(this.#models.list()),
								configuration: "host_managed",
								perSkillSetupRequired: false,
							})
						),
						details: {},
					};
				},
			}),
			defineTool({
				name: "generate_image",
				label: "Generate image",
				description:
					"Generate one image with the configured default image model. Optional model selects only another image model saved in Settings when explicitly requested by the user; no endpoint or credential overrides. Returns a persisted chat attachment. Optional referenceArtifactId edits an existing workspace image through images/edits.",
				promptSnippet: "Generate or edit an image using the default image model from Settings",
				promptGuidelines: [
					"When the user provides a product or reference image, use its attached_image artifactId as referenceArtifactId. Never invent an artifact ID or substitute an unrelated sample product for an unavailable reference image.",
					"For ALL image-generation skills, use generate_image with the user-configured default. Adapt a third-party skill's provider invocation to this tool while preserving its creative instructions. Do not request or configure per-skill credentials, or run a provider script to bypass this route.",
					"When creating or learning image/video skills, reference generate_image, generate_video and get_generated_video; do not embed model IDs, endpoints or credentials. Generated artifacts already display in chat; do not invent local paths or remote media links.",
				],
				parameters: Type.Object(
					{
						prompt: Type.String({ minLength: 1, maxLength: 32_000 }),
						model: Type.Optional(
							Type.String({
								minLength: 1,
								maxLength: 200,
								description:
									"Omit to use the default. Only use a saved image model ID when the user explicitly requests it; media_model_status lists allowed IDs.",
							})
						),
						size: Type.Optional(Type.String({ pattern: "^(auto|[0-9]{2,4}x[0-9]{2,4})$" })),
						quality: Type.Optional(
							Type.Union(["auto", "low", "medium", "high", "standard", "hd"].map((value) => Type.Literal(value)))
						),
						referenceArtifactId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
					},
					{ additionalProperties: false }
				),
				execute: async (id, params, externalSignal) => {
					const config = this.#models.resolve("image", params.model);
					const permit = await authorize(id, config, externalSignal);
					const signal = AbortSignal.any([
						...(externalSignal ? [externalSignal] : []),
						AbortSignal.timeout(5 * 60_000),
					]);
					try {
						let body: BodyInit;
						let resource = "images/generations";
						if (params.referenceArtifactId) {
							const record = this.#artifacts.get(params.referenceArtifactId);
							if (!record || record.workspaceId !== snapshot.session.workspaceId || record.kind !== "image")
								throw new Error("Reference image is not accessible in this workspace");
							const { content } = await this.#artifacts.read(params.referenceArtifactId);
							const form = new FormData();
							form.set("model", config.model);
							form.set("prompt", params.prompt);
							form.set("n", "1");
							form.set("image", new Blob([new Uint8Array(content)], { type: record.ref.mimeType }), record.ref.name);
							if (params.size) form.set("size", params.size);
							if (params.quality) form.set("quality", params.quality);
							body = form;
							resource = "images/edits";
						} else {
							body = JSON.stringify({
								model: config.model,
								prompt: params.prompt,
								n: 1,
								...(params.size ? { size: params.size } : {}),
								...(params.quality ? { quality: params.quality } : {}),
							});
						}
						const payload = await this.#json(
							await this.#request(config, resource, signal, body, resource === "images/generations"),
							Math.ceil((this.#maxImageBytes * 4) / 3) + 65536
						);
						const image = object(Array.isArray(payload.data) ? payload.data[0] : undefined);
						let content: Buffer;
						if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
							if (!/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(image.b64_json)) throw new Error("Invalid image Base64 response");
							content = Buffer.from(image.b64_json, "base64");
						} else if (typeof image.url === "string") {
							// Provider output is untrusted. This downloader pins public DNS and never sends the API key.
							content = await this.#download(image.url, { maxBytes: this.#maxImageBytes, signal });
						} else throw new Error("Unsupported image response: expected data[0].b64_json or data[0].url");
						signal.throwIfAborted();
						const artifact = await this.#save(snapshot, content, "image");
						return {
							content: outputText(`Image generated with ${config.model}. Attached as ${artifact.name}.`),
							details: { artifact },
						};
					} finally {
						if (permit) approvals.completeAuthorization(permit);
					}
				},
			}),
			defineTool({
				name: "generate_video",
				label: "Generate video",
				description:
					"Submit one video to the configured default video model (OpenAI-compatible or official Agnes Video v2.0 API). Agnes supports approximately 1-18 seconds at 24 fps. Returns a durable jobId; use get_generated_video to wait and attach the result. Submission may be billable: never submit a second job merely because the first is pending.",
				promptSnippet: "Start a video generation using the default video model from Settings",
				promptGuidelines: [
					"For video skills use generate_video with the user-configured default, not hard-coded skill providers or scripts. Then call get_generated_video until completed or failed. Cancellation stops local waiting, not a provider-side job or its charges.",
				],
				parameters: Type.Object(
					{
						prompt: Type.String({ minLength: 1, maxLength: 32_000 }),
						size: Type.Optional(Type.String({ pattern: "^[0-9]{2,4}x[0-9]{2,4}$" })),
						seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
					},
					{ additionalProperties: false }
				),
				execute: async (id, params, externalSignal) => {
					const config = this.#models.resolve("video");
					const request = videoRequest(config, params);
					const permit = await authorize(id, config, externalSignal);
					const signal = AbortSignal.any([...(externalSignal ? [externalSignal] : []), AbortSignal.timeout(120_000)]);
					try {
						const payload = await this.#json(await this.#request(config, "videos", signal, request.body, request.json));
						const remoteId = request.protocol === "agnes" ? payload.video_id : payload.id;
						if (typeof remoteId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(remoteId))
							throw new Error("Unsupported video response: expected a video task id. Do not resubmit automatically.");
						const jobId = randomUUID();
						this.#db
							.prepare(
								"INSERT INTO media_video_jobs (id, session_id, remote_id, connection_hash, protocol) VALUES (?, ?, ?, ?, ?)"
							)
							.run(jobId, snapshot.session.id, remoteId, connectionHash(config), request.protocol);
						return {
							content: outputText(
								JSON.stringify({
									jobId,
									status: "submitted",
									next: "Call get_generated_video with this jobId; do not resubmit.",
								})
							),
							details: { jobId },
						};
					} finally {
						if (permit) approvals.completeAuthorization(permit);
					}
				},
			}),
			defineTool({
				name: "get_generated_video",
				label: "Retrieve generated video",
				description:
					"Wait up to 60 seconds for an existing video job from this session, then return pending or attach the completed video for inline playback. Safe to call again for the same job, including after reconnect/restart. Never creates or bills a new generation.",
				promptSnippet: "Check a submitted video and show its completed video attachment in chat",
				parameters: Type.Object(
					{ jobId: Type.String({ minLength: 1, maxLength: 200 }) },
					{ additionalProperties: false }
				),
				execute: async (
					id,
					params,
					externalSignal
				): Promise<{ content: ReturnType<typeof outputText>; details: { artifact?: ArtifactRef; jobId?: string } }> => {
					const job = this.#db
						.prepare("SELECT * FROM media_video_jobs WHERE id = ? AND session_id = ?")
						.get(params.jobId, snapshot.session.id) as unknown as VideoJob | undefined;
					if (!job) throw new Error("Video job does not exist in this session");
					if (job.artifact)
						return {
							content: outputText("Video completed."),
							details: { artifact: JSON.parse(job.artifact) as ArtifactRef },
						};
					const config = this.#models.resolve("video");
					if (job.connection_hash !== connectionHash(config))
						throw new Error("Video model settings changed; restore the original settings to retrieve this job");
					const permit = await authorize(id, config, externalSignal);
					const signal = AbortSignal.any([...(externalSignal ? [externalSignal] : []), AbortSignal.timeout(180_000)]);
					try {
						const deadline = Date.now() + 60_000;
						while (true) {
							const payload = await this.#json(
								await this.#request(config, videoResultResource(config, job.protocol, job.remote_id), signal)
							);
							const status = String(payload.status).toLowerCase();
							if (
								status === "completed" ||
								(job.protocol === "agnes" && ["succeeded", "success", "done"].includes(status))
							) {
								let content: Buffer;
								if (job.protocol === "agnes") {
									const url = object(payload.metadata).url;
									if (typeof url !== "string" || !url.trim())
										throw new Error(
											"Unsupported Agnes video result: expected metadata.url. Retrieve this job again; do not resubmit."
										);
									content = await this.#download(url, { maxBytes: this.#maxVideoBytes, signal });
								} else {
									const response = await this.#request(
										config,
										`videos/${encodeURIComponent(job.remote_id)}/content`,
										signal
									);
									content = await readMediaBody(response, this.#maxVideoBytes);
								}
								signal.throwIfAborted();
								const artifact = await this.#save(snapshot, content, "video");
								this.#db
									.prepare("UPDATE media_video_jobs SET artifact = ? WHERE id = ?")
									.run(JSON.stringify(artifact), job.id);
								return { content: outputText("Video completed and attached for playback."), details: { artifact } };
							}
							if (["failed", "cancelled", "canceled", "error"].includes(status))
								throw new Error(
									`Video generation ${status}; provider did not produce a video. Do not resubmit without user direction.`
								);
							if (!["queued", "in_progress", "pending", "processing"].includes(status))
								throw new Error("Unsupported video job status");
							if (Date.now() >= deadline)
								return {
									content: outputText(
										JSON.stringify({
											jobId: job.id,
											status,
											next: "Call get_generated_video again; do not resubmit.",
										})
									),
									details: { jobId: job.id },
								};
							await delay(this.#pollMs, undefined, { signal });
						}
					} finally {
						if (permit) approvals.completeAuthorization(permit);
					}
				},
			}),
		];
	}
}

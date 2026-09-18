import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	getSupportedThinkingLevels,
	type AuthOperationOptions,
	type AuthPrompt,
	type Credential,
	type CredentialStore,
	type OAuthCredential,
	type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { ModelMetadata, OfficialAccount, OfficialProvider } from "@wuming/protocol";

const IDS: OfficialProvider[] = ["official-claude", "official-chatgpt", "official-grok"];
const HOSTS: Record<OfficialProvider, string[]> = {
	"official-claude": ["claude.ai", "claude.com", "platform.claude.com"],
	"official-chatgpt": ["auth.openai.com"],
	"official-grok": ["auth.x.ai", "accounts.x.ai", "grok.com", "x.ai"],
};

export function isOfficialProvider(id: string): id is OfficialProvider {
	return IDS.includes(id as OfficialProvider);
}

/** Separate IDs prevent subscription credentials from ever reaching custom endpoints. */
export function officialProviders(): Provider[] {
	return [anthropicProvider(), openaiCodexProvider(), xaiProvider()].map((base, index) => {
		const id = IDS[index]!;
		return {
			...base,
			id,
			name: ["Claude", "ChatGPT", "Grok"][index]!,
			auth: { oauth: base.auth.oauth! },
			getModels: () => base.getModels().map((model) => ({ ...model, provider: id })),
		};
	});
}

function validCredential(value: unknown): value is OAuthCredential {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<OAuthCredential>;
	return (
		item.type === "oauth" &&
		typeof item.access === "string" &&
		!!item.access &&
		typeof item.refresh === "string" &&
		!!item.refresh &&
		typeof item.expires === "number" &&
		Number.isSafeInteger(item.expires) &&
		item.expires >= 0
	);
}

/** One shared instance per gateway serializes refresh/logout and atomic encrypted writes. */
export class OfficialCredentialStore implements CredentialStore {
	#data: Record<string, OAuthCredential> = {};
	#queue: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly filePath: string,
		private readonly key: Buffer
	) {
		if (key.length !== 32) throw new Error("Official account encryption requires a 32-byte key");
	}
	async load(): Promise<void> {
		let text: string;
		try {
			text = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		try {
			const envelope = JSON.parse(text);
			const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64url"));
			decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
			const decoded = JSON.parse(
				Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64url")), decipher.final()]).toString("utf8")
			);
			if (
				!decoded ||
				decoded.version !== 1 ||
				!decoded.accounts ||
				typeof decoded.accounts !== "object" ||
				Array.isArray(decoded.accounts)
			)
				throw new Error();
			for (const [id, credential] of Object.entries(decoded.accounts)) {
				if (!isOfficialProvider(id) || !validCredential(credential)) throw new Error();
			}
			this.#data = decoded.accounts;
		} catch {
			throw new Error("Cannot decrypt official accounts; check the model encryption key and account file");
		}
	}
	expires(id: string): number | undefined {
		return this.#data[id]?.expires;
	}
	async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.#data[id] ? structuredClone(this.#data[id]) : undefined;
	}
	async list() {
		return Object.keys(this.#data).map((providerId) => ({ providerId, type: "oauth" as const }));
	}
	#serialize<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(fn);
		this.#queue = result.catch(() => {});
		return result;
	}
	modify(
		id: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions
	): Promise<Credential | undefined> {
		return this.#serialize(async () => {
			if (!isOfficialProvider(id)) throw new Error("Unknown official provider");
			options?.signal?.throwIfAborted();
			const next = await fn(await this.read(id));
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				if (!validCredential(next)) throw new Error("Invalid official account credential");
				await this.#persist({ ...this.#data, [id]: structuredClone(next) });
			}
			return this.read(id);
		});
	}
	delete(id: string, options?: AuthOperationOptions): Promise<void> {
		return this.#serialize(async () => {
			options?.signal?.throwIfAborted();
			const next = { ...this.#data };
			delete next[id];
			await this.#persist(next);
		});
	}
	async #persist(accounts: Record<string, OAuthCredential>): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		const data = Buffer.concat([cipher.update(JSON.stringify({ version: 1, accounts })), cipher.final()]);
		const temporary = `${this.filePath}.${randomUUID()}.tmp`;
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
			await rename(temporary, this.filePath);
			this.#data = accounts;
		} finally {
			await rm(temporary, { force: true });
		}
	}
}

type Login = {
	public: { -readonly [K in keyof NonNullable<OfficialAccount["login"]>]: NonNullable<OfficialAccount["login"]>[K] };
	controller: AbortController;
	done: Promise<void>;
	submit?: (value: string) => void;
};

export class OfficialAccountManager {
	readonly #providers: Provider[];
	readonly #logins = new Map<OfficialProvider, Login>();
	readonly #operations = new Map<OfficialProvider, Promise<unknown>>();
	constructor(
		readonly credentials: OfficialCredentialStore,
		providers = officialProviders(),
		private readonly timeoutMs = 10 * 60_000
	) {
		this.#providers = providers;
	}
	accounts(): OfficialAccount[] {
		return this.#providers.map((provider) => {
			const id = provider.id as OfficialProvider;
			const expiresAt = this.credentials.expires(id);
			return {
				provider: id,
				name: provider.name,
				loggedIn: expiresAt !== undefined,
				...(expiresAt === undefined ? {} : { expiresAt }),
				modelCount: expiresAt === undefined ? 0 : provider.getModels().length,
				...(this.#logins.has(id) ? { login: structuredClone(this.#logins.get(id)!.public) } : {}),
			};
		});
	}
	list(): ModelMetadata[] {
		return this.#providers
			.filter((p) => this.credentials.expires(p.id) !== undefined)
			.flatMap((p) =>
				p.getModels().map((model) => ({
					model: { provider: p.id, id: model.id },
					name: `${model.name} (${p.name})`,
					reasoning: model.reasoning,
					thinkingLevels: [...getSupportedThinkingLevels(model)],
					input: [...model.input],
					contextWindow: model.contextWindow,
					maxOutputTokens: model.maxTokens,
					authenticated: true,
				}))
			);
	}
	async createRuntime(agentDir: string, selectedProvider: string): Promise<ModelRuntime> {
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			...(isOfficialProvider(selectedProvider) ? { credentials: this.credentials } : {}),
		});
		for (const provider of this.#providers) runtime.registerNativeProvider(provider);
		return runtime;
	}
	#serialize<T>(id: OfficialProvider, action: () => Promise<T>): Promise<T> {
		const result = (this.#operations.get(id) ?? Promise.resolve()).then(action);
		this.#operations.set(
			id,
			result.catch(() => {})
		);
		return result;
	}
	start(id: OfficialProvider, method: "browser" | "device_code" = "browser"): Promise<void> {
		return this.#serialize(id, async () => {
			await this.#cancel(id);
			const provider = this.#providers.find((p) => p.id === id);
			if (!provider?.auth.oauth) throw new Error("Official account login is unavailable");
			const controller = new AbortController();
			const login: Login = {
				public: { id: randomUUID(), status: "pending", expiresAt: Date.now() + this.timeoutMs },
				controller,
				done: Promise.resolve(),
			};
			this.#logins.set(id, login);
			const timer = setTimeout(() => {
				login.public.status = "error";
				login.public.error = "Authorization timed out. Please sign in again.";
				controller.abort();
			}, this.timeoutMs);
			timer.unref();
			login.done = Promise.resolve()
				.then(async () => {
					const credential = await provider.auth.oauth!.login({
						signal: controller.signal,
						prompt: (prompt) => this.#prompt(login, prompt, method),
						notify: (event) => {
							controller.signal.throwIfAborted();
							if (event.type === "auth_url" || event.type === "device_code") {
								const url = new URL(event.type === "auth_url" ? event.url : event.verificationUri);
								if (url.protocol !== "https:" || url.username || url.password || !HOSTS[id].includes(url.hostname))
									throw new Error("Unexpected authorization host");
								login.public.authorizeUrl = url.href;
								if (event.type === "device_code") login.public.userCode = event.userCode;
							}
						},
					});
					controller.signal.throwIfAborted();
					await this.credentials.modify(id, async () => credential, { signal: controller.signal });
					login.public.status = "complete";
				})
				.catch(() => {
					if (login.public.status === "pending") {
						login.public.status = "error";
						login.public.error =
							"Authorization failed. Check your network, account access and callback port, then sign in again.";
					}
				})
				.finally(() => {
					clearTimeout(timer);
					delete login.submit;
					delete login.public.manualCode;
					delete login.public.authorizeUrl;
					delete login.public.userCode;
				});
		});
	}
	#prompt(login: Login, prompt: AuthPrompt, method: string): Promise<string> {
		if (prompt.type === "select") return Promise.resolve(method);
		if (prompt.type !== "manual_code") return Promise.reject(new Error("Unsupported authorization prompt"));
		const signal = AbortSignal.any([login.controller.signal, ...(prompt.signal ? [prompt.signal] : [])]);
		if (signal.aborted) return Promise.reject(new Error("Authorization cancelled"));
		login.public.manualCode = true;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				signal.removeEventListener("abort", abort);
				delete login.submit;
				delete login.public.manualCode;
			};
			const abort = () => {
				cleanup();
				reject(new Error("Authorization cancelled"));
			};
			login.submit = (value) => {
				cleanup();
				resolve(value);
			};
			signal.addEventListener("abort", abort, { once: true });
		});
	}
	submit(id: OfficialProvider, loginId: string, code: string): void {
		const login = this.#logins.get(id);
		if (!login || login.public.id !== loginId || login.public.status !== "pending" || !login.submit)
			throw new Error("Authorization session is no longer waiting for a callback");
		// Manual redirects must carry the same state as the PKCE session, just like HTTP callbacks.
		let url: URL;
		try {
			url = new URL(code.trim());
		} catch {
			throw new Error("Paste the complete callback URL including code and state");
		}
		const expected = new URL(login.public.authorizeUrl!).searchParams.get("state");
		if (!expected || url.searchParams.get("state") !== expected || !url.searchParams.get("code"))
			throw new Error("Authorization callback state does not match");
		login.submit(url.href);
	}
	async #cancel(id: OfficialProvider): Promise<void> {
		const login = this.#logins.get(id);
		if (!login) return;
		if (login.public.status === "pending") login.public.status = "cancelled";
		login.controller.abort();
		await login.done;
	}
	cancel(id: OfficialProvider, loginId: string): Promise<void> {
		return this.#serialize(id, async () => {
			if (this.#logins.get(id)?.public.id !== loginId) throw new Error("Authorization session is no longer active");
			await this.#cancel(id);
		});
	}
	logout(id: OfficialProvider): Promise<void> {
		return this.#serialize(id, async () => {
			await this.#cancel(id);
			await this.credentials.delete(id);
			this.#logins.delete(id);
		});
	}
	async dispose(): Promise<void> {
		await Promise.all(IDS.map((id) => this.#serialize(id, () => this.#cancel(id))));
	}
}

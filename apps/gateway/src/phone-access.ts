import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative, extname, isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import type { GatewayPrincipal } from "./auth.js";
import { PhoneTunnel } from "./phone-tunnel.js";

const COOKIE = "__Host-wuming-phone";
const TTL = 30 * 24 * 60 * 60_000;
const secret = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(message: string, status = 400): never {
	throw Object.assign(new Error(message), { httpStatus: status });
}
export type PhoneDevice = {
	id: string;
	name: string;
	ownerId: string;
	workspaceIds: string[];
	workbench?: boolean;
	origin: string;
	tokenHash: string;
	createdAt: number;
	expiresAt: number;
};
type Pending = {
	id: string;
	name: string;
	claimHash: string;
	expiresAt: number;
	approved: boolean;
	workbench?: boolean;
};
export interface PhoneAccessOptions {
	storePath: string;
	webRoot: string;
	now?: () => number;
}
export interface PhoneAccessHandlers {
	http(request: IncomingMessage, response: ServerResponse, principal: GatewayPrincipal): Promise<void>;
	upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, principal: GatewayPrincipal): void;
	revoke(deviceId?: string): void;
}
const workbenchCommands = new Set([
	"session.create",
	"session.rename",
	"session.archive",
	"session.model.set",
	"session.thinking.set",
	"skill.list",
]);
export const phoneCommandAllowed = (type: string, workbench = false) =>
	(workbench && workbenchCommands.has(type)) ||
	new Set([
		"workspace.list",
		"model.list",
		"session.list",
		"session.attach",
		"session.detach",
		"session.snapshot.get",
		"turn.prompt",
		"turn.abort",
		"approval.respond",
		"session.run.list",
		"team.list",
		"team.get",
	]).has(type);

/** A separate listener establishes the trust boundary; no forwarded header grants local trust. */
export class PhoneAccess {
	#server: Server | undefined;
	#origin: string | undefined;
	#owner: GatewayPrincipal | undefined;
	#devices: PhoneDevice[] = [];
	#configuration: { mode: "proxy" | "cloudflare"; origin: string; port: number; executable: string } | undefined;
	#pending = new Map<string, Pending>();
	#pair: { hash: string; expiresAt: number } | undefined;
	#rates = new Map<string, { count: number; since: number }>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#tunnel = new PhoneTunnel();
	#now: () => number;
	#handlers: PhoneAccessHandlers | undefined;
	#controlQueue: Promise<unknown> = Promise.resolve();
	constructor(private readonly options: PhoneAccessOptions) {
		this.#now = options.now ?? Date.now;
		try {
			const value = JSON.parse(readFileSync(options.storePath, "utf8"));
			if (value.version !== 1 || !Array.isArray(value.devices) || value.devices.length > 32)
				throw new Error("Invalid phone device store");
			const c = value.configuration;
			if (
				c &&
				["proxy", "cloudflare"].includes(c.mode) &&
				typeof c.origin === "string" &&
				typeof c.executable === "string" &&
				Number.isInteger(c.port)
			)
				this.#configuration = c;
			this.#devices = value.devices.filter(
				(d: PhoneDevice) =>
					typeof d.id === "string" &&
					typeof d.ownerId === "string" &&
					typeof d.name === "string" &&
					Array.isArray(d.workspaceIds) &&
					d.workspaceIds.every((id) => typeof id === "string") &&
					typeof d.origin === "string" &&
					/^[a-f0-9]{64}$/.test(d.tokenHash) &&
					Number.isFinite(d.createdAt) &&
					Number.isFinite(d.expiresAt)
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	bind(handlers: PhoneAccessHandlers) {
		this.#handlers = handlers;
	}
	#persist(devices: PhoneDevice[]) {
		mkdirSync(dirname(this.options.storePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.options.storePath}.tmp`;
		writeFileSync(temporary, JSON.stringify({ version: 1, devices, configuration: this.#configuration }), {
			mode: 0o600,
		});
		renameSync(temporary, this.options.storePath);
		this.#devices = devices;
	}
	status() {
		const address = this.#server?.address();
		return {
			configuration: this.#configuration,
			enabled: Boolean(this.#server),
			port: address && typeof address !== "string" ? address.port : null,
			url: this.#origin ? `${this.#origin}/phone` : null,
			tunnel: {
				state: this.#tunnel.state,
				error: this.#tunnel.error,
				stage: this.#tunnel.stage,
				attempt: this.#tunnel.attempt,
				nextRetryAt: this.#tunnel.nextRetryAt,
			},
			pending: [...this.#pending.values()]
				.filter((p) => p.expiresAt > this.#now() && !p.approved)
				.map(({ id, name }) => ({ id, name })),
			devices: this.#devices
				.filter((d) => d.expiresAt > this.#now())
				.map(({ id, name, createdAt, expiresAt, origin, workbench }) => ({
					id,
					name,
					createdAt,
					expiresAt,
					origin,
					workbench: workbench === true,
				})),
		};
	}
	#rate(key: string, maximum: number) {
		const old = this.#rates.get(key);
		if (!old || this.#now() - old.since >= 60_000) {
			this.#rates.set(key, { count: 1, since: this.#now() });
			return;
		}
		if (++old.count > maximum) fail("请求过于频繁，请稍后重试", 429);
	}
	#setOrigin(value: string | undefined) {
		if (value !== this.#origin) {
			this.#handlers?.revoke();
			this.#pair = undefined;
			this.#pending.clear();
		}
		this.#origin = value;
	}
	control(action: string, input: Record<string, unknown>, principal: GatewayPrincipal): Promise<unknown> {
		const operation = this.#controlQueue.then(() => this.#control(action, input, principal));
		this.#controlQueue = operation.catch(() => undefined);
		return operation;
	}
	async #control(action: string, input: Record<string, unknown>, principal: GatewayPrincipal) {
		if (action === "status") return this.status();
		if (action === "disable") {
			await this.close();
			return this.status();
		}
		if (action === "revoke") {
			this.#persist(this.#devices.filter((d) => d.id !== input.id));
			this.#handlers?.revoke(String(input.id));
			return this.status();
		}
		if (action === "enable") {
			if (this.#server) fail("请先关闭手机访问再更改连接配置", 409);
			const port = input.port === undefined ? 0 : input.port;
			if (!Number.isInteger(port) || (port !== 0 && ((port as number) < 1024 || (port as number) > 65535)))
				fail("端口必须是 0 或 1024–65535");
			const mode = input.mode;
			if (mode !== "proxy" && mode !== "cloudflare") fail("请选择固定 HTTPS 入口或 Cloudflare 临时隧道");
			let origin: string | undefined;
			if (mode === "proxy") {
				const url = new URL(String(input.origin ?? ""));
				if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
					fail("请输入不带路径的 HTTPS 域名");
				origin = url.origin;
				if (port === 0) fail("固定反向代理需要指定本机端口");
			}
			// Verify built assets before opening a listener.
			readFileSync(join(this.options.webRoot, "index.html"));
			this.#owner = principal;
			const server = createServer((req, res) => {
				void this.#http(req, res);
			});
			server.requestTimeout = 15_000;
			server.headersTimeout = 10_000;
			server.on("upgrade", (req, socket, head) => {
				try {
					this.#checkOrigin(req, true);
					if (new URL(req.url ?? "/", "http://localhost").pathname !== "/api/ws") fail("Not found", 404);
					const identity = this.#authenticate(req);
					if (!identity) fail("Device pairing required", 401);
					this.#rate(`ws:${identity.remoteDeviceId}`, 60);
					this.#handlers!.upgrade(req, socket, head, identity);
				} catch {
					socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				}
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port as number, "127.0.0.1", () => {
					server.off("error", reject);
					resolve();
				});
			});
			this.#server = server;
			this.#setOrigin(origin);
			this.#timer = setInterval(() => {
				for (const d of this.#devices) if (d.expiresAt <= this.#now()) this.#handlers?.revoke(d.id);
				for (const [id, p] of this.#pending) if (p.expiresAt <= this.#now()) this.#pending.delete(id);
				for (const [key, r] of this.#rates) if (this.#now() - r.since > 60_000) this.#rates.delete(key);
			}, 5_000);
			this.#timer.unref();
			try {
				this.#configuration = {
					mode,
					origin: origin ?? "",
					port: port as number,
					executable: mode === "cloudflare" ? String(input.executable ?? "") : "",
				};
				this.#persist(this.#devices);
				if (mode === "cloudflare")
					this.#tunnel.start(String(input.executable ?? ""), this.status().port!, (url) => this.#setOrigin(url));
			} catch (error) {
				await this.close();
				throw error;
			}
			return this.status();
		}
		if (!this.#server || !this.#origin) fail("手机入口尚未就绪", 409);
		if (action === "pairing") {
			const value = secret();
			this.#pair = { hash: hash(value), expiresAt: this.#now() + 300_000 };
			return { url: `${this.#origin}/phone#pair=${value}`, expiresAt: this.#pair.expiresAt };
		}
		if (action === "approve" || action === "reject") {
			const p = this.#pending.get(String(input.id));
			if (!p || p.expiresAt <= this.#now()) fail("配对已过期", 404);
			if (action === "approve") {
				p.approved = true;
				p.workbench = input.workbench === true;
			} else this.#pending.delete(p.id);
			return this.status();
		}
		fail("Unknown action", 404);
	}
	checkMessage(id: string): void {
		this.#rate(`message:${id}`, 180);
	}
	isActive(id: string): boolean {
		return Boolean(
			this.#server && this.#devices.some((d) => d.id === id && d.expiresAt > this.#now() && d.origin === this.#origin)
		);
	}
	#authenticate(request: IncomingMessage): GatewayPrincipal | undefined {
		const token = request.headers.cookie
			?.split(";")
			.map((v) => v.trim())
			.find((v) => v.startsWith(`${COOKIE}=`))
			?.slice(COOKIE.length + 1);
		if (!token || token.length > 128 || !this.#owner) return;
		const d = this.#devices.find(
			(d) => d.tokenHash === hash(token) && d.ownerId === this.#owner!.id && this.isActive(d.id)
		);
		if (!d) return;
		return {
			id: this.#owner.id,
			role: "member",
			remoteDeviceId: d.id,
			phoneWorkbench: d.workbench === true,
			workspaces: this.#owner.workspaces.filter((w) => d.workspaceIds.includes(w.id)),
		};
	}
	#checkOrigin(req: IncomingMessage, required = false) {
		if (!this.#server || !this.#origin) fail("手机入口不可用", 503);
		if (req.headers.host !== new URL(this.#origin).host) fail("Host rejected", 403);
		if (
			(required && req.headers.origin !== this.#origin) ||
			(req.headers.origin && req.headers.origin !== this.#origin)
		)
			fail("Origin rejected", 403);
		if (["cross-site", "same-site"].includes(String(req.headers["sec-fetch-site"])))
			fail("Cross-site request rejected", 403);
	}
	async #body(req: IncomingMessage): Promise<Record<string, unknown>> {
		let body = "";
		for await (const chunk of req) {
			body += String(chunk);
			if (Buffer.byteLength(body) > 4096) fail("Request too large", 413);
		}
		const value: unknown = JSON.parse(body || "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid JSON");
		return value as Record<string, unknown>;
	}
	#json(res: ServerResponse, status: number, value: unknown) {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(value));
	}
	async #http(req: IncomingMessage, res: ServerResponse) {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
		);
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			// Public navigation is not an authenticated API operation. Allow links from other
			// sites to the inert shell; same-origin fetch then checks the Strict cookie.
			const shellNavigation =
				(req.method === "GET" || req.method === "HEAD") &&
				["/", "/phone"].includes(url.pathname) &&
				req.headers["sec-fetch-mode"] === "navigate" &&
				req.headers["sec-fetch-dest"] === "document";
			if (shellNavigation) {
				if (!this.#server || !this.#origin) fail("手机入口不可用", 503);
				if (req.headers.host !== new URL(this.#origin).host) fail("Host rejected", 403);
			} else this.#checkOrigin(req, req.method !== "GET" && req.method !== "HEAD");
			if (url.pathname.startsWith("/api/phone/")) {
				this.#rate("pairing", 180);
				if (url.pathname === "/api/phone/session" && req.method === "GET") {
					const principal = this.#authenticate(req);
					this.#json(res, 200, { authenticated: Boolean(principal), workbench: principal?.phoneWorkbench === true });
					return;
				}
				if (req.method !== "POST") fail("Method not allowed", 405);
				const input = await this.#body(req);
				if (url.pathname === "/api/phone/pair") {
					this.#rate("pair-attempt", 20);
					if (
						!this.#pair ||
						this.#pair.expiresAt <= this.#now() ||
						typeof input.secret !== "string" ||
						hash(input.secret) !== this.#pair.hash
					)
						fail("二维码已过期或已使用，请在电脑上重新生成", 401);
					if (this.#pending.size >= 8 || this.#devices.filter((d) => d.expiresAt > this.#now()).length >= 32)
						fail("设备或待处理请求数量已达上限", 429);
					const id = secret(),
						claim = secret();
					this.#pending.set(id, {
						id,
						claimHash: hash(claim),
						name:
							typeof input.name === "string" ? input.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80) : "手机浏览器",
						expiresAt: this.#pair.expiresAt,
						approved: false,
					});
					this.#pair = undefined;
					this.#json(res, 200, { id, claim });
					return;
				}
				if (url.pathname === "/api/phone/claim") {
					const p = this.#pending.get(String(input.id));
					if (!p || p.expiresAt <= this.#now() || typeof input.claim !== "string" || hash(input.claim) !== p.claimHash)
						fail("配对已过期或被拒绝", 401);
					if (!p.approved) {
						this.#json(res, 200, { approved: false });
						return;
					}
					const token = secret();
					this.#persist([
						...this.#devices.filter((d) => d.expiresAt > this.#now()),
						{
							id: p.id,
							name: p.name,
							workbench: p.workbench === true,
							ownerId: this.#owner!.id,
							workspaceIds: this.#owner!.workspaces.map((w) => w.id),
							origin: this.#origin!,
							tokenHash: hash(token),
							createdAt: this.#now(),
							expiresAt: this.#now() + TTL,
						},
					]);
					this.#pending.delete(p.id);
					res.setHeader(
						"Set-Cookie",
						`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL / 1000}`
					);
					this.#json(res, 200, { approved: true, workbench: p.workbench === true });
					return;
				}
				if (url.pathname === "/api/phone/logout") {
					const principal = this.#authenticate(req);
					if (principal) {
						this.#persist(this.#devices.filter((d) => d.id !== principal.remoteDeviceId));
						this.#handlers?.revoke(principal.remoteDeviceId);
					}
					res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
					this.#json(res, 200, {});
					return;
				}
				fail("Not found", 404);
			}
			if (url.pathname.startsWith("/api/")) {
				const principal = this.#authenticate(req);
				if (!principal) fail("请先配对设备", 401);
				this.#rate(`api:${principal.remoteDeviceId}`, 600);
				const download = req.method === "GET" && /^\/api\/artifacts\/[^/]+$/.test(url.pathname);
				const upload =
					principal.phoneWorkbench &&
					req.method === "POST" &&
					/^\/api\/workspaces\/[^/]+\/artifacts$/.test(url.pathname);
				if (!download && !upload) fail("此能力仅限电脑端", 403);
				if (upload) this.#rate(`upload:${principal.remoteDeviceId}`, 30);
				await this.#handlers!.http(req, res, principal);
				return;
			}
			if (req.method !== "GET" && req.method !== "HEAD") fail("Method not allowed", 405);
			const pathname = url.pathname;
			if (pathname === "/") {
				res.writeHead(302, { Location: "/phone" });
				res.end();
				return;
			}
			if (pathname !== "/" && pathname !== "/phone" && !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname))
				fail("Not found", 404);
			const root = realpathSync(this.options.webRoot);
			const file = realpathSync(
				pathname.startsWith("/assets/") ? resolve(root, `.${pathname}`) : join(root, "index.html")
			);
			const rel = relative(root, file);
			if (rel.startsWith("..") || isAbsolute(rel)) fail("Forbidden", 403);
			const content = readFileSync(file);
			if (extname(file) === ".html") {
				const hashes = [...content.toString().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
					.filter((m) => m[1]!.trim())
					.map((m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`);
				res.setHeader(
					"Content-Security-Policy",
					`default-src 'self'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`
				);
			}
			const mime: Record<string, string> = {
				".html": "text/html; charset=utf-8",
				".js": "text/javascript; charset=utf-8",
				".css": "text/css; charset=utf-8",
				".png": "image/png",
				".woff2": "font/woff2",
			};
			// Only content-hashed build resources are reusable; HTML, APIs and user files stay no-store.
			if (/^\/assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{8,}\.(?:js|css|png|woff2)$/.test(pathname))
				res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
			res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
			res.end(req.method === "HEAD" ? undefined : content);
		} catch (error) {
			if (!res.headersSent)
				this.#json(res, Number((error as { httpStatus?: number }).httpStatus) || 400, {
					error: error instanceof Error && "httpStatus" in error ? error.message : "请求失败，请检查入口配置",
				});
			else res.end();
		}
	}
	async close() {
		this.#tunnel.stop();
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#handlers?.revoke();
		this.#pair = undefined;
		this.#pending.clear();
		this.#rates.clear();
		this.#origin = undefined;
		this.#owner = undefined;
		const server = this.#server;
		this.#server = undefined;
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}
}

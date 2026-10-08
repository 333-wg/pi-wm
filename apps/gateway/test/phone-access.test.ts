import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { PhoneAccess, phoneCommandAllowed } from "../src/phone-access.js";
import type { GatewayPrincipal } from "../src/auth.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const principal: GatewayPrincipal = {
	id: "owner",
	workspaces: [{ id: "w1", name: "Project", status: "ready", createdAt: 1, updatedAt: 1 }],
};
export async function unusedPhonePort() {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
export async function phoneRequest(port: number, path: string, input?: unknown, headers: Record<string, string> = {}) {
	return new Promise<{ status: number; body: any; headers: import("node:http").IncomingHttpHeaders }>(
		(resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port,
					path,
					agent: false,
					method: input === undefined ? "GET" : "POST",
					headers: {
						Host: "phone.example.com",
						Origin: "https://phone.example.com",
						"Content-Type": "application/json",
						...headers,
					},
				},
				(res) => {
					let body = "";
					res.on("data", (chunk) => (body += chunk));
					res.on("end", () => {
						let parsed: unknown = body;
						try {
							parsed = JSON.parse(body);
						} catch {}
						resolve({ status: res.statusCode!, body: parsed, headers: res.headers });
					});
				}
			);
			req.on("error", reject);
			req.end(input === undefined ? undefined : JSON.stringify(input));
		}
	);
}
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "phone-access-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "index.html"), "<html><script>window.example=1</script><body>Phone shell</body></html>");
	let now = Date.now();
	const revoked: (string | undefined)[] = [];
	const options = { storePath: join(root, "devices.json"), webRoot: root, now: () => now };
	const phone = new PhoneAccess(options);
	phone.bind({
		http: async (_req, res, p) => {
			res.end(JSON.stringify(p));
		},
		upgrade: () => {},
		revoke: (id) => revoked.push(id),
	});
	cleanup.push(() => phone.close());
	const port = await unusedPhonePort();
	expect(phone.status().enabled).toBe(false);
	await phone.control("enable", { mode: "proxy", origin: "https://phone.example.com", port }, principal);
	async function pair() {
		const issued = (await phone.control("pairing", {}, principal)) as { url: string };
		const value = new URL(issued.url).hash.slice(6);
		const p = await phoneRequest(port, "/api/phone/pair", { secret: value, name: "My phone" });
		expect(p.status).toBe(200);
		return { ...p.body, secret: value };
	}
	async function approve(p: { id: string; claim: string }) {
		await phone.control("approve", { id: p.id }, principal);
		const claimed = await phoneRequest(port, "/api/phone/claim", p);
		expect(claimed.status).toBe(200);
		return claimed.headers["set-cookie"]![0]!.split(";")[0]!;
	}
	return { phone, root, options, port, pair, approve, revoked, advance: (ms: number) => (now += ms) };
}
describe("independent phone access", () => {
	it("requires one-use pairing and desktop approval, stores hashes, and revokes the individual device", async () => {
		const f = await fixture();
		expect((await phoneRequest(f.port, "/api/artifacts/one")).status).toBe(401);
		const p = await f.pair();
		expect((await phoneRequest(f.port, "/api/phone/pair", { secret: p.secret })).status).toBe(401);
		expect((await phoneRequest(f.port, "/api/phone/claim", p)).body.approved).toBe(false);
		const cookie = await f.approve(p);
		expect((await phoneRequest(f.port, "/api/phone/claim", p)).status).toBe(401);
		expect((await phoneRequest(f.port, "/api/phone/session", undefined, { Cookie: cookie })).body.authenticated).toBe(
			true
		);
		const read = await phoneRequest(f.port, "/api/artifacts/one", undefined, { Cookie: cookie });
		expect(read.body).toMatchObject({ id: "owner", role: "member", remoteDeviceId: p.id, workspaces: [{ id: "w1" }] });
		expect(read.body.phoneWorkbench).toBe(false);
		expect((await phoneRequest(f.port, "/api/workspaces/w1/artifacts", {}, { Cookie: cookie })).status).toBe(403);
		expect(phoneCommandAllowed("session.create", false)).toBe(false);
		expect(phoneCommandAllowed("session.create", true)).toBe(true);
		expect(phoneCommandAllowed("session.policy.set", true)).toBe(false);
		expect(readFileSync(f.options.storePath, "utf8")).not.toContain(cookie.split("=")[1]);
		expect(readFileSync(f.options.storePath, "utf8")).not.toContain(p.secret);
		await f.phone.control("revoke", { id: p.id }, principal);
		expect(f.revoked).toContain(p.id);
		expect((await phoneRequest(f.port, "/api/phone/session", undefined, { Cookie: cookie })).body.authenticated).toBe(
			false
		);
	});
	it("blocks spoofed origins, proxy headers, local management and unsafe business endpoints", async () => {
		const f = await fixture(),
			p = await f.pair(),
			cookie = await f.approve(p);
		for (const headers of [
			{ Origin: "https://evil.example" },
			{ Host: "evil.example" },
			{ "Sec-Fetch-Site": "cross-site" },
			{ Origin: "" },
		])
			expect((await phoneRequest(f.port, "/api/phone/logout", {}, { Cookie: cookie, ...headers })).status).toBe(403);
		for (const path of [
			"/api/projects/pick",
			"/api/phone-access/pairing",
			"/api/computer-use",
			"/api/workspaces/w1/file?path=secrets",
		])
			expect(
				(await phoneRequest(f.port, path, undefined, { Cookie: cookie, "X-Forwarded-For": "127.0.0.1" })).status
			).toBe(403);
		expect((await phoneRequest(f.port, "/phone")).headers["content-security-policy"]).toContain("'sha256-");
		expect((await phoneRequest(f.port, "/")).headers.location).toBe("/phone");
		expect((await phoneRequest(f.port, "/assets/../../devices.json")).status).toBe(404);
		expect(phoneCommandAllowed("turn.prompt")).toBe(true);
		for (const type of [
			"terminal.create",
			"session.configure",
			"model.custom.set",
			"mcp.trust",
			"computer.use",
			"session.create",
		])
			expect(phoneCommandAllowed(type)).toBe(false);
	});
	it("caches only hashed build assets, never entry HTML or authorization responses", async () => {
		const f = await fixture();
		mkdirSync(join(f.root, "assets"));
		writeFileSync(join(f.root, "assets", "phone-abcdefgh.js"), "export {};");
		writeFileSync(join(f.root, "assets", "plain.js"), "export {};");
		expect((await phoneRequest(f.port, "/assets/phone-abcdefgh.js")).headers["cache-control"]).toBe(
			"public, max-age=31536000, immutable"
		);
		for (const path of ["/phone", "/api/phone/session", "/assets/plain.js"])
			expect((await phoneRequest(f.port, path)).headers["cache-control"]).toBe("no-store");
	});
	it("allows cross-site document entry but keeps APIs and embedded entry protected", async () => {
		const f = await fixture();
		const navigation = {
			"Sec-Fetch-Site": "cross-site",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Dest": "document",
			Origin: "https://links.example",
		};
		expect((await phoneRequest(f.port, "/phone", undefined, navigation)).status).toBe(200);
		expect((await phoneRequest(f.port, "/", undefined, navigation)).status).toBe(302);
		expect((await phoneRequest(f.port, "/api/phone/session", undefined, navigation)).status).toBe(403);
		expect(
			(await phoneRequest(f.port, "/phone", undefined, { ...navigation, "Sec-Fetch-Dest": "iframe" })).status
		).toBe(403);
		expect((await phoneRequest(f.port, "/phone", undefined, { ...navigation, Host: "evil.example" })).status).toBe(403);
	});
	it("persists only explicit desktop workbench grants and routes uploads through workspace authorization", async () => {
		const f = await fixture(),
			p = await f.pair();
		await f.phone.control("approve", { id: p.id, workbench: true }, principal);
		const claim = await phoneRequest(f.port, "/api/phone/claim", p);
		const cookie = claim.headers["set-cookie"]![0]!.split(";")[0]!;
		expect(claim.body.workbench).toBe(true);
		expect(
			(await phoneRequest(f.port, "/api/workspaces/w1/artifacts", {}, { Cookie: cookie })).body.phoneWorkbench
		).toBe(true);
		const persisted = new PhoneAccess(f.options);
		expect(persisted.status().devices[0]?.workbench).toBe(true);
	});
	it("expires pairing and devices, retains authorization across normal restarts but never enables automatically", async () => {
		const f = await fixture(),
			expired = await f.pair();
		f.advance(300_001);
		expect((await phoneRequest(f.port, "/api/phone/claim", expired)).status).toBe(401);
		const p = await f.pair(),
			cookie = await f.approve(p);
		await f.phone.close();
		const restarted = new PhoneAccess(f.options);
		cleanup.push(() => restarted.close());
		restarted.bind({ http: async () => {}, upgrade: () => {}, revoke: () => {} });
		expect(restarted.status().enabled).toBe(false);
		await restarted.control("enable", { mode: "proxy", origin: "https://phone.example.com", port: f.port }, principal);
		expect((await phoneRequest(f.port, "/api/phone/session", undefined, { Cookie: cookie })).body.authenticated).toBe(
			true
		);
		f.advance(30 * 24 * 3600_000 + 1);
		expect((await phoneRequest(f.port, "/api/phone/session", undefined, { Cookie: cookie })).body.authenticated).toBe(
			false
		);
	});
	it("revokes while disabled, rejects invalid tunnel setup, and scopes grants to the original origin and workspaces", async () => {
		const f = await fixture(),
			p = await f.pair();
		await f.approve(p);
		await f.phone.close();
		await f.phone.control("revoke", { id: p.id }, principal);
		expect(f.phone.status().devices).toHaveLength(0);
		await expect(f.phone.control("enable", { mode: "cloudflare", executable: "cmd.exe" }, principal)).rejects.toThrow();
		expect(f.phone.status().enabled).toBe(false);
		await expect(
			f.phone.control("enable", { mode: "proxy", origin: "http://example.com", port: f.port }, principal)
		).rejects.toThrow("HTTPS");
	});
});

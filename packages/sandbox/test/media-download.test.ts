import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ http: vi.fn(), https: vi.fn() }));
vi.mock("node:http", () => ({ request: transport.http }));
vi.mock("node:https", () => ({ request: transport.https }));
import { SafeWebClient } from "../src/web.js";

afterEach(() => vi.resetAllMocks());

function respond(status = 200, headers: Record<string, string> = {}, body = "image") {
	return (_options: unknown, callback: (incoming: Readable) => void) => {
		const request = new EventEmitter();
		return Object.assign(request, {
			end: () => {
				callback(Object.assign(Readable.from([Buffer.from(body)]), { statusCode: status, headers }));
			},
		});
	};
}
const synthetic = async () => [{ address: "198.18.0.206", family: 4 }];
const publicAnswer = JSON.stringify({
	Status: 0,
	Answer: [
		{ type: 1, data: "8.8.8.8" },
		{ type: 28, data: "2606:4700:4700::1111" },
	],
});

describe("media downloads through synthetic proxy DNS", () => {
	it("resolves both families through authenticated DNS and pins real public IPs without changing the signed URL", async () => {
		transport.http.mockImplementation(respond());
		transport.https.mockImplementation(respond(200, {}, publicAnswer));
		const client = new SafeWebClient({ resolver: synthetic });
		expect(
			await client.download("http://cdn.example/image.png?signature=opaque", { maxBytes: 100, resolveProxyHttp: true })
		).toEqual(Buffer.from("image"));
		expect(transport.https).toHaveBeenCalledTimes(2);
		for (const [options] of transport.https.mock.calls) {
			expect(options).toMatchObject({
				protocol: "https:",
				hostname: "cloudflare-dns.com",
				headers: { accept: "application/dns-json" },
			});
			expect(options.path).toMatch(/^\/dns-query\?name=cdn.example&type=(1|28)$/);
			expect(options.path).not.toContain("signature");
			expect(options.rejectUnauthorized).not.toBe(false);
		}
		const options = transport.http.mock.calls[0]![0];
		expect(options).toMatchObject({ protocol: "http:", hostname: "cdn.example", path: "/image.png?signature=opaque" });
		expect(options.headers.authorization).toBeUndefined();
		const lookup = vi.fn();
		options.lookup("cdn.example", {}, lookup);
		expect(lookup).toHaveBeenCalledWith(null, "8.8.8.8", 4);
	});

	it("does not relax ordinary HTTP fetches or downloads", async () => {
		const client = new SafeWebClient({ resolver: synthetic });
		await expect(client.download("http://cdn.example/image", { maxBytes: 100 })).rejects.toMatchObject({
			code: "network_denied",
		});
		await expect(client.fetch("http://cdn.example/image")).rejects.toMatchObject({ code: "network_denied" });
		expect(transport.http).not.toHaveBeenCalled();
		expect(transport.https).not.toHaveBeenCalled();
	});

	it("leaves public HTTP and existing HTTPS downloads unchanged", async () => {
		transport.http.mockImplementation(respond());
		transport.https.mockImplementation(respond());
		const client = new SafeWebClient({ resolver: async () => [{ address: "8.8.8.8", family: 4 }] });
		await client.download("http://cdn.example/image", { maxBytes: 100, resolveProxyHttp: true });
		await new SafeWebClient({ resolver: synthetic }).download("https://cdn.example/image", {
			maxBytes: 100,
			resolveProxyHttp: true,
		});
		expect(transport.http).toHaveBeenCalledTimes(1);
		expect(transport.https).toHaveBeenCalledTimes(1);
		expect(transport.https.mock.calls[0]![0].hostname).toBe("cdn.example");
	});

	it("never recovers private, mixed-private or invalid destinations through public DNS", async () => {
		for (const addresses of [
			[{ address: "127.0.0.1", family: 4 }],
			[
				{ address: "198.18.0.206", family: 4 },
				{ address: "10.0.0.1", family: 4 },
			],
			[
				{ address: "198.18.0.206", family: 4 },
				{ address: "::1", family: 6 },
			],
			[],
		]) {
			const client = new SafeWebClient({ resolver: async () => addresses });
			await expect(
				client.download("http://cdn.example/image", { maxBytes: 100, resolveProxyHttp: true })
			).rejects.toMatchObject({ code: "network_denied" });
		}
		const client = new SafeWebClient({ resolver: synthetic });
		for (const url of [
			"http://198.18.0.206/image",
			"http://127.0.0.1/image",
			"http://cdn.example:8080/image",
			"file:///secret",
		])
			await expect(client.download(url, { maxBytes: 100, resolveProxyHttp: true })).rejects.toMatchObject({
				code: "network_denied",
			});
		expect(transport.http).not.toHaveBeenCalled();
		expect(transport.https).not.toHaveBeenCalled();
	});

	it("rejects private/reserved answers, including a private IPv6 answer alongside public IPv4", async () => {
		const client = new SafeWebClient({ resolver: synthetic });
		for (const address of ["127.0.0.1", "169.254.169.254", "198.18.0.1", "::1", "fc00::1", "invalid"]) {
			transport.https.mockImplementation(
				respond(
					200,
					{},
					JSON.stringify({
						Status: 0,
						Answer: [
							{ type: 1, data: "8.8.8.8" },
							{ type: address.includes(":") ? 28 : 1, data: address },
						],
					})
				)
			);
			await expect(
				client.download("http://cdn.example/image", { maxBytes: 100, resolveProxyHttp: true })
			).rejects.toMatchObject({ code: "network_denied" });
		}
		expect(transport.http).not.toHaveBeenCalled();
	});

	it("revalidates redirect destinations and bounds redirect loops and download sizes", async () => {
		transport.https.mockImplementation(respond(200, {}, publicAnswer));
		transport.http
			.mockImplementationOnce(respond(302, { location: "http://cdn.example/final" }))
			.mockImplementation(respond());
		const client = new SafeWebClient({ resolver: synthetic });
		await client.download("http://cdn.example/image", { maxBytes: 100, resolveProxyHttp: true });
		expect(transport.http.mock.calls.map(([options]) => options.path)).toEqual(["/image", "/final"]);
		transport.http.mockImplementationOnce(respond(302, { location: "http://169.254.169.254/secret" }));
		await expect(
			client.download("http://cdn.example/image", { maxBytes: 100, resolveProxyHttp: true })
		).rejects.toMatchObject({ code: "network_denied" });
		transport.http.mockImplementation(respond(302, { location: "http://cdn.example/image" }));
		await expect(
			client.download("http://cdn.example/image", { maxBytes: 100, resolveProxyHttp: true })
		).rejects.toThrow("redirects");
		transport.http.mockImplementation(respond());
		await expect(client.download("http://cdn.example/image", { maxBytes: 2, resolveProxyHttp: true })).rejects.toThrow(
			"size limit"
		);
	});

	it("fails closed if public DNS returns errors, malformed data, empty answers or cross-origin redirects", async () => {
		const client = new SafeWebClient({ resolver: synthetic });
		for (const body of [
			"invalid",
			"null",
			JSON.stringify({ Status: 2 }),
			JSON.stringify({ Status: 0 }),
			JSON.stringify({ Status: 0, Answer: {} }),
		]) {
			transport.https.mockImplementation(respond(200, {}, body));
			await expect(
				client.download("http://cdn.example/image", { maxBytes: 100, resolveProxyHttp: true })
			).rejects.toThrow();
		}
		transport.https.mockImplementation(respond(302, { location: "https://other.example/dns" }));
		await expect(
			client.download("http://cdn.example/image", { maxBytes: 100, resolveProxyHttp: true })
		).rejects.toMatchObject({ code: "network_denied" });
		expect(transport.http).not.toHaveBeenCalled();
	});

	it("does not connect to fake-IP HTTP when the DNS service fails TLS authentication", async () => {
		transport.https.mockImplementation(() => {
			const request = new EventEmitter();
			return Object.assign(request, { end: () => request.emit("error", new Error("certificate invalid")) });
		});
		const client = new SafeWebClient({ resolver: synthetic });
		await expect(
			client.download("http://cdn.example/image", { maxBytes: 100, resolveProxyHttp: true })
		).rejects.toThrow("certificate invalid");
		expect(transport.http).not.toHaveBeenCalled();
	});
});

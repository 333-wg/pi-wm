import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlaywrightBrowserManager, validateBrowserNavigationUrl } from "../src/browser.js";

describe("browser navigation policy", () => {
	it("allows loopback development servers on arbitrary ports", async () => {
		await expect(validateBrowserNavigationUrl("http://127.0.0.1:5173/app")).resolves.toMatchObject({
			hostname: "127.0.0.1",
			port: "5173",
		});
		await expect(validateBrowserNavigationUrl("http://localhost:8787/")).resolves.toMatchObject({
			hostname: "localhost",
			port: "8787",
		});
	});

	it("allows hostnames only when every DNS answer is public", async () => {
		await expect(
			validateBrowserNavigationUrl("https://example.com/page", async () => [{ address: "93.184.216.34", family: 4 }])
		).resolves.toMatchObject({ hostname: "example.com" });
		await expect(
			validateBrowserNavigationUrl("https://mixed.example/page", async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "10.0.0.2", family: 4 },
			])
		).rejects.toThrow(/did not resolve exclusively to public addresses/);
	});

	it("allows HTTPS hosts resolved through the deployment transparent proxy range", async () => {
		await expect(
			validateBrowserNavigationUrl("https://unpkg.com/three/build/three.min.js", async () => [
				{ address: "198.18.0.2", family: 4 },
			])
		).resolves.toMatchObject({ hostname: "unpkg.com" });
		await expect(
			validateBrowserNavigationUrl("http://unpkg.com/three/build/three.min.js", async () => [
				{ address: "198.18.0.2", family: 4 },
			])
		).rejects.toThrow(/did not resolve exclusively to public addresses/);
	});

	it("rejects private, credential-bearing, local-network, and non-web URLs", async () => {
		await expect(validateBrowserNavigationUrl("http://192.168.1.10:3000/")).rejects.toThrow(/Private and reserved/);
		await expect(validateBrowserNavigationUrl("http://printer.local/")).rejects.toThrow(/Local network/);
		await expect(validateBrowserNavigationUrl("https://user:password@example.com/")).rejects.toThrow(/credentials/);
		await expect(validateBrowserNavigationUrl("file:///etc/passwd")).rejects.toThrow(/HTTP and HTTPS/);
	});

	it("searches and downloads through the local browser context", async () => {
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://" + request.headers.host);
			if (url.pathname === "/search") {
				response.writeHead(200, { "content-type": "text/html" });
				response.end(
					'<html><body><li class="b_algo"><h2><a href="https://example.com/result">Result</a></h2><p>Snippet</p></li></body></html>'
				);
				return;
			}
			if (url.pathname === "/asset.txt") {
				response.writeHead(200, { "content-type": "application/javascript" });
				response.end("downloaded locally");
				return;
			}
			response.writeHead(404);
			response.end("not found");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not expose a port");
		const workspaceRoot = await mkdtemp(join(tmpdir(), "wuming-browser-"));
		const manager = new PlaywrightBrowserManager({
			headless: true,
			searchEndpoint: "http://127.0.0.1:" + address.port + "/search",
		});
		try {
			const browser = manager.session("browser-test");
			const search = await browser.search!("local query", { count: 3 });
			expect(search.items).toEqual([{ title: "Result", url: "https://example.com/result", snippet: "Snippet" }]);
			const download = await browser.download!(
				{ url: "http://127.0.0.1:" + address.port + "/asset.txt" },
				{ workspaceRoot }
			);
			expect(download.path).toBe("asset.txt");
			await expect(readFile(join(workspaceRoot, "asset.txt"), "utf8")).resolves.toBe("downloaded locally");
			await expect(
				browser.download!(
					{ url: "http://127.0.0.1:" + address.port + "/asset.txt", path: "../outside.txt" },
					{ workspaceRoot }
				)
			).rejects.toMatchObject({ code: "path_escape" });
		} finally {
			await manager[Symbol.asyncDispose]();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});
});

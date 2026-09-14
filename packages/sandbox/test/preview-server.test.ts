import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostPreviewServerManager, validatePreviewUrl } from "../src/preview-server.js";

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

describe("host preview server", () => {
	it("only accepts loopback readiness URLs", () => {
		expect(validatePreviewUrl("http://127.0.0.1:5173/").port).toBe("5173");
		expect(() => validatePreviewUrl("https://example.com/")).toThrow(/localhost/);
		expect(() => validatePreviewUrl("file:///tmp/page.html")).toThrow(/localhost/);
	});

	it("keeps a development server alive until the session stops it", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-preview-"));
		const port = await freePort();
		const manager = new HostPreviewServerManager({
			workspaceRoot: root,
			defaultReadyTimeoutMs: 10_000,
		});
		const preview = manager.session("session-1");
		const script = `console.log('preview-ready');require('node:http').createServer((_,r)=>r.end('ok')).listen(${port},'127.0.0.1')`;
		const command = `"${process.execPath}" -e "${script}"`;
		try {
			const started = await preview.start(command, { url: `http://127.0.0.1:${port}/` });
			expect(started).toMatchObject({ state: "running", url: `http://127.0.0.1:${port}/` });
			expect(await (await fetch(started.url!)).text()).toBe("ok");
			expect(await preview.status()).toMatchObject({
				state: "running",
				log: expect.stringContaining("preview-ready"),
			});
			expect(await preview.stop()).toMatchObject({ state: "stopped" });
			await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
		} finally {
			await manager[Symbol.asyncDispose]();
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);
});

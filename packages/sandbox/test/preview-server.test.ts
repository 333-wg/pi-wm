import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
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
	it("does not launch a command when an occupied address responds slowly", async () => {
		const server = createHttpServer((_, response) => {
			setTimeout(() => response.end("healthy but slow"), 800);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing port");
		const manager = new HostPreviewServerManager({ workspaceRoot: process.cwd() });
		try {
			await expect(
				manager.session("slow").start("echo must-not-run", { url: `http://127.0.0.1:${address.port}/` })
			).rejects.toThrow(/availability is unknown.*No command was started/);
			expect(await manager.session("slow").status()).toMatchObject({ state: "stopped" });
		} finally {
			await manager[Symbol.asyncDispose]();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("preserves a managed process when a reuse health probe times out", async () => {
		const port = await freePort();
		const manager = new HostPreviewServerManager({ workspaceRoot: process.cwd() });
		const preview = manager.session("slow-reuse");
		const url = `http://127.0.0.1:${port}/`;
		const script = `let n=0;require('node:http').createServer((q,r)=>setTimeout(()=>r.end('ok'),n++===0?0:800)).listen(${port},'127.0.0.1')`;
		const command = `"${process.execPath}" -e "${script}"`;
		try {
			const started = await preview.start(command, { url });
			await expect(preview.start(command, { url })).rejects.toThrow(/health is unknown/);
			expect(await preview.status()).toMatchObject({
				state: "running",
				pid: started.pid,
				startedAt: started.startedAt,
			});
		} finally {
			await manager[Symbol.asyncDispose]();
		}
	});

	it("holds a borrowed preview during active work and expires it after the last release", async () => {
		const port = await freePort();
		const manager = new HostPreviewServerManager({ workspaceRoot: process.cwd(), idleTimeoutMs: 400 });
		const url = `http://127.0.0.1:${port}/`;
		const script = `require('node:http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')`;
		try {
			await manager.session("owner").start(`"${process.execPath}" -e "${script}"`, { url });
			const borrower = manager.session("borrower");
			const releaseFirst = borrower.acquire!(url)!;
			const releaseSecond = manager.session("other").acquire!(url)!;
			releaseFirst();
			releaseFirst();
			await delay(650);
			expect(await (await fetch(url)).text()).toBe("ok");
			releaseSecond();
			await delay(650);
			expect(await borrower.status()).not.toHaveProperty("workspacePreviews");
			await vi.waitFor(
				async () => {
					const reachable = await fetch(url).then(
						async (response) => {
							await response.body?.cancel();
							return true;
						},
						() => false
					);
					expect(reachable).toBe(false);
				},
				{ timeout: 3000, interval: 50 }
			);
		} finally {
			await manager[Symbol.asyncDispose]();
		}
	});

	it("renews only the explicitly selected preview for an external browser", async () => {
		const port = await freePort();
		const manager = new HostPreviewServerManager({ workspaceRoot: process.cwd(), idleTimeoutMs: 600 });
		const url = `http://127.0.0.1:${port}/`;
		const script = `require('node:http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')`;
		try {
			await manager.session("owner").start(`"${process.execPath}" -e "${script}"`, { url });
			await delay(350);
			await manager.session("borrower").status({ url });
			await delay(350);
			expect(await (await fetch(url)).text()).toBe("ok");
		} finally {
			await manager[Symbol.asyncDispose]();
		}
	});

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
			const reused = await preview.start(command, { url: started.url! });
			expect(reused.pid).toBe(started.pid);
			expect(reused.startedAt).toBe(started.startedAt);
			const other = manager.session("session-2");
			expect(await other.status()).toMatchObject({
				state: "stopped",
				workspacePreviews: [{ ownerSessionId: "session-1", url: started.url, state: "running" }],
			});
			await expect(other.start(command, { url: started.url! })).rejects.toThrow(/workspace preview already uses/);
			await other.stop();
			expect(await (await fetch(started.url!)).text()).toBe("ok");
			expect(await preview.stop()).toMatchObject({ state: "stopped" });
			await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
		} finally {
			await manager[Symbol.asyncDispose]();
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("does not claim an unrelated existing service as its own preview", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-preview-"));
		const server = createHttpServer((_, response) => {
			response.writeHead(503);
			response.end("existing service");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing port");
		const url = `http://127.0.0.1:${address.port}/`;
		const manager = new HostPreviewServerManager({ workspaceRoot: root });
		try {
			await expect(manager.session("new").start("must-not-be-executed", { url })).rejects.toThrow(/already responds/);
			expect(await manager.session("new").status()).toMatchObject({ state: "stopped" });
			expect(await (await fetch(url)).text()).toBe("existing service");
		} finally {
			await manager[Symbol.asyncDispose]();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reports HTTP failures instead of marking an unhealthy preview ready", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-preview-"));
		const port = await freePort();
		const manager = new HostPreviewServerManager({ workspaceRoot: root });
		const url = `http://127.0.0.1:${port}/`;
		const script = `require('node:http').createServer((_,r)=>{r.writeHead(500);r.end('unhealthy')}).listen(${port},'127.0.0.1')`;
		try {
			await expect(
				manager.session("unhealthy").start(`"${process.execPath}" -e "${script}"`, { url, timeoutMs: 1500 })
			).rejects.toThrow(/last HTTP status: 500/);
			expect(await manager.session("unhealthy").status()).toMatchObject({ state: "stopped" });
			await expect(fetch(url)).rejects.toThrow();
		} finally {
			await manager[Symbol.asyncDispose]();
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);

	it("reserves a pending address so concurrent chats cannot start duplicate servers", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-preview-"));
		const port = await freePort();
		const manager = new HostPreviewServerManager({ workspaceRoot: root });
		const url = `http://127.0.0.1:${port}/`;
		const script = `setTimeout(()=>require('node:http').createServer((_,r)=>r.end('ok')).listen(${port},'127.0.0.1'),200)`;
		try {
			const results = await Promise.allSettled(
				["first", "second"].map((id) => manager.session(id).start(`"${process.execPath}" -e "${script}"`, { url }))
			);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		} finally {
			await manager[Symbol.asyncDispose]();
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);
});

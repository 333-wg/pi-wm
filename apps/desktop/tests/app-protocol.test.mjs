import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentSecurityPolicy, createAppProtocol, isAppUrl } from "../src/app-protocol.mjs";

test("application origin does not trust lookalikes, credentials or other schemes", () => {
	assert.equal(isAppUrl("wuming://app/assets/main.js"), true);
	for (const value of ["https://app/", "wuming://app.evil/", "wuming://user@app/", "wuming://app:80/", "file:///app"])
		assert.equal(isAppUrl(value), false);
	const policy = contentSecurityPolicy("<script>window.test = 1;</script>", "ws://127.0.0.1:1234/api/ws");
	assert.match(policy, /'sha256-/);
	assert.ok(!policy.includes("unsafe-eval"));
	assert.match(policy, /frame-src 'none'/);
});

test("serves only built assets and forwards authenticated API traffic without redirects", async () => {
	const root = await mkdtemp(join(tmpdir(), "wuming-protocol-"));
	try {
		const webRoot = join(root, "web");
		await mkdir(webRoot);
		await writeFile(join(webRoot, "index.html"), "<html><script>window.test = 1;</script></html>");
		await writeFile(join(root, "private.txt"), "private");
		let forwarded;
		const handler = await createAppProtocol({
			webRoot,
			connection: { token: "test-token", baseUrl: "http://127.0.0.1:1234", websocketUrl: "ws://127.0.0.1:1234/api/ws" },
			fetchGateway: async (...args) => {
				forwarded = args;
				return new Response("ok");
			},
		});
		assert.equal((await handler(new Request("wuming://app/"))).status, 200);
		assert.equal((await handler(new Request("wuming://evil/"))).status, 403);
		assert.equal((await handler(new Request("wuming://app/private.txt"))).status, 404);
		assert.equal((await handler(new Request("wuming://app/%2e%2e%5cprivate.txt"))).status, 403);
		assert.equal((await handler(new Request("wuming://app/", { method: "POST" }))).status, 405);
		await symlink(root, join(webRoot, "escape"), "junction");
		assert.equal((await handler(new Request("wuming://app/escape/private.txt"))).status, 403);
		await handler(
			new Request("wuming://app/api/projects?q=1", {
				method: "POST",
				body: "hello",
				headers: { authorization: "wrong", cookie: "private-cookie" },
			})
		);
		assert.equal(forwarded[0], "http://127.0.0.1:1234/api/projects?q=1");
		assert.equal(forwarded[1].headers.get("authorization"), "Bearer test-token");
		assert.equal(forwarded[1].headers.get("cookie"), null);
		assert.equal(forwarded[1].headers.get("origin"), "wuming://app");
		assert.equal(forwarded[1].redirect, "error");
		assert.equal(Buffer.from(forwarded[1].body).toString(), "hello");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

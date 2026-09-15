import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const APP_URL = "wuming://app/";
export function isAppUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "wuming:" && url.hostname === "app" && !url.port && !url.username && !url.password;
	} catch {
		return false;
	}
}

const types = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

export function contentSecurityPolicy(html, websocketUrl) {
	const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
		.filter((match) => match[1].trim())
		.map((match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
	return `default-src 'self'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ${websocketUrl}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'`;
}

export async function createAppProtocol({ webRoot, connection, fetchGateway = fetch }) {
	const root = await realpath(webRoot);
	const html = await readFile(resolve(root, "index.html"), "utf8");
	const csp = contentSecurityPolicy(html, connection.websocketUrl);
	return async (request) => {
		if (!isAppUrl(request.url)) return new Response("Forbidden", { status: 403 });
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/")) {
			const headers = new Headers(request.headers);
			headers.delete("host");
			headers.delete("connection");
			headers.delete("cookie");
			headers.set("origin", "wuming://app");
			headers.set("authorization", `Bearer ${connection.token}`);
			try {
				return await fetchGateway(`${connection.baseUrl}${url.pathname}${url.search}`, {
					method: request.method,
					headers,
					redirect: "error",
					signal: request.signal,
					...(["GET", "HEAD"].includes(request.method) ? {} : { body: await request.arrayBuffer() }),
				});
			} catch {
				return new Response("Local service unavailable", { status: 502 });
			}
		}
		if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
		try {
			const path = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
			if (path.includes("\0") || path.includes("\\")) return new Response("Forbidden", { status: 403 });
			const file = await realpath(resolve(root, `.${path}`));
			const rel = relative(root, file);
			if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
				return new Response("Forbidden", { status: 403 });
			return new Response(request.method === "HEAD" ? null : await readFile(file), {
				headers: {
					"content-type": types[extname(file)] ?? "application/octet-stream",
					"content-security-policy": csp,
					"x-content-type-options": "nosniff",
					"cache-control": "no-store",
				},
			});
		} catch {
			return new Response("Not found", { status: 404 });
		}
	};
}

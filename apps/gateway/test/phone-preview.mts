import { createServer as httpServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { generate } from "selfsigned";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, extname } from "node:path";
import { SessionOrchestrator, SqliteOrchestratorStore, type AgentRuntime } from "@wuming/orchestrator";
import { GatewayServer } from "../src/server.js";
import { StaticTokenAuth } from "../src/auth.js";
import type { SessionSnapshot, ToolCapability } from "@wuming/protocol";
import { ApprovalBroker } from "@wuming/sandbox";
import { ArtifactStore } from "@wuming/artifacts";

/** Local-only disposable fixture: no real models, tools, user profiles or public tunnel. */
export async function startPhonePreview(ports = { desktop: 0, https: 0 }) {
	const root = await mkdtemp(join(tmpdir(), "wuming-phone-preview-"));
	const store = new SqliteOrchestratorStore(":memory:");
	const artifacts = await ArtifactStore.open(":memory:", join(root, "artifacts"));
	const skill = {
		id: "phone-check",
		workspaceId: "phone-project",
		name: "手机验收技能",
		description: "仅用于隔离测试",
		path: "fixture",
		updatedAt: 1,
	};
	const runtime: AgentRuntime = {
		async executeTurn(input) {
			if (input.operation.payload.content.some((part) => part.type === "text" && part.text === "验证审批按钮")) {
				await approvals.authorize({
					sessionId: input.snapshot.session.id,
					toolCallId: crypto.randomUUID(),
					risk: "high",
					summary: "本地验收审批：不会执行真实工具",
					capabilities: [{ type: "process.exec", executable: "fixture-no-execution", args: [] }],
					signal: input.signal,
				});
			}
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 1500);
				input.signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					},
					{ once: true }
				);
			});
			const text = input.operation.payload.content.some((p) => p.type === "text" && p.text === "验证长对话阅读")
				? Array.from(
						{ length: 30 },
						(_, i) => `### 阅读段落 ${i + 1}\n\n这是隔离环境的长回复，用于检查滚动位置、输入区和移动阅读布局。`
					).join("\n\n")
				: input.operation.payload.content.some((p) => p.type === "text" && p.text.includes("Markdown"))
					? "## 验收结果\n\n**格式正常**\n\n```ts\nconst phone = true;\n```"
					: "手机与电脑共享同一会话。此回复来自本地演示运行时，没有调用真实模型或执行命令。";
			return {
				items: [
					{
						type: "assistant",
						id: crypto.randomUUID(),
						createdAt: Date.now(),
						status: "complete",
						content: [{ type: "text", text }],
						model: input.snapshot.model,
					},
				],
			};
		},
	};
	const orchestrator = new SessionOrchestrator(store, runtime);
	const approvals = new ApprovalBroker({ store });
	const approvalAbort = new AbortController();
	const workspace = {
		id: "phone-project",
		name: "手机访问验收项目",
		status: "ready" as const,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	const session = await orchestrator.createSession({
		principalId: "preview-owner",
		idempotencyKey: "preview-seed",
		workspaceId: workspace.id,
		name: "电脑与手机接续测试",
		model: { provider: "demo", id: "demo-model" },
		thinkingLevel: "off",
		sandboxMode: "workspace_write",
		approvalPolicy: "on_risk",
	});
	const webRoot = resolve("apps/web/dist");
	const token = "phone-preview-local-only";
	const gateway = new GatewayServer({
		store,
		orchestrator,
		approvals,
		artifacts,
		skills: {
			list: async () => [skill],
			get: async (_workspace, _path, id) => {
				if (id !== skill.id) throw new Error("No fixture skill");
				return { ...skill, content: "Only verify the fixture.", truncated: false };
			},
		},
		workspacePath: () => root,
		auth: new StaticTokenAuth(token, {
			id: "preview-owner",
			workspaces: [
				workspace,
				{ ...workspace, id: "phone-project-empty", name: "ai-image" },
				{ ...workspace, id: "phone-project-long", name: "测试 wuming-agent 的超长项目名称与手机端布局" },
			],
		}),
		phoneAccess: { storePath: join(root, "devices.json"), webRoot },
		models: [
			{
				model: { provider: "demo", id: "demo-alternate" },
				name: "备用演示",
				reasoning: false,
				input: ["text"],
				contextWindow: 32000,
				maxOutputTokens: 4096,
				authenticated: true,
			},
			{
				model: { provider: "demo", id: "demo-model" },
				name: "本地演示",
				reasoning: true,
				thinkingLevels: ["off", "low", "high"],
				input: ["text", "image"],
				contextWindow: 32000,
				maxOutputTokens: 4096,
				authenticated: true,
			},
		],
		executionEnvironment: {
			placement: "local_device",
			processMode: "disabled",
			terminalMode: "disabled",
			previewEnabled: false,
			platform: process.platform,
			shell: "disabled",
		},
	});
	const address = await gateway.listen();
	const gatewayUrl = `http://127.0.0.1:${address.port}`;
	let remotePort = 0;
	const certificate = await generate([{ name: "commonName", value: "localhost" }], {
		notAfterDate: new Date(Date.now() + 2 * 86400_000),
		keySize: 2048,
		extensions: [
			{
				name: "subjectAltName",
				altNames: [
					{ type: 2, value: "localhost" },
					{ type: 7, ip: "127.0.0.1" },
				],
			},
		],
	});
	const sockets = new Set<import("node:stream").Duplex>();
	const proxy = (
		req: import("node:http").IncomingMessage,
		res: import("node:http").ServerResponse,
		port: number,
		remote: boolean
	) => {
		const headers = {
			...req.headers,
			host: remote ? `localhost:${httpsPort}` : `127.0.0.1:${address.port}`,
			...(remote ? {} : { origin: `http://127.0.0.1:${address.port}` }),
		};
		const upstream = request(
			{ hostname: "127.0.0.1", port, path: req.url, method: req.method, headers },
			(response) => {
				res.writeHead(response.statusCode!, response.headers);
				response.pipe(res);
			}
		);
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.pipe(upstream);
	};
	const upgrade = (
		req: import("node:http").IncomingMessage,
		socket: import("node:stream").Duplex,
		head: Buffer,
		port: number,
		remote: boolean
	) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		const upstream = connect(port, "127.0.0.1", () => {
			const headers = {
				...req.headers,
				host: remote ? `localhost:${httpsPort}` : `127.0.0.1:${address.port}`,
				...(remote ? {} : { origin: `http://127.0.0.1:${address.port}` }),
			};
			upstream.write(
				`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers)
					.map(([k, v]) => `${k}: ${v}`)
					.join("\r\n")}\r\n\r\n`
			);
			if (head.length) upstream.write(head);
			socket.pipe(upstream).pipe(socket);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		socket.on("close", () => upstream.destroy());
	};
	const secure = httpsServer({ key: certificate.private, cert: certificate.cert }, (req, res) =>
		proxy(req, res, remotePort, true)
	);
	let httpsPort = 0;
	await new Promise<void>((resolve) => secure.listen(ports.https, "127.0.0.1", resolve));
	httpsPort = (secure.address() as { port: number }).port;
	secure.on("upgrade", (req, socket, head) => upgrade(req, socket, head, remotePort, true));
	const desktop = httpServer((req, res) => {
		if (req.url?.startsWith("/api/")) {
			proxy(req, res, address.port, false);
			return;
		}
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (path !== "/" && !/^\/assets\/[\w.-]+$/.test(path)) {
			res.writeHead(404);
			res.end();
			return;
		}
		void readFile(join(webRoot, path === "/" ? "index.html" : path))
			.then((content) => {
				res.setHeader(
					"Content-Type",
					({ ".js": "text/javascript", ".css": "text/css", ".png": "image/png" } as Record<string, string>)[
						extname(path)
					] ?? "text/html"
				);
				res.end(content);
			})
			.catch(() => {
				res.writeHead(404);
				res.end();
			});
	});
	desktop.on("upgrade", (req, socket, head) => upgrade(req, socket, head, address.port, false));
	await new Promise<void>((resolve) => desktop.listen(ports.desktop, "127.0.0.1", resolve));
	async function control(action: string, input?: unknown) {
		const response = await fetch(`${gatewayUrl}/api/phone-access/${action}`, {
			method: input === undefined ? "GET" : "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(input === undefined ? {} : { body: JSON.stringify(input) }),
		});
		const value = (await response.json()) as any;
		if (!response.ok) throw new Error(JSON.stringify(value));
		return value;
	}
	const reservation = httpServer();
	await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
	remotePort = (reservation.address() as { port: number }).port;
	await new Promise<void>((resolve) => reservation.close(() => resolve()));
	return {
		token,
		sessionId: session.snapshot.session.id,
		gatewayUrl,
		remotePort,
		phoneUrl: `https://localhost:${httpsPort}/phone`,
		origin: `https://localhost:${httpsPort}`,
		desktopUrl: `http://127.0.0.1:${(desktop.address() as { port: number }).port}`,
		control,
		snapshot: (): SessionSnapshot => store.loadSnapshot(session.snapshot.session.id)!,
		operations: (id: string) => store.listOperations(id, 20),
		authorize(capability: ToolCapability) {
			return approvals.authorize({
				sessionId: session.snapshot.session.id,
				toolCallId: crypto.randomUUID(),
				risk: "high",
				summary: "本地验收审批：不会执行真实工具",
				capabilities: [capability],
				signal: approvalAbort.signal,
			});
		},
		async close() {
			approvalAbort.abort();
			for (const socket of sockets) socket.destroy();
			await gateway.close();
			secure.closeAllConnections();
			desktop.closeAllConnections();
			await Promise.all([
				new Promise<void>((r) => secure.close(() => r())),
				new Promise<void>((r) => desktop.close(() => r())),
			]);
			store.close();
			artifacts.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}
if (process.argv.includes("--serve")) {
	const fixture = await startPhonePreview({ desktop: 5190, https: 5191 });
	console.log(
		`Phone desktop fixture: ${fixture.desktopUrl}; HTTPS: ${fixture.origin}; reverse proxy port: ${fixture.remotePort}`
	);
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			void fixture.close().then(() => process.exit());
		});
}

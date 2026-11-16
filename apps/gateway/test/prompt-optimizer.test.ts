import { afterEach, expect, it, vi } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { GatewayServer, type GatewayServerOptions } from "../src/server.js";
import { StaticTokenMapAuth } from "../src/auth.js";
import WebSocket from "ws";
import { bearerProtocol } from "../src/auth.js";
import type { ServerMessage, PromptOptimizeRequest } from "@wuming/protocol";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const workspace = { id: "w", name: "test", status: "ready" as const, createdAt: 1, updatedAt: 1 };
const input: PromptOptimizeRequest = {
	workspaceId: "w",
	text: "先分析，不改代码",
	model: { provider: "custom-service", id: "chosen" },
	thinkingLevel: "high",
};
async function setup(
	optimizePrompt: NonNullable<GatewayServerOptions["optimizePrompt"]> = vi.fn(
		async (_input: PromptOptimizeRequest, _signal: AbortSignal) => ({ text: "更清晰的提示词" })
	)
) {
	const store = new SqliteOrchestratorStore(":memory:");
	cleanup.push(() => store.close());
	const executeTurn = vi.fn();
	const server = new GatewayServer({
		store,
		orchestrator: new SessionOrchestrator(store, { executeTurn }),
		auth: new StaticTokenMapAuth([
			{ token: "owner", principal: { id: "owner", role: "owner", workspaces: [workspace] } },
			{ token: "viewer", principal: { id: "viewer", role: "viewer", workspaces: [workspace] } },
			{ token: "outsider", principal: { id: "outsider", workspaces: [] } },
		]),
		models: [
			{
				model: input.model,
				name: "chosen",
				reasoning: true,
				input: ["text"],
				contextWindow: 100000,
				maxOutputTokens: 8192,
				authenticated: true,
			},
		],
		optimizePrompt,
	});
	const address = await server.listen();
	cleanup.push(() => server.close());
	const url = `http://127.0.0.1:${address.port}/api/prompt/optimize`;
	const post = (body: unknown = input, token = "owner", signal?: AbortSignal) =>
		fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			...(signal ? { signal } : {}),
		});
	return { post, optimizePrompt, executeTurn, store, url };
}
it("optimizes without starting an agent turn and preserves exact model selection", async () => {
	const { post, optimizePrompt, executeTurn } = await setup();
	const response = await post();
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ text: "更清晰的提示词" });
	expect(optimizePrompt).toHaveBeenCalledWith(input, expect.any(AbortSignal), expect.any(Function));
	expect(executeTurn).not.toHaveBeenCalled();
});
it("requires authentication, write permission and workspace access", async () => {
	const { post, optimizePrompt } = await setup();
	for (const [token, status] of [
		["bad", 401],
		["viewer", 403],
		["outsider", 403],
	] as const)
		expect((await post(input, token)).status).toBe(status);
	expect(optimizePrompt).not.toHaveBeenCalled();
});
it("rejects empty/oversized/command drafts, unknown models and extra properties", async () => {
	const { post, optimizePrompt } = await setup();
	for (const body of [
		{ ...input, text: " " },
		{ ...input, text: "x".repeat(16001) },
		{ ...input, text: "/team task" },
		{ ...input, model: { provider: "other", id: "chosen" } },
		{ ...input, tools: [] },
	])
		expect((await post(body)).status).toBe(400);
	expect(optimizePrompt).not.toHaveBeenCalled();
});
it("blocks duplicate requests and propagates disconnect cancellation", async () => {
	const optimizePrompt = vi.fn(
		(_input: PromptOptimizeRequest, signal: AbortSignal) =>
			new Promise<{ text: string }>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
			)
	);
	const { post } = await setup(optimizePrompt);
	const controller = new AbortController();
	const pending = post(input, "owner", controller.signal).catch(() => undefined);
	await vi.waitFor(() => expect(optimizePrompt).toHaveBeenCalledOnce());
	expect((await post()).status).toBe(409);
	controller.abort();
	await pending;
	await vi.waitFor(() => expect(optimizePrompt.mock.calls[0]![1].aborted).toBe(true));
});

const usage = {
	inputTokens: 10,
	outputTokens: 5,
	cacheReadTokens: 2,
	cacheWriteTokens: 1,
	totalTokens: 18,
	costUsd: 0.01,
};
it.each([true, false])(
	"records auxiliary usage exactly once, including invalid rewrites (valid: %s)",
	async (valid) => {
		const { post, store, executeTurn } = await setup(async (_input, _signal, onUsage) => {
			onUsage?.(usage);
			onUsage?.(usage);
			if (!valid) throw Object.assign(new Error("private upstream response"), { promptOptimizeCode: "invalid_output" });
			return { text: "改写" };
		});
		store.usageOverview("w", Date.now()); // Prime the cache before the write.
		const response = await post();
		expect(response.status).toBe(valid ? 200 : 502);
		if (!valid)
			expect(await response.json()).toEqual({ error: "提示词优化未完成，原文已保留", code: "invalid_output" });
		expect(store.usageOverview("w", Date.now())).toMatchObject({
			total: usage,
			totalTurnCount: 0,
			totalRequestCount: 1,
			auxiliary: { usage, requestCount: 1 },
		});
		expect(store.usageOverview([], Date.now()).total.totalTokens).toBe(0);
		expect(executeTurn).not.toHaveBeenCalled();
	}
);

it("invalidates only authorized clients and keeps workspace totals isolated", async () => {
	const { post, url } = await setup(async (_input, _signal, onUsage) => {
		onUsage?.(usage);
		return { text: "改写" };
	});
	const clients = await Promise.all(
		["owner", "viewer", "outsider"].map(async (token) => {
			const ws = new WebSocket(url.replace("http:", "ws:").replace("/api/prompt/optimize", "/api/ws"), [
				"wuming.v1",
				bearerProtocol(token),
			]);
			const messages: ServerMessage[] = [];
			ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
			cleanup.push(() => {
				ws.terminate();
			});
			await new Promise<void>((resolve, reject) => {
				ws.once("open", resolve);
				ws.once("error", reject);
			});
			ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: token, capabilities: [] }));
			await vi.waitFor(() => expect(messages.some((m) => m.type === "hello")).toBe(true));
			return { ws, messages, token };
		})
	);
	await post();
	for (const { ws, messages, token } of clients) {
		ws.send(
			JSON.stringify({
				type: "request",
				requestId: "usage",
				idempotencyKey: "usage",
				command: { type: "usage.overview", days: 7 },
			})
		);
		await vi.waitFor(() => expect(messages.some((m) => m.type === "response" && m.requestId === "usage")).toBe(true));
		const response = messages.find((m) => m.type === "response" && m.requestId === "usage");
		expect(response).toMatchObject({
			ok: true,
			result: { type: "usage.overview", overview: { total: { totalTokens: token === "outsider" ? 0 : 18 } } },
		});
		expect(messages.filter((m) => m.type === "usage.invalidated")).toHaveLength(token === "outsider" ? 0 : 1);
	}
});

it("does not expose upstream credentials in errors", async () => {
	const { post } = await setup(async () => {
		throw new Error("provider rejected secret-key at https://private.example");
	});
	const response = await post();
	expect(response.status).toBe(502);
	expect(await response.json()).toEqual({ error: "提示词优化未完成，原文已保留", code: "provider_failed" });
});

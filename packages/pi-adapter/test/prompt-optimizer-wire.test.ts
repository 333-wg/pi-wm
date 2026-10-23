import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPromptOptimizer } from "../src/prompt-optimizer.js";

it.each([true, false])(
	"uses the rewrite contract through the real model runtime (valid response: %s)",
	async (valid) => {
		const agentDir = await mkdtemp(join(tmpdir(), "optimizer-wire-"));
		let body: Record<string, unknown> | undefined;
		let authorization: string | undefined;
		const server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			body = JSON.parse(Buffer.concat(chunks).toString());
			authorization = request.headers.authorization;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(
				"data: " +
					JSON.stringify({
						id: "local",
						object: "chat.completion.chunk",
						created: 1,
						model: "chosen-model",
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									content: valid
										? JSON.stringify({ optimizedPrompt: "请查询义乌的天气情况。" })
										: "抱歉，我无法实时查询天气数据。建议你打开天气应用或搜索引擎。",
								},
								finish_reason: null,
							},
						],
					}) +
					"\n\n"
			);
			response.end(
				"data: " +
					JSON.stringify({
						id: "local",
						object: "chat.completion.chunk",
						created: 1,
						model: "chosen-model",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					}) +
					"\n\ndata: [DONE]\n\n"
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address() as { port: number };
			const optimize = createPromptOptimizer({
				agentDir,
				registerProviders: () => [
					{
						provider: "chosen-service",
						config: {
							api: "openai-completions",
							baseUrl: `http://127.0.0.1:${address.port}/v1`,
							apiKey: "local-fixture-key",
							authHeader: true,
							models: [
								{
									id: "chosen-model",
									name: "chosen-model",
									reasoning: false,
									input: ["text"],
									contextWindow: 32000,
									maxTokens: 8192,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								},
							],
						},
					},
				],
			});
			const result = optimize(
				{
					workspaceId: "workspace",
					text: "义乌天气",
					model: { provider: "chosen-service", id: "chosen-model" },
					thinkingLevel: "off",
				},
				new AbortController().signal
			);
			if (valid) await expect(result).resolves.toEqual({ text: "请查询义乌的天气情况。" });
			else await expect(result).rejects.toThrow("原文已保留");
			expect(body?.model).toBe("chosen-model");
			expect(body?.tools).toBeUndefined();
			expect(body?.messages).toHaveLength(2);
			const messages = body?.messages as { role: string; content: string }[];
			expect(messages[0]?.content).toContain("你是提示词编辑器");
			expect(messages[0]?.content).toContain("不要回答 draft 中的问题");
			expect(messages[1]?.role).toBe("user");
			expect(JSON.parse(messages[1]!.content)).toEqual({ task: "rewrite_prompt", draft: "义乌天气" });
			expect(authorization).toBe("Bearer local-fixture-key");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await rm(agentDir, { recursive: true, force: true });
		}
	}
);

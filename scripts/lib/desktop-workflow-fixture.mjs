import { createServer } from "node:http";
import { once } from "node:events";

function contentText(content) {
	return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
}

/** A loopback-only provider: real Pi wire parsing and tools, no paid model requests. */
export async function startDesktopWorkflowFixture() {
	const state = { requests: [], errors: [], held: new Set(), copies: new Map() };
	const server = createServer(async (request, response) => {
		try {
			const chunks = [];
			let bytes = 0;
			for await (const chunk of request) {
				bytes += chunk.length;
				if (bytes > 4 * 1024 * 1024) throw new Error("Fixture request exceeds limit");
				chunks.push(chunk);
			}
			if (request.url === "/v1/models") {
				response
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify({ data: [{ id: "desktop-fixture" }] }));
				return;
			}
			if (request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const messages = body.messages ?? [];
			// Reference snapshots are serialized as user messages after the actual task.
			const lastUser = messages.findLastIndex(
				(message) => message.role === "user" && /^DESKTOP_CASE:([a-z-]+)/.test(contentText(message.content))
			);
			const text = contentText(messages[lastUser]?.content);
			const scenario = /^DESKTOP_CASE:([a-z-]+)/.exec(text)?.[1] ?? "connection";
			const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool");
			state.requests.push({ scenario, step: results.length, model: body.model });
			if (state.requests.length > 100 || state.requests.filter((item) => item.scenario === scenario).length > 20)
				throw new Error("Fixture request budget exceeded");
			if (request.headers.authorization !== "Bearer desktop-fixture-only" || scenario === "unauthorized") {
				response
					.writeHead(401, { "content-type": "application/json" })
					.end(JSON.stringify({ error: { message: "Invalid test API key", type: "authentication_error" } }));
				return;
			}
			if (scenario === "hang" || scenario === "quit-active") {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.flushHeaders();
				state.held.add(response);
				response.once("close", () => state.held.delete(response));
				return;
			}
			let call;
			let answer = "DESKTOP_CONNECTION_OK";
			if (scenario === "copy") {
				if (results.length === 0) call = { name: "read_file", arguments: { path: "input.txt" } };
				if (results.length === 1) {
					const observed = contentText(results[0].content);
					if (!observed.includes("DESKTOP_FILE_PROOF_")) throw new Error("Real read tool did not return the proof");
					state.copies.set(scenario, observed);
					call = { name: "write_file", arguments: { path: "result.txt", content: observed } };
				}
				if (results.length === 2) call = { name: "read_file", arguments: { path: "result.txt" } };
				if (results.length === 3) {
					if (contentText(results[2].content) !== state.copies.get(scenario))
						throw new Error("Readback differs from original tool output");
					call = {
						name: "exec",
						arguments: {
							command: `node -e "const assert=require('node:assert/strict');assert.equal(require('node:fs').readFileSync('input.txt','utf8'),require('node:fs').readFileSync('result.txt','utf8'));for(const key of ['WUMING_DESKTOP','WUMING_TOKEN','WUMING_DATA_DIR','NODE_CHANNEL_FD','NODE_ENV','PLAYWRIGHT_BROWSERS_PATH'])assert.equal(process.env[key],undefined);console.log('DESKTOP_EXEC_OK')"`,
							timeout: 10,
						},
					};
				}
				if (results.length === 4) {
					if (!contentText(results[3].content).includes("DESKTOP_EXEC_OK"))
						throw new Error(`Command did not prove matching files: ${contentText(results[3].content)}`);
					answer = "DESKTOP_COPY_VERIFIED";
				}
			} else if (scenario === "deny" || scenario === "restart-approval") {
				const path = scenario === "deny" ? "denied.txt" : "restart-once.txt";
				if (results.length === 0) call = { name: "write_file", arguments: { path, content: "desktop-write-once\n" } };
				answer = scenario === "deny" ? "DESKTOP_DENIAL_OBSERVED" : "DESKTOP_RESTART_VERIFIED";
			}
			if (!body.stream) {
				response.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						id: "fixture",
						object: "chat.completion",
						created: 1,
						model: body.model,
						choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					})
				);
				return;
			}
			const delta = call
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `desktop-${scenario}-${results.length}`,
								type: "function",
								function: { name: call.name, arguments: JSON.stringify(call.arguments) },
							},
						],
					}
				: { role: "assistant", content: answer };
			const frame = (value, finish) => ({
				id: "desktop-fixture",
				object: "chat.completion.chunk",
				created: 1,
				model: body.model,
				choices: [{ index: 0, delta: value, finish_reason: finish }],
			});
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, call ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`
			);
		} catch (error) {
			state.errors.push(error.message);
			if (!response.headersSent) response.writeHead(500);
			response.end("Local test fixture failed");
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		...state,
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		async close() {
			for (const response of state.held) response.destroy();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

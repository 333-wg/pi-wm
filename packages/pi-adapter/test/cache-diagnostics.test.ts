import { describe, expect, it } from "vitest";
import { PromptCacheObserver } from "../src/cache-diagnostics.js";

const model = { api: "openai-completions", provider: "test", id: "model", baseUrl: "https://private.example" };
const user = { role: "user", content: "private input" };
const payload = () => ({
	model: "model",
	messages: [{ role: "system", content: "private policy" }, user],
	tools: [{ type: "function", function: { name: "read", parameters: {} } }],
	prompt_cache_key: "private-session",
	stream: true,
});

describe("provider payload cache diagnostics", () => {
	it("tracks append-only history, request intervals and rewrites without storing bodies", () => {
		const observer = new PromptCacheObserver();
		observer.observe(payload(), model, 100);
		expect(observer.diagnostic).toMatchObject({
			change: "first_observation",
			messageCount: 1,
			sharedPrefixMessages: 0,
		});
		expect(observer.diagnostic?.intervalMs).toBeUndefined();
		const next = payload();
		next.messages.push({ role: "assistant", content: "done" }, { role: "user", content: "next" });
		observer.observe(next, model, 500);
		expect(observer.diagnostic).toMatchObject({
			change: "append_only",
			messageCount: 3,
			sharedPrefixMessages: 1,
			previousMessageCount: 1,
			intervalMs: 400,
		});
		observer.observe(next, model, 600);
		expect(observer.diagnostic?.change).toBe("unchanged");
		next.messages[1] = { role: "user", content: "compacted" };
		observer.observe(next, model, 700);
		expect(observer.diagnostic?.change).toBe("history_changed");
		const serialized = JSON.stringify(observer.diagnostic);
		for (const secret of ["private", "compacted", "done", "read"]) expect(serialized).not.toContain(secret);
		observer.beginRequest();
		expect(observer.diagnostic).toBeUndefined();
		observer.observe(next, model, 800);
		expect(observer.diagnostic?.change).toBe("unchanged");
	});

	it.each(["model_changed", "tools_changed", "system_changed", "parameters_changed", "history_changed"] as const)(
		"identifies %s",
		(change) => {
			const observer = new PromptCacheObserver();
			observer.observe(payload(), model);
			const next = payload();
			const nextModel = { ...model };
			if (change === "model_changed") nextModel.baseUrl += "/other";
			if (change === "tools_changed") next.tools[0]!.function.name = "write";
			if (change === "system_changed") next.messages[0]!.content = "new policy";
			if (change === "parameters_changed") next.prompt_cache_key = "new-session";
			if (change === "history_changed") next.messages.pop();
			observer.observe(next, nextModel);
			expect(observer.diagnostic?.change).toBe(change);
		}
	);

	it("ignores moving Anthropic cache markers but not similarly named tool arguments", () => {
		const observer = new PromptCacheObserver();
		const anthropic = { ...model, api: "anthropic-messages" };
		const marker = { type: "ephemeral" };
		const first = {
			system: [{ type: "text", text: "policy", cache_control: marker }],
			tools: [{ name: "inspect", cache_control: marker }],
			messages: [{ role: "user", content: [{ type: "text", text: "input", cache_control: marker }] }],
		};
		observer.observe(first, anthropic);
		const next = {
			system: [{ type: "text", text: "policy" }],
			tools: [{ name: "inspect" }],
			messages: [{ role: "user", content: [{ type: "text", text: "input" }] }],
		};
		observer.observe(next, anthropic);
		expect(observer.diagnostic?.change).toBe("unchanged");
		const withTool = (value: string) => ({
			...next,
			messages: [{ role: "assistant", content: [{ type: "tool_use", input: { cache_control: value } }] }],
		});
		observer.observe(withTool("a"), anthropic);
		observer.observe(withTool("b"), anthropic);
		expect(observer.diagnostic?.change).toBe("history_changed");
	});

	it("compares Responses instructions and handles unsupported payloads without inventing observations", () => {
		const observer = new PromptCacheObserver();
		const responses = { ...model, api: "openai-responses" };
		observer.observe({ instructions: "one", input: [user] }, responses);
		observer.observe({ instructions: "two", input: [user] }, responses);
		expect(observer.diagnostic?.change).toBe("system_changed");
		observer.beginRequest();
		observer.observe({ input: "not an array" }, responses);
		expect(observer.diagnostic).toBeUndefined();
		observer.observe(payload(), { ...model, api: "unsupported" });
		expect(observer.diagnostic).toBeUndefined();
	});
});

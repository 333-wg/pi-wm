import type { McpServerConfiguration } from "@wuming/protocol";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是 JSON 对象");
	return value as Record<string, unknown>;
}

export function importMcpConfigurations(text: string): McpServerConfiguration[] {
	if (new TextEncoder().encode(text).length > 100 * 1024) throw new Error("配置不能超过 100 KB");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("JSON 格式不正确");
	}
	const root = record(parsed);
	const map = root.mcpServers ?? root.mcp_servers;
	const entries = Array.isArray(root.servers)
		? root.servers
		: map
			? Object.entries(record(map)).map(([id, value]) => ({ ...record(value), id }))
			: [root];
	if (!entries.length || entries.length > 32) throw new Error("配置需包含 1 至 32 个服务");
	const ids = new Set<string>();
	return entries.map((entry) => {
		const value = { ...record(entry) };
		if (typeof value.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.id))
			throw new Error("服务 ID 需以字母或数字开头，且只能包含字母、数字、点、下划线和短横线");
		if (ids.has(value.id)) throw new Error("服务 ID 重复");
		ids.add(value.id);
		const aliases = {
			type: "transport",
			endpoint: "url",
			http_headers: "headers",
			enabled_tools: "enabledTools",
			disabled_tools: "disabledTools",
			startup_timeout_ms: "startupTimeoutMs",
			request_timeout_ms: "requestTimeoutMs",
			toolCallTimeoutMs: "requestTimeoutMs",
			tool_call_timeout_ms: "requestTimeoutMs",
		};
		for (const [alias, canonical] of Object.entries(aliases)) {
			if (value[canonical] === undefined && value[alias] !== undefined) value[canonical] = value[alias];
			delete value[alias];
		}
		for (const [alias, canonical] of [
			["startup_timeout_sec", "startupTimeoutMs"],
			["tool_timeout_sec", "requestTimeoutMs"],
		] as const) {
			if (value[canonical] === undefined && typeof value[alias] === "number") value[canonical] = value[alias] * 1000;
			delete value[alias];
		}
		value.transport ??= value.url ? "streamable-http" : "stdio";
		if (value.transport === "http") value.transport = "streamable-http";
		if (!["stdio", "streamable-http", "sse"].includes(String(value.transport))) throw new Error("不支持的传输方式");
		if (value.transport === "stdio" && (typeof value.command !== "string" || !value.command.trim()))
			throw new Error("启动命令不能为空");
		if (value.transport !== "stdio" && (typeof value.url !== "string" || !value.url.trim()))
			throw new Error("服务地址不能为空");
		if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string")))
			throw new Error("启动参数必须是 JSON 字符串数组");
		for (const field of ["env", "headers"]) {
			if (
				value[field] !== undefined &&
				!Object.values(record(value[field])).every((item) => typeof item === "string" || item === null)
			)
				throw new Error("环境变量和请求头的值必须是字符串");
		}
		return value as McpServerConfiguration;
	});
}

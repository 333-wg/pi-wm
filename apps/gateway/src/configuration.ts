import type { ModelMetadata } from "@wuming/protocol";
import type { WebSearchConfiguration } from "@wuming/sandbox";
import { isAbsolute, resolve } from "node:path";

export interface WorkspaceConfiguration {
	id: string;
	name: string;
	path: string;
}

type WorkspaceEnvironment = Partial<Record<"WUMING_WORKSPACES_JSON" | "WUMING_WORKSPACE_NAME", string>>;
type ModelEnvironment = Partial<Record<"WUMING_MODELS_JSON", string>>;
type McpTrustEnvironment = Partial<Record<"WUMING_MCP_TRUSTED_SERVERS_JSON", string>>;
type WebSearchEnvironment = Partial<Record<
	"WUMING_WEB_SEARCH_PROVIDER" | "WUMING_WEB_SEARCH_API_KEY" | "WUMING_WEB_SEARCH_ENDPOINT",
	string
>>;

function configuredArray(name: string, raw: string | undefined): unknown[] | undefined {
	if (raw === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`${name} must contain valid JSON`);
	}
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty JSON array`);
	return value;
}

function resolvePath(value: string): string {
	return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

export function configuredWorkspaces(
	fallbackPath: string,
	environment: WorkspaceEnvironment = process.env,
): WorkspaceConfiguration[] {
	const configured = configuredArray("WUMING_WORKSPACES_JSON", environment.WUMING_WORKSPACES_JSON);
	if (!configured) {
		return [{
			id: "local-workspace",
			name: environment.WUMING_WORKSPACE_NAME ?? "Local workspace",
			path: fallbackPath,
		}];
	}
	const workspaces = configured.map((value, index) => {
		if (!value || typeof value !== "object") throw new Error(`WUMING_WORKSPACES_JSON[${index}] must be an object`);
		const record = value as Record<string, unknown>;
		if (typeof record.id !== "string" || !record.id.trim()) throw new Error(`WUMING_WORKSPACES_JSON[${index}].id is required`);
		if (typeof record.name !== "string" || !record.name.trim()) throw new Error(`WUMING_WORKSPACES_JSON[${index}].name is required`);
		if (typeof record.path !== "string" || !record.path.trim()) throw new Error(`WUMING_WORKSPACES_JSON[${index}].path is required`);
		return { id: record.id, name: record.name, path: resolvePath(record.path) };
	});
	if (new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length) {
		throw new Error("WUMING_WORKSPACES_JSON workspace IDs must be unique");
	}
	return workspaces;
}

export function configuredModels(
	fallback: ModelMetadata,
	environment: ModelEnvironment = process.env,
): ModelMetadata[] {
	const configured = configuredArray("WUMING_MODELS_JSON", environment.WUMING_MODELS_JSON);
	if (!configured) return [fallback];
	const models = configured.map((value, index): ModelMetadata => {
		if (!value || typeof value !== "object") throw new Error(`WUMING_MODELS_JSON[${index}] must be an object`);
		const record = value as Record<string, unknown>;
		if (typeof record.provider !== "string" || !record.provider.trim()) throw new Error(`WUMING_MODELS_JSON[${index}].provider is required`);
		if (typeof record.id !== "string" || !record.id.trim()) throw new Error(`WUMING_MODELS_JSON[${index}].id is required`);
		if (typeof record.name !== "string" || !record.name.trim()) throw new Error(`WUMING_MODELS_JSON[${index}].name is required`);
		const input = record.input ?? ["text", "image"];
		if (!Array.isArray(input) || input.length === 0 || input.some((item) => item !== "text" && item !== "image")) {
			throw new Error(`WUMING_MODELS_JSON[${index}].input must contain text and/or image`);
		}
		const contextWindow = record.contextWindow ?? fallback.contextWindow;
		const maxOutputTokens = record.maxOutputTokens ?? fallback.maxOutputTokens;
		if (typeof contextWindow !== "number" || !Number.isInteger(contextWindow) || contextWindow <= 0) {
			throw new Error(`WUMING_MODELS_JSON[${index}].contextWindow must be a positive integer`);
		}
		if (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
			throw new Error(`WUMING_MODELS_JSON[${index}].maxOutputTokens must be a positive integer`);
		}
		return {
			model: { provider: record.provider, id: record.id },
			name: record.name,
			reasoning: record.reasoning === undefined ? fallback.reasoning : record.reasoning === true,
			input: input as Array<"text" | "image">,
			contextWindow,
			maxOutputTokens,
			authenticated: record.authenticated === undefined ? true : record.authenticated === true,
		};
	});
	const keys = models.map((model) => `${model.model.provider}\0${model.model.id}`);
	if (new Set(keys).size !== keys.length) throw new Error("WUMING_MODELS_JSON provider/model pairs must be unique");
	return models;
}

export function configuredMcpTrust(environment: McpTrustEnvironment = process.env): ReadonlySet<string> {
	const raw = environment.WUMING_MCP_TRUSTED_SERVERS_JSON;
	if (raw === undefined) return new Set();
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("WUMING_MCP_TRUSTED_SERVERS_JSON must contain valid JSON");
	}
	if (!Array.isArray(value)) throw new Error("WUMING_MCP_TRUSTED_SERVERS_JSON must be a JSON array");
	const trusted = new Set<string>();
	for (const [index, entry] of value.entries()) {
		if (!entry || typeof entry !== "object") throw new Error(`WUMING_MCP_TRUSTED_SERVERS_JSON[${index}] must be an object`);
		const record = entry as Record<string, unknown>;
		if (typeof record.workspaceId !== "string" || !record.workspaceId.trim()) throw new Error(`WUMING_MCP_TRUSTED_SERVERS_JSON[${index}].workspaceId is required`);
		if (typeof record.serverId !== "string" || !record.serverId.trim()) throw new Error(`WUMING_MCP_TRUSTED_SERVERS_JSON[${index}].serverId is required`);
		trusted.add(`${record.workspaceId}\0${record.serverId}`);
	}
	return trusted;
}

export function configuredWebSearch(environment: WebSearchEnvironment = process.env): WebSearchConfiguration | undefined {
	const provider = environment.WUMING_WEB_SEARCH_PROVIDER;
	if (provider === undefined) {
		if (environment.WUMING_WEB_SEARCH_API_KEY) {
			throw new Error("WUMING_WEB_SEARCH_PROVIDER is required when search credentials or an endpoint are configured");
		}
		return {
			provider: "bing",
			...(environment.WUMING_WEB_SEARCH_ENDPOINT ? { endpoint: environment.WUMING_WEB_SEARCH_ENDPOINT } : {}),
		};
	}
	if (provider === "bing") {
		if (environment.WUMING_WEB_SEARCH_API_KEY) throw new Error("WUMING_WEB_SEARCH_API_KEY is not used by the Bing HTML provider");
		return { provider, ...(environment.WUMING_WEB_SEARCH_ENDPOINT ? { endpoint: environment.WUMING_WEB_SEARCH_ENDPOINT } : {}) };
	}
	if (provider === "duckduckgo") {
		if (environment.WUMING_WEB_SEARCH_API_KEY) throw new Error("WUMING_WEB_SEARCH_API_KEY is not used by the DuckDuckGo provider");
		return { provider, ...(environment.WUMING_WEB_SEARCH_ENDPOINT ? { endpoint: environment.WUMING_WEB_SEARCH_ENDPOINT } : {}) };
	}
	if (provider === "brave") {
		if (!environment.WUMING_WEB_SEARCH_API_KEY?.trim()) throw new Error("WUMING_WEB_SEARCH_API_KEY is required for Brave Search");
		return {
			provider,
			apiKey: environment.WUMING_WEB_SEARCH_API_KEY,
			...(environment.WUMING_WEB_SEARCH_ENDPOINT ? { endpoint: environment.WUMING_WEB_SEARCH_ENDPOINT } : {}),
		};
	}
	if (provider === "searxng") {
		if (!environment.WUMING_WEB_SEARCH_ENDPOINT?.trim()) throw new Error("WUMING_WEB_SEARCH_ENDPOINT is required for SearXNG");
		if (environment.WUMING_WEB_SEARCH_API_KEY) throw new Error("WUMING_WEB_SEARCH_API_KEY is not used by the SearXNG provider");
		return { provider, endpoint: environment.WUMING_WEB_SEARCH_ENDPOINT };
	}
	throw new Error("WUMING_WEB_SEARCH_PROVIDER must be bing, duckduckgo, brave, or searxng");
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServer, McpServerSummary, McpToolSummary, SessionSnapshot } from "@wuming/protocol";
import { Type } from "typebox";
import type { ApprovalBroker } from "@wuming/sandbox";

const CONFIG_DIRECTORY = ".wuming";
const CONFIG_FILE = "mcp.json";
const CONFIG_LABEL = ".wuming/mcp.json";
const MAX_CONFIG_BYTES = 100 * 1024;
const MAX_SERVERS = 32;
const MAX_TOOLS = 100;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_CHARS = 4096;
const MAX_COMMAND_CHARS = 1000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_RPC_BUFFER_CHARS = 2_000_000;
const MAX_STDERR_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 10_000;
const SAFE_ENVIRONMENT_KEYS = new Set([
	"APPDATA", "COMSPEC", "HOME", "LANG", "LC_ALL", "LOCALAPPDATA", "PATH", "PATHEXT",
	"SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "TZ", "USERPROFILE", "WINDIR",
]);

interface McpConfigServer {
	id: string;
	name?: string;
	transport: "stdio";
	command: string;
	args: string[];
	readOnly: boolean;
}

interface JsonRpcMessage {
	id?: number;
	result?: unknown;
	error?: { code?: number; message?: string };
}

interface McpCatalogOptions {
	requestTimeoutMs?: number;
	startupTimeoutMs?: number;
	resolveWorkspace?: (workspaceId: string) => string;
	isTrusted?: (workspaceId: string, serverId: string) => boolean;
}

interface PendingRequest {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface McpToolCallResult {
	content: string;
	isError: boolean;
}

function configError(message: string): Error {
	return Object.assign(new Error(message), { protocolCode: "invalid_request" });
}

function validId(value: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
}

function bounded(value: string): string {
	return value.length <= MAX_OUTPUT_CHARS ? value : `${value.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
}

function toolId(serverId: string, name: string): string {
	const normalized = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "tool";
	return `mcp__${serverId}__${normalized}`;
}

function abortReason(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error(typeof signal.reason === "string" ? signal.reason : "MCP request aborted");
	error.name = "AbortError";
	return error;
}

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isWithin(root: string, path: string): boolean {
	const candidate = relative(root, path);
	return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function serverEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = value;
	}
	return environment;
}

function parseConfig(raw: string): McpConfigServer[] {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw configError(`${CONFIG_LABEL} contains invalid JSON`);
	}
	const entries = Array.isArray(value)
		? value
		: value && typeof value === "object" && Array.isArray((value as { servers?: unknown }).servers)
			? (value as { servers: unknown[] }).servers
			: undefined;
	if (!entries) throw configError(`${CONFIG_LABEL} must contain a servers array`);
	if (entries.length > MAX_SERVERS) throw configError(`${CONFIG_LABEL} cannot define more than ${MAX_SERVERS} servers`);
	const ids = new Set<string>();
	return entries.map((entry, index) => {
		const label = `${CONFIG_LABEL} server ${index + 1}`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw configError(`${label} must be an object`);
		const candidate = entry as Record<string, unknown>;
		if (typeof candidate.id !== "string" || !validId(candidate.id)) throw configError(`${label} has an invalid id`);
		if (ids.has(candidate.id)) throw configError(`${CONFIG_LABEL} contains duplicate server id ${candidate.id}`);
		ids.add(candidate.id);
		if (candidate.transport !== undefined && candidate.transport !== "stdio") throw configError(`${label} must use stdio transport`);
		if (
			typeof candidate.command !== "string" ||
			candidate.command.length === 0 ||
			candidate.command.length > MAX_COMMAND_CHARS ||
			candidate.command !== candidate.command.trim() ||
			/[\0\r\n]/.test(candidate.command)
		) throw configError(`${label} has an invalid command`);
		if (candidate.args !== undefined && !Array.isArray(candidate.args)) throw configError(`${label} args must be an array`);
		const args = candidate.args ?? [];
		if (args.length > MAX_ARGUMENTS) throw configError(`${label} cannot define more than ${MAX_ARGUMENTS} arguments`);
		if (!args.every((arg) => typeof arg === "string" && arg.length <= MAX_ARGUMENT_CHARS && !arg.includes("\0"))) {
			throw configError(`${label} contains an invalid argument`);
		}
		if (candidate.name !== undefined && (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 200)) {
			throw configError(`${label} has an invalid name`);
		}
		if (candidate.readOnly !== undefined && typeof candidate.readOnly !== "boolean") throw configError(`${label} readOnly must be boolean`);
		return {
			id: candidate.id,
			...(typeof candidate.name === "string" ? { name: candidate.name.trim() } : {}),
			transport: "stdio" as const,
			command: candidate.command,
			args: args as string[],
			readOnly: candidate.readOnly === true,
		};
	});
}

async function loadConfig(workspaceRoot: string): Promise<McpConfigServer[]> {
	const root = resolve(workspaceRoot);
	const directory = join(root, CONFIG_DIRECTORY);
	const path = join(directory, CONFIG_FILE);
	const directoryStat = await lstat(directory).catch((error: unknown) => {
		if (isMissing(error)) return undefined;
		throw error;
	});
	if (!directoryStat) return [];
	if (directoryStat.isSymbolicLink()) throw configError(`${CONFIG_DIRECTORY} cannot be a symbolic link`);
	if (!directoryStat.isDirectory()) throw configError(`${CONFIG_DIRECTORY} must be a directory`);
	const fileStat = await lstat(path).catch((error: unknown) => {
		if (isMissing(error)) return undefined;
		throw error;
	});
	if (!fileStat) return [];
	if (fileStat.isSymbolicLink()) throw configError(`${CONFIG_LABEL} cannot be a symbolic link`);
	if (!fileStat.isFile()) throw configError(`${CONFIG_LABEL} must be a regular file`);
	if (fileStat.size > MAX_CONFIG_BYTES) throw configError(`${CONFIG_LABEL} is too large`);
	const file = await readFile(path);
	if (file.byteLength > MAX_CONFIG_BYTES) throw configError(`${CONFIG_LABEL} is too large`);
	return parseConfig(file.toString("utf8"));
}

async function resolveServerCommand(server: McpConfigServer, workspaceRoot: string): Promise<string> {
	if (isAbsolute(server.command) || server.command.includes("/") || server.command.includes("\\")) {
		const command = isAbsolute(server.command) ? resolve(server.command) : resolve(workspaceRoot, server.command);
		if (!isAbsolute(server.command) && !isWithin(resolve(workspaceRoot), command)) {
			throw configError(`MCP server ${server.id} command must stay inside the workspace`);
		}
		const stat = await lstat(command).catch((error: unknown) => {
			if (isMissing(error)) throw configError(`MCP server ${server.id} command does not exist`);
			throw error;
		});
		if (stat.isSymbolicLink() && !isAbsolute(server.command)) throw configError(`MCP server ${server.id} workspace command cannot be a symbolic link`);
		if (!stat.isFile()) throw configError(`MCP server ${server.id} command must be a regular file`);
		return command;
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,199}$/.test(server.command)) {
		throw configError(`MCP server ${server.id} command must be an absolute path, a workspace-relative path, or a bare executable name`);
	}
	return server.command;
}

class McpConnection {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #ready: Promise<void>;
	readonly #onClose: (connection: McpConnection) => void;
	#requestId = 0;
	#stdoutBuffer = "";
	#stderrTail = "";
	#closed = false;

	constructor(command: string, args: string[], workspaceRoot: string, startupTimeoutMs: number, onClose: (connection: McpConnection) => void) {
		this.#onClose = onClose;
		this.#child = spawn(command, args, { cwd: resolve(workspaceRoot), env: serverEnvironment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, detached: false });
		this.#child.stdout.on("data", (chunk: Buffer | string) => this.#receive(chunk));
		this.#child.stderr.on("data", (chunk: Buffer | string) => {
			this.#stderrTail = (this.#stderrTail + chunk.toString()).slice(-MAX_STDERR_CHARS);
		});
		this.#child.once("error", (error) => this.#fail(error));
		this.#child.once("close", (code, signal) => {
			const suffix = this.#stderrTail.trim() ? `: ${this.#stderrTail.trim()}` : "";
			this.#fail(new Error(`MCP server exited (code ${code ?? "none"}, signal ${signal ?? "none"})${suffix}`));
		});
		this.#ready = this.#initialize(startupTimeoutMs);
	}

	get closed(): boolean {
		return this.#closed;
	}

	async #initialize(timeoutMs: number): Promise<void> {
		await this.#request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wuming", version: "0.1.0" } }, timeoutMs);
		this.#notify("notifications/initialized", {});
	}

	#notify(method: string, params: unknown): void {
		if (this.#closed) throw new Error("MCP connection is closed");
		this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, (error) => {
			if (error) this.#terminate(error);
		});
	}

	#receive(chunk: Buffer | string): void {
		this.#stdoutBuffer += chunk.toString();
		if (this.#stdoutBuffer.length > MAX_RPC_BUFFER_CHARS) {
			this.#terminate(new Error("MCP server response exceeded the protocol buffer limit"));
			return;
		}
		while (true) {
			const newline = this.#stdoutBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#stdoutBuffer.slice(0, newline).trim();
			this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			let message: JsonRpcMessage;
			try { message = JSON.parse(line) as JsonRpcMessage; } catch { continue; }
			if (typeof message.id !== "number") continue;
			const pending = this.#pending.get(message.id);
			if (!pending) continue;
			this.#settle(message.id);
			if (message.error) pending.reject(new Error(message.error.message ?? `MCP request ${pending.method} failed`));
			else pending.resolve(message.result);
		}
	}

	#settle(requestId: number): void {
		const pending = this.#pending.get(requestId);
		if (!pending) return;
		this.#pending.delete(requestId);
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
	}

	#fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const [requestId, pending] of this.#pending) {
			this.#settle(requestId);
			pending.reject(error);
		}
		this.#onClose(this);
	}

	#terminate(error: Error): void {
		this.#fail(error);
		if (!this.#child.killed) this.#child.kill();
	}

	#request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (this.#closed) return Promise.reject(new Error("MCP connection is closed"));
		if (signal?.aborted) {
			const error = abortReason(signal);
			this.#terminate(error);
			return Promise.reject(error);
		}
		const requestId = ++this.#requestId;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => this.#terminate(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
			const pending: PendingRequest = { method, resolve: resolvePromise, reject, timer, ...(signal ? { signal } : {}) };
			if (signal) {
				pending.onAbort = () => this.#terminate(abortReason(signal));
				signal.addEventListener("abort", pending.onAbort, { once: true });
			}
			this.#pending.set(requestId, pending);
			this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`, (error) => {
				if (error) this.#terminate(error);
			});
		});
	}

	async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) this.#terminate(abortReason(signal));
		let onAbort: (() => void) | undefined;
		if (signal) {
			onAbort = () => this.#terminate(abortReason(signal));
			signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			await this.#ready;
		} finally {
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
		return this.#request(method, params, timeoutMs, signal);
	}

	close(): void {
		this.#terminate(new Error("MCP connection closed"));
	}
}

function mapTools(value: unknown): McpToolSummary[] {
	if (!value || typeof value !== "object") return [];
	const tools = (value as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return [];
	return tools.slice(0, MAX_TOOLS).flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const candidate = entry as Record<string, unknown>;
		if (typeof candidate.name !== "string" || !candidate.name || !validId(candidate.name.replace(/[^a-zA-Z0-9._-]/g, "_"))) return [];
		return [{
			name: candidate.name.slice(0, 200),
			...(typeof candidate.description === "string" ? { description: candidate.description.slice(0, 4000) } : {}),
			...(candidate.inputSchema && typeof candidate.inputSchema === "object" ? { inputSchema: candidate.inputSchema as never } : {}),
		}];
	});
}

function mapToolCallResult(value: unknown): McpToolCallResult {
	if (!value || typeof value !== "object") return { content: bounded(JSON.stringify(value) ?? "(empty result)"), isError: false };
	const result = value as { content?: unknown; isError?: unknown };
	if (!Array.isArray(result.content)) return { content: bounded(JSON.stringify(value)), isError: result.isError === true };
	const content = bounded(result.content.map((part) => part && typeof part === "object" && "text" in part
		? String((part as { text?: unknown }).text ?? "")
		: part && typeof part === "object" && "type" in part
			? `[MCP ${(part as { type?: unknown }).type ?? "content"}]`
			: "").filter(Boolean).join("\n") || "(empty result)");
	return { content, isError: result.isError === true };
}

export class FileMcpCatalog {
	readonly #requestTimeoutMs: number;
	readonly #startupTimeoutMs: number;
	readonly #resolveWorkspace: ((workspaceId: string) => string) | undefined;
	readonly #isTrusted: (workspaceId: string, serverId: string) => boolean;
	readonly #connections = new Map<string, { fingerprint: string; connection: McpConnection }>();

	constructor(options: McpCatalogOptions = {}) {
		this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		this.#startupTimeoutMs = options.startupTimeoutMs ?? Math.min(STARTUP_TIMEOUT_MS, this.#requestTimeoutMs);
		if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) throw new Error("MCP request timeout must be positive");
		if (!Number.isFinite(this.#startupTimeoutMs) || this.#startupTimeoutMs <= 0) throw new Error("MCP startup timeout must be positive");
		this.#resolveWorkspace = options.resolveWorkspace;
		this.#isTrusted = options.isTrusted ?? (() => false);
	}

	async #connectionFor(server: McpConfigServer, workspaceRoot: string): Promise<McpConnection> {
		const root = resolve(workspaceRoot);
		const command = await resolveServerCommand(server, root);
		const key = `${root}\0${server.id}`;
		const fingerprint = JSON.stringify([command, server.args]);
		const current = this.#connections.get(key);
		if (current && current.fingerprint === fingerprint && !current.connection.closed) return current.connection;
		current?.connection.close();
		const connection = new McpConnection(command, server.args, root, this.#startupTimeoutMs, (closed) => {
			if (this.#connections.get(key)?.connection === closed) this.#connections.delete(key);
		});
		this.#connections.set(key, { fingerprint, connection });
		return connection;
	}

	#reconcileConnections(workspaceRoot: string, servers: McpConfigServer[]): void {
		const prefix = `${resolve(workspaceRoot)}\0`;
		const configured = new Set(servers.map((server) => `${prefix}${server.id}`));
		for (const [key, current] of this.#connections) {
			if (key.startsWith(prefix) && !configured.has(key)) current.connection.close();
		}
	}

	async #servers(workspaceRoot: string): Promise<McpConfigServer[]> {
		try {
			const servers = await loadConfig(workspaceRoot);
			this.#reconcileConnections(workspaceRoot, servers);
			return servers;
		} catch (error) {
			this.#reconcileConnections(workspaceRoot, []);
			throw error;
		}
	}

	async #listServerTools(server: McpConfigServer, workspaceRoot: string): Promise<McpToolSummary[]> {
		const connection = await this.#connectionFor(server, workspaceRoot);
		return mapTools(await connection.request("tools/list", {}, this.#requestTimeoutMs));
	}

	async #callServerTool(server: McpConfigServer, workspaceRoot: string, name: string, argumentsValue: unknown, signal?: AbortSignal): Promise<McpToolCallResult> {
		const connection = await this.#connectionFor(server, workspaceRoot);
		return mapToolCallResult(await connection.request("tools/call", { name, arguments: argumentsValue ?? {} }, this.#requestTimeoutMs, signal));
	}

	async list(workspaceId: string, workspaceRoot: string): Promise<McpServerSummary[]> {
		const servers = await this.#servers(workspaceRoot);
		const summaries: McpServerSummary[] = [];
		for (const server of servers) {
			const trusted = this.#isTrusted(workspaceId, server.id);
			if (!trusted) {
				summaries.push({ id: server.id, workspaceId, name: server.name ?? server.id, transport: "stdio", readOnly: server.readOnly, trusted: false, toolCount: 0 });
				continue;
			}
			try {
				const tools = await this.#listServerTools(server, workspaceRoot);
				summaries.push({ id: server.id, workspaceId, name: server.name ?? server.id, transport: "stdio", readOnly: server.readOnly, trusted: true, toolCount: tools.length });
			} catch {
				summaries.push({ id: server.id, workspaceId, name: server.name ?? server.id, transport: "stdio", readOnly: server.readOnly, trusted: true, toolCount: 0 });
			}
		}
		return summaries;
	}

	async get(workspaceId: string, workspaceRoot: string, serverId: string): Promise<McpServer> {
		const server = (await this.#servers(workspaceRoot)).find((candidate) => candidate.id === serverId);
		if (!server) throw Object.assign(new Error(`MCP server ${serverId} was not found`), { protocolCode: "not_found" });
		if (!this.#isTrusted(workspaceId, server.id)) {
			return { id: server.id, workspaceId, name: server.name ?? server.id, transport: "stdio", readOnly: server.readOnly, trusted: false, toolCount: 0, tools: [] };
		}
		const tools = await this.#listServerTools(server, workspaceRoot);
		return { id: server.id, workspaceId, name: server.name ?? server.id, transport: "stdio", readOnly: server.readOnly, trusted: true, toolCount: tools.length, tools };
	}

	async createTools(snapshot: SessionSnapshot, approvals: ApprovalBroker): Promise<ToolDefinition[]> {
		const workspaceRoot = this.#resolveWorkspace?.(snapshot.session.workspaceId) ?? resolve(process.cwd());
		const callServerTool = (server: McpConfigServer, name: string, argumentsValue: unknown, signal?: AbortSignal) =>
			this.#callServerTool(server, workspaceRoot, name, argumentsValue, signal);
		const servers = await this.#servers(workspaceRoot);
		const tools: ToolDefinition[] = [];
		for (const server of servers.filter((candidate) => this.#isTrusted(snapshot.session.workspaceId, candidate.id))) {
			let summaries: McpToolSummary[];
			try { summaries = await this.#listServerTools(server, workspaceRoot); } catch { continue; }
			for (const summary of summaries) {
				const parameters = summary.inputSchema && typeof summary.inputSchema === "object" ? Type.Unsafe(summary.inputSchema) : Type.Object({});
				tools.push(defineTool({
					name: toolId(server.id, summary.name),
					label: `${server.name ?? server.id}/${summary.name}`.slice(0, 200),
					description: summary.description ?? `MCP tool ${summary.name}`,
					promptSnippet: `Call MCP ${server.name ?? server.id}/${summary.name}`,
					parameters,
					async execute(toolCallId, params, signal) {
						if (signal?.aborted) throw abortReason(signal);
						const permit = await approvals.authorize({ sessionId: snapshot.session.id, toolCallId, risk: server.readOnly ? "low" : "high", summary: `MCP ${server.name ?? server.id}/${summary.name}`, capabilities: [{ type: "mcp.call", serverId: server.id, toolName: summary.name, readOnly: server.readOnly }], ...(signal ? { signal } : {}) });
						const startedAt = Date.now();
						try {
							const result = await callServerTool(server, summary.name, params, signal);
							const details = { mcpServerId: server.id, mcpToolName: summary.name, durationMs: Math.max(0, Date.now() - startedAt), mcpStatus: result.isError ? "error" : "complete" };
							if (result.isError) throw Object.assign(new Error(result.content), { details });
							return { content: [{ type: "text" as const, text: result.content }], details };
						} catch (error) {
							if (error && typeof error === "object" && !("details" in error)) {
								Object.assign(error, { details: { mcpServerId: server.id, mcpToolName: summary.name, durationMs: Math.max(0, Date.now() - startedAt), mcpStatus: signal?.aborted ? "aborted" : "error" } });
							}
							throw error;
						} finally {
							if (permit) approvals.completeAuthorization?.(permit);
						}
					},
				}));
			}
		}
		return tools;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		for (const { connection } of this.#connections.values()) connection.close();
		this.#connections.clear();
	}
}

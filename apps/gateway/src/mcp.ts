import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	CompatibilityCallToolResultSchema,
	ListToolsResultSchema,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer, McpServerSummary, McpToolSummary, SessionSnapshot } from "@wuming/protocol";
import type { McpServerConfiguration as PublicMcpConfiguration } from "@wuming/protocol";
import { Type } from "typebox";
import type { ApprovalBroker } from "@wuming/sandbox";

const CONFIG_DIRECTORY = ".wuming";
const CONFIG_FILE = "mcp.json";
const CONFIG_LABEL = ".wuming/mcp.json";
const TRUST_FILE = "mcp-permissions.json";
const TRUST_LABEL = ".wuming/mcp-permissions.json";
const MAX_CONFIG_BYTES = 100 * 1024;
const MAX_TRUSTED_SERVERS = 256;
const MAX_SERVERS = 32;
const MAX_TOOLS = 100;
const MAX_TOOL_PAGES = 20;
const MAX_CURSOR_CHARS = 4000;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_CHARS = 4096;
const MAX_COMMAND_CHARS = 1000;
const MAX_CWD_CHARS = 4000;
const MAX_ENV_ENTRIES = 32;
const MAX_HEADER_ENTRIES = 32;
const MAX_HEADER_CHARS = 4000;
const MAX_TOOL_SCHEMA_CHARS = 64 * 1024;
const MAX_CONTENT_BLOCKS = 256;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_RPC_BUFFER_CHARS = 2_000_000;
const MAX_STDERR_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const SAFE_ENVIRONMENT_KEYS = new Set([
	"APPDATA",
	"COMSPEC",
	"HOME",
	"LANG",
	"LC_ALL",
	"LOCALAPPDATA",
	"PATH",
	"PATHEXT",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"TZ",
	"USERPROFILE",
	"WINDIR",
]);

interface McpConfigServerBase {
	id: string;
	name?: string;
	readOnly: boolean;
	enabled: boolean;
	enabledTools?: string[];
	disabledTools: string[];
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
}

interface McpStdioServer extends McpConfigServerBase {
	transport: "stdio";
	command: string;
	args: string[];
	cwd?: string;
	env: Record<string, string>;
}

interface McpHttpServer extends McpConfigServerBase {
	transport: "streamable-http" | "sse";
	url: string;
	headers: Record<string, string>;
}

type McpConfigServer = McpStdioServer | McpHttpServer;
type LocalMcpTrust = Map<string, string>;

interface McpCatalogOptions {
	requestTimeoutMs?: number;
	startupTimeoutMs?: number;
	resolveWorkspace?: (workspaceId: string) => string;
	isTrusted?: (workspaceId: string, serverId: string) => boolean;
}

export type McpServerConfiguration = Record<string, unknown>;

interface McpConnectionLike {
	readonly closed: boolean;
	request(
		method: string,
		params: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
		beforeSend?: () => Promise<void>
	): Promise<unknown>;
	close(): void;
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

interface ParsedConfigEntry {
	id?: string;
	value: unknown;
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
	const normalizedServer = serverId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const serverHash = createHash("sha256").update(serverId).digest("hex").slice(0, 8);
	const serverSegment =
		normalizedServer.length <= 24 ? normalizedServer : `${normalizedServer.slice(0, 15)}_${serverHash}`;
	const prefix = `mcp__${serverSegment}__`;
	const normalizedName = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
	const candidate = `${prefix}${normalizedName}`;
	if (serverId === serverSegment && name === normalizedName && candidate.length <= 64) return candidate;
	const hash = createHash("sha256").update(`${serverId}\0${name}`).digest("hex").slice(0, 12);
	const nameChars = Math.max(1, 64 - prefix.length - hash.length - 1);
	return `${prefix}${normalizedName.slice(0, nameChars)}_${hash}`;
}

function safeJson(value: unknown, fallback: string): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? fallback : serialized;
	} catch {
		return fallback;
	}
}

function boundedJson(value: unknown, fallback: string): string {
	return bounded(safeJson(value, fallback));
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (!value || typeof value !== "object") return safeJson(value, "null");
	return `{${Object.keys(value as Record<string, unknown>)
		.sort()
		.map((key) => `${safeJson(key, '""')}:${stableJson((value as Record<string, unknown>)[key])}`)
		.join(",")}}`;
}

function configurationDigest(server: McpConfigServer): string {
	return createHash("sha256").update(stableJson(server)).digest("hex");
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseStringRecord(
	value: unknown,
	label: string,
	maxEntries: number,
	maxValueChars: number,
	keyPattern: RegExp
): Record<string, string> {
	if (value === undefined) return {};
	const record = plainRecord(value);
	if (!record) throw configError(`${label} must be an object`);
	const entries = Object.entries(record);
	if (entries.length > maxEntries) throw configError(`${label} cannot contain more than ${maxEntries} entries`);
	const result: Record<string, string> = {};
	for (const [key, entry] of entries) {
		if (!keyPattern.test(key) || key.length > 200) throw configError(`${label} contains an invalid key`);
		if (typeof entry !== "string" || entry.length > maxValueChars || /[\0\r\n]/.test(entry))
			throw configError(`${label}.${key} contains an invalid value`);
		result[key] = entry;
	}
	return result;
}

function parseToolNameList(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_TOOLS)
		throw configError(`${label} must be an array with at most ${MAX_TOOLS} entries`);
	const names = value.map((entry, index) => {
		if (typeof entry !== "string" || !entry || entry.length > 200 || /[\0\r\n]/.test(entry))
			throw configError(`${label}[${index}] is invalid`);
		return entry;
	});
	if (new Set(names).size !== names.length) throw configError(`${label} contains duplicates`);
	return names;
}

function parseTimeout(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number")
		throw configError(`${label} must be a positive number no greater than ${MAX_TIMEOUT_MS}`);
	if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS)
		throw configError(`${label} must be a positive number no greater than ${MAX_TIMEOUT_MS}`);
	return Math.ceil(value);
}

function parseUrl(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4000 || /[\0\r\n]/.test(value))
		throw configError(`${label} has an invalid URL`);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw configError(`${label} has an invalid URL`);
	}
	if (url.username || url.password) throw configError(`${label} must not contain credentials`);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
		throw configError(`${label} must use HTTPS, or HTTP on loopback`);
	return url.toString();
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function abortReason(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error(typeof signal.reason === "string" ? signal.reason : "MCP request aborted");
	error.name = "AbortError";
	return error;
}

function isMissing(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT"
	);
}

function isWithin(root: string, path: string): boolean {
	const candidate = relative(root, path);
	return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function serverEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = value;
	}
	return { ...environment, ...extra };
}

function parseConfig(raw: string): McpConfigServer[] {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw configError(`${CONFIG_LABEL} contains invalid JSON`);
	}
	const record = plainRecord(value);
	let entries: ParsedConfigEntry[] | undefined;
	if (Array.isArray(value)) {
		entries = value.map((entry) => ({ value: entry }));
	} else if (record && Array.isArray(record.servers)) {
		entries = record.servers.map((entry) => ({ value: entry }));
	} else if (record && plainRecord(record.mcpServers)) {
		entries = Object.entries(record.mcpServers as Record<string, unknown>).map(([id, entry]) => ({
			id,
			value: entry,
		}));
	} else if (record && plainRecord(record.mcp_servers)) {
		entries = Object.entries(record.mcp_servers as Record<string, unknown>).map(([id, entry]) => ({
			id,
			value: entry,
		}));
	}
	if (!entries) throw configError(`${CONFIG_LABEL} must contain a servers array or mcpServers object`);
	if (entries.length > MAX_SERVERS) throw configError(`${CONFIG_LABEL} cannot define more than ${MAX_SERVERS} servers`);
	const ids = new Set<string>();
	return entries.map(({ id: mappedId, value: entry }, index) => {
		const label = `${CONFIG_LABEL} server ${index + 1}`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw configError(`${label} must be an object`);
		const candidate = entry as Record<string, unknown>;
		const id = candidate.id ?? mappedId;
		if (typeof id !== "string" || !validId(id)) throw configError(`${label} has an invalid id`);
		if (ids.has(id)) throw configError(`${CONFIG_LABEL} contains duplicate server id ${id}`);
		ids.add(id);
		if (
			candidate.name !== undefined &&
			(typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 200)
		) {
			throw configError(`${label} has an invalid name`);
		}
		if (candidate.readOnly !== undefined && typeof candidate.readOnly !== "boolean")
			throw configError(`${label} readOnly must be boolean`);
		if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean")
			throw configError(`${label} enabled must be boolean`);
		const enabledTools = parseToolNameList(candidate.enabledTools ?? candidate.enabled_tools, `${label}.enabledTools`);
		const disabledTools =
			parseToolNameList(candidate.disabledTools ?? candidate.disabled_tools, `${label}.disabledTools`) ?? [];
		const startupTimeoutMs = parseTimeout(
			candidate.startupTimeoutMs ??
				candidate.startup_timeout_ms ??
				(typeof candidate.startup_timeout_sec === "number" ? candidate.startup_timeout_sec * 1000 : undefined),
			`${label}.startupTimeoutMs`
		);
		const requestTimeoutMs = parseTimeout(
			candidate.requestTimeoutMs ??
				candidate.request_timeout_ms ??
				candidate.toolCallTimeoutMs ??
				candidate.tool_call_timeout_ms ??
				(typeof candidate.tool_timeout_sec === "number" ? candidate.tool_timeout_sec * 1000 : undefined),
			`${label}.requestTimeoutMs`
		);
		const common = {
			id,
			...(typeof candidate.name === "string" ? { name: candidate.name.trim() } : {}),
			readOnly: candidate.readOnly === true,
			enabled: candidate.enabled !== false,
			...(enabledTools ? { enabledTools } : {}),
			disabledTools,
			...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
			...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
		};
		const transport = candidate.transport ?? candidate.type ?? "stdio";
		if (transport === "stdio") {
			if (
				typeof candidate.command !== "string" ||
				candidate.command.length === 0 ||
				candidate.command.length > MAX_COMMAND_CHARS ||
				candidate.command !== candidate.command.trim() ||
				/[\0\r\n]/.test(candidate.command)
			)
				throw configError(`${label} has an invalid command`);
			if (candidate.args !== undefined && !Array.isArray(candidate.args))
				throw configError(`${label} args must be an array`);
			const args = candidate.args ?? [];
			if (args.length > MAX_ARGUMENTS) throw configError(`${label} cannot define more than ${MAX_ARGUMENTS} arguments`);
			if (!args.every((arg) => typeof arg === "string" && arg.length <= MAX_ARGUMENT_CHARS && !arg.includes("\0")))
				throw configError(`${label} contains an invalid argument`);
			if (
				candidate.cwd !== undefined &&
				(typeof candidate.cwd !== "string" ||
					candidate.cwd.length === 0 ||
					candidate.cwd.length > MAX_CWD_CHARS ||
					/[\0\r\n]/.test(candidate.cwd))
			)
				throw configError(`${label} has an invalid cwd`);
			return {
				...common,
				transport: "stdio" as const,
				command: candidate.command,
				args: args as string[],
				...(candidate.cwd === undefined ? {} : { cwd: candidate.cwd }),
				env: parseStringRecord(
					candidate.env,
					`${label}.env`,
					MAX_ENV_ENTRIES,
					MAX_ARGUMENT_CHARS,
					/^[A-Za-z_][A-Za-z0-9_]*$/
				),
			};
		}
		if (transport === "streamable-http" || transport === "http" || transport === "sse") {
			const resolvedTransport: McpHttpServer["transport"] = transport === "sse" ? "sse" : "streamable-http";
			return {
				...common,
				transport: resolvedTransport,
				url: parseUrl(candidate.url ?? candidate.endpoint, `${label}.url`),
				headers: parseStringRecord(
					candidate.headers ?? candidate.http_headers,
					`${label}.headers`,
					MAX_HEADER_ENTRIES,
					MAX_HEADER_CHARS,
					/^[A-Za-z0-9-]+$/
				),
			};
		}
		throw configError(`${label} must use stdio, streamable-http, or sse transport`);
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

async function ensureConfigDirectory(workspaceRoot: string): Promise<string> {
	const directory = join(resolve(workspaceRoot), CONFIG_DIRECTORY);
	const existing = await lstat(directory).catch((error: unknown) => {
		if (isMissing(error)) return undefined;
		throw error;
	});
	if (existing?.isSymbolicLink()) throw configError(`${CONFIG_DIRECTORY} cannot be a symbolic link`);
	if (existing && !existing.isDirectory()) throw configError(`${CONFIG_DIRECTORY} must be a directory`);
	if (!existing) await mkdir(directory, { recursive: true });
	const created = await lstat(directory);
	if (created.isSymbolicLink() || !created.isDirectory())
		throw configError(`${CONFIG_DIRECTORY} must be a regular directory`);
	return directory;
}

async function readLocalTrust(workspaceRoot: string): Promise<LocalMcpTrust> {
	const root = resolve(workspaceRoot);
	const directory = join(root, CONFIG_DIRECTORY);
	const directoryStat = await lstat(directory).catch((error: unknown) => {
		if (isMissing(error)) return undefined;
		throw error;
	});
	if (!directoryStat) return new Map();
	if (directoryStat.isSymbolicLink()) throw configError(`${CONFIG_DIRECTORY} cannot be a symbolic link`);
	if (!directoryStat.isDirectory()) throw configError(`${CONFIG_DIRECTORY} must be a directory`);
	const path = join(directory, TRUST_FILE);
	const fileStat = await lstat(path).catch((error: unknown) => {
		if (isMissing(error)) return undefined;
		throw error;
	});
	if (!fileStat) return new Map();
	if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw configError(`${TRUST_LABEL} must be a regular file`);
	if (fileStat.size > 64 * 1024) throw configError(`${TRUST_LABEL} is too large`);
	let value: unknown;
	try {
		value = JSON.parse((await readFile(path)).toString("utf8"));
	} catch {
		throw configError(`${TRUST_LABEL} contains invalid JSON`);
	}
	const entries = Array.isArray(value) ? value : plainRecord(value)?.trustedServers;
	if (!Array.isArray(entries) || entries.length > MAX_TRUSTED_SERVERS)
		throw configError(`${TRUST_LABEL} must contain a trustedServers array`);
	const trusted: LocalMcpTrust = new Map();
	for (const entry of entries) {
		const record = plainRecord(entry);
		if (!record || typeof record.serverId !== "string" || !validId(record.serverId))
			throw configError(`${TRUST_LABEL} contains an invalid server id`);
		if (typeof record.configDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.configDigest))
			throw configError(`${TRUST_LABEL} contains an invalid configuration digest`);
		if (trusted.has(record.serverId)) throw configError(`${TRUST_LABEL} contains duplicate server ids`);
		trusted.set(record.serverId, record.configDigest);
	}
	return trusted;
}

async function writeLocalTrust(workspaceRoot: string, trusted: ReadonlyMap<string, string>): Promise<void> {
	const directory = await ensureConfigDirectory(workspaceRoot);
	const path = join(directory, TRUST_FILE);
	const existing = await lstat(path).catch((error: unknown) => {
		if (isMissing(error)) return undefined;
		throw error;
	});
	if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
		throw configError(`${TRUST_LABEL} must be a regular file`);
	const values = [...trusted.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([serverId, configDigest]) => ({ serverId, configDigest }));
	if (values.length > MAX_TRUSTED_SERVERS) throw configError(`${TRUST_LABEL} has too many entries`);
	const temporary = join(directory, `.mcp-permissions-${randomUUID()}.tmp`);
	await writeFile(temporary, `${JSON.stringify({ trustedServers: values }, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
	try {
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

function serializableServer(server: McpConfigServer): PublicMcpConfiguration {
	const common: Record<string, unknown> = {
		id: server.id,
		readOnly: server.readOnly,
		enabled: server.enabled,
		...(server.name === undefined ? {} : { name: server.name }),
		...(server.enabledTools === undefined ? {} : { enabledTools: server.enabledTools }),
		...(server.disabledTools.length === 0 ? {} : { disabledTools: server.disabledTools }),
		...(server.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: server.startupTimeoutMs }),
		...(server.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: server.requestTimeoutMs }),
	};
	return server.transport === "stdio"
		? {
				...common,
				transport: "stdio",
				command: server.command,
				args: server.args,
				...(server.cwd === undefined ? {} : { cwd: server.cwd }),
				...(Object.keys(server.env).length === 0 ? {} : { env: server.env }),
			}
		: {
				...common,
				transport: server.transport,
				url: server.url,
				...(Object.keys(server.headers).length === 0 ? {} : { headers: server.headers }),
			};
}

async function writeConfig(workspaceRoot: string, servers: readonly McpConfigServer[]): Promise<void> {
	const directory = await ensureConfigDirectory(workspaceRoot);
	const path = join(directory, CONFIG_FILE);
	const existing = await lstat(path).catch((error: unknown) => {
		if (isMissing(error)) return undefined;
		throw error;
	});
	if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
		throw configError(`${CONFIG_LABEL} must be a regular file`);
	const content = `${JSON.stringify({ servers: servers.map(serializableServer) }, null, 2)}\n`;
	if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) throw configError(`${CONFIG_LABEL} is too large`);
	const temporary = join(directory, `.mcp-config-${randomUUID()}.tmp`);
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
	try {
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

async function resolveServerCommand(server: McpStdioServer, workspaceRoot: string): Promise<string> {
	if (isAbsolute(server.command) || server.command.includes("/") || server.command.includes("\\")) {
		const command = isAbsolute(server.command) ? resolve(server.command) : resolve(workspaceRoot, server.command);
		if (!isAbsolute(server.command) && !isWithin(resolve(workspaceRoot), command)) {
			throw configError(`MCP server ${server.id} command must stay inside the workspace`);
		}
		const stat = await lstat(command).catch((error: unknown) => {
			if (isMissing(error)) throw configError(`MCP server ${server.id} command does not exist`);
			throw error;
		});
		if (stat.isSymbolicLink() && !isAbsolute(server.command))
			throw configError(`MCP server ${server.id} workspace command cannot be a symbolic link`);
		if (!stat.isFile()) throw configError(`MCP server ${server.id} command must be a regular file`);
		return command;
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,199}$/.test(server.command)) {
		throw configError(
			`MCP server ${server.id} command must be an absolute path, a workspace-relative path, or a bare executable name`
		);
	}
	return server.command;
}

async function resolveServerCwd(server: McpStdioServer, workspaceRoot: string): Promise<string> {
	const root = resolve(workspaceRoot);
	if (server.cwd === undefined) return root;
	const cwd = isAbsolute(server.cwd) ? resolve(server.cwd) : resolve(root, server.cwd);
	if (!isWithin(root, cwd)) throw configError(`MCP server ${server.id} cwd must stay inside the workspace`);
	const stat = await lstat(cwd).catch((error: unknown) => {
		if (isMissing(error)) throw configError(`MCP server ${server.id} cwd does not exist`);
		throw error;
	});
	if (stat.isSymbolicLink()) throw configError(`MCP server ${server.id} cwd cannot be a symbolic link`);
	if (!stat.isDirectory()) throw configError(`MCP server ${server.id} cwd must be a directory`);
	return cwd;
}

class McpConnection implements McpConnectionLike {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #ready: Promise<void>;
	readonly #onClose: (connection: McpConnectionLike) => void;
	readonly #onNotification: (method: string) => void | Promise<void>;
	#requestId = 0;
	#stdoutBuffer = "";
	#stderrTail = "";
	#closed = false;

	constructor(
		command: string,
		args: string[],
		cwd: string,
		environment: Record<string, string>,
		startupTimeoutMs: number,
		onClose: (connection: McpConnectionLike) => void,
		onNotification: (method: string) => void | Promise<void>
	) {
		this.#onClose = onClose;
		this.#onNotification = onNotification;
		this.#child = spawn(command, args, {
			cwd,
			env: serverEnvironment(environment),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
			detached: false,
		});
		// Preserve partial UTF-8 characters between OS pipe chunks on both streams.
		this.#child.stdout.setEncoding("utf8");
		this.#child.stderr.setEncoding("utf8");
		this.#child.stdout.on("data", (chunk: Buffer | string) => this.#receive(chunk));
		this.#child.stderr.on("data", (chunk: Buffer | string) => {
			this.#stderrTail = (this.#stderrTail + chunk.toString()).slice(-MAX_STDERR_CHARS);
		});
		this.#child.once("error", (error) => this.#fail(error));
		this.#child.once("close", (code, signal) => {
			const suffix = this.#stderrTail.trim() ? `: ${this.#stderrTail.trim()}` : "";
			this.#fail(new Error(`MCP server exited (code ${code ?? "none"}, signal ${signal ?? "none"})${suffix}`));
		});
		this.#ready = this.#initialize(startupTimeoutMs).catch((error: unknown) => {
			this.#terminate(error instanceof Error ? error : new Error(String(error)));
			throw error;
		});
	}

	get closed(): boolean {
		return this.#closed;
	}

	async #initialize(timeoutMs: number): Promise<void> {
		const result = await this.#request(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "wuming", version: "0.1.0" },
			},
			timeoutMs
		);
		if (result !== undefined && (!result || typeof result !== "object" || Array.isArray(result)))
			throw new Error("MCP initialize returned an invalid result");
		if (
			result &&
			typeof result === "object" &&
			!Array.isArray(result) &&
			"protocolVersion" in result &&
			typeof (result as { protocolVersion?: unknown }).protocolVersion !== "string"
		)
			throw new Error("MCP initialize returned an invalid protocol version");
		this.#notify("notifications/initialized", {});
	}

	#notify(method: string, params: unknown): void {
		if (this.#closed) throw new Error("MCP connection is closed");
		this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, (error) => {
			if (error) this.#terminate(error);
		});
	}

	#respondToServerRequest(id: unknown): void {
		if (this.#closed) return;
		this.#child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: "MCP client method not supported" },
			})}\n`,
			(error) => {
				if (error) this.#terminate(error);
			}
		);
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
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				this.#terminate(new Error("MCP server sent invalid JSON"));
				return;
			}
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				this.#terminate(new Error("MCP server sent an invalid response envelope"));
				return;
			}
			const message = value as Record<string, unknown>;
			if (message.jsonrpc !== "2.0") {
				this.#terminate(new Error("MCP server sent an invalid response version"));
				return;
			}
			// MCP servers may notify the client that their tool catalog changed. A
			// server request is answered explicitly instead of being left pending;
			// the advertised client capabilities are intentionally empty.
			if (typeof message.method === "string") {
				if (Object.hasOwn(message, "id")) this.#respondToServerRequest(message.id);
				else {
					try {
						const result = this.#onNotification(message.method);
						if (result instanceof Promise) void result.catch(() => undefined);
					} catch {
						// Notification handling must not corrupt the protocol stream.
					}
				}
				continue;
			}
			if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
				this.#terminate(new Error("MCP server sent an invalid response id"));
				return;
			}
			const pending = this.#pending.get(message.id);
			if (!pending) continue;
			const hasResult = Object.hasOwn(message, "result");
			const hasError = Object.hasOwn(message, "error");
			const error = message.error;
			if (
				hasResult === hasError ||
				(hasError &&
					(!error ||
						typeof error !== "object" ||
						Array.isArray(error) ||
						!("code" in error) ||
						!Number.isInteger(error.code) ||
						!("message" in error) ||
						typeof error.message !== "string"))
			) {
				this.#terminate(new Error("MCP server sent an invalid response payload"));
				return;
			}
			this.#settle(message.id);
			if (hasError) pending.reject(new Error(bounded((error as { message: string }).message)));
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
		if (this.#requestId >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error("MCP request id space exhausted"));
		const requestId = ++this.#requestId;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(
				() => this.#terminate(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`)),
				timeoutMs
			);
			const pending: PendingRequest = {
				method,
				resolve: resolvePromise,
				reject,
				timer,
				...(signal ? { signal } : {}),
			};
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

	async request(
		method: string,
		params: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
		beforeSend?: () => Promise<void>
	): Promise<unknown> {
		if (signal?.aborted) this.#terminate(abortReason(signal));
		let onAbort: (() => void) | undefined;
		if (signal) {
			onAbort = () => this.#terminate(abortReason(signal));
			signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			await this.#ready;
			await beforeSend?.();
		} finally {
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
		return this.#request(method, params, timeoutMs, signal);
	}

	close(): void {
		this.#terminate(new Error("MCP connection closed"));
	}
}

class McpHttpConnection implements McpConnectionLike {
	readonly #client: Client;
	readonly #transport: StreamableHTTPClientTransport | SSEClientTransport;
	readonly #ready: Promise<void>;
	readonly #onClose: (connection: McpConnectionLike) => void;
	readonly #onNotification: (method: string) => void | Promise<void>;
	#closed = false;

	constructor(
		url: string,
		headers: Record<string, string>,
		transportKind: "streamable-http" | "sse",
		startupTimeoutMs: number,
		onClose: (connection: McpConnectionLike) => void,
		onNotification: (method: string) => void | Promise<void>
	) {
		this.#onClose = onClose;
		this.#onNotification = onNotification;
		this.#client = new Client({ name: "wuming", version: "0.1.0" }, { capabilities: {} });
		this.#transport =
			transportKind === "sse"
				? new SSEClientTransport(new URL(url), { requestInit: { headers } })
				: new StreamableHTTPClientTransport(new URL(url), {
						requestInit: { headers },
						reconnectionOptions: {
							initialReconnectionDelay: 500,
							maxReconnectionDelay: 30_000,
							reconnectionDelayGrowFactor: 2,
							maxRetries: 3,
						},
					});
		this.#client.onclose = () => this.#fail(new Error("MCP HTTP connection closed"));
		this.#client.onerror = (error) => {
			// Transport errors are surfaced by the individual request or close
			// callback. Keep the error hook for SDK diagnostics without logging raw
			// response bodies or credentials.
			void error;
		};
		this.#client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			await this.#onNotification("notifications/tools/list_changed");
		});
		this.#ready = this.#initialize(startupTimeoutMs).catch((error: unknown) => {
			this.#fail(error instanceof Error ? error : new Error(String(error)));
			throw error;
		});
	}

	get closed(): boolean {
		return this.#closed;
	}

	async #initialize(timeoutMs: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.#client.connect(this.#transport as unknown as Parameters<Client["connect"]>[0]),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`MCP initialize timed out after ${timeoutMs}ms`)), timeoutMs);
				}),
			]);
		} catch (error) {
			void this.#client.close().catch(() => undefined);
			throw error;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async request(
		method: string,
		params: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
		beforeSend?: () => Promise<void>
	): Promise<unknown> {
		if (this.#closed) throw new Error("MCP connection is closed");
		if (signal?.aborted) throw abortReason(signal);
		await this.#ready;
		await beforeSend?.();
		if (signal?.aborted) throw abortReason(signal);
		const options = { ...(signal ? { signal } : {}), timeout: timeoutMs };
		if (method === "tools/list") {
			return this.#client.request(
				{ method: "tools/list", params: (params ?? {}) as Record<string, unknown> },
				ListToolsResultSchema,
				options
			);
		}
		if (method === "tools/call") {
			return this.#client.request(
				{ method: "tools/call", params: params as Record<string, unknown> },
				CompatibilityCallToolResultSchema,
				options
			);
		}
		throw new Error(`MCP HTTP method ${method} is not supported`);
	}

	#fail(_error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#onClose(this);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#onClose(this);
		void this.#client.close().catch(() => undefined);
	}
}

function mapTools(value: unknown): McpToolSummary[] {
	if (!value || typeof value !== "object") return [];
	const tools = (value as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return [];
	return tools.slice(0, MAX_TOOLS).flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const candidate = entry as Record<string, unknown>;
		if (typeof candidate.name !== "string" || !candidate.name || candidate.name.length > 200) return [];
		const inputSchema = candidate.inputSchema;
		const outputSchema = candidate.outputSchema;
		if (
			inputSchema !== undefined &&
			(!plainRecord(inputSchema) || safeJson(inputSchema, "").length > MAX_TOOL_SCHEMA_CHARS)
		)
			return [];
		if (
			outputSchema !== undefined &&
			(!plainRecord(outputSchema) || safeJson(outputSchema, "").length > MAX_TOOL_SCHEMA_CHARS)
		)
			return [];
		return [
			{
				name: candidate.name,
				...(typeof candidate.description === "string" ? { description: candidate.description.slice(0, 4000) } : {}),
				...(inputSchema && typeof inputSchema === "object" ? { inputSchema: inputSchema as never } : {}),
				...(outputSchema && typeof outputSchema === "object" ? { outputSchema: outputSchema as never } : {}),
			},
		];
	});
}

function mapToolCallResult(value: unknown): McpToolCallResult {
	if (!value || typeof value !== "object") return { content: boundedJson(value, "(empty result)"), isError: false };
	const result = value as { content?: unknown; isError?: unknown };
	if (!Array.isArray(result.content))
		return {
			content: boundedJson(value, "(empty result)"),
			isError: result.isError === true,
		};
	const parts = result.content.slice(0, MAX_CONTENT_BLOCKS).flatMap((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part)) return ["[unsupported MCP content block]"];
		const block = part as Record<string, unknown>;
		switch (block.type) {
			case "text":
				return [typeof block.text === "string" ? block.text : "[MCP text block missing text]"];
			case "image":
				return [`[MCP image result: ${typeof block.mimeType === "string" ? block.mimeType : "unknown media type"}]`];
			case "audio":
				return [`[MCP audio result: ${typeof block.mimeType === "string" ? block.mimeType : "unknown media type"}]`];
			case "resource_link":
				return [
					typeof block.uri === "string"
						? `MCP resource link${typeof block.name === "string" ? ` ${block.name}` : ""}: ${block.uri.slice(0, 4000)}`
						: "[MCP resource link missing URI]",
				];
			case "resource":
				return ["[MCP embedded resource result]"];
			default:
				return [`[MCP ${typeof block.type === "string" ? block.type : "unknown"} result]`];
		}
	});
	if (result.content.length > MAX_CONTENT_BLOCKS) parts.push("[MCP content truncated]");
	if ("structuredContent" in (value as Record<string, unknown>)) {
		parts.push(
			`Structured content: ${boundedJson((value as Record<string, unknown>).structuredContent, "(unserializable)")}`
		);
	}
	return { content: bounded(parts.filter(Boolean).join("\n") || "(empty result)"), isError: result.isError === true };
}

function exposedTools(server: McpConfigServer, tools: McpToolSummary[]): McpToolSummary[] {
	return tools.filter(
		(tool) =>
			(server.enabledTools === undefined || server.enabledTools.includes(tool.name)) &&
			!server.disabledTools.includes(tool.name)
	);
}

export class FileMcpCatalog {
	readonly #requestTimeoutMs: number;
	readonly #startupTimeoutMs: number;
	readonly #resolveWorkspace: ((workspaceId: string) => string) | undefined;
	readonly #isTrusted: (workspaceId: string, serverId: string) => boolean;
	readonly #localTrust = new Map<string, ReadonlyMap<string, string>>();
	readonly #mutations = new Map<string, Promise<unknown>>();

	async #mutate<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
		const root = resolve(workspaceRoot);
		const previous = this.#mutations.get(root) ?? Promise.resolve();
		const pending = previous.catch(() => {}).then(operation);
		this.#mutations.set(root, pending);
		try {
			return await pending;
		} finally {
			if (this.#mutations.get(root) === pending) this.#mutations.delete(root);
		}
	}
	readonly #connections = new Map<string, { fingerprint: string; connection: McpConnectionLike }>();
	readonly #connectionStarts = new Map<
		string,
		{ fingerprint: string; token: symbol; promise: Promise<McpConnectionLike> }
	>();
	readonly #discoveryVersions = new Map<string, number>();
	readonly #discovery = new Map<
		string,
		{ fingerprint: string; tools?: McpToolSummary[]; pending?: Promise<McpToolSummary[]> }
	>();

	constructor(options: McpCatalogOptions = {}) {
		this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		this.#startupTimeoutMs = options.startupTimeoutMs ?? Math.min(STARTUP_TIMEOUT_MS, this.#requestTimeoutMs);
		if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0)
			throw new Error("MCP request timeout must be positive");
		if (!Number.isFinite(this.#startupTimeoutMs) || this.#startupTimeoutMs <= 0)
			throw new Error("MCP startup timeout must be positive");
		this.#resolveWorkspace = options.resolveWorkspace;
		this.#isTrusted = options.isTrusted ?? (() => false);
	}

	workspaceRoot(workspaceId: string): string {
		return this.#resolveWorkspace?.(workspaceId) ?? resolve(process.cwd());
	}

	async #refreshLocalTrust(workspaceRoot: string): Promise<void> {
		this.#localTrust.set(resolve(workspaceRoot), await readLocalTrust(workspaceRoot));
	}

	async #trusted(workspaceId: string, workspaceRoot: string, server: McpConfigServer): Promise<boolean> {
		return (
			this.#isTrusted(workspaceId, server.id) ||
			this.#localTrust.get(resolve(workspaceRoot))?.get(server.id) === configurationDigest(server)
		);
	}

	async #setLocalTrust(
		workspaceRoot: string,
		serverId: string,
		trusted: boolean,
		server?: McpConfigServer
	): Promise<void> {
		const root = resolve(workspaceRoot);
		const next = new Map(this.#localTrust.get(root) ?? (await readLocalTrust(root)));
		if (trusted) {
			if (!server || server.id !== serverId) throw configError("MCP trust requires the current server configuration");
			next.set(serverId, configurationDigest(server));
		} else next.delete(serverId);
		await writeLocalTrust(root, next);
		this.#localTrust.set(root, next);
	}

	async #connectionFor(server: McpConfigServer, workspaceRoot: string): Promise<McpConnectionLike> {
		const root = resolve(workspaceRoot);
		const key = `${root}\0${server.id}`;
		const fingerprint = stableJson(server);
		const current = this.#connections.get(key);
		if (current && current.fingerprint === fingerprint && !current.connection.closed) return current.connection;
		current?.connection.close();
		const existingStart = this.#connectionStarts.get(key);
		if (existingStart?.fingerprint === fingerprint) return existingStart.promise;
		const token = Symbol("mcp-connection-start");
		const start = (async (): Promise<McpConnectionLike> => {
			await Promise.resolve();
			const onClose = (closed: McpConnectionLike) => {
				if (this.#connections.get(key)?.connection === closed) this.#connections.delete(key);
				this.#invalidateDiscovery(key);
			};
			const onNotification = (method: string) => {
				if (method === "notifications/tools/list_changed") this.#invalidateDiscovery(key);
			};
			const connection =
				server.transport === "stdio"
					? new McpConnection(
							await resolveServerCommand(server, root),
							server.args,
							await resolveServerCwd(server, root),
							server.env,
							server.startupTimeoutMs ?? this.#startupTimeoutMs,
							onClose,
							onNotification
						)
					: new McpHttpConnection(
							server.url,
							server.headers,
							server.transport,
							server.startupTimeoutMs ?? this.#startupTimeoutMs,
							onClose,
							onNotification
						);
			if (this.#connectionStarts.get(key)?.token !== token) {
				connection.close();
				throw new Error("MCP connection superseded by a newer configuration");
			}
			this.#connections.set(key, { fingerprint, connection });
			return connection;
		})();
		this.#connectionStarts.set(key, { fingerprint, token, promise: start });
		try {
			return await start;
		} finally {
			if (this.#connectionStarts.get(key)?.token === token) this.#connectionStarts.delete(key);
		}
	}

	#invalidateDiscovery(key: string): void {
		this.#discoveryVersions.set(key, (this.#discoveryVersions.get(key) ?? 0) + 1);
		this.#discovery.delete(key);
	}

	#reconcileConnections(workspaceRoot: string, servers: McpConfigServer[]): void {
		const root = resolve(workspaceRoot);
		const prefix = `${root}\0`;
		const configured = new Set(servers.map((server) => `${prefix}${server.id}`));
		for (const server of servers) {
			const key = `${prefix}${server.id}`;
			const fingerprint = stableJson(server);
			const current = this.#connections.get(key);
			if (current && current.fingerprint !== fingerprint) {
				current.connection.close();
				this.#invalidateDiscovery(key);
			}
			const pending = this.#connectionStarts.get(key);
			if (pending && pending.fingerprint !== fingerprint) {
				this.#connectionStarts.delete(key);
				this.#invalidateDiscovery(key);
			}
			const discovery = this.#discovery.get(key);
			if (discovery && discovery.fingerprint !== fingerprint) this.#invalidateDiscovery(key);
		}
		for (const [key, current] of this.#connections) {
			if (key.startsWith(prefix) && !configured.has(key)) {
				current.connection.close();
				this.#invalidateDiscovery(key);
			}
		}
		for (const key of this.#connectionStarts.keys()) {
			if (key.startsWith(prefix) && !configured.has(key)) {
				this.#connectionStarts.delete(key);
				this.#invalidateDiscovery(key);
			}
		}
		for (const key of this.#discovery.keys()) {
			if (key.startsWith(prefix) && !configured.has(key)) this.#invalidateDiscovery(key);
		}
	}

	async #servers(workspaceRoot: string): Promise<McpConfigServer[]> {
		await this.#refreshLocalTrust(workspaceRoot);
		try {
			const servers = await loadConfig(workspaceRoot);
			this.#reconcileConnections(workspaceRoot, servers);
			return servers;
		} catch (error) {
			this.#reconcileConnections(workspaceRoot, []);
			throw error;
		}
	}

	async #listServerTools(
		workspaceId: string,
		server: McpConfigServer,
		workspaceRoot: string,
		force = false
	): Promise<McpToolSummary[]> {
		const key = `${resolve(workspaceRoot)}\0${server.id}`;
		const fingerprint = stableJson(server);
		const version = this.#discoveryVersions.get(key) ?? 0;
		const cached = this.#discovery.get(key);
		if (cached?.fingerprint === fingerprint && cached.pending) return cached.pending;
		if (!force && cached?.fingerprint === fingerprint && cached.tools) return cached.tools.map((tool) => ({ ...tool }));
		const connection = await this.#connectionFor(server, workspaceRoot);
		const controller = new AbortController();
		const requestTimeoutMs = server.requestTimeoutMs ?? this.#requestTimeoutMs;
		const timer = setTimeout(() => controller.abort(new Error("MCP tools/list discovery timed out")), requestTimeoutMs);
		let discovery: Promise<McpToolSummary[]> = Promise.resolve([]);
		discovery = (async (): Promise<McpToolSummary[]> => {
			const tools: McpToolSummary[] = [];
			const cursors = new Set<string>();
			const names = new Set<string>();
			let cursor: string | undefined;
			try {
				for (let page = 0; page < MAX_TOOL_PAGES; page++) {
					const value = await connection.request(
						"tools/list",
						cursor === undefined ? {} : { cursor },
						requestTimeoutMs,
						controller.signal,
						() => this.#assertServerCurrent(workspaceId, workspaceRoot, server)
					);
					if (
						!value ||
						typeof value !== "object" ||
						Array.isArray(value) ||
						!("tools" in value) ||
						!Array.isArray(value.tools)
					)
						throw new Error("MCP tools/list returned an invalid page");
					if (tools.length + value.tools.length > MAX_TOOLS) throw new Error("MCP tool catalog exceeds 100 tools");
					const mapped = mapTools(value);
					if (mapped.length !== value.tools.length) throw new Error("MCP tools/list returned an invalid tool");
					for (const tool of mapped) {
						const id = toolId(server.id, tool.name);
						if (names.has(id)) throw new Error("MCP tool catalog contains duplicate or colliding tool names");
						names.add(id);
						tools.push(tool);
					}
					if (!("nextCursor" in value)) {
						const complete = tools.map((tool) => ({ ...tool }));
						if ((this.#discoveryVersions.get(key) ?? 0) === version)
							this.#discovery.set(key, { fingerprint, tools: complete });
						return complete;
					}
					if (typeof value.nextCursor !== "string" || value.nextCursor.length > MAX_CURSOR_CHARS)
						throw new Error("MCP tools/list returned an invalid cursor");
					if (cursors.has(value.nextCursor)) throw new Error("MCP tools/list repeated a cursor");
					cursors.add(value.nextCursor);
					cursor = value.nextCursor;
				}
				throw new Error("MCP tool catalog exceeds 20 pages");
			} catch (error) {
				connection.close();
				if (this.#discovery.get(key)?.pending === discovery) this.#discovery.delete(key);
				throw error;
			} finally {
				clearTimeout(timer);
			}
		})();
		this.#discovery.set(key, { fingerprint, pending: discovery });
		return discovery;
	}

	async #assertServerCurrent(workspaceId: string, workspaceRoot: string, server: McpConfigServer): Promise<void> {
		const current = (await this.#servers(workspaceRoot)).find((candidate) => candidate.id === server.id);
		if (
			!current ||
			!(await this.#trusted(workspaceId, workspaceRoot, current)) ||
			stableJson(current) !== stableJson(server)
		) {
			this.#connections.get(`${resolve(workspaceRoot)}\0${server.id}`)?.connection.close();
			throw configError(`MCP server ${server.id} trust or configuration changed; refresh tools before calling`);
		}
	}

	async #callServerTool(
		workspaceId: string,
		server: McpConfigServer,
		workspaceRoot: string,
		name: string,
		argumentsValue: unknown,
		signal?: AbortSignal
	): Promise<McpToolCallResult> {
		await this.#assertServerCurrent(workspaceId, workspaceRoot, server);
		if (!server.enabled) throw configError(`MCP server ${server.id} is disabled`);
		if (signal?.aborted) throw abortReason(signal);
		const connection = await this.#connectionFor(server, workspaceRoot);
		return mapToolCallResult(
			await connection.request(
				"tools/call",
				{ name, arguments: argumentsValue ?? {} },
				server.requestTimeoutMs ?? this.#requestTimeoutMs,
				signal,
				() => this.#assertServerCurrent(workspaceId, workspaceRoot, server)
			)
		);
	}

	async list(workspaceId: string, workspaceRoot: string): Promise<McpServerSummary[]> {
		const servers = await this.#servers(workspaceRoot);
		const summaries: McpServerSummary[] = [];
		for (const server of servers) {
			const trusted = await this.#trusted(workspaceId, workspaceRoot, server);
			const transport = server.transport;
			if (!server.enabled) {
				summaries.push({
					id: server.id,
					workspaceId,
					name: server.name ?? server.id,
					transport,
					readOnly: server.readOnly,
					trusted,
					toolCount: 0,
					discoveryStatus: "disabled",
				});
				continue;
			}
			if (!trusted) {
				summaries.push({
					id: server.id,
					workspaceId,
					name: server.name ?? server.id,
					transport,
					readOnly: server.readOnly,
					trusted: false,
					toolCount: 0,
					discoveryStatus: "untrusted",
				});
				continue;
			}
			try {
				const tools = exposedTools(server, await this.#listServerTools(workspaceId, server, workspaceRoot, true));
				summaries.push({
					id: server.id,
					workspaceId,
					name: server.name ?? server.id,
					transport,
					readOnly: server.readOnly,
					trusted: true,
					toolCount: tools.length,
					discoveryStatus: "ready",
				});
			} catch {
				const stillTrusted = await this.#trusted(workspaceId, workspaceRoot, server);
				summaries.push({
					id: server.id,
					workspaceId,
					name: server.name ?? server.id,
					transport,
					readOnly: server.readOnly,
					trusted: stillTrusted,
					toolCount: 0,
					discoveryStatus: stillTrusted ? "failed" : "untrusted",
				});
			}
		}
		return summaries;
	}

	async get(workspaceId: string, workspaceRoot: string, serverId: string): Promise<McpServer> {
		const server = (await this.#servers(workspaceRoot)).find((candidate) => candidate.id === serverId);
		if (!server)
			throw Object.assign(new Error(`MCP server ${serverId} was not found`), {
				protocolCode: "not_found",
			});
		if (!server.enabled) {
			return {
				id: server.id,
				workspaceId,
				name: server.name ?? server.id,
				transport: server.transport,
				readOnly: server.readOnly,
				trusted: await this.#trusted(workspaceId, workspaceRoot, server),
				toolCount: 0,
				tools: [],
				discoveryStatus: "disabled",
			};
		}
		if (!(await this.#trusted(workspaceId, workspaceRoot, server))) {
			return {
				id: server.id,
				workspaceId,
				name: server.name ?? server.id,
				transport: server.transport,
				readOnly: server.readOnly,
				trusted: false,
				toolCount: 0,
				tools: [],
				discoveryStatus: "untrusted",
			};
		}
		const tools = exposedTools(server, await this.#listServerTools(workspaceId, server, workspaceRoot, true));
		return {
			id: server.id,
			workspaceId,
			name: server.name ?? server.id,
			transport: server.transport,
			readOnly: server.readOnly,
			trusted: true,
			toolCount: tools.length,
			tools,
			discoveryStatus: "ready",
		};
	}

	async configurationKey(workspaceId: string, workspaceRoot: string): Promise<string> {
		const servers = await this.#servers(workspaceRoot);
		const entries = await Promise.all(
			servers.map(async (server) => ({
				config: configurationDigest(server),
				trusted: await this.#trusted(workspaceId, workspaceRoot, server),
			}))
		);
		return createHash("sha256").update(stableJson(entries)).digest("hex");
	}

	async getConfiguration(workspaceRoot: string, serverId: string): Promise<PublicMcpConfiguration> {
		const server = (await this.#servers(workspaceRoot)).find((entry) => entry.id === serverId);
		if (!server) throw Object.assign(new Error("MCP server was not found"), { protocolCode: "not_found" });
		const config = serializableServer(server);
		// Null retains a stored credential during editing; omission deletes it.
		const field = server.transport === "stdio" ? "env" : "headers";
		const values = server.transport === "stdio" ? server.env : server.headers;
		return { ...config, [field]: Object.fromEntries(Object.keys(values).map((key) => [key, null])) };
	}

	async removeServer(workspaceId: string, workspaceRoot: string, serverId: string): Promise<void> {
		return this.#mutate(workspaceRoot, () => this.#removeServer(workspaceRoot, serverId));
	}

	async #removeServer(workspaceRoot: string, serverId: string): Promise<void> {
		const root = resolve(workspaceRoot);
		const servers = await this.#servers(root);
		if (!servers.some((server) => server.id === serverId))
			throw Object.assign(new Error("MCP server was not found"), { protocolCode: "not_found" });
		await this.#setLocalTrust(root, serverId, false);
		const remaining = servers.filter((server) => server.id !== serverId);
		await writeConfig(root, remaining);
		this.#reconcileConnections(root, remaining);
	}

	async configureServer(
		workspaceId: string,
		workspaceRoot: string,
		configuration: McpServerConfiguration
	): Promise<McpServer> {
		return this.#mutate(workspaceRoot, () => this.#configureServer(workspaceId, workspaceRoot, configuration));
	}

	async #configureServer(
		workspaceId: string,
		workspaceRoot: string,
		configuration: McpServerConfiguration
	): Promise<McpServer> {
		if (!plainRecord(configuration)) throw configError("MCP server configuration must be an object");
		const root = resolve(workspaceRoot);
		const current = await this.#servers(root);
		const previous = current.find((server) => server.id === configuration.id);
		const restored = { ...configuration };
		for (const field of ["env", "headers"] as const) {
			const values = plainRecord(configuration[field]);
			if (!values) continue;
			const saved =
				previous?.transport === "stdio" && field === "env"
					? previous.env
					: previous && previous.transport !== "stdio" && field === "headers"
						? previous.headers
						: undefined;
			restored[field] = Object.fromEntries(
				Object.entries(values).map(([key, value]) => {
					if (value !== null) return [key, value];
					if (!saved || !Object.hasOwn(saved, key)) throw configError("No saved value exists for this MCP credential");
					return [key, saved[key]];
				})
			);
		}
		let raw: string;
		try {
			raw = JSON.stringify({ servers: [restored] });
		} catch {
			throw configError("MCP server configuration is not serializable");
		}
		const candidate = parseConfig(raw)[0];
		if (!candidate) throw configError("MCP server configuration is empty");
		const next = [...current.filter((server) => server.id !== candidate.id), candidate];
		if (next.length > MAX_SERVERS) throw configError("MCP cannot contain more than 32 servers");
		// Configuration changes always require a fresh local trust decision.
		await this.#setLocalTrust(root, candidate.id, false);
		await writeConfig(root, next);
		this.#reconcileConnections(root, next);
		return this.get(workspaceId, root, candidate.id);
	}

	async setEnabled(workspaceId: string, workspaceRoot: string, serverId: string, enabled: boolean): Promise<McpServer> {
		return this.#mutate(workspaceRoot, async () => {
			const root = resolve(workspaceRoot);
			const servers = await this.#servers(root);
			const previous = servers.find((server) => server.id === serverId);
			if (!previous) throw Object.assign(new Error("MCP server was not found"), { protocolCode: "not_found" });
			if (previous.enabled !== enabled) {
				const next = { ...previous, enabled };
				// Carry forward only an existing local grant for this exact configuration.
				// A failed write can lose trust, but cannot authorize an edited configuration.
				const locallyTrusted = this.#localTrust.get(root)?.get(serverId) === configurationDigest(previous);
				await this.#setLocalTrust(root, serverId, locallyTrusted, next);
				const updated = servers.map((server) => (server.id === serverId ? next : server));
				await writeConfig(root, updated);
				this.#reconcileConnections(root, updated);
			}
			try {
				return await this.get(workspaceId, root, serverId);
			} catch {
				// Enabling is persisted even if discovery fails; report the resulting state.
				const server = (await this.#servers(root)).find((entry) => entry.id === serverId);
				if (!server) throw Object.assign(new Error("MCP server was not found"), { protocolCode: "not_found" });
				const trusted = await this.#trusted(workspaceId, root, server);
				return {
					id: server.id,
					workspaceId,
					name: server.name ?? server.id,
					transport: server.transport,
					readOnly: server.readOnly,
					trusted,
					toolCount: 0,
					tools: [],
					discoveryStatus: !server.enabled ? "disabled" : trusted ? "failed" : "untrusted",
				};
			}
		});
	}

	async trustServer(workspaceId: string, workspaceRoot: string, serverId: string): Promise<McpServer> {
		return this.#mutate(workspaceRoot, () => this.#trustServer(workspaceId, workspaceRoot, serverId));
	}

	async #trustServer(workspaceId: string, workspaceRoot: string, serverId: string): Promise<McpServer> {
		const root = resolve(workspaceRoot);
		const server = (await this.#servers(root)).find((candidate) => candidate.id === serverId);
		if (!server) throw Object.assign(new Error(`MCP server ${serverId} was not found`), { protocolCode: "not_found" });
		await this.#setLocalTrust(root, serverId, true, server);
		return this.get(workspaceId, root, serverId);
	}

	async untrustServer(workspaceId: string, workspaceRoot: string, serverId: string): Promise<McpServer> {
		return this.#mutate(workspaceRoot, () => this.#untrustServer(workspaceId, workspaceRoot, serverId));
	}

	async #untrustServer(workspaceId: string, workspaceRoot: string, serverId: string): Promise<McpServer> {
		const root = resolve(workspaceRoot);
		const server = (await this.#servers(root)).find((candidate) => candidate.id === serverId);
		if (server && this.#isTrusted(workspaceId, serverId))
			return this.#configureServer(workspaceId, root, { ...serializableServer(server), enabled: false });
		if (!server) throw Object.assign(new Error(`MCP server ${serverId} was not found`), { protocolCode: "not_found" });
		await this.#setLocalTrust(root, serverId, false);
		this.#connections.get(`${root}\0${serverId}`)?.connection.close();
		this.#invalidateDiscovery(`${root}\0${serverId}`);
		return this.get(workspaceId, root, serverId);
	}

	async createTools(snapshot: SessionSnapshot, approvals: ApprovalBroker): Promise<ToolDefinition[]> {
		const workspaceRoot = this.#resolveWorkspace?.(snapshot.session.workspaceId) ?? resolve(process.cwd());
		const assertServerCurrent = (server: McpConfigServer) =>
			this.#assertServerCurrent(snapshot.session.workspaceId, workspaceRoot, server);
		const callServerTool = (server: McpConfigServer, name: string, argumentsValue: unknown, signal?: AbortSignal) =>
			this.#callServerTool(snapshot.session.workspaceId, server, workspaceRoot, name, argumentsValue, signal);
		const servers = await this.#servers(workspaceRoot);
		const tools: ToolDefinition[] = [];
		for (const server of servers) {
			if (!server.enabled || !(await this.#trusted(snapshot.session.workspaceId, workspaceRoot, server))) continue;
			let summaries: McpToolSummary[];
			try {
				summaries = exposedTools(
					server,
					await this.#listServerTools(snapshot.session.workspaceId, server, workspaceRoot)
				);
			} catch {
				continue;
			}
			for (const summary of summaries) {
				const parameters =
					summary.inputSchema && typeof summary.inputSchema === "object"
						? Type.Unsafe(summary.inputSchema)
						: Type.Object({});
				tools.push(
					defineTool({
						name: toolId(server.id, summary.name),
						label: `${server.name ?? server.id}/${summary.name}`.slice(0, 200),
						description: summary.description ?? `MCP tool ${summary.name}`,
						promptSnippet: `Call MCP ${server.name ?? server.id}/${summary.name}`,
						parameters,
						async execute(toolCallId, params, signal) {
							if (signal?.aborted) throw abortReason(signal);
							await assertServerCurrent(server);
							const permit = await approvals.authorize({
								sessionId: snapshot.session.id,
								toolCallId,
								risk: server.readOnly ? "low" : "high",
								summary: `MCP ${server.name ?? server.id}/${summary.name}`,
								capabilities: [
									{
										type: "mcp.call",
										serverId: server.id,
										toolName: summary.name,
										readOnly: server.readOnly,
									},
								],
								...(signal ? { signal } : {}),
							});
							const startedAt = Date.now();
							try {
								const result = await callServerTool(server, summary.name, params, signal);
								const details = {
									mcpServerId: server.id,
									mcpToolName: summary.name,
									durationMs: Math.max(0, Date.now() - startedAt),
									mcpStatus: result.isError ? "error" : "complete",
								};
								if (result.isError) throw Object.assign(new Error(result.content), { details });
								return { content: [{ type: "text" as const, text: result.content }], details };
							} catch (error) {
								if (error && typeof error === "object" && !("details" in error)) {
									Object.assign(error, {
										details: {
											mcpServerId: server.id,
											mcpToolName: summary.name,
											durationMs: Math.max(0, Date.now() - startedAt),
											mcpStatus: signal?.aborted ? "aborted" : "error",
										},
									});
								}
								throw error;
							} finally {
								if (permit) approvals.completeAuthorization?.(permit);
							}
						},
					})
				);
			}
		}
		return tools;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		for (const { connection } of this.#connections.values()) connection.close();
		this.#connections.clear();
	}
}

async function authorizeMcpManagement(
	approvals: ApprovalBroker,
	snapshot: SessionSnapshot,
	toolCallId: string,
	serverId: string,
	action: "configure" | "trust" | "untrust",
	summary: string,
	signal?: AbortSignal
) {
	return approvals.authorize({
		requireExplicitApproval: true,
		sessionId: snapshot.session.id,
		toolCallId,
		risk: "high",
		summary,
		capabilities: [{ type: "mcp.manage", serverId, action }],
		...(signal ? { signal } : {}),
	});
}

export function createMcpManagementTools(
	catalog: FileMcpCatalog,
	snapshot: SessionSnapshot,
	approvals: ApprovalBroker
): ToolDefinition[] {
	const workspaceRoot = catalog.workspaceRoot(snapshot.session.workspaceId);
	return [
		defineTool({
			name: "mcp_list",
			label: "List local MCP servers",
			description:
				"List MCP servers configured in the user's local workspace. This reads local metadata only and never starts an untrusted server.",
			promptSnippet: "Inspect the user's local MCP configuration",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, signal) {
				signal?.throwIfAborted();
				const servers = await catalog.list(snapshot.session.workspaceId, workspaceRoot);
				return {
					content: [{ type: "text", text: JSON.stringify({ servers }) }],
					details: { localOnly: true, count: servers.length },
				};
			},
		}),
		defineTool({
			name: "mcp_configure",
			label: "Configure local MCP",
			description:
				"Create or replace one MCP server in the user's local .wuming/mcp.json, then trust it locally and verify its tool catalog. The config must be a JSON object for one server with id, transport, and either stdio command or HTTP url. Do not ask users to send secrets in chat; credentials can be entered in the MCP settings form (stored in the local configuration file, not a keychain). Newly configured tools become available on the next user message in this conversation.",
			promptSnippet: "Configure and verify one MCP server in the user's local workspace",
			parameters: Type.Object({
				config: Type.String({ minLength: 2, maxLength: MAX_CONFIG_BYTES }),
			}),
			async execute(toolCallId, params, signal) {
				signal?.throwIfAborted();
				let record: Record<string, unknown>;
				let serverId: string;
				try {
					const parsed = JSON.parse(params.config) as unknown;
					const candidate = plainRecord(parsed);
					if (!candidate) throw new Error("not an object");
					record = candidate;
					serverId = parseConfig(JSON.stringify({ servers: [candidate] }))[0]!.id;
				} catch {
					throw configError("MCP configuration must be a valid single-server JSON object");
				}
				const permit = await authorizeMcpManagement(
					approvals,
					snapshot,
					toolCallId,
					serverId,
					"configure",
					`Configure and start local MCP server ${serverId}`,
					signal
				);
				try {
					const configured = await catalog.configureServer(snapshot.session.workspaceId, workspaceRoot, record);
					const trusted = await catalog.trustServer(snapshot.session.workspaceId, workspaceRoot, configured.id);
					return {
						content: [{ type: "text", text: JSON.stringify({ server: trusted, localOnly: true }) }],
						details: { localOnly: true, serverId: trusted.id, configured: true },
					};
				} finally {
					if (permit) approvals.completeAuthorization?.(permit);
				}
			},
		}),
		defineTool({
			name: "mcp_trust",
			label: "Trust local MCP",
			description:
				"Trust one already-configured MCP server in the user's local workspace, start it if needed, and verify its tools. This changes only the local MCP permission file.",
			promptSnippet: "Allow one configured local MCP server to run",
			parameters: Type.Object({ serverId: Type.String({ minLength: 1, maxLength: 100 }) }),
			async execute(toolCallId, params, signal) {
				signal?.throwIfAborted();
				if (!validId(params.serverId)) throw configError("MCP server id is invalid");
				const permit = await authorizeMcpManagement(
					approvals,
					snapshot,
					toolCallId,
					params.serverId,
					"trust",
					`Trust local MCP server ${params.serverId}`,
					signal
				);
				try {
					const server = await catalog.trustServer(snapshot.session.workspaceId, workspaceRoot, params.serverId);
					return {
						content: [{ type: "text", text: JSON.stringify({ server, localOnly: true }) }],
						details: { localOnly: true, serverId: server.id, trusted: true },
					};
				} finally {
					if (permit) approvals.completeAuthorization?.(permit);
				}
			},
		}),
		defineTool({
			name: "mcp_untrust",
			label: "Disable local MCP",
			description:
				"Disable one local MCP server by removing its local trust permission and closing its process. The configuration remains on disk for later reuse.",
			promptSnippet: "Disable one local MCP server without deleting its config",
			parameters: Type.Object({ serverId: Type.String({ minLength: 1, maxLength: 100 }) }),
			async execute(toolCallId, params, signal) {
				signal?.throwIfAborted();
				if (!validId(params.serverId)) throw configError("MCP server id is invalid");
				const permit = await authorizeMcpManagement(
					approvals,
					snapshot,
					toolCallId,
					params.serverId,
					"untrust",
					`Disable local MCP server ${params.serverId}`,
					signal
				);
				try {
					const server = await catalog.untrustServer(snapshot.session.workspaceId, workspaceRoot, params.serverId);
					return {
						content: [{ type: "text", text: JSON.stringify({ server, localOnly: true }) }],
						details: { localOnly: true, serverId: server.id, trusted: false },
					};
				} finally {
					if (permit) approvals.completeAuthorization?.(permit);
				}
			},
		}),
	];
}

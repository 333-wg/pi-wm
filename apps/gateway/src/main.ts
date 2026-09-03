import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "@wuming/artifacts";
import type { AgentRuntime } from "@wuming/orchestrator";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { ApprovalRequest, Capability, ModelMetadata, ModelRef, TranscriptItem, Usage, WorkspaceSummary } from "@wuming/protocol";
import { StaticTokenAuth } from "./auth.js";
import { createAgencyTools, type SubagentRunner } from "./agency.js";
import { configuredMcpTrust, configuredModels, configuredWebSearch, configuredWorkspaces } from "./configuration.js";
import { GatewayServer, type ApprovalResponder } from "./server.js";
import { FileSkillCatalog } from "./skills.js";
import { FileMcpCatalog } from "./mcp.js";
import { TerminalManager } from "./terminal.js";
import { createConsoleStructuredLogger } from "./logging.js";
import { createBuiltinToolCatalog } from "./tools.js";
import { CustomModelRegistry, loadOrCreateModelEncryptionKey } from "./custom-models.js";
import { ImportedProjectCatalog } from "./projects.js";
import { showLocalProjectPicker } from "./local-picker.js";

function envPath(value: string | undefined, fallback: string): string {
	const selected = value ?? fallback;
	return isAbsolute(selected) ? selected : resolve(process.cwd(), selected);
}

function envPositiveNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
	return value;
}

function envNonNegativeNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
	return value;
}

function envBoolean(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new Error(`${name} must be true or false`);
}

/**
 * The uid:gid to run sandbox containers as. The workspace is a bind mount owned by
 * the host user running the gateway, so matching that user keeps files the model
 * creates editable outside the container instead of landing root-owned. `getuid` is
 * POSIX-only; on Windows the Docker VM maps ownership itself, so the image default
 * stands.
 */
function containerUser(): string | undefined {
	const configured = process.env.WUMING_DOCKER_USER;
	if (configured) return configured;
	if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return undefined;
	return `${process.getuid()}:${process.getgid()}`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolveDelay, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const finish = () => {
			signal.removeEventListener("abort", abort);
			resolveDelay();
		};
		const timer = setTimeout(finish, ms);
		const abort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

interface DemoActiveTurn {
	injected: Array<{ mode: "steer" | "follow_up"; text: string }>;
	wake?: () => void;
}

const demoSessionFileBefore = `export interface Session {
	id: string;
	title: string;
}

export function describe(session: Session): string {
	return \`\${session.title} (\${session.id})\`;
}
`;

const demoRichSummary = `## 已完成

给 \`Session\` 加上了 **archived** 字段，并让 \`describe\` 在归档时追加后缀。

1. 读取 \`src/index.ts\` 确认现有结构
2. 编辑接口与 \`describe\`
3. 跑通 \`npm test\`

| 检查 | 结果 |
| --- | --- |
| 类型检查 | 通过 |
| 单元测试 | 4 passed |
| Lint | 失败（见上方工具卡片） |

> Lint 报错来自既有的 \`no-console\`，与本次改动无关。

\`\`\`ts
const suffix = session.archived ? " [已归档]" : "";
\`\`\`

需要我顺手清掉那条 \`console.log\` 吗？`;

// Demo turns report synthetic usage so the console's context meter and cost
// readouts have something real to render; it grows with the transcript the way a
// live session does.
function demoUsage(transcriptLength: number): Usage {
	const inputTokens = 720 + transcriptLength * 260;
	const cacheReadTokens = Math.round(inputTokens * 0.35);
	const outputTokens = 180;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens: 0,
		totalTokens: inputTokens + cacheReadTokens + outputTokens,
		costUsd: Number(((inputTokens + cacheReadTokens) * 0.000_003 + outputTokens * 0.000_015).toFixed(4)),
	};
}

// Fixture turn that exercises every tool card renderer without touching the
// filesystem: /demo-rich returns a canned tool sequence for UI verification.
function demoRichItems(operationId: string, model: ModelRef): TranscriptItem[] {
	const createdAt = Date.now();
	const calls = [
		{
			id: `${operationId}-plan`,
			toolName: "update_plan",
			input: {
				plan: [
					{ step: "摸清 Session 类型和它的调用方", status: "completed" },
					{ step: "给 Session 补上 archived 字段", status: "in_progress" },
					{ step: "为归档行为加一个测试", status: "pending" },
				],
				explanation: "先定位类型定义，再改字段，最后补测试。",
			},
			output: "先定位类型定义，再改字段，最后补测试。\nPlan updated (1/3 done)\n- [x] 摸清 Session 类型和它的调用方\n- [>] 给 Session 补上 archived 字段\n- [ ] 为归档行为加一个测试",
		},
		{
			id: `${operationId}-ls`,
			toolName: "ls",
			input: { path: "src", depth: 2 },
			output: "src: 4 entry(ies)\nsrc/session/\nsrc/index.ts\t1284\nsrc/session/format.ts\t612\nsrc/session/index.ts\t208",
		},
		{
			id: `${operationId}-grep`,
			toolName: "grep",
			input: { pattern: "interface Session", glob: "src/**/*.ts" },
			output: "2 match(es) in 2 file(s); searched 12 file(s)\nsrc/index.ts:3: export interface Session {\nsrc/session/index.ts:1: import type { Session } from \"../index.js\";",
		},
		{
			id: `${operationId}-read`,
			toolName: "read_file",
			input: { path: "src/index.ts", offset: 1, limit: 40 },
			output: demoSessionFileBefore,
		},
		{
			id: `${operationId}-glob`,
			toolName: "glob",
			input: { pattern: "**/*.test.ts", path: "test" },
			output: "2 path(s); visited 9 entry(ies)\ntest/session.test.ts\ntest/format.test.ts",
		},
		{
			id: `${operationId}-subagent`,
			toolName: "subagent",
			input: {
				task: "在 src 与 test 下找出所有构造 Session 字面量的位置。\n只回报文件路径、行号，以及它是否已经带上 archived 字段。",
				name: "session-callers",
				cost_budget_usd: 0.5,
			},
			output: "Subagent session-callers completed using 4210 token(s), $0.0180.\n\n三处构造 Session 字面量：src/session/index.ts:22、test/session.test.ts:8、test/format.test.ts:14，都还没有 archived 字段。前两处依赖默认值即可，第三处显式断言了对象形状，需要一并更新。",
		},
		{
			id: `${operationId}-edit`,
			toolName: "edit",
			input: {
				path: "src/index.ts",
				edits: [
					{ oldText: "export interface Session {\n\tid: string;\n\ttitle: string;\n}", newText: "export interface Session {\n\tid: string;\n\ttitle: string;\n\tarchived: boolean;\n}" },
					{ oldText: "\treturn `${session.title} (${session.id})`;", newText: "\tconst suffix = session.archived ? \" [已归档]\" : \"\";\n\treturn `${session.title} (${session.id})${suffix}`;" },
				],
			},
			output: "已应用 2 处修改，写入 src/index.ts。",
		},
		{
			id: `${operationId}-write`,
			toolName: "write_file",
			input: { path: "src/archive.ts", content: "import type { Session } from \"./index.js\";\n\nexport function archive(session: Session): Session {\n\treturn { ...session, archived: true };\n}\n" },
			output: "已创建 src/archive.ts（5 行）。",
		},
		{
			id: `${operationId}-exec`,
			toolName: "exec",
			input: { command: "npm test --silent", timeout: 120000 },
			output: "> tsx --test test/*.ts\n\nTAP version 13\nok 1 - describe 附加归档后缀\nok 2 - archive 返回新对象\n# pass 4\n# fail 0",
		},
		{
			id: `${operationId}-search`,
			toolName: "web_search",
			input: { query: "typescript satisfies operator 用法" },
			output: "1. TypeScript 4.9 Release Notes — satisfies 在保留字面量推断的同时校验类型。\n2. TS Handbook — 与 as const 的组合用法。",
		},
		{
			id: `${operationId}-mcp`,
			toolName: "mcp__github__create_issue",
			input: { repo: "wuming/agent", title: "清理 src/index.ts 里的 console.log", labels: ["chore", "lint"] },
			output: "已创建 issue #482。",
		},
	];
	const items: TranscriptItem[] = [
		{
			id: `${operationId}-intro`,
			type: "assistant",
			createdAt,
			status: "complete",
			model,
			content: [
				{ type: "text", text: "先列个计划：摸清 `Session` 的结构和调用方，再补归档字段，最后加测试。" },
				...calls.map((call) => ({ type: "tool_call" as const, toolCallId: call.id, toolName: call.toolName, input: call.input })),
				{ type: "tool_call" as const, toolCallId: `${operationId}-lint`, toolName: "exec", input: { command: "npm run lint" } },
			],
		},
	];
	for (const [index, call] of calls.entries()) {
		items.push({
			id: `${operationId}-tool-${index}`,
			type: "tool",
			createdAt: createdAt + index + 1,
			toolCallId: call.id,
			toolName: call.toolName,
			status: "complete",
			input: call.input,
			content: [{ type: "text", text: call.output }],
			isError: false,
		});
	}
	items.push({
		id: `${operationId}-tool-lint`,
		type: "tool",
		createdAt: createdAt + calls.length + 1,
		toolCallId: `${operationId}-lint`,
		toolName: "exec",
		status: "error",
		input: { command: "npm run lint" },
		content: [{ type: "text", text: "src/index.ts:12:2  error  Unexpected console statement  no-console\n\n1 problem (1 error, 0 warnings)" }],
		isError: true,
	});
	items.push({
		id: `${operationId}-summary`,
		type: "assistant",
		createdAt: createdAt + calls.length + 2,
		status: "complete",
		model,
		content: [{ type: "text", text: demoRichSummary }],
	});
	return items;
}

class DemoRuntime implements AgentRuntime {
	readonly #active = new Map<string, DemoActiveTurn>();

	constructor(
		private readonly requestApproval?: (input: {
			sessionId: string;
			toolCallId: string;
			signal: AbortSignal;
		}) => Promise<void>,
	) {}

	async executeTurn(input: Parameters<AgentRuntime["executeTurn"]>[0]) {
		const text = input.operation.payload.content
			.filter((part): part is Extract<(typeof input.operation.payload.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join(" ");
		const active: DemoActiveTurn = { injected: [] };
		this.#active.set(input.operation.sessionId, active);
		try {
			if (text.trim() === "/retry-once" && input.operation.attempt === 1) {
				return {
					items: [],
					usage: { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7, costUsd: 0.01 },
					failure: { code: "runtime_error" as const, message: "Simulated transient provider failure", retryable: true },
				};
			}
			if (text.trim() === "/approval" && this.requestApproval) {
				await this.requestApproval({
					sessionId: input.operation.sessionId,
					toolCallId: `demo-approval-${input.operation.id}`,
					signal: input.signal,
				});
			}
			if (text.trim() === "/inject") await this.#waitForInjection(active, input.signal);
			if (text.trim() === "/demo-rich") {
				await delay(120, input.signal);
				return {
					items: demoRichItems(input.operation.id, input.snapshot.model),
					usage: { inputTokens: 1840, outputTokens: 612, cacheReadTokens: 1024, cacheWriteTokens: 0, totalTokens: 2452, costUsd: 0.031 },
				};
			}
			const answer = text.trim().startsWith("Review the candidate result against the goal")
				? JSON.stringify({ verdict: "pass", feedback: "Demo reviewer accepted the candidate result." })
				: text.trim() === "/long"
				? Array.from({ length: 600 }, (_, index) => `demo-step-${index + 1}`).join(" ")
				: text.trim() === "/inject"
					? `Active ${active.injected[0]?.mode ?? "instruction"} received: ${active.injected[0]?.text ?? ""}`
					: text
						? text.trim() === "/retry-once"
							? "Demo provider recovered after retry."
							: text.trim() === "/approval"
							? "Demo approval was granted. No filesystem or process action was executed."
							: `Demo runtime received: ${text}\n\nConfigure WUMING_RUNTIME=pi and server-side model credentials to run the real Pi agent.`
						: "Demo runtime is connected.";
			const itemId = `demo-${input.operation.id}`;
			for (const [index, chunk] of answer.match(/.{1,18}/gs)?.entries() ?? []) {
				await delay(text.trim() === "/long" ? 45 : 18, input.signal);
				input.onProgress({
					type: "assistant.delta",
					sessionId: input.operation.sessionId,
					itemId,
					streamSeq: index,
					contentIndex: 0,
					kind: "text",
					delta: chunk,
				});
			}
			const injectionSummary = active.injected.length > 0 && text.trim() !== "/inject"
				? `\n\nInjected: ${active.injected.map((item) => `${item.mode}: ${item.text}`).join("; ")}`
				: "";
			return {
				items: [
					{
						id: itemId,
						type: "assistant" as const,
						createdAt: Date.now(),
						status: "complete" as const,
						content: [{ type: "text" as const, text: answer + injectionSummary }],
						model: input.snapshot.model,
					},
				],
				...(text.trim() === "/retry-once"
					? { usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 17, costUsd: 0.02 } }
					: { usage: demoUsage(input.snapshot.transcript.length) }),
			};
		} finally {
			this.#active.delete(input.operation.sessionId);
		}
	}

	async injectTurn(input: Parameters<NonNullable<AgentRuntime["injectTurn"]>>[0]): Promise<void> {
		if (input.operation.payload.mode === "prompt") throw new Error("Cannot inject a prompt");
		if (input.signal.aborted) throw input.signal.reason;
		const active = this.#active.get(input.operation.sessionId);
		if (!active) throw new Error("Demo session is no longer active");
		const text = input.operation.payload.content
			.filter((part): part is Extract<(typeof input.operation.payload.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join(" ");
		active.injected.push({ mode: input.operation.payload.mode, text });
		active.wake?.();
	}

	async #waitForInjection(active: DemoActiveTurn, signal: AbortSignal): Promise<void> {
		if (active.injected.length > 0) return;
		await new Promise<void>((resolve, reject) => {
			const finish = () => {
				signal.removeEventListener("abort", abort);
				delete active.wake;
				resolve();
			};
			const abort = () => {
				delete active.wake;
				reject(signal.reason);
			};
			active.wake = finish;
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		});
	}
}

async function main(): Promise<void> {
	const configuredLogLevel = process.env.WUMING_LOG_LEVEL ?? "info";
	if (!["debug", "info", "warn", "error"].includes(configuredLogLevel)) throw new Error("WUMING_LOG_LEVEL must be debug, info, warn, or error");
	const logger = createConsoleStructuredLogger({ level: configuredLogLevel as "debug" | "info" | "warn" | "error" });
	const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
	const host = process.env.WUMING_HOST ?? "127.0.0.1";
	const port = Number(process.env.WUMING_PORT ?? "8787");
	const token = process.env.WUMING_TOKEN ?? "wuming";
	const dataDir = envPath(process.env.WUMING_DATA_DIR, join(projectRoot, ".wuming-data"));
	mkdirSync(dataDir, { recursive: true });
	const fallbackWorkspacePath = envPath(process.env.WUMING_WORKSPACE, process.env.INIT_CWD ?? projectRoot);
	const importedProjects = await ImportedProjectCatalog.open(join(dataDir, "projects"), {
		maxFiles: envPositiveNumber("WUMING_PROJECT_MAX_FILES", 10_000),
		maxTotalBytes: envPositiveNumber("WUMING_PROJECT_MAX_BYTES", 512 * 1024 * 1024),
	});
	const workspaceConfigurations = [...configuredWorkspaces(fallbackWorkspacePath), ...importedProjects.configurations()];
	const workspacePaths = new Map(workspaceConfigurations.map((workspace) => [workspace.id, workspace.path]));

	const runtimeMode = process.env.WUMING_RUNTIME ?? "pi";
	if (runtimeMode !== "pi" && runtimeMode !== "demo") throw new Error("WUMING_RUNTIME must be pi or demo");
	const provider = process.env.WUMING_MODEL_PROVIDER ?? (runtimeMode === "demo" ? "demo" : "unconfigured");
	const modelId = process.env.WUMING_MODEL_ID ?? (runtimeMode === "demo" ? "wuming-demo" : "unconfigured");
	const modelEncryptionKey = runtimeMode === "pi"
		? await loadOrCreateModelEncryptionKey(join(dataDir, "custom-models.key"), process.env.WUMING_MODEL_CONFIG_KEY)
		: undefined;
	const customModels = runtimeMode === "pi"
		? new CustomModelRegistry({ filePath: join(dataDir, "custom-models.enc"), encryptionKey: modelEncryptionKey! })
		: undefined;
	if (customModels) await customModels.load();
	const now = Date.now();
	const workspaces: WorkspaceSummary[] = workspaceConfigurations.map((workspace) => ({
		id: workspace.id,
		name: workspace.name,
		status: "ready",
		createdAt: now,
		updatedAt: now,
	}));
	const defaultModel: ModelMetadata = {
		model: { provider, id: modelId },
		name: process.env.WUMING_MODEL_NAME ?? (runtimeMode === "pi" ? modelId : "Wuming Demo"),
		reasoning: runtimeMode === "pi",
		input: ["text", "image"],
		contextWindow: Number(process.env.WUMING_CONTEXT_WINDOW ?? "200000"),
		maxOutputTokens: Number(process.env.WUMING_MAX_OUTPUT_TOKENS ?? "32000"),
		authenticated: true,
	};
	const hasEnvironmentModel = Boolean(process.env.WUMING_MODEL_PROVIDER?.trim() && process.env.WUMING_MODEL_ID?.trim());
	const models = runtimeMode === "demo" || process.env.WUMING_MODELS_JSON !== undefined || hasEnvironmentModel
		? configuredModels(defaultModel)
		: [];
	const workspacePathFor = (workspaceId: string): string => {
		const path = workspacePaths.get(workspaceId);
		if (!path) throw Object.assign(new Error("Unknown workspace"), { code: "forbidden" });
		return path;
	};

	const store = new SqliteOrchestratorStore(join(dataDir, "wuming.db"));
	const maxArtifactBytes = envPositiveNumber("WUMING_MAX_ARTIFACT_BYTES", 10 * 1024 * 1024);
	const maxTextArtifactBytes = envPositiveNumber("WUMING_MAX_TEXT_ARTIFACT_BYTES", 2 * 1024 * 1024);
	const artifacts = await ArtifactStore.open(join(dataDir, "artifacts.db"), join(dataDir, "artifacts"), {
		maxFileBytes: maxArtifactBytes,
		maxImageBytes: maxArtifactBytes,
		maxTextBytes: maxTextArtifactBytes,
		maxImagePixels: envPositiveNumber("WUMING_MAX_IMAGE_PIXELS", 40_000_000),
		maxExtractedTextChars: envPositiveNumber("WUMING_MAX_EXTRACTED_TEXT_CHARS", 200_000),
	});
	const { ApprovalBroker, WorkspaceInspector } = await import("@wuming/sandbox");
	let handleRecoveredDecision: ((approval: ApprovalRequest) => void) | undefined;
	const approvalBroker = new ApprovalBroker({
		store,
		onRecoveredDecision: (approval) => handleRecoveredDecision?.(approval),
	});
	const workspaceInspectors = new Map<string, Awaited<ReturnType<typeof WorkspaceInspector.create>>>();
	const inspectionOptions = {
		maxEntries: envPositiveNumber("WUMING_MAX_DIRECTORY_ENTRIES", 2000),
		maxFileBytes: envPositiveNumber("WUMING_MAX_FILE_PREVIEW_BYTES", 1024 * 1024),
		maxGitBytes: envPositiveNumber("WUMING_MAX_GIT_OUTPUT_BYTES", 2 * 1024 * 1024),
		gitTimeoutMs: envPositiveNumber("WUMING_GIT_TIMEOUT_MS", 10_000),
	};
	const registerWorkspaceInspector = async (workspace: { id: string; path: string }) => {
		workspaceInspectors.set(workspace.id, await WorkspaceInspector.create(workspace.path, inspectionOptions));
	};
	for (const workspace of workspaceConfigurations) {
		await registerWorkspaceInspector(workspace);
	}
	const workspaceInspectorFor = (workspaceId: string) => {
		const inspector = workspaceInspectors.get(workspaceId);
		if (!inspector) throw new Error("Unknown workspace");
		return inspector;
	};
	const terminalMode = process.env.WUMING_TERMINAL_MODE ?? (runtimeMode === "demo" ? "host" : "disabled");
	const terminal = terminalMode === "host" || terminalMode === "docker"
		? new TerminalManager({
				workspaceRoot: workspaceConfigurations[0]!.path,
				mode: terminalMode,
				...(process.env.WUMING_DOCKER_IMAGE ? { dockerImage: process.env.WUMING_DOCKER_IMAGE } : {}),
				...(process.env.WUMING_DOCKER_EXECUTABLE ? { dockerExecutable: process.env.WUMING_DOCKER_EXECUTABLE } : {}),
				idleTimeoutMs: envPositiveNumber("WUMING_TERMINAL_IDLE_TIMEOUT_MS", 15 * 60_000),
				maxTerminals: envPositiveNumber("WUMING_MAX_TERMINALS", 8),
				assertWorkspace: workspacePathFor,
			})
		: undefined;
	const skillCatalog = new FileSkillCatalog();
	const trustedMcpServers = configuredMcpTrust();
	const mcpCatalog = new FileMcpCatalog({
		resolveWorkspace: workspacePathFor,
		isTrusted: (workspaceId, serverId) => trustedMcpServers.has(`${workspaceId}\0${serverId}`),
	});
	let runtime: AgentRuntime;
	// The Pi session factory closes over this before the orchestrator exists, and the
	// orchestrator needs the runtime to be constructed; the model-facing `subagent`
	// tool therefore reads the runner from here at tool-creation time.
	const agency: { runner?: SubagentRunner } = {};
	const approvals: ApprovalResponder = approvalBroker;
	let registerRuntimeWorkspace: (workspace: { id: string; path: string }) => Promise<void> = async () => undefined;
	if (runtimeMode === "pi") {
		const { createDefaultPiSessionFactory, PiAgentRuntime } = await import("@wuming/pi-adapter");
		const { createSandboxTools, DockerProcessSandbox, SafeWebClient, WorkspaceFileExecutor, WorkspaceSearcher } = await import("@wuming/sandbox");
		const agentDir = envPath(process.env.WUMING_AGENT_DIR, join(homedir(), ".pi", "agent"));
		const dockerImage = process.env.WUMING_DOCKER_IMAGE;
		const dockerUser = containerUser();
		// Container limits are deployment-shaped: a real build needs far more room
		// than a smoke test, and only the operator knows what the host can spare.
		// The network stays off unless this deployment asks for it.
		const dockerOptions = {
			allowMutableImage: envBoolean("WUMING_DOCKER_ALLOW_MUTABLE_IMAGE", false),
			network: process.env.WUMING_DOCKER_NETWORK ?? "none",
			allowHostNetwork: envBoolean("WUMING_DOCKER_ALLOW_HOST_NETWORK", false),
			defaultTimeoutMs: envPositiveNumber("WUMING_DOCKER_TIMEOUT_MS", 300_000),
			maxTimeoutMs: envPositiveNumber("WUMING_DOCKER_MAX_TIMEOUT_MS", 30 * 60_000),
			maxOutputBytes: envPositiveNumber("WUMING_DOCKER_MAX_OUTPUT_BYTES", 1024 * 1024),
			cpus: envPositiveNumber("WUMING_DOCKER_CPUS", 2),
			memory: process.env.WUMING_DOCKER_MEMORY ?? "2g",
			pidsLimit: envPositiveNumber("WUMING_DOCKER_PIDS_LIMIT", 512),
			tmpfsSize: process.env.WUMING_DOCKER_TMPFS_SIZE ?? "512m",
			homeSize: process.env.WUMING_DOCKER_HOME_SIZE ?? "512m",
			...(process.env.WUMING_DOCKER_HOME ? { home: process.env.WUMING_DOCKER_HOME } : {}),
			...(process.env.WUMING_DOCKER_CACHE_VOLUME ? { homeVolume: process.env.WUMING_DOCKER_CACHE_VOLUME } : {}),
			...(dockerUser ? { user: dockerUser } : {}),
			...(process.env.WUMING_DOCKER_EXECUTABLE ? { dockerExecutable: process.env.WUMING_DOCKER_EXECUTABLE } : {}),
		};
		const search = configuredWebSearch();
		const web = new SafeWebClient({
			...(search ? { search } : {}),
			timeoutMs: envPositiveNumber("WUMING_WEB_TIMEOUT_MS", 20_000),
			maxResponseBytes: envPositiveNumber("WUMING_WEB_MAX_RESPONSE_BYTES", 2 * 1024 * 1024),
			allowProxyDnsAddresses: envBoolean("WUMING_WEB_ALLOW_PROXY_DNS", false),
		});
		const fileExecutors = new Map<string, Awaited<ReturnType<typeof WorkspaceFileExecutor.create>>>();
		const searchers = new Map<string, Awaited<ReturnType<typeof WorkspaceSearcher.create>>>();
		const processSandboxes = new Map<string, InstanceType<typeof DockerProcessSandbox>>();
		registerRuntimeWorkspace = async (workspace) => {
			const files = await WorkspaceFileExecutor.create(workspace.path);
			fileExecutors.set(workspace.id, files);
			searchers.set(workspace.id, await WorkspaceSearcher.create(workspace.path, {
				maxFiles: envPositiveNumber("WUMING_SEARCH_MAX_FILES", 20_000),
				maxFileBytes: envPositiveNumber("WUMING_SEARCH_MAX_FILE_BYTES", 2 * 1024 * 1024),
				maxTotalReadBytes: envPositiveNumber("WUMING_SEARCH_MAX_READ_BYTES", 64 * 1024 * 1024),
				followGitignore: envBoolean("WUMING_SEARCH_FOLLOW_GITIGNORE", true),
			}));
			if (dockerImage) {
				processSandboxes.set(workspace.id, new DockerProcessSandbox({
					workspaceRoot: files.root,
					image: dockerImage,
					...dockerOptions,
				}));
			}
		};
		for (const workspace of workspaceConfigurations) {
			await registerRuntimeWorkspace(workspace);
		}
		const initialToolChoice = process.env.WUMING_PI_INITIAL_TOOL_CHOICE;
		if (initialToolChoice !== undefined && initialToolChoice !== "required") {
			throw new Error("WUMING_PI_INITIAL_TOOL_CHOICE must be required when set");
		}
		runtime = new PiAgentRuntime({
			resolveArtifact: (artifact, snapshot) => artifacts.resolve(artifact, snapshot),
			resolveSkills: async (snapshot, skillIds) => {
				const root = workspacePathFor(snapshot.session.workspaceId);
				const resolved = [];
				for (const skillId of skillIds.slice(0, 8)) {
					const skill = await skillCatalog.get(snapshot.session.workspaceId, root, skillId);
					resolved.push({ id: skill.id, name: skill.name, content: skill.content });
				}
				return resolved;
			},
			createSession: createDefaultPiSessionFactory({
				agentDir,
				sessionDataDir: join(dataDir, "pi-sessions"),
				resolveWorkspace: workspacePathFor,
				createCustomTools: async (snapshot) => {
					const files = fileExecutors.get(snapshot.session.workspaceId);
					if (!files) throw new Error("Unknown workspace");
					const processSandbox = processSandboxes.get(snapshot.session.workspaceId);
					const sandboxTools = createSandboxTools({
						snapshot,
						executor: {
							files,
							web,
							...(searchers.get(snapshot.session.workspaceId) ? { search: searchers.get(snapshot.session.workspaceId)! } : {}),
							...(processSandbox ? { process: processSandbox } : {}),
						},
						approvals: approvalBroker,
						maxToolOutputChars: envPositiveNumber("WUMING_MAX_TOOL_OUTPUT_CHARS", 200_000),
						maxArtifactOutputBytes: Math.min(
							envPositiveNumber("WUMING_MAX_TOOL_ARTIFACT_BYTES", maxTextArtifactBytes),
							maxTextArtifactBytes,
						),
						artifactWriter: async (input) => (await artifacts.create({
							workspaceId: input.workspaceId,
							ownerId: `session:${input.sessionId}`,
							name: input.name,
							suppliedMimeType: "text/plain",
							content: input.content,
						})).ref,
					});
					const mcpTools = await mcpCatalog.createTools(snapshot, approvalBroker);
					const agencyTools = createAgencyTools({
						snapshot,
						runner: agency.runner,
						maxResultChars: envPositiveNumber("WUMING_MAX_SUBAGENT_REPORT_CHARS", 60_000),
					});
					return [...sandboxTools, ...agencyTools, ...mcpTools];
				},
				...(initialToolChoice === "required" ? { initialToolChoice } : {}),
				registerProviders: () => customModels?.registrations() ?? [],
			}),
		});
	} else {
		runtime = new DemoRuntime(async ({ sessionId, toolCallId, signal }) => {
			const permit = await approvalBroker.authorize({
				sessionId,
				toolCallId,
				risk: "medium",
				summary: "Demo approval check (no external action will run)",
				capabilities: [{ type: "filesystem.write", paths: ["demo-only.txt"] }],
				signal,
			});
			if (permit) approvalBroker.completeAuthorization(permit);
		},
		);
	}

	const orchestrator = new SessionOrchestrator(store, runtime, {
		turnTimeoutMs: envPositiveNumber("WUMING_TURN_TIMEOUT_MS", 20 * 60_000),
		abortGraceMs: envPositiveNumber("WUMING_ABORT_GRACE_MS", 5_000),
		forceTerminateTimeoutMs: envPositiveNumber("WUMING_FORCE_TERMINATE_TIMEOUT_MS", 2_000),
		maxRetries: envNonNegativeNumber("WUMING_MAX_RETRIES", 2),
		retryBaseDelayMs: envNonNegativeNumber("WUMING_RETRY_BASE_DELAY_MS", 1_000),
		...(process.env.WUMING_COST_BUDGET_USD === undefined ? {} : { defaultCostBudgetUsd: envPositiveNumber("WUMING_COST_BUDGET_USD", 1) }),
		logger,
	});
	agency.runner = orchestrator;
	handleRecoveredDecision = (approval) => {
		if (!orchestrator.handleRecoveredApproval(approval)) return;
		logger.log("warn", "gateway.approval.recovered", { sessionId: approval.sessionId, approvalId: approval.id, status: approval.status });
		void orchestrator.drainSession(approval.sessionId)
			.then(() => orchestrator.continueGoalForSession(approval.sessionId))
			.catch((error) => logger.log("error", "gateway.approval.recovery_failed", { sessionId: approval.sessionId, error }));
	};
	store.clearWriterLeases();
	const recoveredInterruptedOperations = orchestrator.recoverInterruptedOperations();
	const recoveredPendingApprovals = approvalBroker.recoverPendingApprovals();
	const reconciledSubagentResults = await orchestrator.reconcileSubagentResults();
	const backfilledSessionNames = (await Promise.all(
		workspaceConfigurations.map((workspace) => orchestrator.backfillSessionNames(workspace.id)),
	)).reduce((total, count) => total + count, 0);
	const searchConfiguration = configuredWebSearch();
	const toolCatalog = createBuiltinToolCatalog({
		runtime: runtimeMode === "pi" ? "pi" : "demo",
		...(process.env.WUMING_DOCKER_IMAGE ? { dockerImage: process.env.WUMING_DOCKER_IMAGE } : {}),
		searchProvider: searchConfiguration?.provider ?? "bing",
	});
	const capabilities: Capability[] = ["session.resume", "session.fork", "subagents", "goals", ...(runtimeMode === "pi" ? ["session.compaction" as const] : []), "turn.steer", "turn.follow_up", "artifact", "image_input", "git", "tools", ...(terminal ? ["terminal" as const] : [])];
	capabilities.push("skills");
	capabilities.push("mcp");
	capabilities.push("approval");
	if (customModels) capabilities.push("model.custom");
	const registerProjectWorkspace = async (workspace: WorkspaceSummary): Promise<WorkspaceSummary> => {
		const configuration = importedProjects.configurations().find((candidate) => candidate.id === workspace.id);
		if (!configuration) throw new Error("Imported project configuration is unavailable");
		if (!workspacePaths.has(configuration.id)) {
			workspacePaths.set(configuration.id, configuration.path);
			await registerWorkspaceInspector(configuration);
			await registerRuntimeWorkspace(configuration);
		}
		if (!workspaces.some((candidate) => candidate.id === workspace.id)) workspaces.push(workspace);
		return workspace;
	};
	const server = new GatewayServer({
		auth: new StaticTokenAuth(token, { id: "local-user", workspaces }),
		orchestrator,
		store,
		approvals,
		artifacts,
		workspace: {
			listDirectory: (workspaceId, path) => {
				return workspaceInspectorFor(workspaceId).listDirectory(path);
			},
			searchFiles: (workspaceId, query, limit) => {
				return workspaceInspectorFor(workspaceId).searchFiles(query, limit);
			},
			readFile: (workspaceId, path) => {
				return workspaceInspectorFor(workspaceId).readFile(path);
			},
			gitStatus: (workspaceId) => {
				return workspaceInspectorFor(workspaceId).gitStatus();
			},
			gitDiff: (workspaceId, path, staged) => {
				return workspaceInspectorFor(workspaceId).gitDiff(path, staged);
			},
		},
		projects: {
			pick: async (_ownerId, kind) => {
				const path = await showLocalProjectPicker(kind);
				return registerProjectWorkspace(await importedProjects.addLocal(path, kind));
			},
			create: (ownerId, name) => importedProjects.create(ownerId, name),
			writeFile: (ownerId, projectId, path, content) => importedProjects.writeProjectFile(ownerId, projectId, path, content),
			complete: async (ownerId, projectId) => {
				const completed = await importedProjects.complete(ownerId, projectId);
				return registerProjectWorkspace(completed.workspace);
			},
			rename: (_ownerId, projectId, name) => importedProjects.renameProject(projectId, name),
			remove: (_ownerId, projectId) => importedProjects.removeProject(projectId),
		},
		skills: skillCatalog,
		mcp: mcpCatalog,
		tools: toolCatalog,
		workspacePath: workspacePathFor,
		...(terminal ? { terminal } : {}),
		maxArtifactBytes,
		models,
		...(customModels ? { customModels } : {}),
		capabilities,
		onError: (error) => logger.log("error", "gateway.unhandled_error", { error }),
		logger,
	});
	const address = await server.listen(port, host);
	console.log(`Wuming gateway listening on http://${address.address}:${address.port}`);
	console.log(`Runtime: ${runtimeMode}; workspaces: ${workspaceConfigurations.map((workspace) => `${workspace.id}=${workspace.path}`).join(", ")}`);
	if (recoveredInterruptedOperations > 0) console.log(`Recovered ${recoveredInterruptedOperations} interrupted operation(s)`);
	if (recoveredPendingApprovals > 0) console.log(`Restored ${recoveredPendingApprovals} pending approval(s)`);
	if (reconciledSubagentResults > 0) console.log(`Published ${reconciledSubagentResults} recovered subagent result(s)`);
	if (backfilledSessionNames > 0) console.log(`Generated titles for ${backfilledSessionNames} existing session(s)`);
	void orchestrator.resumeQueuedSessions()
		.then(() => orchestrator.resumeGoalReviews())
		.catch((error) => logger.log("error", "gateway.queue.recovery_failed", { error }));
	if (runtimeMode === "pi") {
		console.log(`Process sandbox: ${process.env.WUMING_DOCKER_IMAGE ? "Docker" : "disabled (set WUMING_DOCKER_IMAGE)"}`);
	}

	const shutdown = async () => {
		logger.log("info", "gateway.shutdown.started");
		await server.close();
		if (Symbol.asyncDispose in runtime) await (runtime as AgentRuntime & AsyncDisposable)[Symbol.asyncDispose]();
		await mcpCatalog[Symbol.asyncDispose]();
		if (terminal) await terminal[Symbol.asyncDispose]();
		artifacts.close();
		store.close();
		logger.log("info", "gateway.shutdown.completed");
	};
	process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
	process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "@wuming/artifacts";
import type { AgentRuntime } from "@wuming/orchestrator";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { ApprovalRequest, Capability, ModelMetadata, WorkspaceSummary } from "@wuming/protocol";
import { StaticTokenAuth } from "./auth.js";
import { configuredMcpTrust, configuredModels, configuredWebSearch, configuredWorkspaces } from "./configuration.js";
import { GatewayServer, type ApprovalResponder } from "./server.js";
import { FileSkillCatalog } from "./skills.js";
import { FileMcpCatalog } from "./mcp.js";
import { TerminalManager } from "./terminal.js";
import { createConsoleStructuredLogger } from "./logging.js";
import { createBuiltinToolCatalog } from "./tools.js";
import { CustomModelRegistry, loadOrCreateModelEncryptionKey } from "./custom-models.js";

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
			const answer = text.trim() === "/long"
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
				...(text.trim() === "/retry-once" ? { usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 17, costUsd: 0.02 } } : {}),
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
	const token = process.env.WUMING_TOKEN ?? "dev-token";
	const fallbackWorkspacePath = envPath(process.env.WUMING_WORKSPACE, process.env.INIT_CWD ?? projectRoot);
	const workspaceConfigurations = configuredWorkspaces(fallbackWorkspacePath);
	const workspacePaths = new Map(workspaceConfigurations.map((workspace) => [workspace.id, workspace.path]));
	const dataDir = envPath(process.env.WUMING_DATA_DIR, join(projectRoot, ".wuming-data"));
	mkdirSync(dataDir, { recursive: true });

	const provider = process.env.WUMING_MODEL_PROVIDER ?? "demo";
	const modelId = process.env.WUMING_MODEL_ID ?? "wuming-demo";
	const runtimeMode = process.env.WUMING_RUNTIME ?? "demo";
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
	const models = configuredModels(defaultModel);
	const workspacePathFor = (workspaceId: string): string => {
		const path = workspacePaths.get(workspaceId);
		if (!path) throw Object.assign(new Error("Unknown workspace"), { code: "forbidden" });
		return path;
	};

	const store = new SqliteOrchestratorStore(join(dataDir, "wuming.db"));
	const maxArtifactBytes = envPositiveNumber("WUMING_MAX_ARTIFACT_BYTES", 10 * 1024 * 1024);
	const maxTextArtifactBytes = envPositiveNumber("WUMING_MAX_TEXT_ARTIFACT_BYTES", 2 * 1024 * 1024);
	const artifacts = await ArtifactStore.open(join(dataDir, "artifacts.db"), join(dataDir, "artifacts"), {
		maxImageBytes: maxArtifactBytes,
		maxTextBytes: maxTextArtifactBytes,
		maxImagePixels: envPositiveNumber("WUMING_MAX_IMAGE_PIXELS", 40_000_000),
	});
	const { ApprovalBroker, WorkspaceInspector } = await import("@wuming/sandbox");
	let handleRecoveredDecision: ((approval: ApprovalRequest) => void) | undefined;
	const approvalBroker = new ApprovalBroker({
		store,
		onRecoveredDecision: (approval) => handleRecoveredDecision?.(approval),
	});
	const workspaceInspectors = new Map<string, Awaited<ReturnType<typeof WorkspaceInspector.create>>>();
	for (const workspace of workspaceConfigurations) {
		workspaceInspectors.set(workspace.id, await WorkspaceInspector.create(workspace.path, {
			maxEntries: envPositiveNumber("WUMING_MAX_DIRECTORY_ENTRIES", 2000),
			maxFileBytes: envPositiveNumber("WUMING_MAX_FILE_PREVIEW_BYTES", 1024 * 1024),
			maxGitBytes: envPositiveNumber("WUMING_MAX_GIT_OUTPUT_BYTES", 2 * 1024 * 1024),
			gitTimeoutMs: envPositiveNumber("WUMING_GIT_TIMEOUT_MS", 10_000),
		}));
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
	const approvals: ApprovalResponder = approvalBroker;
	if (runtimeMode === "pi") {
		const { createDefaultPiSessionFactory, PiAgentRuntime } = await import("@wuming/pi-adapter");
		const { createSandboxTools, DockerProcessSandbox, SafeWebClient, WorkspaceFileExecutor } = await import("@wuming/sandbox");
		const agentDir = envPath(process.env.WUMING_AGENT_DIR, join(homedir(), ".pi", "agent"));
		const dockerImage = process.env.WUMING_DOCKER_IMAGE;
		const search = configuredWebSearch();
		const web = new SafeWebClient({
			...(search ? { search } : {}),
			timeoutMs: envPositiveNumber("WUMING_WEB_TIMEOUT_MS", 20_000),
			maxResponseBytes: envPositiveNumber("WUMING_WEB_MAX_RESPONSE_BYTES", 2 * 1024 * 1024),
			allowProxyDnsAddresses: envBoolean("WUMING_WEB_ALLOW_PROXY_DNS", false),
		});
		const fileExecutors = new Map<string, Awaited<ReturnType<typeof WorkspaceFileExecutor.create>>>();
		const processSandboxes = new Map<string, InstanceType<typeof DockerProcessSandbox>>();
		for (const workspace of workspaceConfigurations) {
			const files = await WorkspaceFileExecutor.create(workspace.path);
			fileExecutors.set(workspace.id, files);
			if (dockerImage) {
				processSandboxes.set(workspace.id, new DockerProcessSandbox({
					workspaceRoot: files.root,
					image: dockerImage,
					allowMutableImage: process.env.WUMING_DOCKER_ALLOW_MUTABLE_IMAGE === "true",
				}));
			}
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
						executor: { files, web, ...(processSandbox ? { process: processSandbox } : {}) },
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
					return [...sandboxTools, ...mcpTools];
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
	handleRecoveredDecision = (approval) => {
		if (!orchestrator.handleRecoveredApproval(approval)) return;
		logger.log("warn", "gateway.approval.recovered", { sessionId: approval.sessionId, approvalId: approval.id, status: approval.status });
		void orchestrator.drainSession(approval.sessionId).catch((error) => logger.log("error", "gateway.approval.recovery_failed", { sessionId: approval.sessionId, error }));
	};
	store.clearWriterLeases();
	const recoveredInterruptedOperations = orchestrator.recoverInterruptedOperations();
	const recoveredPendingApprovals = approvalBroker.recoverPendingApprovals();
	const reconciledSubagentResults = await orchestrator.reconcileSubagentResults();
	const searchConfiguration = configuredWebSearch();
	const toolCatalog = createBuiltinToolCatalog({
		runtime: runtimeMode === "pi" ? "pi" : "demo",
		...(process.env.WUMING_DOCKER_IMAGE ? { dockerImage: process.env.WUMING_DOCKER_IMAGE } : {}),
		searchProvider: searchConfiguration?.provider ?? "bing",
	});
	const capabilities: Capability[] = ["session.resume", "session.fork", "subagents", ...(runtimeMode === "pi" ? ["session.compaction" as const] : []), "turn.steer", "turn.follow_up", "artifact", "image_input", "git", "tools", ...(terminal ? ["terminal" as const] : [])];
	capabilities.push("skills");
	capabilities.push("mcp");
	capabilities.push("approval");
	if (customModels) capabilities.push("model.custom");
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
	void orchestrator.resumeQueuedSessions().catch((error) => logger.log("error", "gateway.queue.recovery_failed", { error }));
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

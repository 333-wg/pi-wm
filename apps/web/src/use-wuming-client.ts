import { useCallback, useEffect, useRef, useState } from "react";
import { mergeUsageRequests, sessionUsageRequests } from "@wuming/protocol";
import type {
	ApprovalPolicy,
	AutomationRunSummary,
	AutomationSchedule,
	Command,
	CommandResult,
	Capability,
	CustomModelConfig,
	CustomModelConnection,
	CustomModelService,
	MediaKind,
	MediaModelConfig,
	MediaModelDiscoveryConnection,
	EvaluationAttestation,
	EvaluationDataset,
	EvaluationGrader,
	ExecutionEnvironment,
	GoalExecutionMode,
	GoalSummary,
	GoalPlanSpec,
	GoalAutomationSummary,
	ArtifactRef,
	ModelMetadata,
	OfficialAccount,
	ModelRef,
	RunFailureKind,
	RunEvaluation,
	RunSummary,
	SandboxMode,
	ServerMessage,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	UsageOverview,
	UserContentPart,
	WebEvidence,
	WorkspaceSummary,
	Skill,
	SkillSummary,
	McpServer,
	McpServerSummary,
	MemoryAction,
	MemoryRecord,
	SubagentSummary,
	ToolStatus,
} from "@wuming/protocol";
import { workspaceApi } from "./workspace-api.js";
import { readStoredPermission, writeStoredPermission } from "./lib/permission-preference.js";
import { readStoredThinking, thinkingLevelForModel, writeStoredThinking } from "./lib/thinking-preference.js";
import { isImplicitWorkspace } from "./lib/workspaces.js";
import { desktopConnection } from "./lib/desktop.js";
import { bearerProtocol, gatewayWebSocketUrl } from "./lib/gateway-connection.js";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface LiveAssistant {
	id: string;
	order: number;
	text: string;
	thinking: string;
	toolCall: string;
}

interface BufferedAssistantDelta extends LiveAssistant {
	sessionId: string;
}

const STREAM_RENDER_INTERVAL_MS = 30;

export interface LiveTool {
	toolCallId: string;
	toolName: string;
	input: unknown;
	order: number;
	status: "running" | "complete" | "error";
	preview: string;
	truncated: boolean;
	artifact?: ArtifactRef;
	webEvidence?: WebEvidence;
}

export interface LiveGoalActivity {
	goalId: string;
	runSessionId: string;
	order: number;
	phase: "thinking" | "tool" | "retrying";
	text: string;
	thinking: string;
	toolName?: string;
	toolStatus?: "running" | "complete" | "error";
	toolPreview?: string;
	message?: string;
}

export interface LiveRetry {
	operationId: string;
	attempt: number;
	nextAttempt: number;
	maxAttempts: number;
	delayMs: number;
	failureKind: RunFailureKind;
	error: string;
}

interface ClientState {
	liveCompaction?: { sessionId: string; status: "running" | "complete" | "failed" | "cancelled" } | undefined;
	connection: ConnectionStatus;
	capabilities: Capability[];
	executionEnvironment: ExecutionEnvironment | undefined;
	workspaces: WorkspaceSummary[];
	models: ModelMetadata[];
	selectedWorkspaceId: string | undefined;
	selectedModel: ModelRef | undefined;
	sessions: SessionSummary[];
	usageOverview: UsageOverview | undefined;
	runs: RunSummary[];
	memories: MemoryRecord[];
	evaluationDatasets: EvaluationDataset[];
	snapshot: SessionSnapshot | undefined;
	liveAssistants: Record<string, LiveAssistant>;
	liveTools: Record<string, LiveTool>;
	liveGoalActivities: Record<string, LiveGoalActivity>;
	liveRetry: LiveRetry | undefined;
	skills: SkillSummary[];
	selectedSkill: Skill | undefined;
	mcpServers: McpServerSummary[];
	selectedMcpServer: McpServer | undefined;
	tools: ToolStatus[];
	toolRuntime: "pi" | "demo" | undefined;
	subagents: SubagentSummary[];
	subagentDepth: number;
	canCreateSubagent: boolean;
	goals: GoalSummary[];
	automations: GoalAutomationSummary[];
	error: string | undefined;
}

export interface SessionListOptions {
	query?: string;
	archived?: boolean;
}

const initialState: ClientState = {
	connection: "connecting",
	capabilities: [],
	executionEnvironment: undefined,
	workspaces: [],
	models: [],
	selectedWorkspaceId: undefined,
	selectedModel: undefined,
	sessions: [],
	usageOverview: undefined,
	runs: [],
	memories: [],
	evaluationDatasets: [],
	snapshot: undefined,
	liveAssistants: {},
	liveTools: {},
	liveGoalActivities: {},
	liveRetry: undefined,
	skills: [],
	selectedSkill: undefined,
	mcpServers: [],
	selectedMcpServer: undefined,
	tools: [],
	toolRuntime: undefined,
	subagents: [],
	subagentDepth: 0,
	canCreateSubagent: true,
	goals: [],
	automations: [],
	error: undefined,
};

function id(): string {
	return crypto.randomUUID();
}

function clientId(): string {
	const existing = localStorage.getItem("wuming.clientId");
	if (existing) return existing;
	const created = id();
	localStorage.setItem("wuming.clientId", created);
	return created;
}

function sessionSelectionKey(workspaceId: string): string {
	return `wuming.sessionId.${workspaceId}`;
}

function sameModel(left: ModelRef | undefined, right: ModelRef): boolean {
	return left?.provider === right.provider && left.id === right.id;
}

function upsertTranscript(snapshot: SessionSnapshot, item: SessionSnapshot["transcript"][number]): SessionSnapshot {
	const index = snapshot.transcript.findIndex((candidate) => candidate.id === item.id);
	if (index === -1) return { ...snapshot, transcript: [...snapshot.transcript, item] };
	const transcript = [...snapshot.transcript];
	transcript[index] = item;
	return { ...snapshot, transcript };
}

export function useWumingClient() {
	const liveOrder = useRef(0);
	const [token, setTokenState] = useState(
		() => desktopConnection()?.token ?? localStorage.getItem("wuming.token") ?? ""
	);
	const [reconnectAttempt, setReconnectAttempt] = useState(0);
	const legacyHello = useRef(false);
	const [state, setState] = useState<ClientState>(initialState);
	useEffect(() => {
		const notice = state.liveCompaction;
		if (!notice) return;
		const stale = notice.sessionId !== state.snapshot?.session.id || state.connection !== "connected";
		const ended = notice.status === "running" && state.snapshot?.session.phase === "idle";
		const clear = () =>
			setState((current) => (current.liveCompaction === notice ? { ...current, liveCompaction: undefined } : current));
		if (stale || ended) {
			clear();
			return;
		}
		if (notice.status === "running") return;
		const timer = window.setTimeout(clear, 4500);
		return () => window.clearTimeout(timer);
	}, [state.liveCompaction, state.snapshot?.session.id, state.snapshot?.session.phase, state.connection]);
	const pending = useRef(
		new Map<string, { resolve: (result: CommandResult) => void; reject: (error: Error) => void }>()
	);
	const requestRef = useRef<((command: Command, idempotencyKey?: string) => Promise<CommandResult>) | undefined>(
		undefined
	);
	const snapshotRef = useRef<SessionSnapshot | undefined>(undefined);
	const restoringSession = useRef(false);
	const goalMutationVersion = useRef(0);
	const capabilitiesRef = useRef<Capability[]>([]);
	const cursorRef = useRef<string | undefined>(localStorage.getItem("wuming.cursor") ?? undefined);
	const sessionListRef = useRef<SessionListOptions>({ archived: false });
	const skillSelectionRevision = useRef(0);
	const skillListRevision = useRef(0);
	const mcpSelectionRevision = useRef(0);
	const mcpListRevision = useRef(0);
	const mcpWorkspaceRef = useRef(state.selectedWorkspaceId);
	mcpWorkspaceRef.current = state.selectedWorkspaceId;
	const bufferedAssistantDeltas = useRef(new Map<string, BufferedAssistantDelta>());
	const assistantDeltaFlushTimer = useRef<number | undefined>(undefined);

	const flushAssistantDeltas = useCallback(() => {
		if (assistantDeltaFlushTimer.current !== undefined) clearTimeout(assistantDeltaFlushTimer.current);
		assistantDeltaFlushTimer.current = undefined;
		const buffered = bufferedAssistantDeltas.current;
		if (buffered.size === 0) return;
		bufferedAssistantDeltas.current = new Map();
		setState((current) => {
			const sessionId = current.snapshot?.session.id;
			let liveAssistants = current.liveAssistants;
			let changed = false;
			for (const delta of buffered.values()) {
				if (delta.sessionId !== sessionId) continue;
				const existing = liveAssistants[delta.id] ?? {
					id: delta.id,
					order: delta.order,
					text: "",
					thinking: "",
					toolCall: "",
				};
				if (!changed) {
					liveAssistants = { ...liveAssistants };
					changed = true;
				}
				liveAssistants[delta.id] = {
					...existing,
					text: existing.text + delta.text,
					thinking: existing.thinking + delta.thinking,
					toolCall: existing.toolCall + delta.toolCall,
				};
			}
			return changed ? { ...current, liveAssistants } : current;
		});
	}, []);

	const scheduleAssistantDeltaFlush = useCallback(() => {
		if (assistantDeltaFlushTimer.current !== undefined) return;
		assistantDeltaFlushTimer.current = window.setTimeout(flushAssistantDeltas, STREAM_RENDER_INTERVAL_MS);
	}, [flushAssistantDeltas]);

	const discardAssistantDeltas = useCallback((sessionId?: string, itemId?: string) => {
		if (sessionId === undefined && itemId === undefined) bufferedAssistantDeltas.current.clear();
		else {
			for (const [key, delta] of bufferedAssistantDeltas.current) {
				if ((sessionId === undefined || delta.sessionId === sessionId) && (itemId === undefined || key === itemId)) {
					bufferedAssistantDeltas.current.delete(key);
				}
			}
		}
		if (bufferedAssistantDeltas.current.size === 0 && assistantDeltaFlushTimer.current !== undefined) {
			clearTimeout(assistantDeltaFlushTimer.current);
			assistantDeltaFlushTimer.current = undefined;
		}
	}, []);

	const syncStoredPermission = useCallback(async (snapshot: SessionSnapshot): Promise<SessionSnapshot> => {
		const permission = readStoredPermission(localStorage);
		if (
			snapshot.session.phase !== "idle" ||
			snapshot.session.archivedAt !== undefined ||
			(snapshot.sandboxMode === permission.sandboxMode && snapshot.approvalPolicy === permission.approvalPolicy)
		) {
			return snapshot;
		}
		try {
			const result = await requestRef.current?.({
				type: "session.policy.set",
				sessionId: snapshot.session.id,
				sandboxMode: permission.sandboxMode,
				approvalPolicy: permission.approvalPolicy,
			});
			return result?.type === "session.configured" ? result.snapshot : snapshot;
		} catch {
			// A concurrent turn can make the session non-idle. The next idle snapshot retries the global policy.
			return snapshot;
		}
	}, []);

	const refreshSkills = useCallback(async (workspaceId: string) => {
		const revision = ++skillListRevision.current;
		++skillSelectionRevision.current;
		setState((current) =>
			current.selectedWorkspaceId === workspaceId ? { ...current, selectedSkill: undefined } : current
		);
		const result = await requestRef.current?.({ type: "skill.list", workspaceId });
		const skills = result?.type === "skill.list" ? result.skills : [];
		setState((current) =>
			revision === skillListRevision.current && current.selectedWorkspaceId === workspaceId
				? { ...current, skills }
				: current
		);
		return skills;
	}, []);

	const refreshMcp = useCallback(async (workspaceId: string) => {
		const revision = ++mcpListRevision.current;
		++mcpSelectionRevision.current;
		setState((current) =>
			current.selectedWorkspaceId === workspaceId
				? { ...current, mcpServers: [], selectedMcpServer: undefined }
				: current
		);
		try {
			const result = await requestRef.current?.({ type: "mcp.list", workspaceId });
			const mcpServers = result?.type === "mcp.list" ? result.servers : [];
			setState((current) =>
				revision === mcpListRevision.current && current.selectedWorkspaceId === workspaceId
					? { ...current, mcpServers, selectedMcpServer: undefined }
					: current
			);
			return mcpServers;
		} catch (error) {
			if (revision !== mcpListRevision.current) return [];
			throw error;
		}
	}, []);

	const refreshTools = useCallback(async (workspaceId: string) => {
		const result = await requestRef.current?.({ type: "tool.list", workspaceId });
		const tools = result?.type === "tool.list" ? result.tools : [];
		setState((current) => ({
			...current,
			tools,
			toolRuntime: result?.type === "tool.list" ? result.runtime : undefined,
		}));
		return tools;
	}, []);

	const refreshModels = useCallback(async () => {
		const result = await requestRef.current?.({ type: "model.list" });
		const models = result?.type === "model.list" ? result.models : [];
		setState((current) => {
			const selectedModel =
				models.find((candidate) => candidate.authenticated && sameModel(current.selectedModel, candidate.model))
					?.model ??
				models.find((candidate) => candidate.authenticated && candidate.model.provider.startsWith("custom-"))?.model ??
				models.find((candidate) => candidate.authenticated)?.model ??
				models[0]?.model;
			if (selectedModel) localStorage.setItem("wuming.model", JSON.stringify(selectedModel));
			else localStorage.removeItem("wuming.model");
			return { ...current, models, selectedModel };
		});
		return models;
	}, []);

	const [modelSettingsRevision, setModelSettingsRevision] = useState(0);
	const officialAccounts = useCallback(
		async (
			command: Extract<Command, { type: `model.official.${string}` }> = { type: "model.official.list" }
		): Promise<OfficialAccount[]> => {
			const result = await requestRef.current?.(command);
			if (result?.type !== "model.official.accounts") throw new Error("Official accounts are unavailable");
			return result.accounts;
		},
		[]
	);
	const listCustomMediaModels = useCallback(async () => {
		const result = await requestRef.current?.({ type: "model.custom.media.list" });
		if (result?.type !== "model.custom.media.list") throw new Error("无法读取已添加的生成模型");
		return result.models;
	}, []);
	const configureCustomModels = useCallback(
		async (configs: CustomModelConfig[]) => {
			const configured: ModelMetadata[] = [];
			let available: ModelMetadata[] = [];
			try {
				for (const config of configs) {
					const result = await requestRef.current?.({ type: "model.custom.set", config });
					if (result?.type !== "model.custom.configured") throw new Error(`自定义模型 ${config.id} 配置失败`);
					configured.push(result.model);
				}
			} finally {
				setModelSettingsRevision((value) => value + 1);
				available = await refreshModels();
			}
			const chatModels = configured.filter((item) =>
				available.some((candidate) => sameModel(item.model, candidate.model))
			);
			const selected = chatModels.at(-1)?.model;
			if (selected) {
				localStorage.setItem("wuming.model", JSON.stringify(selected));
				setState((current) => ({ ...current, selectedModel: selected }));
			}
			return chatModels;
		},
		[refreshModels]
	);

	const configureCustomModel = useCallback(
		async (config: CustomModelConfig) => {
			const model = (await configureCustomModels([config]))[0];
			if (!model) throw new Error("自定义模型配置失败");
			return model;
		},
		[configureCustomModels]
	);

	const discoverCustomModels = useCallback(
		async (connection: CustomModelConnection) => {
			const result = await requestRef.current?.({ type: "model.custom.discover", connection });
			if (result?.type !== "model.custom.discovered") throw new Error("无法从该地址获取模型列表");
			setModelSettingsRevision((value) => value + 1);
			await refreshModels();
			return result;
		},
		[refreshModels]
	);

	const listCustomModelServices = useCallback(async (): Promise<CustomModelService[]> => {
		const result = await requestRef.current?.({ type: "model.custom.service.list" });
		if (result?.type !== "model.custom.service.list") throw new Error("无法读取模型服务");
		return result.services;
	}, []);

	const refreshCustomModelService = useCallback(
		async (provider: string) => {
			const result = await requestRef.current?.({ type: "model.custom.service.refresh", provider });
			if (result?.type !== "model.custom.discovered") throw new Error("无法刷新模型服务");
			setModelSettingsRevision((value) => value + 1);
			await refreshModels();
			return result;
		},
		[refreshModels]
	);

	const removeCustomModelService = useCallback(async (provider: string) => {
		const result = await requestRef.current?.({ type: "model.custom.service.remove", provider });
		if (result?.type !== "model.custom.service.removed") throw new Error("删除模型服务失败");
	}, []);

	const getCustomModelSettings = useCallback(async (model: ModelRef) => {
		const result = await requestRef.current?.({ type: "model.custom.get", model });
		if (result?.type !== "model.custom.settings") throw new Error("无法读取自定义模型设置");
		return result.settings;
	}, []);

	const removeCustomModel = useCallback(
		async (model: ModelRef) => {
			const result = await requestRef.current?.({ type: "model.custom.remove", model });
			if (result?.type !== "model.custom.removed") throw new Error("删除自定义模型失败");
			setModelSettingsRevision((value) => value + 1);
			await refreshModels();
		},
		[refreshModels]
	);

	const testCustomModel = useCallback(async (model: ModelRef) => {
		const result = await requestRef.current?.({ type: "model.custom.test", model });
		if (result?.type !== "model.custom.tested") throw new Error("模型测试失败");
		return result.latencyMs;
	}, []);
	const listMediaModels = useCallback(async () => {
		const result = await requestRef.current?.({ type: "model.media.list" });
		if (result?.type !== "model.media.settings") throw new Error("无法读取生成模型设置");
		return result.settings;
	}, []);
	const discoverMediaModels = useCallback(async (connection: MediaModelDiscoveryConnection) => {
		const result = await requestRef.current?.({ type: "model.media.discover", connection });
		if (result?.type !== "model.media.discovered") throw new Error("无法获取生成模型列表");
		return result.models;
	}, []);
	const setMediaModel = useCallback(async (config: MediaModelConfig) => {
		const result = await requestRef.current?.({ type: "model.media.set", config });
		if (result?.type !== "model.media.settings") throw new Error("无法保存生成模型");
		return result.settings;
	}, []);
	const setDefaultImageModel = useCallback(async (model: ModelRef) => {
		const result = await requestRef.current?.({ type: "model.media.image.default", model });
		if (result?.type !== "model.media.settings") throw new Error("无法设置默认生图模型");
		return result.settings;
	}, []);
	const setDefaultVideoModel = useCallback(async (model: ModelRef) => {
		const result = await requestRef.current?.({ type: "model.media.video.default", model });
		if (result?.type !== "model.media.settings") throw new Error("无法设置默认视频模型");
		return result.settings;
	}, []);
	const removeVideoModel = useCallback(async (model: ModelRef) => {
		const result = await requestRef.current?.({ type: "model.media.video.remove", model });
		if (result?.type !== "model.media.settings") throw new Error("无法删除视频模型");
		return result.settings;
	}, []);
	const removeImageModel = useCallback(async (model: ModelRef) => {
		const result = await requestRef.current?.({ type: "model.media.image.remove", model });
		if (result?.type !== "model.media.settings") throw new Error("无法删除生图模型");
		return result.settings;
	}, []);
	const removeMediaModel = useCallback(async (kind: MediaKind) => {
		const result = await requestRef.current?.({ type: "model.media.remove", kind });
		if (result?.type !== "model.media.settings") throw new Error("无法移除生成模型");
		return result.settings;
	}, []);

	useEffect(() => {
		snapshotRef.current = state.snapshot;
	}, [state.snapshot]);

	const setToken = useCallback((value: string) => {
		localStorage.removeItem("wuming.cursor");
		cursorRef.current = undefined;
		setTokenState(value);
		setReconnectAttempt((attempt) => attempt + 1);
	}, []);

	const refreshSessions = useCallback(
		async (workspaceId: string, options: SessionListOptions = sessionListRef.current) => {
			const normalized = {
				...(options.query?.trim() ? { query: options.query.trim() } : {}),
				archived: options.archived ?? false,
			};
			sessionListRef.current = normalized;
			const result = await requestRef.current?.({
				type: "session.list",
				workspaceId,
				...normalized,
				limit: 200,
			});
			if (result?.type === "session.list") setState((current) => ({ ...current, sessions: result.sessions }));
			return result?.type === "session.list" ? result.sessions : [];
		},
		[]
	);

	const getUsageOverview = useCallback(async (workspaceId?: string, days = 7) => {
		const result = await requestRef.current?.({
			type: "usage.overview",
			...(workspaceId ? { workspaceId } : {}),
			days,
		});
		return result?.type === "usage.overview" ? result.overview : undefined;
	}, []);

	const refreshUsageOverview = useCallback(
		async (workspaceId: string, days = 7) => {
			const overview = await getUsageOverview(workspaceId, days);
			if (overview && days === 7) {
				setState((current) =>
					current.selectedWorkspaceId === undefined || current.selectedWorkspaceId === workspaceId
						? { ...current, usageOverview: overview }
						: current
				);
			}
			return overview;
		},
		[getUsageOverview]
	);

	const refreshRuns = useCallback(async (sessionId: string) => {
		const result = await requestRef.current?.({ type: "session.run.list", sessionId, limit: 20 });
		if (result?.type === "session.run.list" && snapshotRef.current?.session.id === sessionId) {
			setState((current) => ({ ...current, runs: result.runs }));
		}
		return result?.type === "session.run.list" ? result.runs : [];
	}, []);

	const refreshMemories = useCallback(async (sessionId: string) => {
		const result = await requestRef.current?.({
			type: "session.memory.list",
			sessionId,
			limit: 20,
		});
		if (result?.type === "session.memory.list" && snapshotRef.current?.session.id === sessionId) {
			setState((current) => ({ ...current, memories: result.memories }));
		}
		return result?.type === "session.memory.list" ? result.memories : [];
	}, []);

	const refreshEvaluationDatasets = useCallback(async (workspaceId: string) => {
		const result = await requestRef.current?.({ type: "evaluation.dataset.list", workspaceId });
		const evaluationDatasets = result?.type === "evaluation.dataset.list" ? result.datasets : [];
		setState((current) =>
			current.selectedWorkspaceId === undefined || current.selectedWorkspaceId === workspaceId
				? { ...current, evaluationDatasets }
				: current
		);
		return evaluationDatasets;
	}, []);

	const createEvaluationDataset = useCallback(
		async (name: string, graders: EvaluationGrader[]) => {
			const workspaceId = snapshotRef.current?.session.workspaceId;
			if (!workspaceId) throw new Error("未选择会话");
			const result = await requestRef.current?.({
				type: "evaluation.dataset.create",
				workspaceId,
				name,
				graders,
			});
			if (result?.type !== "evaluation.dataset.created") throw new Error("评测数据集创建失败");
			await refreshEvaluationDatasets(workspaceId);
			return result.dataset;
		},
		[refreshEvaluationDatasets]
	);

	const deleteEvaluationDataset = useCallback(
		async (datasetId: string) => {
			const workspaceId = snapshotRef.current?.session.workspaceId;
			if (!workspaceId) throw new Error("未选择会话");
			const result = await requestRef.current?.({
				type: "evaluation.dataset.delete",
				workspaceId,
				datasetId,
			});
			if (result?.type !== "evaluation.dataset.deleted") throw new Error("评测数据集删除失败");
			await refreshEvaluationDatasets(workspaceId);
		},
		[refreshEvaluationDatasets]
	);

	const listRunEvaluations = useCallback(async (runId: string): Promise<RunEvaluation[]> => {
		const sessionId = snapshotRef.current?.session.id;
		if (!sessionId) throw new Error("未选择会话");
		const result = await requestRef.current?.({
			type: "session.run.evaluation.list",
			sessionId,
			runId,
			limit: 20,
		});
		if (result?.type !== "session.run.evaluation.list") throw new Error("无法读取运行评测");
		return result.evaluations;
	}, []);

	const runEvaluation = useCallback(
		async (
			runId: string,
			input: { datasetId?: string; name?: string; graders?: EvaluationGrader[] }
		): Promise<RunEvaluation> => {
			const sessionId = snapshotRef.current?.session.id;
			if (!sessionId) throw new Error("未选择会话");
			const result = await requestRef.current?.({
				type: "session.run.evaluate",
				sessionId,
				runId,
				...input,
			});
			if (result?.type !== "session.run.evaluated") throw new Error("运行评测失败");
			return result.evaluation;
		},
		[]
	);

	const createRunAttestation = useCallback(
		async (runId: string, evaluationId: string): Promise<EvaluationAttestation> => {
			const sessionId = snapshotRef.current?.session.id;
			if (!sessionId) throw new Error("未选择会话");
			const result = await requestRef.current?.({
				type: "session.run.attestation.create",
				sessionId,
				runId,
				evaluationId,
			});
			if (result?.type !== "session.run.attested") throw new Error("签名证明创建失败");
			return result.attestation;
		},
		[]
	);

	const manageMemory = useCallback(
		async (memoryId: string, action: MemoryAction) => {
			const snapshot = snapshotRef.current;
			if (!snapshot) throw new Error("未选择会话");
			const result = await requestRef.current?.({
				type: "session.memory.manage",
				sessionId: snapshot.session.id,
				memoryId,
				action,
			});
			if (result?.type !== "session.memory.managed") throw new Error("记忆管理失败");
			await refreshMemories(snapshot.session.id);
			return result;
		},
		[refreshMemories]
	);

	const refreshSubagents = useCallback(async (sessionId: string) => {
		const result = await requestRef.current?.({ type: "subagent.list", sessionId, limit: 100 });
		if (result?.type === "subagent.list" && snapshotRef.current?.session.id === sessionId) {
			setState((current) => ({
				...current,
				subagents: result.subagents,
				subagentDepth: result.depth,
				canCreateSubagent: result.canCreate,
			}));
		}
		return result?.type === "subagent.list" ? result.subagents : [];
	}, []);

	const refreshGoals = useCallback(async (sessionId: string) => {
		const requestVersion = goalMutationVersion.current;
		const result = await requestRef.current?.({ type: "goal.list", sessionId, limit: 100 });
		if (
			result?.type === "goal.list" &&
			goalMutationVersion.current === requestVersion &&
			snapshotRef.current?.session.id === sessionId
		) {
			setState((current) => {
				const liveGoalActivities = { ...current.liveGoalActivities };
				for (const goal of result.goals) {
					if (["completed", "failed", "cancelled"].includes(goal.status)) delete liveGoalActivities[goal.id];
				}
				return { ...current, goals: result.goals, liveGoalActivities };
			});
		}
		return result?.type === "goal.list" ? result.goals : [];
	}, []);

	const refreshAutomations = useCallback(async (sessionId: string) => {
		const result = await requestRef.current?.({ type: "automation.list", sessionId, limit: 100 });
		if (result?.type === "automation.list" && snapshotRef.current?.session.id === sessionId) {
			setState((current) => ({ ...current, automations: result.automations }));
		}
		return result?.type === "automation.list" ? result.automations : [];
	}, []);

	const attachSession = useCallback(
		async (sessionId: string) => {
			discardAssistantDeltas();
			const result = await requestRef.current?.({ type: "session.attach", sessionId });
			if (result?.type === "session.attached") {
				// Opening a child must preserve the policy inherited from its parent.
				// Primary sessions keep the existing once-on-attach default behavior.
				const snapshot = result.snapshot.session.parentSessionId
					? result.snapshot
					: await syncStoredPermission(result.snapshot);
				const workspaceId = snapshot.session.workspaceId;
				snapshotRef.current = snapshot;
				localStorage.setItem("wuming.workspaceId", workspaceId);
				localStorage.setItem(sessionSelectionKey(workspaceId), sessionId);
				localStorage.setItem("wuming.model", JSON.stringify(snapshot.model));
				setState((current) => ({
					...current,
					selectedWorkspaceId: workspaceId,
					selectedModel: snapshot.model,
					snapshot,
					liveAssistants: {},
					liveTools: {},
					liveRetry: undefined,
					memories: [],
					subagents: [],
					subagentDepth: 0,
					canCreateSubagent: true,
					goals: [],
					automations: [],
					error: undefined,
				}));
				await Promise.all([
					refreshRuns(sessionId),
					...(capabilitiesRef.current.includes("session.memory") ? [refreshMemories(sessionId)] : []),
					...(capabilitiesRef.current.includes("subagents") ? [refreshSubagents(sessionId)] : []),
					...(capabilitiesRef.current.includes("goals") ? [refreshGoals(sessionId)] : []),
					...(capabilitiesRef.current.includes("automations") ? [refreshAutomations(sessionId)] : []),
				]);
			}
		},
		[
			discardAssistantDeltas,
			refreshAutomations,
			refreshGoals,
			refreshMemories,
			refreshRuns,
			refreshSubagents,
			syncStoredPermission,
		]
	);

	const restoreSelectedSession = useCallback(
		async (workspaceId: string, sessions: SessionSummary[], restoreRoot: boolean) => {
			const storedId = localStorage.getItem(sessionSelectionKey(workspaceId));
			if (storedId && !sessions.some((session) => session.id === storedId)) {
				// Child sessions are intentionally omitted from the root conversation list.
				const result = await requestRef
					.current?.({ type: "session.snapshot.get", sessionId: storedId })
					.catch(() => undefined);
				if (
					result?.type === "session.snapshot" &&
					result.snapshot.session.workspaceId === workspaceId &&
					result.snapshot.session.parentSessionId &&
					result.snapshot.session.archivedAt === undefined
				) {
					await attachSession(storedId);
					return;
				}
			}
			const session = sessions.find((candidate) => candidate.id === storedId) ?? sessions[0];
			if (restoreRoot && session) await attachSession(session.id);
		},
		[attachSession]
	);

	useEffect(() => {
		let disposed = false;
		let helloReceived = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		if (!token) {
			requestRef.current = undefined;
			capabilitiesRef.current = [];
			setState((current) => ({
				...current,
				connection: "disconnected",
				capabilities: [],
				executionEnvironment: undefined,
				error: undefined,
			}));
			return;
		}
		setState((current) => ({ ...current, connection: "connecting", error: undefined }));
		const ws = new WebSocket(gatewayWebSocketUrl(), ["wuming.v1", bearerProtocol(token)]);

		const request = (command: Command, idempotencyKey = id()) =>
			new Promise<CommandResult>((resolve, reject) => {
				if (ws.readyState !== WebSocket.OPEN) return reject(new Error("网关尚未连接"));
				const requestId = id();
				pending.current.set(requestId, { resolve, reject });
				ws.send(JSON.stringify({ type: "request", requestId, idempotencyKey, command }));
			});
		requestRef.current = request;
		let resyncGeneration = 0;

		const resync = async (sessionId: string) => {
			const generation = ++resyncGeneration;
			try {
				const result = await request({ type: "session.snapshot.get", sessionId });
				if (generation !== resyncGeneration || result.type !== "session.snapshot") return;
				setState((current) => {
					const snapshot = current.snapshot;
					if (snapshot?.session.id !== sessionId || snapshot.revision > result.snapshot.revision) return current;
					snapshotRef.current = result.snapshot;
					return {
						...current,
						snapshot: result.snapshot,
						liveAssistants: {},
						liveTools: {},
						liveRetry: undefined,
					};
				});
				void refreshRuns(sessionId);
				if (capabilitiesRef.current.includes("session.memory")) void refreshMemories(sessionId);
			} catch (error) {
				if (generation !== resyncGeneration) return;
				setState((current) => ({
					...current,
					error: error instanceof Error ? error.message : String(error),
				}));
			}
		};

		const applyMessage = (message: ServerMessage) => {
			if (message.type === "task.notification") {
				if (localStorage.getItem("wuming.taskNotifications") !== "false") {
					const { id, sessionId, workspaceId, kind } = message;
					void window.wumingDesktop?.notifications?.show({ id, sessionId, workspaceId, kind }).catch(() => undefined);
				}
				return;
			}
			if (message.type === "hello") {
				helloReceived = true;
				restoringSession.current = true;
				if (!desktopConnection()) localStorage.setItem("wuming.token", token);
				capabilitiesRef.current = message.capabilities;
				setState((current) => ({
					...current,
					connection: "connected",
					capabilities: message.capabilities,
					executionEnvironment: message.executionEnvironment,
					error: undefined,
				}));
				void (async () => {
					try {
						const [workspaceResult, modelResult] = await Promise.all([
							request({ type: "workspace.list" }),
							request({ type: "model.list" }),
						]);
						const workspaces = workspaceResult.type === "workspace.list" ? workspaceResult.workspaces : [];
						const models = modelResult.type === "model.list" ? modelResult.models : [];
						const storedWorkspaceId = localStorage.getItem("wuming.workspaceId");
						const workspace = workspaces.find((candidate) => candidate.id === storedWorkspaceId) ?? workspaces[0];
						let storedModel: ModelRef | undefined;
						try {
							storedModel = JSON.parse(localStorage.getItem("wuming.model") ?? "null") as ModelRef | undefined;
						} catch {
							localStorage.removeItem("wuming.model");
						}
						const selectedModel =
							models.find((candidate) => candidate.authenticated && sameModel(storedModel, candidate.model))?.model ??
							models.find((candidate) => candidate.authenticated && candidate.model.provider.startsWith("custom-"))
								?.model ??
							models.find((candidate) => candidate.authenticated)?.model ??
							models[0]?.model;
						if (workspace) localStorage.setItem("wuming.workspaceId", workspace.id);
						if (selectedModel) localStorage.setItem("wuming.model", JSON.stringify(selectedModel));
						setState((current) => ({
							...current,
							workspaces,
							models,
							selectedWorkspaceId: workspace?.id,
							selectedModel,
						}));
						if (!workspace) return;
						await refreshSkills(workspace.id);
						if (message.capabilities.includes("tools")) await refreshTools(workspace.id);
						if (message.capabilities.includes("mcp")) await refreshMcp(workspace.id);
						if (message.capabilities.includes("evaluation")) await refreshEvaluationDatasets(workspace.id);
						const sessionResult = await request({
							type: "session.list",
							workspaceId: workspace.id,
							...sessionListRef.current,
							limit: 200,
						});
						const sessions = sessionResult.type === "session.list" ? sessionResult.sessions : [];
						setState((current) => ({ ...current, sessions }));
						await refreshUsageOverview(workspace.id);
						await restoreSelectedSession(workspace.id, sessions, !isImplicitWorkspace(workspace));
					} catch (error) {
						setState((current) => ({
							...current,
							connection: "error",
							error: error instanceof Error ? error.message : String(error),
						}));
					} finally {
						restoringSession.current = false;
					}
				})();
				return;
			}
			if (message.type === "hello_error") {
				setState((current) => ({ ...current, connection: "error", error: message.error.message }));
				return;
			}
			if (message.type === "response") {
				const waiter = pending.current.get(message.requestId);
				if (!waiter) return;
				pending.current.delete(message.requestId);
				if (message.ok) waiter.resolve(message.result);
				else waiter.reject(new Error(message.error.message));
				return;
			}
			if (message.type === "progress") {
				const event = message.event;
				if (event.sessionId !== snapshotRef.current?.session.id) return;
				if (event.type === "context.compaction") {
					if (event.runSessionId && event.runSessionId !== event.sessionId) return;
					setState((current) => ({ ...current, liveCompaction: { sessionId: event.sessionId, status: event.status } }));
					return;
				}
				if (event.goalId) {
					const runsInCurrentSession = !event.runSessionId || event.runSessionId === event.sessionId;
					const goalId = event.goalId;
					const runSessionId = event.runSessionId ?? event.sessionId;
					const order = ++liveOrder.current;
					setState((current) => {
						const existing = current.liveGoalActivities[goalId] ?? {
							goalId,
							runSessionId,
							order,
							phase: "thinking" as const,
							text: "",
							thinking: "",
						};
						let next: LiveGoalActivity = { ...existing, runSessionId };
						if (event.type === "run.retrying") {
							next = { ...next, phase: "retrying", message: event.error };
						} else if (event.type === "assistant.delta") {
							next = {
								...next,
								phase: "thinking",
								text: event.kind === "text" ? next.text + event.delta : next.text,
								thinking: event.kind === "thinking" ? next.thinking + event.delta : next.thinking,
							};
						} else if (event.type === "tool.started") {
							next = {
								...next,
								phase: "tool",
								toolName: event.toolName,
								toolStatus: "running",
								toolPreview: "",
							};
						} else if (event.type === "tool.progress") {
							next = {
								...next,
								phase: "tool",
								toolName: next.toolName ?? "tool",
								toolStatus: "running",
								toolPreview: event.preview,
							};
						} else {
							next = {
								...next,
								phase: "tool",
								toolName: next.toolName ?? "tool",
								toolStatus: event.isError ? "error" : "complete",
								toolPreview: event.preview,
							};
						}
						return {
							...current,
							liveGoalActivities: {
								...current.liveGoalActivities,
								[goalId]: next,
							},
						};
					});
					if (!runsInCurrentSession) return;
				}
				// Checkpointed items arrive as complete replacements, not append-only deltas.
				// Keep the legacy live path for runtimes that do not publish checkpoints.
				if (
					(event.type === "assistant.delta" &&
						snapshotRef.current?.transcript.some((item) => item.id === event.itemId)) ||
					("toolCallId" in event &&
						snapshotRef.current?.transcript.some(
							(item) => item.type === "tool" && item.toolCallId === event.toolCallId
						))
				)
					return;
				if (event.type === "run.retrying") {
					discardAssistantDeltas(event.sessionId);
					setState((current) => ({
						...current,
						liveAssistants: {},
						liveTools: {},
						liveRetry: {
							operationId: event.operationId,
							attempt: event.attempt,
							nextAttempt: event.nextAttempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							failureKind: event.failureKind,
							error: event.error,
						},
					}));
				} else if (event.type === "assistant.delta") {
					const order = ++liveOrder.current;
					const existing = bufferedAssistantDeltas.current.get(event.itemId) ?? {
						sessionId: event.sessionId,
						id: event.itemId,
						order,
						text: "",
						thinking: "",
						toolCall: "",
					};
					const field = event.kind === "text" ? "text" : event.kind === "thinking" ? "thinking" : "toolCall";
					bufferedAssistantDeltas.current.set(event.itemId, {
						...existing,
						[field]: existing[field] + event.delta,
					});
					scheduleAssistantDeltaFlush();
				} else if (event.type === "tool.started") {
					flushAssistantDeltas();
					const order = ++liveOrder.current;
					setState((current) => ({
						...current,
						liveTools: {
							...current.liveTools,
							[event.toolCallId]: {
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								input: event.input,
								order,
								status: "running",
								preview: "",
								truncated: false,
							},
						},
					}));
				} else if (event.type === "tool.progress") {
					const order = ++liveOrder.current;
					setState((current) => {
						const existing = current.liveTools[event.toolCallId] ?? {
							toolCallId: event.toolCallId,
							toolName: "tool",
							input: null,
							order,
							status: "running" as const,
							preview: "",
							truncated: false,
						};
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[event.toolCallId]: {
									...existing,
									preview: event.preview,
									truncated: event.truncated,
									...(event.artifact ? { artifact: event.artifact } : {}),
								},
							},
						};
					});
				} else {
					const order = ++liveOrder.current;
					setState((current) => {
						const existing = current.liveTools[event.toolCallId] ?? {
							toolCallId: event.toolCallId,
							toolName: "tool",
							input: null,
							order,
							status: "running" as const,
							preview: "",
							truncated: false,
						};
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[event.toolCallId]: {
									...existing,
									status: event.isError ? "error" : "complete",
									preview: event.preview,
									truncated: event.truncated,
									...(event.artifact ? { artifact: event.artifact } : {}),
									...(event.webEvidence ? { webEvidence: event.webEvidence } : {}),
								},
							},
						};
					});
				}
				return;
			}
			if (message.type !== "event") return;
			const event = message.event;
			if (event.type === "resync_required") {
				cursorRef.current = undefined;
				localStorage.removeItem("wuming.cursor");
				if (snapshotRef.current) void resync(snapshotRef.current.session.id);
				return;
			}
			cursorRef.current = message.cursor;
			localStorage.setItem("wuming.cursor", message.cursor);
			if (event.type === "session.snapshot") {
				setState((current) => ({
					...current,
					sessions: current.sessions.map((session) =>
						session.id === event.snapshot.session.id ? event.snapshot.session : session
					),
				}));
				if (event.snapshot.session.phase === "idle") discardAssistantDeltas(event.snapshot.session.id);
				if (event.snapshot.session.id === snapshotRef.current?.session.id) {
					setState((current) => {
						if (current.snapshot && current.snapshot.revision > event.snapshot.revision) return current;
						snapshotRef.current = event.snapshot;
						return {
							...current,
							snapshot: event.snapshot,
							...(event.snapshot.session.phase === "idle"
								? { liveAssistants: {}, liveTools: {}, liveRetry: undefined }
								: {}),
						};
					});
					void refreshSessions(event.snapshot.session.workspaceId);
					void refreshUsageOverview(event.snapshot.session.workspaceId);
				}
				return;
			}
			// Sidebar status also follows conversations that are not currently open.
			if (event.type === "session.phase.changed") {
				setState((current) => ({
					...current,
					sessions: current.sessions.map((session) =>
						session.id === event.sessionId ? { ...session, phase: event.phase } : session
					),
				}));
			}
			if (event.sessionId !== snapshotRef.current?.session.id) return;
			if (event.type === "session.phase.changed" && (event.phase === "idle" || event.phase === "retry")) {
				void refreshRuns(event.sessionId);
				if (capabilitiesRef.current.includes("session.memory")) void refreshMemories(event.sessionId);
				if (capabilitiesRef.current.includes("goals")) void refreshGoals(event.sessionId);
			}
			if (event.type === "approval.requested" && capabilitiesRef.current.includes("goals")) {
				void refreshGoals(event.sessionId);
			}
			if (event.type === "session.item.upserted") discardAssistantDeltas(event.sessionId, event.item.id);
			if (event.type === "session.phase.changed" && event.phase === "idle") {
				discardAssistantDeltas(event.sessionId);
			}
			setState((current) => {
				const snapshot = current.snapshot;
				if (!snapshot) return current;
				if (event.revision <= snapshot.revision) return current;
				if (event.revision !== snapshot.revision + 1) {
					void resync(snapshot.session.id);
					return current;
				}
				if (event.type === "session.item.upserted") {
					const next = { ...upsertTranscript(snapshot, event.item), revision: event.revision };
					snapshotRef.current = next;
					const liveAssistants = { ...current.liveAssistants };
					const liveTools = { ...current.liveTools };
					delete liveAssistants[event.item.id];
					if (event.item.type === "tool") delete liveTools[event.item.toolCallId];
					return {
						...current,
						snapshot: next,
						liveAssistants,
						liveTools,
					};
				}
				if (event.type === "session.request.usage.updated") {
					const next = {
						...snapshot,
						revision: event.revision,
						usageRequests: mergeUsageRequests(sessionUsageRequests(snapshot), [event.request]),
					};
					snapshotRef.current = next;
					return { ...current, snapshot: next };
				}
				if (event.type === "session.context.updated") {
					const next = { ...snapshot, revision: event.revision, contextUsage: event.contextUsage };
					snapshotRef.current = next;
					return {
						...current,
						snapshot: next,
						...(event.contextUsage.basis === "compaction"
							? { liveCompaction: { sessionId: event.sessionId, status: "complete" as const } }
							: {}),
					};
				}
				if (event.type === "session.phase.changed") {
					return {
						...current,
						...(event.phase === "compaction"
							? { liveCompaction: { sessionId: event.sessionId, status: "running" as const } }
							: {}),
						snapshot: {
							...snapshot,
							revision: event.revision,
							session: { ...snapshot.session, phase: event.phase },
						},
						...(event.phase === "idle" ? { liveAssistants: {}, liveTools: {}, liveRetry: undefined } : {}),
					};
				}
				if (event.type === "approval.requested") {
					return {
						...current,
						snapshot: {
							...snapshot,
							revision: event.revision,
							pendingApprovals: [...snapshot.pendingApprovals, event.approval],
						},
					};
				}
				if (event.type === "approval.settled") {
					return {
						...current,
						snapshot: {
							...snapshot,
							revision: event.revision,
							pendingApprovals: snapshot.pendingApprovals.filter((approval) => approval.id !== event.approval.id),
						},
					};
				}
				return current;
			});
		};

		ws.addEventListener("open", () => {
			ws.send(
				JSON.stringify({
					type: "hello",
					protocolVersion: 1,
					clientId: clientId(),
					capabilities: [
						"session.resume",
						"session.fork",
						"turn.steer",
						"turn.follow_up",
						"approval",
						"artifact",
						"image_input",
						"git",
						"terminal",
						"skills",
						"mcp",
						"subagents",
						"goals",
						"automations",
						"model.custom",
						"run.trajectory",
						"session.memory",
						"evaluation",
						...(legacyHello.current ? [] : ["task.notifications"]),
					],
					...(cursorRef.current ? { resumeCursor: cursorRef.current } : {}),
				})
			);
		});
		ws.addEventListener("message", (raw) => applyMessage(JSON.parse(String(raw.data)) as ServerMessage));
		ws.addEventListener("close", (event) => {
			if (!disposed) {
				// Older gateways reject unknown optional capabilities before hello.
				// Retry once with the original capabilities; authentication is unchanged.
				if (
					!helloReceived &&
					!legacyHello.current &&
					event.code === 1002 &&
					event.reason === "Invalid protocol message"
				) {
					legacyHello.current = true;
					setReconnectAttempt((attempt) => attempt + 1);
					return;
				}
				setState((current) => ({
					...current,
					connection: "disconnected",
					executionEnvironment: undefined,
				}));
				reconnectTimer = setTimeout(
					() => setReconnectAttempt((attempt) => attempt + 1),
					Math.min(4000, 500 * 2 ** Math.min(reconnectAttempt, 3))
				);
			}
		});
		ws.addEventListener("error", () => {
			if (!disposed) setState((current) => ({ ...current, connection: "error", error: "网关连接失败" }));
		});

		return () => {
			disposed = true;
			discardAssistantDeltas();
			if (reconnectTimer) clearTimeout(reconnectTimer);
			ws.close();
			for (const waiter of pending.current.values()) waiter.reject(new Error("网关连接已关闭"));
			pending.current.clear();
			if (requestRef.current === request) requestRef.current = undefined;
			capabilitiesRef.current = [];
		};
	}, [
		attachSession,
		discardAssistantDeltas,
		flushAssistantDeltas,
		reconnectAttempt,
		refreshEvaluationDatasets,
		refreshGoals,
		refreshMemories,
		refreshRuns,
		refreshSessions,
		refreshSkills,
		refreshTools,
		refreshMcp,
		refreshUsageOverview,
		restoreSelectedSession,
		scheduleAssistantDeltaFlush,
		token,
	]);

	useEffect(() => {
		const sessionId = state.snapshot?.session.id;
		if (state.connection !== "connected" || !sessionId || !state.capabilities.includes("subagents")) return;
		const refresh = () => void refreshSubagents(sessionId).catch(() => undefined);
		refresh();
		const timer = setInterval(refresh, 1500);
		return () => clearInterval(timer);
	}, [refreshSubagents, state.capabilities, state.connection, state.snapshot?.session.id]);

	const hasActiveGoals = state.goals.some((goal) =>
		["pending", "queued", "running", "awaiting_approval", "cancelling"].includes(goal.status)
	);
	useEffect(() => {
		const sessionId = state.snapshot?.session.id;
		if (state.connection !== "connected" || !sessionId || !state.capabilities.includes("goals")) return;
		const refresh = () => void refreshGoals(sessionId).catch(() => undefined);
		refresh();
		if (!hasActiveGoals) return;
		const timer = setInterval(refresh, 1500);
		return () => clearInterval(timer);
	}, [hasActiveGoals, refreshGoals, state.capabilities, state.connection, state.snapshot?.session.id]);

	useEffect(() => {
		const sessionId = state.snapshot?.session.id;
		if (state.connection !== "connected" || !sessionId || !state.capabilities.includes("automations")) return;
		const refresh = () => void refreshAutomations(sessionId).catch(() => undefined);
		refresh();
		const timer = setInterval(refresh, 10_000);
		return () => clearInterval(timer);
	}, [refreshAutomations, state.capabilities, state.connection, state.snapshot?.session.id]);

	const openWorkspace = useCallback(
		async (workspaceId: string, attachLatest = true) => {
			++skillSelectionRevision.current;
			++skillListRevision.current;
			++mcpSelectionRevision.current;
			++mcpListRevision.current;
			const previousSession = snapshotRef.current;
			if (previousSession && (!attachLatest || previousSession.session.workspaceId !== workspaceId)) {
				await requestRef
					.current?.({ type: "session.detach", sessionId: previousSession.session.id })
					.catch(() => undefined);
			}
			localStorage.setItem("wuming.workspaceId", workspaceId);
			snapshotRef.current = undefined;
			setState((current) => ({
				...current,
				selectedWorkspaceId: workspaceId,
				sessions: [],
				usageOverview: undefined,
				runs: [],
				memories: [],
				evaluationDatasets: [],
				snapshot: undefined,
				liveAssistants: {},
				liveTools: {},
				liveRetry: undefined,
				error: undefined,
				skills: [],
				selectedSkill: undefined,
				mcpServers: [],
				selectedMcpServer: undefined,
				tools: [],
				toolRuntime: undefined,
				subagents: [],
				subagentDepth: 0,
				canCreateSubagent: true,
				goals: [],
				automations: [],
			}));
			await refreshSkills(workspaceId);
			if (state.capabilities.includes("tools")) await refreshTools(workspaceId);
			if (state.capabilities.includes("mcp")) await refreshMcp(workspaceId);
			if (state.capabilities.includes("evaluation")) await refreshEvaluationDatasets(workspaceId);
			const sessions = await refreshSessions(workspaceId);
			await refreshUsageOverview(workspaceId);
			if (attachLatest) await restoreSelectedSession(workspaceId, sessions, true);
		},
		[
			attachSession,
			restoreSelectedSession,
			refreshEvaluationDatasets,
			refreshSessions,
			refreshSkills,
			refreshTools,
			refreshMcp,
			refreshUsageOverview,
			state.capabilities,
		]
	);

	const selectWorkspace = useCallback(
		async (workspaceId: string) => {
			if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) throw new Error("工作区不可用");
			await openWorkspace(workspaceId);
		},
		[openWorkspace, state.workspaces]
	);

	const beginNewChat = useCallback(
		async (workspaceId: string) => {
			if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) throw new Error("工作区不可用");
			await openWorkspace(workspaceId, false);
		},
		[openWorkspace, state.workspaces]
	);

	const getSkill = useCallback(async (workspaceId: string, skillId: string) => {
		const revision = ++skillSelectionRevision.current;
		const result = await requestRef.current?.({ type: "skill.get", workspaceId, skillId });
		if (result?.type !== "skill.get") return undefined;
		if (revision !== skillSelectionRevision.current) return undefined;
		if (result.skill.workspaceId !== workspaceId || result.skill.id !== skillId)
			throw new Error("技能响应与请求不匹配");
		setState((current) =>
			revision === skillSelectionRevision.current && current.selectedWorkspaceId === workspaceId
				? { ...current, selectedSkill: result.skill }
				: current
		);
		return result.skill;
	}, []);

	const clearSelectedSkill = useCallback(() => {
		++skillSelectionRevision.current;
		setState((current) => ({ ...current, selectedSkill: undefined }));
	}, []);

	const manageSkills = useCallback(
		async (
			command: Extract<
				Command,
				{
					type: "skill.installed.list" | "skill.install" | "skill.preview" | "skill.set_enabled" | "skill.uninstall";
				}
			>
		): Promise<CommandResult> => {
			const result = await requestRef.current?.(command);
			if (!result) throw new Error("网关未连接");
			if (
				command.type === "skill.install" ||
				command.type === "skill.set_enabled" ||
				command.type === "skill.uninstall"
			) {
				await refreshSkills(command.workspaceId);
			}
			return result;
		},
		[refreshSkills]
	);

	const manageMcp = useCallback(
		async (
			command: Extract<
				Command,
				{
					type:
						"mcp.configure" | "mcp.configuration.get" | "mcp.trust" | "mcp.untrust" | "mcp.remove" | "mcp.setEnabled";
				}
			>
		): Promise<CommandResult> => {
			const result = await requestRef.current?.(command);
			if (!result) throw new Error("网关未连接");
			if (result.type === "mcp.removed") {
				if (mcpWorkspaceRef.current !== command.workspaceId || result.workspaceId !== command.workspaceId)
					return result;
				await refreshMcp(command.workspaceId);
				return result;
			}
			if (result.type === "mcp.updated") {
				if (mcpWorkspaceRef.current !== command.workspaceId || result.workspaceId !== command.workspaceId)
					return result;
				++mcpListRevision.current;
				++mcpSelectionRevision.current;
				setState((current) => {
					if (current.selectedWorkspaceId !== command.workspaceId || result.workspaceId !== command.workspaceId)
						return current;

					return {
						...current,
						mcpServers: current.mcpServers.some((server) => server.id === result.server.id)
							? current.mcpServers.map((server) => (server.id === result.server.id ? result.server : server))
							: [...current.mcpServers, result.server],
						selectedMcpServer:
							command.type === "mcp.configure" || current.selectedMcpServer?.id === result.server.id
								? result.server
								: current.selectedMcpServer,
					};
				});
			}
			return result;
		},
		[refreshMcp]
	);

	const getMcp = useCallback(async (workspaceId: string, serverId: string) => {
		const revision = ++mcpSelectionRevision.current;
		setState((current) =>
			current.selectedWorkspaceId === workspaceId ? { ...current, selectedMcpServer: undefined } : current
		);
		try {
			const result = await requestRef.current?.({ type: "mcp.get", workspaceId, serverId });
			if (result?.type !== "mcp.get") return undefined;
			if (
				revision !== mcpSelectionRevision.current ||
				result.server.workspaceId !== workspaceId ||
				result.server.id !== serverId
			)
				return undefined;
			setState((current) =>
				revision === mcpSelectionRevision.current && current.selectedWorkspaceId === workspaceId
					? {
							...current,
							selectedMcpServer: result.server,
							mcpServers: current.mcpServers.map((server) =>
								server.id === serverId
									? {
											...server,
											trusted: result.server.trusted,
											toolCount: result.server.toolCount,
											discoveryStatus: result.server.discoveryStatus ?? (result.server.trusted ? "ready" : "untrusted"),
										}
									: server
							),
						}
					: current
			);
			return result.server;
		} catch (error) {
			if (revision !== mcpSelectionRevision.current) return undefined;
			setState((current) => {
				if (current.selectedWorkspaceId !== workspaceId) return current;
				const server = current.mcpServers.find((entry) => entry.id === serverId);
				return {
					...current,
					selectedMcpServer: server ? { ...server, discoveryStatus: "failed", tools: [] } : undefined,
					mcpServers: current.mcpServers.map((entry) =>
						entry.id === serverId ? { ...entry, discoveryStatus: "failed" as const } : entry
					),
				};
			});
			throw error;
		}
	}, []);

	const browseSessions = useCallback(
		async (workspaceId: string, options: SessionListOptions) => {
			const sessions = await refreshSessions(workspaceId, options);
			if (restoringSession.current) return sessions;
			const current = snapshotRef.current;
			const archived = options.archived ?? false;
			if (current?.session.workspaceId === workspaceId && (current.session.archivedAt !== undefined) === archived)
				return sessions;
			if (current)
				await requestRef.current?.({ type: "session.detach", sessionId: current.session.id }).catch(() => undefined);
			snapshotRef.current = undefined;
			localStorage.removeItem(sessionSelectionKey(workspaceId));
			setState((value) => ({
				...value,
				snapshot: undefined,
				runs: [],
				memories: [],
				subagents: [],
				subagentDepth: 0,
				canCreateSubagent: true,
				goals: [],
				automations: [],
				liveAssistants: {},
				liveTools: {},
				liveRetry: undefined,
			}));
			if (sessions[0]) await attachSession(sessions[0].id);
			return sessions;
		},
		[attachSession, refreshSessions]
	);

	const searchSessions = useCallback(async (workspaceId: string, query: string, archived: boolean) => {
		const result = await requestRef.current?.({ type: "session.search", workspaceId, query, archived, limit: 30 });
		if (result?.type !== "session.search") throw new Error("聊天搜索不可用");
		return { matches: result.matches, truncated: result.truncated };
	}, []);

	const selectModel = useCallback(
		(model: ModelRef) => {
			const available = state.models.find((candidate) => candidate.authenticated && sameModel(candidate.model, model));
			if (!available) throw new Error("模型不可用或尚未通过验证");
			localStorage.setItem("wuming.model", JSON.stringify(available.model));
			setState((current) => ({ ...current, selectedModel: available.model }));
		},
		[state.models]
	);

	const createSessionInWorkspace = useCallback(
		async (workspaceId: string) => {
			const currentSession = snapshotRef.current;
			if (currentSession && currentSession.session.workspaceId !== workspaceId) {
				await requestRef
					.current?.({ type: "session.detach", sessionId: currentSession.session.id })
					.catch(() => undefined);
			}
			const model =
				state.models.find((candidate) => candidate.authenticated && sameModel(state.selectedModel, candidate.model)) ??
				state.models.find((candidate) => candidate.authenticated) ??
				state.models[0];
			if (!model) throw new Error("模型不可用");
			const permission = readStoredPermission(localStorage);
			const result = await requestRef.current?.({
				type: "session.create",
				workspaceId,
				model: model.model,
				thinkingLevel: thinkingLevelForModel(model, readStoredThinking(localStorage)),
				sandboxMode: permission.sandboxMode,
				approvalPolicy: permission.approvalPolicy,
			});
			if (result?.type === "session.created") {
				sessionListRef.current = { archived: false };
				snapshotRef.current = result.snapshot;
				localStorage.setItem(sessionSelectionKey(workspaceId), result.snapshot.session.id);
				setState((current) => ({
					...current,
					selectedWorkspaceId: workspaceId,
					snapshot: result.snapshot,
					runs: [],
					memories: [],
					subagents: [],
					subagentDepth: 0,
					canCreateSubagent: true,
					goals: [],
					automations: [],
					liveAssistants: {},
					liveTools: {},
					liveRetry: undefined,
				}));
				await refreshSessions(workspaceId, { archived: false });
			}
		},
		[refreshSessions, state.models, state.selectedModel]
	);

	const createSession = useCallback(async () => {
		const workspace =
			state.workspaces.find((candidate) => candidate.id === state.selectedWorkspaceId) ?? state.workspaces[0];
		if (!workspace) throw new Error("工作区不可用");
		await createSessionInWorkspace(workspace.id);
	}, [createSessionInWorkspace, state.selectedWorkspaceId, state.workspaces]);

	const importProject = useCallback(
		async (
			name: string,
			files: Array<{ file: File; path: string }>,
			onProgress?: (uploaded: number, total: number) => void
		) => {
			if (files.length === 0) throw new Error("没有可导入的文件");
			const { project: draft } = await workspaceApi.createProject(token, name);
			let uploaded = 0;
			for (let index = 0; index < files.length; index += 4) {
				const batch = files.slice(index, index + 4);
				await Promise.all(
					batch.map(async (entry) => {
						await workspaceApi.uploadProjectFile(token, draft.id, entry.path, entry.file);
						uploaded += 1;
						onProgress?.(uploaded, files.length);
					})
				);
			}
			const { project } = await workspaceApi.completeProject(token, draft.id);
			const result = await requestRef.current?.({ type: "workspace.list" });
			const workspaces = result?.type === "workspace.list" ? result.workspaces : [...state.workspaces, project];
			setState((current) => ({ ...current, workspaces }));
			await openWorkspace(project.id, false);
			return project;
		},
		[openWorkspace, state.workspaces, token]
	);

	const openLocalProject = useCallback(async () => {
		const { project } = await workspaceApi.pickProject(token);
		const result = await requestRef.current?.({ type: "workspace.list" });
		const workspaces = result?.type === "workspace.list" ? result.workspaces : [...state.workspaces, project];
		setState((current) => ({ ...current, workspaces }));
		await openWorkspace(project.id, false);
		return project;
	}, [openWorkspace, state.workspaces, token]);

	const renameProject = useCallback(
		async (projectId: string, name: string) => {
			const normalizedName = name.trim();
			if (!normalizedName) throw new Error("项目名称不能为空");
			const { project } = await workspaceApi.renameProject(token, projectId, normalizedName);
			setState((current) => ({
				...current,
				workspaces: current.workspaces.map((workspace) => (workspace.id === project.id ? project : workspace)),
			}));
			return project;
		},
		[token]
	);

	const removeProject = useCallback(
		async (projectId: string) => {
			const selected = state.selectedWorkspaceId === projectId;
			const currentSession = snapshotRef.current;
			if (selected && currentSession) {
				if (currentSession.session.phase !== "idle") throw new Error("请先停止正在运行的会话");
			}
			await workspaceApi.removeProject(token, projectId);
			if (selected) snapshotRef.current = undefined;
			const result = await requestRef.current?.({ type: "workspace.list" });
			const workspaces =
				result?.type === "workspace.list"
					? result.workspaces
					: state.workspaces.filter((workspace) => workspace.id !== projectId);
			setState((current) => ({ ...current, workspaces }));
			if (!selected) return;
			const next = workspaces.find((workspace) => !isImplicitWorkspace(workspace)) ?? workspaces[0];
			if (next) {
				await openWorkspace(next.id);
				return;
			}
			localStorage.removeItem("wuming.workspaceId");
			setState((current) => ({
				...current,
				selectedWorkspaceId: undefined,
				sessions: [],
				snapshot: undefined,
				runs: [],
				memories: [],
				subagents: [],
				subagentDepth: 0,
				canCreateSubagent: true,
				goals: [],
				automations: [],
				liveAssistants: {},
				liveTools: {},
				liveRetry: undefined,
			}));
		},
		[openWorkspace, state.selectedWorkspaceId, state.workspaces, token]
	);

	const forkSession = useCallback(
		async (fromItemId?: string) => {
			const snapshot = snapshotRef.current;
			if (!snapshot) throw new Error("未选择会话");
			if (snapshot.session.archivedAt !== undefined) throw new Error("已归档会话为只读状态");
			const result = await requestRef.current?.({
				type: "session.fork",
				sessionId: snapshot.session.id,
				...(fromItemId === undefined ? {} : { fromItemId }),
			});
			if (result?.type !== "session.forked") return;
			const forkedSnapshot = await syncStoredPermission(result.snapshot);
			const workspaceId = forkedSnapshot.session.workspaceId;
			snapshotRef.current = forkedSnapshot;
			localStorage.setItem(sessionSelectionKey(workspaceId), forkedSnapshot.session.id);
			setState((current) => ({
				...current,
				selectedWorkspaceId: workspaceId,
				snapshot: forkedSnapshot,
				runs: [],
				memories: [],
				subagents: [],
				subagentDepth: 0,
				canCreateSubagent: true,
				goals: [],
				automations: [],
				liveAssistants: {},
				liveTools: {},
				liveRetry: undefined,
			}));
			await refreshSessions(workspaceId, { archived: false });
		},
		[refreshSessions, syncStoredPermission]
	);

	const compactSession = useCallback(
		async (instructions?: string) => {
			const snapshot = snapshotRef.current;
			if (!snapshot) throw new Error("未选择会话");
			if (snapshot.session.archivedAt !== undefined) throw new Error("已归档会话为只读状态");
			const result = await requestRef.current?.({
				type: "session.compact",
				sessionId: snapshot.session.id,
				...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
			});
			if (result?.type !== "session.compacted") return;
			snapshotRef.current = result.snapshot;
			setState((current) => ({
				...current,
				snapshot: result.snapshot,
				liveAssistants: {},
				liveTools: {},
				liveRetry: undefined,
			}));
			if (capabilitiesRef.current.includes("session.memory")) await refreshMemories(snapshot.session.id);
		},
		[refreshMemories]
	);

	const setSessionModel = useCallback(async (model: ModelRef) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({
			type: "session.model.set",
			sessionId: snapshot.session.id,
			model,
		});
		if (result?.type !== "session.configured") return;
		snapshotRef.current = result.snapshot;
		setState((current) => ({
			...current,
			snapshot: result.snapshot,
			selectedModel: result.snapshot.model,
		}));
	}, []);

	const setSessionThinking = useCallback(async (thinkingLevel: ThinkingLevel) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({
			type: "session.thinking.set",
			sessionId: snapshot.session.id,
			thinkingLevel,
		});
		if (result?.type !== "session.configured") return;
		snapshotRef.current = result.snapshot;
		// Remembered so the next session opens at the strength the user settled on
		// instead of silently dropping back to the default.
		writeStoredThinking(localStorage, thinkingLevel);
		setState((current) => ({ ...current, snapshot: result.snapshot }));
	}, []);

	const setSessionPolicy = useCallback(async (sandboxMode: SandboxMode, approvalPolicy: ApprovalPolicy) => {
		const snapshot = snapshotRef.current;
		writeStoredPermission(localStorage, { sandboxMode, approvalPolicy });
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({
			type: "session.policy.set",
			sessionId: snapshot.session.id,
			sandboxMode,
			approvalPolicy,
		});
		if (result?.type !== "session.configured") return;
		snapshotRef.current = result.snapshot;
		setState((current) => ({ ...current, snapshot: result.snapshot }));
	}, []);

	const setSessionBudget = useCallback(
		async (budget: { costBudgetUsd?: number | null; tokenBudget?: number | null; budgetWarningThreshold?: number }) => {
			const snapshot = snapshotRef.current;
			if (!snapshot) throw new Error("未选择会话");
			const result = await requestRef.current?.({
				type: "session.budget.set",
				sessionId: snapshot.session.id,
				...budget,
			});
			if (result?.type !== "session.configured") return;
			snapshotRef.current = result.snapshot;
			setState((current) => ({ ...current, snapshot: result.snapshot }));
		},
		[]
	);

	const uploadArtifact = useCallback(
		async (file: File): Promise<ArtifactRef> => {
			const workspaceId =
				snapshotRef.current?.session.workspaceId ?? state.selectedWorkspaceId ?? state.workspaces[0]?.id;
			if (!workspaceId) throw new Error("未选择工作区");
			const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/artifacts`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": file.type || "application/octet-stream",
					"X-Wuming-File-Name": encodeURIComponent(file.name),
				},
				body: file,
			});
			const value = (await response.json()) as { artifact?: ArtifactRef; error?: string };
			if (!response.ok || !value.artifact) throw new Error(value.error ?? `上传失败，状态码 ${response.status}`);
			return value.artifact;
		},
		[state.selectedWorkspaceId, state.workspaces, token]
	);

	const loadArtifact = useCallback(
		async (artifact: ArtifactRef): Promise<Blob> => {
			const response = await fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) {
				const value = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(value.error ?? `下载失败，状态码 ${response.status}`);
			}
			return response.blob();
		},
		[token]
	);

	const downloadArtifact = useCallback(
		async (artifact: ArtifactRef): Promise<void> => {
			const url = URL.createObjectURL(await loadArtifact(artifact));
			try {
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = artifact.name;
				anchor.click();
			} finally {
				setTimeout(() => URL.revokeObjectURL(url), 0);
			}
		},
		[loadArtifact]
	);

	const sendPrompt = useCallback(
		async (text: string, artifacts: ArtifactRef[] = [], queueMode: "steer" | "follow_up" = "steer") => {
			const snapshot = snapshotRef.current;
			if (!snapshot) throw new Error("未选择会话");
			if (snapshot.session.archivedAt !== undefined) throw new Error("已归档会话为只读状态");
			if (state.selectedSkill?.truncated) throw new Error("所选技能内容已截断，无法执行。请先精简技能文件或取消技能。");
			if (state.selectedSkill && state.selectedSkill.workspaceId !== snapshot.session.workspaceId)
				throw new Error("所选技能不属于当前会话的工作区，请重新选择技能。");
			const content: UserContentPart[] = [
				...(text.trim() ? [{ type: "text" as const, text: text.trim() }] : []),
				...artifacts.map((artifact) => ({ type: "artifact" as const, artifact })),
			];
			if (content.length === 0) throw new Error("请输入消息或添加附件");
			const launchTeam = state.selectedSkill?.id === "team" || /^\/team(?:\s|$)/.test(text.trim());
			if (launchTeam && snapshot.session.phase !== "idle") throw new Error("请先停止当前任务，或在新对话中启动团队");
			const type =
				snapshot.session.phase === "idle" ? "turn.prompt" : queueMode === "steer" ? "turn.steer" : "turn.follow_up";
			await requestRef.current?.({
				type,
				sessionId: snapshot.session.id,
				content,
				...(state.selectedSkill ? { skills: [state.selectedSkill.id] } : {}),
			});
			if (launchTeam)
				setState((current) =>
					current.selectedSkill === state.selectedSkill ? { ...current, selectedSkill: undefined } : current
				);
			await refreshRuns(snapshot.session.id);
		},
		[refreshRuns, state.selectedSkill]
	);

	const renameSession = useCallback(
		async (sessionId: string, name: string) => {
			const normalizedName = name.trim();
			if (!normalizedName) throw new Error("会话名称不能为空");
			const result = await requestRef.current?.({
				type: "session.rename",
				sessionId,
				name: normalizedName,
			});
			if (result?.type !== "session.renamed") return;
			if (snapshotRef.current?.session.id === sessionId) {
				snapshotRef.current = result.snapshot;
				setState((current) => ({ ...current, snapshot: result.snapshot }));
			}
			await refreshSessions(result.snapshot.session.workspaceId);
		},
		[refreshSessions]
	);

	const archiveSession = useCallback(
		async (sessionId: string, archived: boolean) => {
			const result = await requestRef.current?.({ type: "session.archive", sessionId, archived });
			if (result?.type !== "session.archived") return;
			const workspaceId = result.snapshot.session.workspaceId;
			await refreshSessions(workspaceId);
			if (snapshotRef.current?.session.id !== sessionId) return;
			if ((result.snapshot.session.archivedAt !== undefined) === (sessionListRef.current.archived ?? false)) {
				snapshotRef.current = result.snapshot;
				setState((current) => ({ ...current, snapshot: result.snapshot }));
				return;
			}
			await requestRef.current?.({ type: "session.detach", sessionId }).catch(() => undefined);
			snapshotRef.current = undefined;
			localStorage.removeItem(sessionSelectionKey(workspaceId));
			setState((current) => ({
				...current,
				snapshot: undefined,
				runs: [],
				memories: [],
				subagents: [],
				subagentDepth: 0,
				canCreateSubagent: true,
				goals: [],
				automations: [],
				liveAssistants: {},
				liveTools: {},
				liveRetry: undefined,
			}));
		},
		[refreshSessions]
	);

	const respondApproval = useCallback(
		async (sessionId: string, approvalId: string, decision: "approve" | "deny") => {
			await requestRef.current?.({ type: "approval.respond", sessionId, approvalId, decision });
			const parentId = snapshotRef.current?.session.id;
			if (parentId && parentId !== sessionId) await Promise.all([refreshSubagents(parentId), refreshGoals(parentId)]);
		},
		[refreshGoals, refreshSubagents]
	);

	const createSubagent = useCallback(
		async (input: { task: string; name?: string; costBudgetUsd?: number; tokenBudget?: number }) => {
			const snapshot = snapshotRef.current;
			if (!snapshot) throw new Error("未选择会话");
			if (snapshot.session.archivedAt !== undefined) throw new Error("已归档会话为只读状态");
			const result = await requestRef.current?.({
				type: "subagent.create",
				sessionId: snapshot.session.id,
				task: input.task,
				...(input.name ? { name: input.name } : {}),
				...(input.costBudgetUsd === undefined ? {} : { costBudgetUsd: input.costBudgetUsd }),
				...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
			});
			if (result?.type !== "subagent.created") throw new Error("子智能体创建失败");
			setState((current) =>
				current.snapshot?.session.id !== snapshot.session.id
					? current
					: {
							...current,
							subagents: [
								result.subagent,
								...current.subagents.filter((candidate) => candidate.id !== result.subagent.id),
							],
						}
			);
			return result.subagent;
		},
		[]
	);

	const cancelSubagent = useCallback(async (subagentId: string, parentSessionId?: string) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({
			type: "subagent.cancel",
			sessionId: parentSessionId ?? snapshot.session.id,
			subagentId,
		});
		if (result?.type !== "subagent.cancel_requested") throw new Error("取消子智能体任务失败");
		setState((current) => ({
			...current,
			subagents: current.subagents.map((candidate) => (candidate.id === subagentId ? result.subagent : candidate)),
		}));
		return result.subagent;
	}, []);

	const createGoal = useCallback(
		async (input: {
			objective: string;
			skillId?: string;
			executionMode?: GoalExecutionMode;
			title?: string;
			successCriteria?: string;
			maxRounds?: number;
			plan?: GoalPlanSpec;
		}) => {
			const snapshot = snapshotRef.current;
			if (!snapshot) throw new Error("未选择会话");
			if (snapshot.session.archivedAt !== undefined) throw new Error("已归档会话为只读状态");
			goalMutationVersion.current += 1;
			// The orchestrator rejects review rounds without success criteria, so both fields travel together.
			const review = input.successCriteria
				? {
						successCriteria: input.successCriteria,
						...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
					}
				: {};
			const result = await requestRef.current?.({
				type: "goal.create",
				sessionId: snapshot.session.id,
				objective: input.objective,
				...(input.skillId === undefined ? {} : { skillId: input.skillId }),
				...(input.executionMode === undefined
					? input.plan === undefined && input.successCriteria === undefined
						? { executionMode: "session" as const }
						: {}
					: { executionMode: input.executionMode }),
				...(input.plan === undefined ? {} : { plan: input.plan }),
				...(input.title ? { title: input.title } : {}),
				...review,
			});
			if (result?.type !== "goal.created") throw new Error("目标创建失败");
			setState((current) =>
				current.snapshot?.session.id !== snapshot.session.id
					? current
					: {
							...current,
							goals: [result.goal, ...current.goals.filter((goal) => goal.id !== result.goal.id)],
						}
			);
			return result.goal;
		},
		[]
	);

	const startGoal = useCallback(async (goalId: string) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		goalMutationVersion.current += 1;
		const result = await requestRef.current?.({
			type: "goal.start",
			sessionId: snapshot.session.id,
			goalId,
		});
		if (result?.type !== "goal.started") throw new Error("目标启动失败");
		setState((current) => ({
			...current,
			liveGoalActivities: Object.fromEntries(
				Object.entries(current.liveGoalActivities).filter(([id]) => id !== goalId)
			),
			goals: current.goals.map((goal) => (goal.id === goalId ? result.goal : goal)),
		}));
		return result.goal;
	}, []);

	const cancelGoal = useCallback(async (goalId: string) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		goalMutationVersion.current += 1;
		const result = await requestRef.current?.({
			type: "goal.cancel",
			sessionId: snapshot.session.id,
			goalId,
		});
		if (result?.type !== "goal.cancel_requested") throw new Error("目标取消失败");
		setState((current) => ({
			...current,
			liveGoalActivities: Object.fromEntries(
				Object.entries(current.liveGoalActivities).filter(([id]) => id !== goalId)
			),
			goals: current.goals.map((goal) => (goal.id === goalId ? result.goal : goal)),
		}));
		return result.goal;
	}, []);

	const pauseGoal = useCallback(async (goalId: string) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		goalMutationVersion.current += 1;
		const result = await requestRef.current?.({
			type: "goal.pause",
			sessionId: snapshot.session.id,
			goalId,
		});
		if (result?.type !== "goal.paused") throw new Error("目标暂停失败");
		setState((current) => ({
			...current,
			liveGoalActivities: Object.fromEntries(
				Object.entries(current.liveGoalActivities).filter(([id]) => id !== goalId)
			),
			goals: current.goals.map((goal) => (goal.id === goalId ? result.goal : goal)),
		}));
		return result.goal;
	}, []);

	const resumeGoal = useCallback(async (goalId: string) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		goalMutationVersion.current += 1;
		const result = await requestRef.current?.({
			type: "goal.resume",
			sessionId: snapshot.session.id,
			goalId,
		});
		if (result?.type !== "goal.resumed") throw new Error("目标继续失败");
		setState((current) => ({
			...current,
			liveGoalActivities: Object.fromEntries(
				Object.entries(current.liveGoalActivities).filter(([id]) => id !== goalId)
			),
			goals: current.goals.map((goal) => (goal.id === goalId ? result.goal : goal)),
		}));
		return result.goal;
	}, []);

	const deleteGoal = useCallback(async (goalId: string) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		goalMutationVersion.current += 1;
		const result = await requestRef.current?.({
			type: "goal.delete",
			sessionId: snapshot.session.id,
			goalId,
		});
		if (result?.type !== "goal.deleted") throw new Error("目标删除失败");
		setState((current) => ({
			...current,
			liveGoalActivities: Object.fromEntries(
				Object.entries(current.liveGoalActivities).filter(([id]) => id !== goalId)
			),
			goals: current.goals.filter((goal) => goal.id !== goalId),
		}));
		return goalId;
	}, []);

	const createAutomation = useCallback(
		async (input: {
			objective: string;
			title?: string;
			schedule: AutomationSchedule;
			successCriteria?: string;
			maxRounds?: number;
			plan?: GoalPlanSpec;
		}) => {
			const snapshot = snapshotRef.current;
			if (!snapshot) throw new Error("未选择会话");
			if (snapshot.session.archivedAt !== undefined) throw new Error("已归档会话为只读状态");
			const review = input.successCriteria
				? {
						successCriteria: input.successCriteria,
						...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
					}
				: {};
			const result = await requestRef.current?.({
				type: "automation.create",
				sessionId: snapshot.session.id,
				objective: input.objective,
				...(input.plan === undefined ? {} : { plan: input.plan }),
				schedule: input.schedule,
				...(input.title ? { title: input.title } : {}),
				...review,
			});
			if (result?.type !== "automation.created") throw new Error("自动化创建失败");
			setState((current) => ({
				...current,
				automations: [
					result.automation,
					...current.automations.filter((automation) => automation.id !== result.automation.id),
				],
			}));
			return result.automation;
		},
		[]
	);

	const setAutomationEnabled = useCallback(async (automationId: string, enabled: boolean) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({
			type: "automation.set_enabled",
			sessionId: snapshot.session.id,
			automationId,
			enabled,
		});
		if (result?.type !== "automation.configured") throw new Error("自动化状态更新失败");
		setState((current) => ({
			...current,
			automations: current.automations.map((automation) =>
				automation.id === automationId ? result.automation : automation
			),
		}));
		return result.automation;
	}, []);

	const triggerAutomation = useCallback(
		async (automationId: string): Promise<AutomationRunSummary> => {
			const snapshot = snapshotRef.current;
			if (!snapshot) throw new Error("未选择会话");
			const result = await requestRef.current?.({
				type: "automation.trigger",
				sessionId: snapshot.session.id,
				automationId,
			});
			if (result?.type !== "automation.triggered") throw new Error("自动化触发失败");
			void refreshAutomations(snapshot.session.id).catch(() => undefined);
			return result.run;
		},
		[refreshAutomations]
	);

	const listAutomationRuns = useCallback(async (automationId: string, limit = 50): Promise<AutomationRunSummary[]> => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({
			type: "automation.run.list",
			sessionId: snapshot.session.id,
			automationId,
			limit,
		});
		if (result?.type !== "automation.run.list") throw new Error("自动化运行记录读取失败");
		return result.runs;
	}, []);

	const abortTurn = useCallback(async () => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		await requestRef.current?.({ type: "turn.abort", sessionId: snapshot.session.id });
		await refreshRuns(snapshot.session.id);
	}, [refreshRuns]);

	const agentTemplates = useCallback(async (command: Extract<Command, { type: `agent.template.${string}` }>) => {
		const result = await requestRef.current?.(command);
		if (result?.type !== "agent.templates") throw new Error("Agent template request failed");
		return result;
	}, []);
	const listTeams = useCallback(async (workspaceId: string) => {
		const result = await requestRef.current?.({ type: "team.list", workspaceId });
		if (result?.type !== "team.list") throw new Error("Team list request failed");
		return result.teams;
	}, []);

	const teamCommand = useCallback(
		async (command: Exclude<Extract<Command, { type: `team.${string}` }>, { type: "team.list" }>) => {
			const result = await requestRef.current?.(command);
			if (result?.type !== "team.snapshot") throw new Error("Team request failed");
			return result.team;
		},
		[]
	);

	return {
		...state,
		teamCommand,
		agentTemplates,
		listTeams,
		token,
		setToken,
		selectWorkspace,
		selectModel,
		browseSessions,
		searchSessions,
		refreshSessions,
		getUsageOverview,
		refreshUsageOverview,
		refreshRuns,
		refreshMemories,
		manageMemory,
		refreshEvaluationDatasets,
		createEvaluationDataset,
		deleteEvaluationDataset,
		listRunEvaluations,
		runEvaluation,
		createRunAttestation,
		refreshSubagents,
		refreshGoals,
		refreshAutomations,
		refreshSkills,
		refreshTools,
		getSkill,
		clearSelectedSkill,
		manageSkills,
		manageMcp,
		refreshMcp,
		refreshModels,
		officialAccounts,
		discoverCustomModels,
		listCustomMediaModels,
		modelSettingsRevision,
		listCustomModelServices,
		refreshCustomModelService,
		removeCustomModelService,
		getCustomModelSettings,
		configureCustomModel,
		configureCustomModels,
		removeCustomModel,
		testCustomModel,
		listMediaModels,
		setDefaultImageModel,
		setDefaultVideoModel,
		removeVideoModel,
		removeImageModel,
		discoverMediaModels,
		setMediaModel,
		removeMediaModel,
		getMcp,
		importProject,
		openLocalProject,
		renameProject,
		removeProject,
		beginNewChat,
		createSessionInWorkspace,
		createSession,
		forkSession,
		compactSession,
		setSessionModel,
		setSessionThinking,
		setSessionPolicy,
		setSessionBudget,
		attachSession,
		renameSession,
		archiveSession,
		sendPrompt,
		respondApproval,
		createSubagent,
		cancelSubagent,
		createGoal,
		startGoal,
		cancelGoal,
		pauseGoal,
		resumeGoal,
		deleteGoal,
		createAutomation,
		setAutomationEnabled,
		triggerAutomation,
		listAutomationRuns,
		abortTurn,
		uploadArtifact,
		loadArtifact,
		downloadArtifact,
	};
}

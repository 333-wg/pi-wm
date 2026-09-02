import { useCallback, useEffect, useRef, useState } from "react";
import type {
	Command,
	CommandResult,
	Capability,
	CustomModelConfig,
	CustomModelConnection,
	CustomModelService,
	GoalSummary,
	ArtifactRef,
	ModelMetadata,
	ModelRef,
	RunSummary,
	ServerMessage,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	UserContentPart,
	WorkspaceSummary,
	Skill,
	SkillSummary,
	McpServer,
	McpServerSummary,
	SubagentSummary,
	ToolStatus,
} from "@wuming/protocol";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface LiveAssistant {
	id: string;
	text: string;
	thinking: string;
	toolCall: string;
}

export interface LiveTool {
	toolCallId: string;
	toolName: string;
	preview: string;
	truncated: boolean;
}

interface ClientState {
	connection: ConnectionStatus;
	capabilities: Capability[];
	workspaces: WorkspaceSummary[];
	models: ModelMetadata[];
	selectedWorkspaceId: string | undefined;
	selectedModel: ModelRef | undefined;
	sessions: SessionSummary[];
	runs: RunSummary[];
	snapshot: SessionSnapshot | undefined;
	liveAssistants: Record<string, LiveAssistant>;
	liveTools: Record<string, LiveTool>;
	skills: SkillSummary[];
	selectedSkill: Skill | undefined;
	mcpServers: McpServerSummary[];
	selectedMcpServer: McpServer | undefined;
	tools: ToolStatus[];
	toolRuntime: "pi" | "demo" | undefined;
	subagents: SubagentSummary[];
	goals: GoalSummary[];
	error: string | undefined;
}

export interface SessionListOptions {
	query?: string;
	archived?: boolean;
}

const initialState: ClientState = {
	connection: "connecting",
	capabilities: [],
	workspaces: [],
	models: [],
	selectedWorkspaceId: undefined,
	selectedModel: undefined,
	sessions: [],
	runs: [],
	snapshot: undefined,
	liveAssistants: {},
	liveTools: {},
	skills: [],
	selectedSkill: undefined,
	mcpServers: [],
	selectedMcpServer: undefined,
	tools: [],
	toolRuntime: undefined,
	subagents: [],
	goals: [],
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

function bearerProtocol(token: string): string {
	const bytes = new TextEncoder().encode(token);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `wuming.bearer.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function upsertTranscript(snapshot: SessionSnapshot, item: SessionSnapshot["transcript"][number]): SessionSnapshot {
	const index = snapshot.transcript.findIndex((candidate) => candidate.id === item.id);
	if (index === -1) return { ...snapshot, transcript: [...snapshot.transcript, item] };
	const transcript = [...snapshot.transcript];
	transcript[index] = item;
	return { ...snapshot, transcript };
}

export function useWumingClient() {
	const [token, setTokenState] = useState(() => localStorage.getItem("wuming.token") ?? "dev-token");
	const [reconnectAttempt, setReconnectAttempt] = useState(0);
	const [state, setState] = useState<ClientState>(initialState);
	const pending = useRef(
		new Map<string, { resolve: (result: CommandResult) => void; reject: (error: Error) => void }>(),
	);
	const requestRef = useRef<((command: Command, idempotencyKey?: string) => Promise<CommandResult>) | undefined>(undefined);
	const snapshotRef = useRef<SessionSnapshot | undefined>(undefined);
	const capabilitiesRef = useRef<Capability[]>([]);
	const cursorRef = useRef<string | undefined>(localStorage.getItem("wuming.cursor") ?? undefined);
	const sessionListRef = useRef<SessionListOptions>({ archived: false });

	const refreshSkills = useCallback(async (workspaceId: string) => {
		const result = await requestRef.current?.({ type: "skill.list", workspaceId });
		const skills = result?.type === "skill.list" ? result.skills : [];
		setState((current) => ({ ...current, skills, selectedSkill: undefined }));
		return skills;
	}, []);

	const refreshMcp = useCallback(async (workspaceId: string) => {
		const result = await requestRef.current?.({ type: "mcp.list", workspaceId });
		const mcpServers = result?.type === "mcp.list" ? result.servers : [];
		setState((current) => ({ ...current, mcpServers, selectedMcpServer: undefined }));
		return mcpServers;
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
			const selectedModel = models.find((candidate) => candidate.authenticated && sameModel(current.selectedModel, candidate.model))?.model
				?? models.find((candidate) => candidate.authenticated && candidate.model.provider.startsWith("custom-"))?.model
				?? models.find((candidate) => candidate.authenticated)?.model
				?? models[0]?.model;
			if (selectedModel) localStorage.setItem("wuming.model", JSON.stringify(selectedModel));
			return { ...current, models, selectedModel };
		});
		return models;
	}, []);

	const configureCustomModels = useCallback(async (configs: CustomModelConfig[]) => {
		const configured: ModelMetadata[] = [];
		for (const config of configs) {
			const result = await requestRef.current?.({ type: "model.custom.set", config });
			if (result?.type !== "model.custom.configured") throw new Error(`自定义模型 ${config.id} 配置失败`);
			configured.push(result.model);
		}
		const selected = configured.at(-1)?.model;
		if (selected) {
			localStorage.setItem("wuming.model", JSON.stringify(selected));
			setState((current) => ({ ...current, selectedModel: selected }));
		}
		await refreshModels();
		return configured;
	}, [refreshModels]);

	const configureCustomModel = useCallback(async (config: CustomModelConfig) => {
		const model = (await configureCustomModels([config]))[0];
		if (!model) throw new Error("自定义模型配置失败");
		return model;
	}, [configureCustomModels]);

	const discoverCustomModels = useCallback(async (connection: CustomModelConnection) => {
		const result = await requestRef.current?.({ type: "model.custom.discover", connection });
		if (result?.type !== "model.custom.discovered") throw new Error("无法从该地址获取模型列表");
		return result;
	}, []);

	const listCustomModelServices = useCallback(async (): Promise<CustomModelService[]> => {
		const result = await requestRef.current?.({ type: "model.custom.service.list" });
		if (result?.type !== "model.custom.service.list") throw new Error("无法读取模型服务");
		return result.services;
	}, []);

	const refreshCustomModelService = useCallback(async (provider: string) => {
		const result = await requestRef.current?.({ type: "model.custom.service.refresh", provider });
		if (result?.type !== "model.custom.discovered") throw new Error("无法刷新模型服务");
		return result;
	}, []);

	const removeCustomModelService = useCallback(async (provider: string) => {
		const result = await requestRef.current?.({ type: "model.custom.service.remove", provider });
		if (result?.type !== "model.custom.service.removed") throw new Error("删除模型服务失败");
	}, []);

	const getCustomModelSettings = useCallback(async (model: ModelRef) => {
		const result = await requestRef.current?.({ type: "model.custom.get", model });
		if (result?.type !== "model.custom.settings") throw new Error("无法读取自定义模型设置");
		return result.settings;
	}, []);

	const removeCustomModel = useCallback(async (model: ModelRef) => {
		const result = await requestRef.current?.({ type: "model.custom.remove", model });
		if (result?.type !== "model.custom.removed") throw new Error("删除自定义模型失败");
		await refreshModels();
	}, [refreshModels]);

	const testCustomModel = useCallback(async (model: ModelRef) => {
		const result = await requestRef.current?.({ type: "model.custom.test", model });
		if (result?.type !== "model.custom.tested") throw new Error("模型测试失败");
		return result.latencyMs;
	}, []);

	useEffect(() => {
		snapshotRef.current = state.snapshot;
	}, [state.snapshot]);

	const setToken = useCallback((value: string) => {
		localStorage.setItem("wuming.token", value);
		localStorage.removeItem("wuming.cursor");
		cursorRef.current = undefined;
		setTokenState(value);
	}, []);

	const refreshSessions = useCallback(async (workspaceId: string, options: SessionListOptions = sessionListRef.current) => {
		const normalized = { ...(options.query?.trim() ? { query: options.query.trim() } : {}), archived: options.archived ?? false };
		sessionListRef.current = normalized;
		const result = await requestRef.current?.({ type: "session.list", workspaceId, ...normalized, limit: 200 });
		if (result?.type === "session.list") setState((current) => ({ ...current, sessions: result.sessions }));
		return result?.type === "session.list" ? result.sessions : [];
	}, []);

	const refreshRuns = useCallback(async (sessionId: string) => {
		const result = await requestRef.current?.({ type: "session.run.list", sessionId, limit: 20 });
		if (result?.type === "session.run.list" && snapshotRef.current?.session.id === sessionId) {
			setState((current) => ({ ...current, runs: result.runs }));
		}
		return result?.type === "session.run.list" ? result.runs : [];
	}, []);

	const refreshSubagents = useCallback(async (sessionId: string) => {
		const result = await requestRef.current?.({ type: "subagent.list", sessionId, limit: 100 });
		if (result?.type === "subagent.list" && snapshotRef.current?.session.id === sessionId) {
			setState((current) => ({ ...current, subagents: result.subagents }));
		}
		return result?.type === "subagent.list" ? result.subagents : [];
	}, []);

	const refreshGoals = useCallback(async (sessionId: string) => {
		const result = await requestRef.current?.({ type: "goal.list", sessionId, limit: 100 });
		if (result?.type === "goal.list" && snapshotRef.current?.session.id === sessionId) {
			setState((current) => ({ ...current, goals: result.goals }));
		}
		return result?.type === "goal.list" ? result.goals : [];
	}, []);

	const attachSession = useCallback(async (sessionId: string) => {
		const result = await requestRef.current?.({ type: "session.attach", sessionId });
		if (result?.type === "session.attached") {
			const workspaceId = result.snapshot.session.workspaceId;
			snapshotRef.current = result.snapshot;
			localStorage.setItem("wuming.workspaceId", workspaceId);
			localStorage.setItem(sessionSelectionKey(workspaceId), sessionId);
			setState((current) => ({
				...current,
				selectedWorkspaceId: workspaceId,
				snapshot: result.snapshot,
				liveAssistants: {},
				liveTools: {},
				subagents: [],
				goals: [],
				error: undefined,
			}));
			await Promise.all([
				refreshRuns(sessionId),
				...(capabilitiesRef.current.includes("subagents") ? [refreshSubagents(sessionId)] : []),
				...(capabilitiesRef.current.includes("goals") ? [refreshGoals(sessionId)] : []),
			]);
		}
	}, [refreshGoals, refreshRuns, refreshSubagents]);

	useEffect(() => {
		let disposed = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		setState((current) => ({ ...current, connection: "connecting", error: undefined }));
		const scheme = location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${scheme}://${location.host}/api/ws`, ["wuming.v1", bearerProtocol(token)]);

		const request = (command: Command, idempotencyKey = id()) =>
			new Promise<CommandResult>((resolve, reject) => {
				if (ws.readyState !== WebSocket.OPEN) return reject(new Error("网关尚未连接"));
				const requestId = id();
				pending.current.set(requestId, { resolve, reject });
				ws.send(JSON.stringify({ type: "request", requestId, idempotencyKey, command }));
			});
		requestRef.current = request;

		const resync = async (sessionId: string) => {
			try {
				const result = await request({ type: "session.snapshot.get", sessionId });
				if (result.type === "session.snapshot") {
					snapshotRef.current = result.snapshot;
					setState((current) => ({ ...current, snapshot: result.snapshot, liveAssistants: {}, liveTools: {} }));
					void refreshRuns(sessionId);
				}
			} catch (error) {
				setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
			}
		};

		const applyMessage = (message: ServerMessage) => {
			if (message.type === "hello") {
				capabilitiesRef.current = message.capabilities;
				setState((current) => ({ ...current, connection: "connected", capabilities: message.capabilities, error: undefined }));
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
						const selectedModel = models.find((candidate) => candidate.authenticated && sameModel(storedModel, candidate.model))?.model
							?? models.find((candidate) => candidate.authenticated && candidate.model.provider.startsWith("custom-"))?.model
							?? models.find((candidate) => candidate.authenticated)?.model
							?? models[0]?.model;
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
						const sessionResult = await request({
							type: "session.list",
							workspaceId: workspace.id,
							...sessionListRef.current,
							limit: 200,
						});
						const sessions = sessionResult.type === "session.list" ? sessionResult.sessions : [];
						setState((current) => ({ ...current, sessions }));
						const storedSessionId = localStorage.getItem(sessionSelectionKey(workspace.id));
						const session = sessions.find((candidate) => candidate.id === storedSessionId) ?? sessions[0];
						if (session) await attachSession(session.id);
					} catch (error) {
						setState((current) => ({
							...current,
							connection: "error",
							error: error instanceof Error ? error.message : String(error),
						}));
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
				if (event.type === "assistant.delta") {
					setState((current) => {
						const existing = current.liveAssistants[event.itemId] ?? {
							id: event.itemId,
							text: "",
							thinking: "",
							toolCall: "",
						};
						const field = event.kind === "text" ? "text" : event.kind === "thinking" ? "thinking" : "toolCall";
						return {
							...current,
							liveAssistants: {
								...current.liveAssistants,
								[event.itemId]: { ...existing, [field]: existing[field] + event.delta },
							},
						};
					});
				} else if (event.type === "tool.started") {
					setState((current) => ({
						...current,
						liveTools: {
							...current.liveTools,
							[event.toolCallId]: {
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								preview: "",
								truncated: false,
							},
						},
					}));
				} else {
					setState((current) => {
						const existing = current.liveTools[event.toolCallId] ?? {
							toolCallId: event.toolCallId,
							toolName: "tool",
							preview: "",
							truncated: false,
						};
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[event.toolCallId]: { ...existing, preview: event.preview, truncated: event.truncated },
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
				if (event.snapshot.session.id === snapshotRef.current?.session.id) {
					snapshotRef.current = event.snapshot;
					setState((current) => ({ ...current, snapshot: event.snapshot }));
					void refreshSessions(event.snapshot.session.workspaceId);
				}
				return;
			}
			if (event.sessionId !== snapshotRef.current?.session.id) return;
			if (event.type === "session.phase.changed" && event.phase === "idle") void refreshRuns(event.sessionId);
			setState((current) => {
				const snapshot = current.snapshot;
				if (!snapshot) return current;
				if (event.revision <= snapshot.revision) return current;
				if (event.revision !== snapshot.revision + 1) {
					void resync(snapshot.session.id);
					return current;
				}
				if (event.type === "session.item.upserted") {
					const next = upsertTranscript(snapshot, event.item);
					const liveAssistants = { ...current.liveAssistants };
					const liveTools = { ...current.liveTools };
					delete liveAssistants[event.item.id];
					if (event.item.type === "tool") delete liveTools[event.item.toolCallId];
					return { ...current, snapshot: { ...next, revision: event.revision }, liveAssistants, liveTools };
				}
				if (event.type === "session.phase.changed") {
					return {
						...current,
						snapshot: { ...snapshot, revision: event.revision, session: { ...snapshot.session, phase: event.phase } },
						...(event.phase === "idle" ? { liveAssistants: {}, liveTools: {} } : {}),
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
						capabilities: ["session.resume", "session.fork", "turn.steer", "turn.follow_up", "approval", "artifact", "image_input", "git", "terminal", "skills", "mcp", "subagents", "goals", "model.custom"],
					...(cursorRef.current ? { resumeCursor: cursorRef.current } : {}),
				}),
			);
		});
		ws.addEventListener("message", (raw) => applyMessage(JSON.parse(String(raw.data)) as ServerMessage));
		ws.addEventListener("close", () => {
			if (!disposed) {
				setState((current) => ({ ...current, connection: "disconnected" }));
				reconnectTimer = setTimeout(
					() => setReconnectAttempt((attempt) => attempt + 1),
					Math.min(4000, 500 * 2 ** Math.min(reconnectAttempt, 3)),
				);
			}
		});
		ws.addEventListener("error", () => {
			if (!disposed) setState((current) => ({ ...current, connection: "error", error: "网关连接失败" }));
		});

		return () => {
			disposed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			ws.close();
			for (const waiter of pending.current.values()) waiter.reject(new Error("网关连接已关闭"));
			pending.current.clear();
			if (requestRef.current === request) requestRef.current = undefined;
			capabilitiesRef.current = [];
		};
	}, [attachSession, reconnectAttempt, refreshRuns, refreshSessions, refreshSkills, refreshTools, refreshMcp, token]);

	useEffect(() => {
		const sessionId = state.snapshot?.session.id;
		if (state.connection !== "connected" || !sessionId || !state.capabilities.includes("subagents")) return;
		const refresh = () => void refreshSubagents(sessionId).catch(() => undefined);
		refresh();
		const timer = setInterval(refresh, 1500);
		return () => clearInterval(timer);
	}, [refreshSubagents, state.capabilities, state.connection, state.snapshot?.session.id]);

	const hasActiveGoals = state.goals.some((goal) => ["queued", "running", "awaiting_approval", "cancelling"].includes(goal.status));
	useEffect(() => {
		const sessionId = state.snapshot?.session.id;
		if (state.connection !== "connected" || !sessionId || !state.capabilities.includes("goals")) return;
		const refresh = () => void refreshGoals(sessionId).catch(() => undefined);
		refresh();
		if (!hasActiveGoals) return;
		const timer = setInterval(refresh, 1500);
		return () => clearInterval(timer);
	}, [hasActiveGoals, refreshGoals, state.capabilities, state.connection, state.snapshot?.session.id]);

	const selectWorkspace = useCallback(async (workspaceId: string) => {
		if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) throw new Error("工作区不可用");
		const previousSession = snapshotRef.current;
		if (previousSession && previousSession.session.workspaceId !== workspaceId) {
			await requestRef.current?.({ type: "session.detach", sessionId: previousSession.session.id }).catch(() => undefined);
		}
		localStorage.setItem("wuming.workspaceId", workspaceId);
		snapshotRef.current = undefined;
		setState((current) => ({
			...current,
			selectedWorkspaceId: workspaceId,
			sessions: [],
			runs: [],
			snapshot: undefined,
			liveAssistants: {},
			liveTools: {},
			error: undefined,
			skills: [],
			selectedSkill: undefined,
			mcpServers: [],
			selectedMcpServer: undefined,
			tools: [],
			toolRuntime: undefined,
			subagents: [],
			goals: [],
		}));
		await refreshSkills(workspaceId);
		if (state.capabilities.includes("tools")) await refreshTools(workspaceId);
		if (state.capabilities.includes("mcp")) await refreshMcp(workspaceId);
		const sessions = await refreshSessions(workspaceId);
		const storedSessionId = localStorage.getItem(sessionSelectionKey(workspaceId));
		const session = sessions.find((candidate) => candidate.id === storedSessionId) ?? sessions[0];
		if (session) await attachSession(session.id);
	}, [attachSession, refreshSessions, refreshSkills, refreshTools, refreshMcp, state.capabilities, state.workspaces]);

	const getSkill = useCallback(async (workspaceId: string, skillId: string) => {
		const result = await requestRef.current?.({ type: "skill.get", workspaceId, skillId });
		if (result?.type !== "skill.get") return undefined;
		setState((current) => ({ ...current, selectedSkill: result.skill }));
		return result.skill;
	}, []);

	const getMcp = useCallback(async (workspaceId: string, serverId: string) => {
		const result = await requestRef.current?.({ type: "mcp.get", workspaceId, serverId });
		if (result?.type !== "mcp.get") return undefined;
		setState((current) => ({ ...current, selectedMcpServer: result.server }));
		return result.server;
	}, []);

	const browseSessions = useCallback(async (workspaceId: string, options: SessionListOptions) => {
		const sessions = await refreshSessions(workspaceId, options);
		const current = snapshotRef.current;
		const archived = options.archived ?? false;
		if (current?.session.workspaceId === workspaceId && (current.session.archivedAt !== undefined) === archived) return sessions;
		if (current) await requestRef.current?.({ type: "session.detach", sessionId: current.session.id }).catch(() => undefined);
		snapshotRef.current = undefined;
		localStorage.removeItem(sessionSelectionKey(workspaceId));
		setState((value) => ({ ...value, snapshot: undefined, runs: [], subagents: [], goals: [], liveAssistants: {}, liveTools: {} }));
		if (sessions[0]) await attachSession(sessions[0].id);
		return sessions;
	}, [attachSession, refreshSessions]);

	const selectModel = useCallback((model: ModelRef) => {
		const available = state.models.find((candidate) => candidate.authenticated && sameModel(candidate.model, model));
		if (!available) throw new Error("模型不可用或尚未通过验证");
		localStorage.setItem("wuming.model", JSON.stringify(available.model));
		setState((current) => ({ ...current, selectedModel: available.model }));
	}, [state.models]);

	const createSession = useCallback(async () => {
		const workspace = state.workspaces.find((candidate) => candidate.id === state.selectedWorkspaceId) ?? state.workspaces[0];
		const model = state.models.find((candidate) => candidate.authenticated && sameModel(state.selectedModel, candidate.model))
			?? state.models.find((candidate) => candidate.authenticated)
			?? state.models[0];
		if (!workspace || !model) throw new Error("工作区或模型不可用");
		const result = await requestRef.current?.({
			type: "session.create",
			workspaceId: workspace.id,
			model: model.model,
			thinkingLevel: model.reasoning ? "medium" : "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		});
		if (result?.type === "session.created") {
			sessionListRef.current = { archived: false };
			snapshotRef.current = result.snapshot;
			localStorage.setItem(sessionSelectionKey(workspace.id), result.snapshot.session.id);
			setState((current) => ({
				...current,
				selectedWorkspaceId: workspace.id,
				snapshot: result.snapshot,
				runs: [],
				subagents: [],
				goals: [],
				liveAssistants: {},
				liveTools: {},
			}));
			await refreshSessions(workspace.id, { archived: false });
		}
	}, [refreshSessions, state.models, state.selectedModel, state.selectedWorkspaceId, state.workspaces]);

	const forkSession = useCallback(async (fromItemId?: string) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		if (snapshot.session.archivedAt !== undefined) throw new Error("已归档会话为只读状态");
		const result = await requestRef.current?.({
			type: "session.fork",
			sessionId: snapshot.session.id,
			...(fromItemId === undefined ? {} : { fromItemId }),
		});
		if (result?.type !== "session.forked") return;
		const workspaceId = result.snapshot.session.workspaceId;
		snapshotRef.current = result.snapshot;
		localStorage.setItem(sessionSelectionKey(workspaceId), result.snapshot.session.id);
		setState((current) => ({
			...current,
			selectedWorkspaceId: workspaceId,
			snapshot: result.snapshot,
			runs: [],
			subagents: [],
			goals: [],
			liveAssistants: {},
			liveTools: {},
		}));
		await refreshSessions(workspaceId, { archived: false });
	}, [refreshSessions]);

	const compactSession = useCallback(async (instructions?: string) => {
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
		setState((current) => ({ ...current, snapshot: result.snapshot, liveAssistants: {}, liveTools: {} }));
	}, []);

	const setSessionModel = useCallback(async (model: ModelRef) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({ type: "session.model.set", sessionId: snapshot.session.id, model });
		if (result?.type !== "session.configured") return;
		snapshotRef.current = result.snapshot;
		setState((current) => ({ ...current, snapshot: result.snapshot, selectedModel: result.snapshot.model }));
	}, []);

	const setSessionThinking = useCallback(async (thinkingLevel: ThinkingLevel) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({ type: "session.thinking.set", sessionId: snapshot.session.id, thinkingLevel });
		if (result?.type !== "session.configured") return;
		snapshotRef.current = result.snapshot;
		setState((current) => ({ ...current, snapshot: result.snapshot }));
	}, []);

	const setSessionBudget = useCallback(async (budget: { costBudgetUsd?: number | null; tokenBudget?: number | null; budgetWarningThreshold?: number }) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({ type: "session.budget.set", sessionId: snapshot.session.id, ...budget });
		if (result?.type !== "session.configured") return;
		snapshotRef.current = result.snapshot;
		setState((current) => ({ ...current, snapshot: result.snapshot }));
	}, []);

	const uploadArtifact = useCallback(async (file: File): Promise<ArtifactRef> => {
		const workspaceId = snapshotRef.current?.session.workspaceId ?? state.selectedWorkspaceId ?? state.workspaces[0]?.id;
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
		const value = await response.json() as { artifact?: ArtifactRef; error?: string };
		if (!response.ok || !value.artifact) throw new Error(value.error ?? `上传失败，状态码 ${response.status}`);
		return value.artifact;
	}, [state.selectedWorkspaceId, state.workspaces, token]);

	const downloadArtifact = useCallback(async (artifact: ArtifactRef): Promise<void> => {
		const response = await fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok) {
			const value = await response.json().catch(() => ({})) as { error?: string };
			throw new Error(value.error ?? `下载失败，状态码 ${response.status}`);
		}
		const url = URL.createObjectURL(await response.blob());
		try {
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = artifact.name;
			anchor.click();
		} finally {
			setTimeout(() => URL.revokeObjectURL(url), 0);
		}
	}, [token]);

	const sendPrompt = useCallback(async (
		text: string,
		artifacts: ArtifactRef[] = [],
		queueMode: "steer" | "follow_up" = "steer",
	) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		if (snapshot.session.archivedAt !== undefined) throw new Error("已归档会话为只读状态");
		const content: UserContentPart[] = [
			...(text.trim() ? [{ type: "text" as const, text: text.trim() }] : []),
			...artifacts.map((artifact) => ({ type: "artifact" as const, artifact })),
		];
		if (content.length === 0) throw new Error("请输入消息或添加附件");
		const type = snapshot.session.phase === "idle" ? "turn.prompt" : queueMode === "steer" ? "turn.steer" : "turn.follow_up";
		await requestRef.current?.({
			type,
			sessionId: snapshot.session.id,
			content,
			...(state.selectedSkill ? { skills: [state.selectedSkill.id] } : {}),
		});
		await refreshRuns(snapshot.session.id);
	}, [refreshRuns, state.selectedSkill]);

	const renameSession = useCallback(async (sessionId: string, name: string) => {
		const normalizedName = name.trim();
		if (!normalizedName) throw new Error("会话名称不能为空");
		const result = await requestRef.current?.({ type: "session.rename", sessionId, name: normalizedName });
		if (result?.type !== "session.renamed") return;
		if (snapshotRef.current?.session.id === sessionId) {
			snapshotRef.current = result.snapshot;
			setState((current) => ({ ...current, snapshot: result.snapshot }));
		}
		await refreshSessions(result.snapshot.session.workspaceId);
	}, [refreshSessions]);

	const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
		const result = await requestRef.current?.({ type: "session.archive", sessionId, archived });
		if (result?.type !== "session.archived") return;
		const workspaceId = result.snapshot.session.workspaceId;
		const sessions = await refreshSessions(workspaceId);
		if (snapshotRef.current?.session.id !== sessionId) return;
		if ((result.snapshot.session.archivedAt !== undefined) === (sessionListRef.current.archived ?? false)) {
			snapshotRef.current = result.snapshot;
			setState((current) => ({ ...current, snapshot: result.snapshot }));
			return;
		}
		await requestRef.current?.({ type: "session.detach", sessionId }).catch(() => undefined);
		snapshotRef.current = undefined;
		localStorage.removeItem(sessionSelectionKey(workspaceId));
		setState((current) => ({ ...current, snapshot: undefined, runs: [], subagents: [], goals: [], liveAssistants: {}, liveTools: {} }));
		if (sessions[0]) await attachSession(sessions[0].id);
	}, [attachSession, refreshSessions]);

	const respondApproval = useCallback(async (sessionId: string, approvalId: string, decision: "approve" | "deny") => {
		await requestRef.current?.({ type: "approval.respond", sessionId, approvalId, decision });
		const parentId = snapshotRef.current?.session.id;
		if (parentId && parentId !== sessionId) await Promise.all([refreshSubagents(parentId), refreshGoals(parentId)]);
	}, [refreshGoals, refreshSubagents]);

	const createSubagent = useCallback(async (input: { task: string; name?: string; costBudgetUsd?: number; tokenBudget?: number }) => {
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
		setState((current) => ({
			...current,
			subagents: [result.subagent, ...current.subagents.filter((candidate) => candidate.id !== result.subagent.id)],
		}));
		return result.subagent;
	}, []);

	const cancelSubagent = useCallback(async (subagentId: string) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({ type: "subagent.cancel", sessionId: snapshot.session.id, subagentId });
		if (result?.type !== "subagent.cancel_requested") throw new Error("取消子智能体任务失败");
		setState((current) => ({
			...current,
			subagents: current.subagents.map((candidate) => candidate.id === subagentId ? result.subagent : candidate),
		}));
		return result.subagent;
	}, []);

	const createGoal = useCallback(async (input: { objective: string; title?: string }) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		if (snapshot.session.archivedAt !== undefined) throw new Error("已归档会话为只读状态");
		const result = await requestRef.current?.({
			type: "goal.create",
			sessionId: snapshot.session.id,
			objective: input.objective,
			...(input.title ? { title: input.title } : {}),
		});
		if (result?.type !== "goal.created") throw new Error("目标创建失败");
		setState((current) => ({ ...current, goals: [result.goal, ...current.goals.filter((goal) => goal.id !== result.goal.id)] }));
		return result.goal;
	}, []);

	const startGoal = useCallback(async (goalId: string) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({ type: "goal.start", sessionId: snapshot.session.id, goalId });
		if (result?.type !== "goal.started") throw new Error("目标启动失败");
		setState((current) => ({ ...current, goals: current.goals.map((goal) => goal.id === goalId ? result.goal : goal) }));
		return result.goal;
	}, []);

	const cancelGoal = useCallback(async (goalId: string) => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		const result = await requestRef.current?.({ type: "goal.cancel", sessionId: snapshot.session.id, goalId });
		if (result?.type !== "goal.cancel_requested") throw new Error("目标取消失败");
		setState((current) => ({ ...current, goals: current.goals.map((goal) => goal.id === goalId ? result.goal : goal) }));
		return result.goal;
	}, []);

	const abortTurn = useCallback(async () => {
		const snapshot = snapshotRef.current;
		if (!snapshot) throw new Error("未选择会话");
		await requestRef.current?.({ type: "turn.abort", sessionId: snapshot.session.id });
		await refreshRuns(snapshot.session.id);
	}, [refreshRuns]);

	return {
		...state,
		token,
		setToken,
		selectWorkspace,
		selectModel,
		browseSessions,
		refreshSessions,
		refreshRuns,
		refreshSubagents,
		refreshGoals,
		refreshSkills,
		refreshTools,
		getSkill,
		refreshMcp,
		refreshModels,
		discoverCustomModels,
		listCustomModelServices,
		refreshCustomModelService,
		removeCustomModelService,
		getCustomModelSettings,
		configureCustomModel,
		configureCustomModels,
		removeCustomModel,
		testCustomModel,
		getMcp,
		createSession,
		forkSession,
		compactSession,
		setSessionModel,
		setSessionThinking,
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
		abortTurn,
		uploadArtifact,
		downloadArtifact,
	};
}

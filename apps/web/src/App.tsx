import { GoalPlanEditor, GoalPlanView, newGoalPlan } from "./components/GoalPlan";
import clover from "./assets/wuming-clover.png";
import { findToolSubagent } from "./lib/subagent-navigation.js";
import { redactDiagnostic } from "./lib/redact.js";
import {
	activeRecovery,
	activeTurnFailure,
	connectionFailure,
	desktopContinuation,
	retrySummary,
	supersededFailure,
} from "./lib/failure-state.js";
import { ChildConversationMenu } from "./components/ChildConversations.js";
import { AgentTeamsWorkbench } from "./components/AgentTeamsWorkbench.js";
import { PersistentAgentTeams } from "./components/PersistentAgentTeams.js";
import { CompactionActivity } from "./components/CompactionActivity.js";
import { GoalActivityCard } from "./components/GoalActivityCard";
import { SkillManagerDialog } from "./components/SkillManagerDialog.js";
import { McpView } from "./components/McpView.js";
import { MediaModelSettings } from "./components/MediaModelSettings.js";
import { ComputerUseSettings, useComputerUse } from "./components/ComputerUseSettings.js";
import { OfficialAccountSettings } from "./components/OfficialAccountSettings.js";
import { AgentTemplateSettings } from "./components/AgentTemplateSettings.js";
import { TeamLaunchNotice } from "./components/TeamLaunchNotice.js";
import { DesktopUpdateNotice, DesktopUpdateSettings, useDesktopUpdates } from "./components/DesktopUpdates.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import { ApprovalPanel } from "./components/ApprovalPanel.js";
import { BrowserPanel } from "./components/BrowserPanel.js";
import { OPEN_BROWSER_EVENT, previewUrl } from "./lib/browser-preview.js";
import { DESKTOP_WELCOME_KEY, isDesktopWelcomePassword, readDesktopWelcome } from "./lib/welcome.js";
import {
	Activity,
	ArrowDown,
	ArrowLeft,
	BarChart3,
	BookOpen,
	Archive,
	ArchiveRestore,
	Bot,
	Check,
	BrainCircuit,
	CalendarClock,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	Command,
	Copy,
	Download,
	FileCode2,
	FileText,
	Folder,
	FolderOpen,
	GitBranch,
	GitCompareArrows,
	Globe,
	Hourglass,
	LoaderCircle,
	TerminalSquare,
	Trash2,
	Upload,
	UserRound,
	Users,
	Menu,
	MoreHorizontal,
	MessageSquareCode,
	Plug,
	PanelLeftClose,
	PanelLeftOpen,
	PanelRight,
	Paperclip,
	Pause,
	Pencil,
	Pin,
	Play,
	Plus,
	Power,
	RefreshCw,
	Search,
	Send,
	Settings,
	ShieldAlert,
	ShieldCheck,
	Sparkles,
	Square,
	SquarePen,
	Sun,
	MoonStar,
	Target,
	Wrench,
	X,
} from "lucide-react";
import {
	lazy,
	Suspense,
	type ChangeEvent,
	type CSSProperties,
	type FormEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { validateCalendarSchedule, type CalendarSchedule } from "@wuming/protocol";
import { CalendarScheduleEditor, SchedulePreview, scheduleLabel } from "./components/AutomationScheduleEditor";
import { ScheduledTasks } from "./components/ScheduledTasks";
import type {
	ArtifactRef,
	AutomationRunSummary,
	AutomationSchedule,
	CommandResult,
	CustomModelApi,
	CustomModelKind,
	CustomModelConfig,
	CustomModelConnection,
	CustomModelService,
	CustomModelSettings as CustomModelSettingsValue,
	ContentPart,
	ExecutionEnvironment,
	GoalPlanSpec,
	GoalAutomationSummary,
	MemoryAction,
	MemoryRecord,
	ModelMetadata,
	ModelRef,
	RunSummary,
	SessionSnapshot,
	SessionSummary,
	TranscriptItem,
	WorkspaceDirectory,
	WorkspaceEntry,
	WorkspaceFileView,
	WorkspaceSummary,
	Skill,
	SkillSummary,
	ThinkingLevel,
	Usage,
	UsageToolSummary,
	UsageOverview,
	ToolStatus,
} from "@wuming/protocol";
import { type LiveAssistant, type LiveRetry, type LiveTool, useWumingClient } from "./use-wuming-client.js";
import { workspaceApi } from "./workspace-api.js";
import { desktopConnection } from "./lib/desktop.js";
import { RunDiagnostics } from "./components/RunDiagnostics";
import { SessionSearch, type SearchSessions } from "./components/SessionSearch";
import { TaskNotificationSettings } from "./components/TaskNotificationSettings";
import { Markdown } from "./components/Markdown.js";
import { ChangesView as WorkspaceChangesView } from "./components/ChangesView.js";
import {
	ToolCard,
	ToolResult,
	ArtifactMediaPreview,
	isPreviewableImageArtifact,
	isPreviewableMediaArtifact,
	type ToolStatusValue,
} from "./components/ToolCard.js";
import {
	commandItems,
	type ComposerCommand,
	fileItems,
	skillItems,
	SuggestMenu,
	type SuggestItem,
} from "./components/ComposerSuggest.js";
import { CommandPalette, modifierLabel, type PaletteEntry } from "./components/CommandPalette.js";
import { MessageActions } from "./components/MessageActions.js";
import { ShortcutsDialog } from "./components/ShortcutsDialog.js";
import { ContextMeter, ContextPill } from "./components/ContextMeter.js";
import { EvaluationDialog } from "./components/EvaluationDialog.js";
import { PermissionPicker, type PermissionValue } from "./components/PermissionPicker.js";
import { ThinkingPicker, thinkingLabel, modelThinkingDescription } from "./components/ThinkingPicker.js";
import { readStoredPermission, writeStoredPermission } from "./lib/permission-preference.js";
import {
	readStoredThinking,
	supportedThinkingLevels,
	thinkingLevelForModel,
	THINKING_LEVELS,
	writeStoredThinking,
} from "./lib/thinking-preference.js";
import { estimateContext, formatTokens, type ContextUsage } from "./lib/context-usage.js";
import { anchorBefore, formatItemTime, formatItemTimestamp, hasVisibleContent, messageText } from "./lib/transcript.js";
import { groupConsecutiveTools } from "./lib/tool-groups.js";
import { ToolGroup } from "./components/ToolGroup.js";
import { isNearBottom } from "./lib/scroll.js";
import { themeLabel } from "./lib/theme.js";
import { ThemeSettings } from "./components/ThemeSettings.js";
import { createTranslator, localeLabel, useLocale, useT, type LocaleKey, type Translate } from "./lib/locale.js";
import { isImplicitWorkspace, resolveNewChatWorkspace } from "./lib/workspaces.js";
import { useTheme } from "./use-theme.js";
import { applyCompletion, cycleIndex, detectTrigger, quoteMention, type Trigger } from "./lib/suggest.js";
const TerminalWorkbench = lazy(() =>
	import("./terminal-view.js").then((module) => ({ default: module.TerminalWorkbench }))
);

function formatMoney(value: number): string {
	if (value === 0) return "$0.00";
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

const STATUS_LABELS: Record<string, LocaleKey> = {
	idle: "statusIdle",
	turn: "statusTurn",
	running: "statusRunning",
	queued: "statusQueued",
	awaiting_approval: "statusApproval",
	compaction: "statusCompaction",
	retry: "statusRetry",
	cancelling: "statusCancelling",
	paused: "statusPaused",
	cancelled: "statusCancelled",
	aborted: "statusAborted",
	streaming: "statusStreaming",
	complete: "statusComplete",
	completed: "statusComplete",
	failed: "statusFailed",
	connected: "connected",
	connecting: "connecting",
	reconnecting: "statusReconnecting",
	disconnected: "statusDisconnected",
	dispatching: "statusDispatching",
	ready: "statusReady",
	closed: "statusClosed",
	error: "statusError",
	pending: "statusPending",
	approved: "statusApproved",
	denied: "statusDenied",
};

const ONBOARDING_STORAGE_KEY = "wuming.onboarding.complete";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "wuming.sidebar.collapsed";
type SettingsSection = "general" | "official" | "models" | "usage" | "connection" | "updates" | "computer" | "agents";
type UsageRange = 7 | 14 | 30;
const SIDEBAR_WIDTH_STORAGE_KEY = "wuming.sidebar.width";
const DEFAULT_SIDEBAR_WIDTH = 252;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_SESSION_TITLE = "新对话";

function clampSidebarWidth(width: number): number {
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function storedSidebarWidth(): number {
	const width = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
	return Number.isFinite(width) && width > 0 ? clampSidebarWidth(width) : DEFAULT_SIDEBAR_WIDTH;
}

function statusLabel(value: string, t: Translate = createTranslator("zh")): string {
	const key = STATUS_LABELS[value];
	return key ? t(key) : value.replaceAll("_", " ");
}

function GatewayPasswordForm({
	draft,
	status,
	submitted,
	firstUse = false,
	onChange,
	onSubmit,
}: {
	draft: string;
	status: "connecting" | "connected" | "disconnected" | "error";
	submitted: boolean;
	firstUse?: boolean;
	onChange: (value: string) => void;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
	const t = useT();
	const failed = submitted && status !== "connecting" && status !== "connected";
	return (
		<form className={firstUse ? "gateway-login" : "gateway-reconnect"} onSubmit={onSubmit}>
			{firstUse && (
				<div className="gateway-login-copy">
					<span className="settings-section-title">{t("connectService")}</span>
					<p className="settings-hint">{t("firstConnectionHint")}</p>
				</div>
			)}
			<label>
				{t("accessPassword")}
				<input
					aria-label={t("accessPassword")}
					autoComplete="current-password"
					autoFocus={firstUse}
					type="password"
					value={draft}
					onChange={(event) => onChange(event.target.value)}
				/>
			</label>
			{failed && (
				<div className="settings-error" role="alert">
					{t("connectionFailed")}
				</div>
			)}
			{submitted && status === "connected" && !firstUse && (
				<div className="settings-success" role="status">
					{t("connectionSuccess")}
				</div>
			)}
			<div className="dialog-actions">
				<button
					className={firstUse ? "primary-button" : "secondary-button"}
					disabled={!draft.trim() || status === "connecting"}
					type="submit"
				>
					<Plug size={14} />
					{status === "connecting" ? t("connecting") : firstUse ? t("connect") : t("reconnect")}
				</button>
			</div>
		</form>
	);
}

function sandboxLabel(value: string | undefined, t: Translate = createTranslator("zh")): string {
	if (!value) return "-";
	return (
		(
			{ read_only: t("readOnly"), workspace_write: t("workspaceWrite"), unrestricted: t("unrestricted") } as Record<
				string,
				string
			>
		)[value] ?? value.replaceAll("_", " ")
	);
}

function approvalPolicyLabel(value: string | undefined, t: Translate = createTranslator("zh")): string {
	if (!value) return "-";
	return (
		({ on_risk: t("approvalRisk"), always: t("approvalAlways"), never: t("approvalNever") } as Record<string, string>)[
			value
		] ?? value.replaceAll("_", " ")
	);
}

function workspaceName(name: string): string {
	return name === "Local workspace" ? "本地工作区" : name;
}

function ProjectImportDialog({
	local,
	onOpenLocal,
	onImport,
	onClose,
}: {
	local: boolean;
	onOpenLocal: () => Promise<unknown>;
	onImport: (
		name: string,
		files: Array<{ file: File; path: string }>,
		onProgress: (uploaded: number, total: number) => void
	) => Promise<unknown>;
	onClose: () => void;
}) {
	const folderInput = useRef<HTMLInputElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<{ uploaded: number; total: number }>();
	const [error, setError] = useState<string>();

	const importSelection = async (name: string, files: Array<{ file: File; path: string }>) => {
		setBusy(true);
		setError(undefined);
		setProgress({ uploaded: 0, total: files.length });
		try {
			await onImport(name, files, (uploaded, total) => setProgress({ uploaded, total }));
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	};

	const pickFolder = (event: ChangeEvent<HTMLInputElement>) => {
		const selected = [...(event.target.files ?? [])];
		if (selected.length === 0) return;
		const root = selected[0]?.webkitRelativePath.split("/")[0] || "新项目";
		const prefix = `${root}/`;
		void importSelection(
			root,
			selected.map((file) => ({
				file,
				path: file.webkitRelativePath.startsWith(prefix) ? file.webkitRelativePath.slice(prefix.length) : file.name,
			}))
		);
	};

	const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file) return;
		const dot = file.name.lastIndexOf(".");
		const name = dot > 0 ? file.name.slice(0, dot) : file.name;
		void importSelection(name, [{ file, path: file.name }]);
	};
	const openLocal = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await onOpenLocal();
			onClose();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			if (message !== "Project selection was cancelled") setError(message);
			setBusy(false);
		}
	};

	return (
		<div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
			<div
				className="project-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="project-dialog-title"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div className="dialog-header">
					<div>
						<h2 id="project-dialog-title">打开项目</h2>
						<span>{local ? "使用这台电脑上的文件和文件夹" : "导入到 Pi-Wm 工作区"}</span>
					</div>
					<button className="icon-button" type="button" title="关闭" disabled={busy} onClick={onClose}>
						<X size={18} />
					</button>
				</div>
				{local ? (
					<button className="project-import-trigger" type="button" disabled={busy} onClick={() => void openLocal()}>
						<FolderOpen size={20} />
						<span>
							<strong>文件或文件夹</strong>
							<small>选择这台电脑上的项目内容</small>
						</span>
					</button>
				) : (
					<div className="project-import-kinds" role="group" aria-label="选择项目内容类型">
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								if (fileInput.current) {
									fileInput.current.value = "";
									fileInput.current.click();
								}
							}}
						>
							<FileCode2 size={17} />
							<span>
								<strong>文件</strong>
								<small>上传为独立项目</small>
							</span>
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								if (folderInput.current) {
									folderInput.current.value = "";
									folderInput.current.click();
								}
							}}
						>
							<FolderOpen size={17} />
							<span>
								<strong>文件夹</strong>
								<small>上传并保留目录结构</small>
							</span>
						</button>
					</div>
				)}
				{!local && (
					<>
						<input
							ref={folderInput}
							className="visually-hidden"
							type="file"
							multiple
							{...{ webkitdirectory: "" }}
							onChange={pickFolder}
						/>
						<input ref={fileInput} className="visually-hidden" type="file" onChange={pickFile} />
					</>
				)}
				{local && busy && (
					<div className="project-picker-wait" role="status">
						<Hourglass size={14} />
						等待系统选择
					</div>
				)}
				{!local && progress && (
					<div className="project-import-progress" role="status">
						<span>{busy ? "正在导入" : "导入已停止"}</span>
						<strong>
							{progress.uploaded} / {progress.total}
						</strong>
						<i>
							<b
								style={{
									width: `${progress.total ? (progress.uploaded / progress.total) * 100 : 0}%`,
								}}
							/>
						</i>
					</div>
				)}
				{error && (
					<div className="settings-error" role="alert">
						{error}
					</div>
				)}
			</div>
		</div>
	);
}

function CustomModelSettings({
	models,
	onListMedia,
	revision,
	onDiscover,
	onListServices,
	onRefreshService,
	onRemoveService,
	onGet,
	onConfigure,
	onTest,
	onRemove,
}: {
	onListMedia: () => Promise<CustomModelSettingsValue[]>;
	revision: number;
	models: ModelMetadata[];
	onDiscover: (
		connection: CustomModelConnection
	) => Promise<Extract<CommandResult, { type: "model.custom.discovered" }>>;
	onListServices: () => Promise<CustomModelService[]>;
	onRefreshService: (provider: string) => Promise<Extract<CommandResult, { type: "model.custom.discovered" }>>;
	onRemoveService: (provider: string) => Promise<void>;
	onGet: (model: { provider: string; id: string }) => Promise<CustomModelSettingsValue>;
	onConfigure: (
		configs: CustomModelConfig[]
	) => Promise<Array<Extract<CommandResult, { type: "model.custom.configured" }>["model"]>>;
	onTest: (model: { provider: string; id: string }) => Promise<number>;
	onRemove: (model: { provider: string; id: string }) => Promise<void>;
}) {
	const t = useT();
	const [services, setServices] = useState<CustomModelService[]>([]);
	const [mediaModels, setMediaModels] = useState<CustomModelSettingsValue[]>([]);
	const [kindOverrides, setKindOverrides] = useState<Record<string, CustomModelKind>>({});
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [discovery, setDiscovery] = useState<Extract<CommandResult, { type: "model.custom.discovered" }>>();
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [modelQuery, setModelQuery] = useState("");
	const [name, setName] = useState("");
	const [api, setApi] = useState<CustomModelApi>("openai-completions");
	const [contextWindow, setContextWindow] = useState("258000");
	const [maxOutputTokens, setMaxOutputTokens] = useState("16384");
	const [busy, setBusy] = useState(false);
	const [loadingService, setLoadingService] = useState<string>();
	const [testingModel, setTestingModel] = useState<string>();
	const [editing, setEditing] = useState<CustomModelSettingsValue>();
	const [editBusy, setEditBusy] = useState(false);
	const [message, setMessage] = useState<string>();
	const [error, setError] = useState<string>();
	const savedModels = models.filter((model) => model.custom);
	const [addOpen, setAddOpen] = useState(() => savedModels.length === 0);
	const reloadServices = async () => {
		const loaded = await onListServices();
		setServices(loaded);
		return loaded;
	};
	useEffect(() => {
		let active = true;
		void Promise.all([onListServices(), onListMedia()])
			.then(([loaded, media]) => {
				if (active) {
					setServices(loaded);
					setMediaModels(media);
				}
			})
			.catch((cause) => {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			active = false;
		};
	}, [onListServices, onListMedia, revision]);
	const resetDiscovery = () => {
		setKindOverrides({});
		setDiscovery(undefined);
		setSelectedIds([]);
		setModelQuery("");
		setMessage(undefined);
		setError(undefined);
	};
	const discover = async () => {
		setBusy(true);
		setError(undefined);
		setMessage(undefined);
		try {
			if (!baseUrl.trim() || !apiKey) throw new Error(t("fillBaseUrlAndKey"));
			const result = await onDiscover({ baseUrl: baseUrl.trim(), apiKey });
			setDiscovery(result);
			setKindOverrides({});
			setBaseUrl(result.baseUrl);
			setApiKey("");
			setApi(result.api);
			setSelectedIds([]);
			setModelQuery("");
			setAddOpen(false);
			await reloadServices();
			setMessage(t("serviceSaved", { count: result.models.length }));
		} catch (cause) {
			setDiscovery(undefined);
			setSelectedIds([]);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};
	const refreshService = async (service: CustomModelService) => {
		setLoadingService(service.provider);
		setError(undefined);
		setMessage(undefined);
		try {
			const result = await onRefreshService(service.provider);
			setDiscovery(result);
			setKindOverrides({});
			setApi(result.api);
			setSelectedIds([]);
			setModelQuery("");
			setName("");
			setAddOpen(false);
			setMessage(t("serviceRefreshed", { count: result.models.length }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoadingService(undefined);
		}
	};
	const removeService = async (service: CustomModelService) => {
		setLoadingService(service.provider);
		setError(undefined);
		setMessage(undefined);
		try {
			await onRemoveService(service.provider);
			if (discovery?.provider === service.provider) setDiscovery(undefined);
			await reloadServices();
			setMessage(t("serviceDeleted"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoadingService(undefined);
		}
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		setMessage(undefined);
		try {
			if (!discovery || selectedIds.length === 0) throw new Error(t("getModelsFirst"));
			const configs: CustomModelConfig[] = selectedIds.map((id) => {
				const selected = discovery.models.find((model) => model.id === id);
				return {
					provider: discovery.provider,
					...(kindOverrides[id] ? { kind: kindOverrides[id] } : {}),
					id,
					name: selectedIds.length === 1 && name.trim() ? name.trim() : selected?.name || id,
					api,
					baseUrl: discovery.baseUrl,
					input: ["text", "image"],
					contextWindow: Number(contextWindow),
					maxOutputTokens: Number(maxOutputTokens),
				};
			});
			await onConfigure(configs);
			setDiscovery(undefined);
			setSelectedIds([]);
			setModelQuery("");
			setName("");
			await reloadServices();
			setMessage(t("modelsAdded", { count: configs.length }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};
	const testSavedModel = async (model: { provider: string; id: string }) => {
		const key = `${model.provider}/${model.id}`;
		setTestingModel(key);
		setError(undefined);
		setMessage(undefined);
		try {
			setMessage(t("modelTested", { id: model.id, duration: await onTest(model) }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setTestingModel(undefined);
		}
	};
	const startEditing = async (model: { provider: string; id: string }) => {
		setError(undefined);
		setMessage(undefined);
		setEditBusy(true);
		try {
			setEditing(await onGet(model));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setEditBusy(false);
		}
	};
	const saveEdit = async (event: FormEvent) => {
		event.preventDefault();
		if (!editing) return;
		setError(undefined);
		setMessage(undefined);
		setEditBusy(true);
		try {
			await onConfigure([
				{
					provider: editing.model.provider,
					...(editing.kind ? { kind: editing.kind } : {}),
					id: editing.model.id,
					name: editing.name,
					api: editing.api,
					baseUrl: editing.baseUrl,
					input: editing.input,
					thinkingOverride: editing.thinkingOverride ?? "auto",
					contextWindow: editing.contextWindow,
					maxOutputTokens: editing.maxOutputTokens,
				},
			]);
			setMessage(t("modelUpdated", { name: editing.name }));
			setEditing(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setEditBusy(false);
		}
	};
	const removeModel = async (model: { provider: string; id: string }) => {
		setError(undefined);
		setMessage(undefined);
		try {
			await onRemove(model);
			await reloadServices();
			setMessage(t("modelDeleted", { id: model.id }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const savedIds = new Set(
		[...savedModels, ...mediaModels]
			.filter((model) => model.model.provider === discovery?.provider)
			.map((model) => model.model.id)
	);
	const visibleModels =
		discovery?.models.filter((model) => {
			const query = modelQuery.trim().toLowerCase();
			return !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query);
		}) ?? [];
	const toggleModel = (id: string) => {
		if (!savedIds.has(id))
			setSelectedIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
	};
	return (
		<div className="custom-model-settings">
			<div className="settings-section-title">{t("customModels")}</div>
			<p className="settings-hint">{t("customModelsHint")}</p>
			{message && <div className="settings-success">{message}</div>}
			{error && <div className="settings-error">{error}</div>}
			{services.length > 0 && (
				<div className="saved-models-heading">
					<strong>{t("savedServices")}</strong>
					<span>{services.length}</span>
				</div>
			)}
			{services.map((service) => (
				<div className="custom-model-row custom-model-service-row" key={service.provider}>
					<span className="custom-model-copy">
						<strong>{new URL(service.baseUrl).host}</strong>
						<small>{service.baseUrl}</small>
						<small className="credential-status">
							<ShieldCheck size={12} />
							{t("credentialSaved", { count: service.modelCount })}
						</small>
					</span>
					<div className="custom-model-row-actions">
						<button
							type="button"
							className="icon-button"
							title={t("refreshModels")}
							disabled={loadingService === service.provider}
							onClick={() => void refreshService(service)}
						>
							<RefreshCw className={loadingService === service.provider ? "spin" : ""} size={14} />
						</button>
						<button
							type="button"
							className="icon-button"
							title={service.modelCount > 0 ? t("deleteServiceBlocked") : t("deleteService")}
							disabled={service.modelCount > 0 || loadingService === service.provider}
							onClick={() => void removeService(service)}
						>
							<Trash2 size={14} />
						</button>
					</div>
				</div>
			))}
			{savedModels.length > 0 && (
				<div className="saved-models-heading">
					<strong>{t("addedModels")}</strong>
					<span>{savedModels.length}</span>
				</div>
			)}
			{savedModels.map((model) => {
				const key = `${model.model.provider}/${model.model.id}`;
				return (
					<div className="custom-model-row" key={key}>
						<span className="custom-model-copy">
							<strong>{model.name}</strong>
							<small>{model.model.id}</small>
							<small>{modelThinkingDescription(model)}</small>
						</span>
						<div className="custom-model-row-actions">
							<button
								type="button"
								className="icon-button"
								title={t("editModel")}
								disabled={editBusy}
								onClick={() => void startEditing(model.model)}
							>
								<Pencil size={14} />
							</button>
							<button
								type="button"
								className="icon-button"
								title={t("testModel")}
								disabled={testingModel === key}
								onClick={() => void testSavedModel(model.model)}
							>
								<Activity size={14} />
							</button>
							<button
								type="button"
								className="icon-button"
								title={t("deleteModel")}
								onClick={() => void removeModel(model.model)}
							>
								<Trash2 size={14} />
							</button>
						</div>
					</div>
				);
			})}
			{editing && (
				<form className="custom-model-edit" onSubmit={(event) => void saveEdit(event)}>
					<div className="custom-model-edit-heading">
						<span>
							<strong>{t("editModel")}</strong>
							<small>{editing.model.id}</small>
						</span>
						<button type="button" className="icon-button" title={t("cancelEdit")} onClick={() => setEditing(undefined)}>
							<X size={14} />
						</button>
					</div>
					<div className="model-service-reference">
						<span>{t("modelService")}</span>
						<strong>{new URL(editing.baseUrl).host}</strong>
						<small>{editing.baseUrl}</small>
					</div>
					<label>
						模型类型
						<select
							aria-label="模型类型"
							value={editing.kind ?? "chat"}
							onChange={(event) => setEditing({ ...editing, kind: event.target.value as CustomModelKind })}
						>
							<option value="chat">对话模型</option>
							<option value="image">生图模型</option>
							<option value="video">视频模型</option>
						</select>
					</label>
					<label>
						{t("name")}
						<input
							value={editing.name}
							onChange={(event) =>
								setEditing((current) => (current ? { ...current, name: event.target.value } : current))
							}
							required
						/>
					</label>
					<div className="custom-model-inline">
						<label>
							{t("contextLength")}
							<input
								type="number"
								min="1"
								value={editing.contextWindow}
								onChange={(event) =>
									setEditing((current) =>
										current ? { ...current, contextWindow: Number(event.target.value) } : current
									)
								}
								required
							/>
						</label>
						<label>
							{t("maxOutput")}
							<input
								type="number"
								min="1"
								value={editing.maxOutputTokens}
								onChange={(event) =>
									setEditing((current) =>
										current ? { ...current, maxOutputTokens: Number(event.target.value) } : current
									)
								}
								required
							/>
						</label>
					</div>
					<label>
						{t("modelThinking")}
						<select
							aria-label={t("modelThinking")}
							value={typeof editing.thinkingOverride === "object" ? "manual" : (editing.thinkingOverride ?? "auto")}
							onChange={(event) => {
								const mode = event.target.value;
								setEditing({
									...editing,
									thinkingOverride:
										mode === "manual"
											? {
													levels:
														editing.reasoning && editing.thinkingLevels?.length
															? [...editing.thinkingLevels]
															: ["low", "medium", "high"],
												}
											: mode === "disabled"
												? "disabled"
												: "auto",
								});
							}}
						>
							<option value="auto">{t("thinkingAuto")}</option>
							<option value="manual">{t("thinkingManual")}</option>
							<option value="disabled">{t("thinkingDisabled")}</option>
						</select>
					</label>
					{typeof editing.thinkingOverride === "object" && (
						<fieldset className="model-thinking-levels">
							<legend>{t("thinkingLevels")}</legend>
							{THINKING_LEVELS.map((level) => (
								<label key={level}>
									<input
										type="checkbox"
										checked={
											typeof editing.thinkingOverride === "object" && editing.thinkingOverride.levels.includes(level)
										}
										onChange={(event) => {
											const checked = event.target.checked;
											setEditing((current) => {
												if (!current || typeof current.thinkingOverride !== "object") return current;
												const selected = new Set(current.thinkingOverride.levels);
												if (checked) selected.add(level);
												else selected.delete(level);
												return {
													...current,
													thinkingOverride: { levels: THINKING_LEVELS.filter((value) => selected.has(value)) },
												};
											});
										}}
									/>
									{thinkingLabel(level)}
								</label>
							))}
						</fieldset>
					)}
					<button
						className="primary-button"
						disabled={
							editBusy || (typeof editing.thinkingOverride === "object" && editing.thinkingOverride.levels.length === 0)
						}
					>
						{editBusy ? t("saving") : t("saveChanges")}
					</button>
				</form>
			)}
			<details className="custom-model-add" open={addOpen} onToggle={(event) => setAddOpen(event.currentTarget.open)}>
				<summary>
					<Plus size={14} />
					{t("addModelService")}
				</summary>
				<div className="custom-model-form">
					<label>
						Base URL
						<input
							type="url"
							value={baseUrl}
							onChange={(event) => {
								setBaseUrl(event.target.value);
								resetDiscovery();
							}}
							placeholder="https://api.example.com/v1"
							required
						/>
					</label>
					<label>
						{t("apiKey")}
						<input
							type="password"
							value={apiKey}
							onChange={(event) => {
								setApiKey(event.target.value);
								resetDiscovery();
							}}
							placeholder={t("newApiKey")}
							required
						/>
					</label>
					<button
						type="button"
						className="secondary-button custom-model-test"
						disabled={busy || !baseUrl.trim() || !apiKey}
						onClick={() => void discover()}
					>
						<RefreshCw className={busy ? "spin" : ""} size={14} />
						{busy ? t("savingAndFetching") : t("saveServiceAndFetch")}
					</button>
				</div>
			</details>
			{discovery && (
				<form className="custom-model-form custom-model-catalog" onSubmit={(event) => void submit(event)}>
					<div className="custom-model-edit-heading">
						<span>
							<strong>{t("addServiceModels")}</strong>
							<small>{discovery.baseUrl}</small>
						</span>
						<button
							type="button"
							className="icon-button"
							title={t("closeModelList")}
							onClick={() => {
								setDiscovery(undefined);
								setSelectedIds([]);
							}}
						>
							<X size={14} />
						</button>
					</div>
					<div className="model-picker">
						<div className="model-picker-heading">
							<span>{t("customModelList")}</span>
							<small>{t("selectedModels", { count: selectedIds.length })}</small>
						</div>
						<input
							aria-label={t("filterModels")}
							value={modelQuery}
							onChange={(event) => setModelQuery(event.target.value)}
							placeholder={t("searchModels")}
						/>
						<div className="model-picker-actions">
							<button
								type="button"
								onClick={() =>
									setSelectedIds(discovery.models.filter((model) => !savedIds.has(model.id)).map((model) => model.id))
								}
							>
								<Check size={12} />
								{t("selectUnadded")}
							</button>
							<button type="button" onClick={() => setSelectedIds([])}>
								<X size={12} />
								{t("clear")}
							</button>
						</div>
						<div className="model-picker-list">
							{visibleModels.length > 0 ? (
								visibleModels.map((model) => (
									<div className={`model-option ${savedIds.has(model.id) ? "already-added" : ""}`} key={model.id}>
										<label className="model-option-label">
											<input
												type="checkbox"
												aria-label={model.name}
												disabled={savedIds.has(model.id)}
												checked={savedIds.has(model.id) || selectedIds.includes(model.id)}
												onChange={() => toggleModel(model.id)}
											/>
											<span>
												<strong>{model.name}</strong>
												{model.name !== model.id && <small>{model.id}</small>}
											</span>
										</label>
										<select
											className="model-kind-select"
											aria-label={`模型类型：${model.id}`}
											value={
												savedIds.has(model.id)
													? (mediaModels.find(
															(item) => item.model.provider === discovery.provider && item.model.id === model.id
														)?.kind ?? "chat")
													: (kindOverrides[model.id] ?? model.kind ?? "chat")
											}
											disabled={savedIds.has(model.id)}
											onChange={(event) =>
												setKindOverrides((current) => ({
													...current,
													[model.id]: event.target.value as CustomModelKind,
												}))
											}
										>
											<option value="chat">对话</option>
											<option value="image">生图</option>
											<option value="video">视频</option>
										</select>
										{savedIds.has(model.id) && <small className="model-added-label">{t("alreadyAdded")}</small>}
									</div>
								))
							) : (
								<div className="model-picker-empty">{t("noModelMatches")}</div>
							)}
						</div>
					</div>
					{selectedIds.length === 1 && (
						<label>
							<span>
								{t("name")} <span className="optional-label">{t("optional")}</span>
							</span>
							<input
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder={discovery.models.find((model) => model.id === selectedIds[0])?.name ?? selectedIds[0]}
							/>
						</label>
					)}
					<details className="custom-model-advanced">
						<summary>{t("advancedSettings")}</summary>
						<label>
							{t("apiProtocol")}
							<select value={api} onChange={(event) => setApi(event.target.value as CustomModelApi)}>
								<option value="openai-completions">OpenAI Chat Completions</option>
								<option value="openai-responses">OpenAI Responses</option>
								<option value="anthropic-messages">Anthropic Messages</option>
							</select>
						</label>
						<div className="custom-model-inline">
							<label>
								{t("contextLength")}
								<input
									type="number"
									min="1"
									value={contextWindow}
									onChange={(event) => setContextWindow(event.target.value)}
									required
								/>
							</label>
							<label>
								{t("maxOutput")}
								<input
									type="number"
									min="1"
									value={maxOutputTokens}
									onChange={(event) => setMaxOutputTokens(event.target.value)}
									required
								/>
							</label>
						</div>
					</details>
					<button className="primary-button" disabled={busy || selectedIds.length === 0}>
						<Plus size={14} />
						{busy
							? t("adding")
							: selectedIds.length > 0
								? t("addModels", { count: selectedIds.length })
								: t("addModel")}
					</button>
				</form>
			)}
		</div>
	);
}

function formatRunDuration(run: RunSummary, t: Translate = createTranslator("zh")): string {
	return formatDuration(
		run.startedAt,
		run.finishedAt ?? (run.status === "running" ? Date.now() : run.updatedAt),
		run.status === "queued" ? t("statusQueued") : t("elapsedUnavailable"),
		t
	);
}

function formatDuration(
	startedAt: number | undefined,
	end: number,
	unavailable?: string,
	t: Translate = createTranslator("zh")
): string {
	if (startedAt === undefined) return unavailable ?? t("elapsedUnavailable");
	const milliseconds = Math.max(0, end - startedAt);
	if (milliseconds < 1000) return `${milliseconds}ms`;
	const seconds = Math.round(milliseconds / 1000);
	return seconds < 60
		? t("seconds", { seconds })
		: t("minutesSeconds", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

function formatRunTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(timestamp);
}

function formatDelay(milliseconds: number): string {
	return milliseconds < 1000
		? `${milliseconds}ms`
		: `${(milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 0 : 1)}s`;
}

const FAILURE_KIND_LABELS: Record<string, LocaleKey> = {
	provider: "providerError",
	provider_auth: "providerAuth",
	provider_rate_limit: "providerRateLimit",
	provider_timeout: "providerTimeout",
	provider_network: "providerNetwork",
	tool: "toolError",
	user_abort: "userAbort",
	runtime_restart: "runtimeRestart",
	budget: "budgetExceeded",
	unknown: "runUnfinished",
};

const HOOK_POINT_LABELS: Record<string, LocaleKey> = {
	"operation.before_execute": "hookBefore",
	"operation.after_execute": "hookAfter",
	"operation.on_error": "hookError",
};

const HOOK_OUTCOME_LABELS: Record<string, LocaleKey> = {
	completed: "passed",
	denied: "blocked",
	denial_ignored: "suggestionIgnored",
	failed: "statusFailed",
	timed_out: "timedOut",
};

const CONTEXT_KIND_LABELS: Record<string, LocaleKey> = {
	system: "contextSystem",
	policy: "contextPolicy",
	skill: "contextSkill",
	workspace: "workspace",
	memory: "contextMemory",
};

const CONTEXT_CACHE_LABELS: Record<string, LocaleKey> = {
	stable: "cacheStable",
	session: "cacheSession",
	turn: "cacheTurn",
};

const TRAJECTORY_CRITERION_LABELS: Record<string, LocaleKey> = {
	integrity: "integrity",
	completion: "completion",
	reliability: "reliability",
	policy: "policyExecution",
	observability: "observability",
};

const MEMORY_REASON_LABELS: Record<MemoryRecord["memory"]["reason"], LocaleKey> = {
	manual: "memoryManual",
	threshold: "memoryThreshold",
	overflow: "memoryOverflow",
};

function failureKindLabel(value: string, t: Translate = createTranslator("zh")): string {
	const key = FAILURE_KIND_LABELS[value];
	return key ? t(key) : value;
}

function runDiagnostic(snapshot: SessionSnapshot | undefined, run: RunSummary): string {
	return [
		"Pi-Wm 运行诊断",
		`生成时间：${new Date().toLocaleString("zh-CN")}`,
		`会话 ID：${run.sessionId}`,
		`运行 ID：${run.id}`,
		`Trace ID：${run.traceId ?? "未记录"}`,
		`状态：${statusLabel(run.status)}`,
		`故障类型：${run.failureKind ? failureKindLabel(run.failureKind) : "无"}`,
		`模型：${run.model ? `${run.model.provider}/${run.model.id}` : snapshot ? `${snapshot.model.provider}/${snapshot.model.id}` : "未知"}`,
		`尝试次数：${run.attempt}`,
		`重试次数：${run.retryHistory?.length ?? 0}`,
		`能力计划：${run.capabilityPlan?.digest ?? "未记录"}`,
		`上下文计划：${run.contextPlan?.digest ?? "未记录"}`,
		`上下文缓存前缀：${run.contextPlan?.cachePrefixDigest ?? "未记录"}`,
		`系统上下文预算：${run.contextPlan ? `${run.contextPlan.estimatedSystemTokens}/${run.contextPlan.availableSystemTokens} tokens` : "未记录"}`,
		`上下文来源：${run.contextPlan?.fragments.map((fragment) => `${fragment.id}=${fragment.renderedTokens}${fragment.truncated ? "(已截断)" : ""}`).join("；") || "未记录"}`,
		`Hook：${run.hookEvents?.map((event) => `${event.hookId}@${event.hookVersion} ${event.point}=${event.outcome}${event.code ? `(${event.code})` : ""}`).join("；") || "无"}`,
		`执行轨迹：${run.trajectory ? `${run.trajectory.eventCount} 个事件，完整性=${run.trajectory.integrity ? "通过" : "失败"}，结构分=${run.trajectory.evaluation.score}/100，语义正确性=未评测，摘要=${run.trajectory.headDigest}` : "未记录"}`,
		`错误：${run.error ? redactDiagnostic(run.error) : "无"}`,
	].join("\n");
}

async function writeClipboardText(value: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(value);
			return;
		} catch {
			// Some embedded browsers expose the API but deny it without a permission prompt.
		}
	}
	const textarea = document.createElement("textarea");
	textarea.value = value;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.append(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	textarea.remove();
	if (!copied) throw new Error("Clipboard is unavailable");
}

function RunDiagnosticButton({ run, onOpen }: { run: RunSummary; onOpen: (run: RunSummary) => void }) {
	const t = useT();
	return (
		<button
			className="run-diagnostic-button"
			type="button"
			title={t("openRunDiagnostics")}
			aria-label={t("openRunDiagnostics")}
			onClick={() => onOpen(run)}
		>
			<Activity size={12} />
		</button>
	);
}

function formatToolName(tool: UsageToolSummary): string {
	return tool.mcpServerId && tool.mcpToolName ? `${tool.mcpServerId}/${tool.mcpToolName}` : tool.toolName;
}

function formatToolOutcome(tool: UsageToolSummary, t: Translate = createTranslator("zh")): string | undefined {
	const parts = [
		tool.succeededCount ? t("toolSuccessCount", { count: tool.succeededCount }) : undefined,
		tool.failedCount ? t("toolFailureCount", { count: tool.failedCount }) : undefined,
		tool.abortedCount ? t("toolAbortCount", { count: tool.abortedCount }) : undefined,
	].filter((value): value is string => value !== undefined);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function formatToolObservation(tool: UsageToolSummary, t: Translate = createTranslator("zh")): string {
	return [
		`${formatToolName(tool)} x${tool.callCount}`,
		tool.durationMs === undefined ? undefined : formatDelay(tool.durationMs),
		formatToolOutcome(tool, t),
	]
		.filter((value): value is string => value !== undefined)
		.join(" · ");
}

function Content({
	parts,
	onDownload,
	onLoadArtifact,
	renderedToolCalls,
	imagesFirst = false,
	showImageDownload = true,
	interrupted = false,
}: {
	parts: ContentPart[];
	onDownload?: ((artifact: ArtifactRef) => Promise<void>) | undefined;
	onLoadArtifact?: ((artifact: ArtifactRef) => Promise<Blob>) | undefined;
	renderedToolCalls?: Set<string> | undefined;
	imagesFirst?: boolean;
	showImageDownload?: boolean;
	interrupted?: boolean;
}) {
	if (imagesFirst) {
		const images = parts.filter((part) => part.type === "artifact" && isPreviewableImageArtifact(part.artifact));
		const remaining = parts.filter((part) => !images.includes(part));
		return (
			<div className="message-content user-message-content">
				{images.length > 0 && (
					<div className="user-message-images">
						{images.map((part, index) => (
							<Content
								key={index}
								parts={[part]}
								onDownload={onDownload}
								onLoadArtifact={onLoadArtifact}
								showImageDownload={false}
							/>
						))}
					</div>
				)}
				{hasVisibleContent(remaining, renderedToolCalls) && (
					<div className="user-message-bubble">
						<Content
							parts={remaining}
							onDownload={onDownload}
							onLoadArtifact={onLoadArtifact}
							renderedToolCalls={renderedToolCalls}
						/>
					</div>
				)}
			</div>
		);
	}
	return (
		<div className="message-content">
			{parts.map((part, index) => {
				if (part.type === "text") return part.text.trim() === "" ? null : <Markdown text={part.text} key={index} />;
				// Thinking deltas are internal model output. Keep them out of the
				// transcript and represent active work with a compact status row.
				if (part.type === "thinking") return null;
				if (part.type === "tool_call") {
					// The tool gets its own transcript item once it starts; render the
					// call inline only while that item does not exist yet.
					if (renderedToolCalls?.has(part.toolCallId)) return null;
					return (
						<ToolCard
							toolName={part.toolName}
							input={part.input}
							status={interrupted ? "aborted" : "pending"}
							key={index}
						/>
					);
				}
				return (
					<div
						key={index}
						className={
							part.artifact.mimeType.startsWith("image/") && isPreviewableMediaArtifact(part.artifact)
								? "message-media-attachment"
								: undefined
						}
					>
						{onLoadArtifact && isPreviewableMediaArtifact(part.artifact) && (
							<ArtifactMediaPreview
								artifact={part.artifact}
								onLoad={onLoadArtifact}
								onDownload={onDownload}
								showDownload={showImageDownload}
							/>
						)}
						{!(onLoadArtifact && isPreviewableImageArtifact(part.artifact)) && (
							<div className="artifact-line">
								<FileCode2 size={15} /> <span>{part.artifact.name}</span>
								{onDownload && (
									<button
										type="button"
										title={`下载 ${part.artifact.name}`}
										onClick={() => void onDownload(part.artifact)}
									>
										<Download size={14} />
									</button>
								)}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

/**
 * What a message can do besides being read. Owned by `App` because forking and
 * re-sending both switch the attached session, which is not a decision a single
 * transcript row gets to make.
 */
interface MessageActionState {
	busy: boolean;
	/** Set while forking or re-sending is impossible: mid-turn, archived, offline. */
	branchDisabled: boolean;
	branchTitle: string;
	error?: string | undefined;
	onFork: () => void;
	onEditStart: () => void;
}

interface FailureActionState {
	run?: RunSummary | undefined;
	resumeDesktop?: boolean;
	busy: boolean;
	disabled: boolean;
	disabledTitle: string;
	onRetry: () => void;
	onOpenSettings: () => void;
	onOpenUsage: () => void;
}

function imageInputUnsupported(error: string): boolean {
	return /当前模型不支持图片理解|model[^\n]{0,80}(?:does not support|doesn't support)[^\n]{0,40}(?:image|vision)|image input[^\n]{0,40}(?:not supported|unsupported)/i.test(
		error
	);
}

function failureTitle(error: string, kind: RunSummary["failureKind"]): string {
	if (/Mutation contains an invalid (event|snapshot)/i.test(error)) return "任务状态保存失败";
	if (connectionFailure(error)) return "连接暂时中断";
	if (imageInputUnsupported(error)) return "当前模型不支持图片理解";
	if (/browser_open|url parameter|Stream ended without finish_reason/i.test(error)) {
		return "浏览器步骤未完成";
	}
	if (/stream ended|premature close|terminated/i.test(error)) {
		return "模型响应中断";
	}
	if (kind === "provider") return "模型服务暂时不可用";
	if (kind === "provider_rate_limit") return "模型服务繁忙";
	if (kind) return failureKindLabel(kind);
	return "任务暂未完成";
}

function failureAdvice(error: string, kind: RunSummary["failureKind"]): string {
	if (/Mutation contains an invalid (event|snapshot)/i.test(error))
		return "项目内部保存任务状态时出错，并非桌面权限不足。已返回的工具结果仍在对话中；恢复前应先检查当前状态，避免重复操作。";
	if (connectionFailure(error))
		return "连接模型服务时中断，暂时不能确定是网络、代理还是接口服务的问题。已返回的工具结果已保留；继续桌面任务时会要求先检查当前状态。";
	if (imageInputUnsupported(error)) {
		return "图片已上传并保留。请切换到支持视觉的模型后重新执行，无需重新上传图片。";
	}
	if (/browser_open|url parameter/i.test(error)) {
		return "打开网页时没有提供网址。已停止重复执行，重新执行会从当前请求重新开始。";
	}
	if (/stream ended|premature close|terminated/i.test(error)) {
		return "模型响应没有正常结束。可以重新执行；如果连续发生，请更换模型或检查模型服务。";
	}
	switch (kind) {
		case "provider_auth":
			return "模型凭据无效或已过期，请检查设置后再试。";
		case "provider_rate_limit":
			return "模型服务请求过多。自动重试已用尽，请稍后重新执行。";
		case "provider_timeout":
			return "模型在限定时间内没有响应，可以重新执行。";
		case "provider_network":
			return "连接模型服务失败，请检查网络后重新执行。";
		case "tool":
			return "工具没有成功完成。请展开详情检查命令输出，再决定是否重新执行。";
		case "runtime_restart":
			return "运行期间服务发生重启，服务恢复后可以重新执行。";
		case "budget":
			return "可用额度不足，请检查模型服务余额或会话用量限额后继续。";
		case "user_abort":
			return "本次任务已由你停止。";
		default:
			return "任务没有完成。可查看技术详情后重新执行。";
	}
}

function hasToolFailureInTurn(transcript: TranscriptItem[], itemId: string): boolean {
	const index = transcript.findIndex((item) => item.id === itemId);
	if (index < 0) return false;
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const item = transcript[cursor];
		if (!item) continue;
		if (item.type === "user") return false;
		if (item.type === "tool" && item.isError) return true;
	}
	return false;
}

function FailureNotice({ error, actions }: { error: string; actions: FailureActionState }) {
	const kind = actions.run?.failureKind;
	const retries = retrySummary(actions.run);
	const previousError = actions.run?.retryHistory?.at(-1)?.error;
	const title = failureTitle(error, kind);
	const severe = /Mutation contains an invalid (event|snapshot)/i.test(error) || kind === "tool";
	const action =
		kind === "provider_auth" ? "settings" : kind === "budget" ? "usage" : kind === "user_abort" ? undefined : "retry";
	return (
		<section
			className={`failure-notice${severe ? " failure-notice-critical" : ""}`}
			role={severe ? "alert" : "status"}
			aria-live={severe ? "assertive" : "polite"}
		>
			<div className="failure-notice-heading">
				{severe ? <CircleAlert size={16} /> : <Pause size={16} />}
				<strong>{title}</strong>
			</div>
			<p>{failureAdvice(error, kind)}</p>
			{retries && <div className="failure-retry-summary">{retries}</div>}
			<details className="failure-details">
				<summary>技术详情</summary>
				<pre>
					{redactDiagnostic(
						previousError && previousError !== error ? `${error}\n触发重试的错误：${previousError}` : error
					)}
				</pre>
			</details>
			{action && (
				<div className="failure-actions">
					{action === "retry" && (
						<button
							type="button"
							disabled={actions.busy || actions.disabled}
							title={
								actions.disabled
									? actions.disabledTitle
									: actions.resumeDesktop
										? "检查当前状态后继续桌面任务"
										: "重新执行上一条请求"
							}
							onClick={actions.onRetry}
						>
							<RefreshCw size={14} />
							{actions.resumeDesktop
								? actions.busy
									? "正在继续..."
									: "继续任务"
								: actions.busy
									? "正在重新执行..."
									: "重新执行"}
						</button>
					)}
					{action === "settings" && (
						<button type="button" onClick={actions.onOpenSettings}>
							<Settings size={14} />
							打开设置
						</button>
					)}
					{action === "usage" && (
						<button type="button" onClick={actions.onOpenUsage}>
							<PanelRight size={14} />
							查看用量
						</button>
					)}
				</div>
			)}
		</section>
	);
}

function TranscriptItemView({
	item,
	onDownload,
	onLoadArtifact,
	renderedToolCalls,
	actions,
	failureActions,
	now,
	transcript,
	onOpenSubagent,
	turnActive = false,
}: {
	item: TranscriptItem;
	onDownload: (artifact: ArtifactRef) => Promise<void>;
	onLoadArtifact: (artifact: ArtifactRef) => Promise<Blob>;
	renderedToolCalls?: Set<string> | undefined;
	actions?: MessageActionState | undefined;
	failureActions?: FailureActionState | undefined;
	now: number;
	transcript: TranscriptItem[];
	onOpenSubagent?: (() => void) | undefined;
	turnActive?: boolean;
}) {
	const t = useT();
	if (item.type === "tool") {
		const media = item.content.filter((part) => part.type === "artifact" && isPreviewableMediaArtifact(part.artifact));
		return (
			<div className={`tool-row ${item.isError ? "tool-error" : ""}`}>
				<ToolCard
					toolName={item.toolName}
					input={item.input}
					status={item.status as ToolStatusValue}
					onOpenSession={onOpenSubagent}
					webEvidence={item.webEvidence}
					receiptText={item.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n")}
				>
					<ToolResult
						parts={item.content.filter((part) => !media.includes(part))}
						toolName={item.toolName}
						input={item.input}
						isError={item.isError}
						onDownload={(artifact) => void onDownload(artifact)}
						onLoadArtifact={onLoadArtifact}
					/>
				</ToolCard>
				{media.length > 0 && (
					<ToolResult
						parts={media}
						toolName={item.toolName}
						onDownload={(artifact) => void onDownload(artifact)}
						onLoadArtifact={onLoadArtifact}
					/>
				)}
			</div>
		);
	}
	if (item.type === "assistant" && !item.error && !hasVisibleContent(item.content, renderedToolCalls)) {
		return null;
	}
	const suppressFailure =
		item.type === "assistant" &&
		!!item.error &&
		(supersededFailure(transcript, item.id) || activeTurnFailure(transcript, item.id, turnActive));
	// Incomplete calls never executed; their real results, if any, have separate tool rows.
	const visibleParts = suppressFailure ? item.content.filter((part) => part.type !== "tool_call") : item.content;
	if (suppressFailure && !hasVisibleContent(visibleParts, renderedToolCalls)) return null;
	const toolFailureInTurn = item.type === "assistant" && item.error ? hasToolFailureInTurn(transcript, item.id) : false;
	if (toolFailureInTurn && !hasVisibleContent(item.content, renderedToolCalls)) return null;

	const text = messageText(item.content);
	return (
		<div className={`message-row ${item.type}`} data-message-id={item.id} tabIndex={-1}>
			{item.type !== "user" && (
				<div className="message-avatar" aria-hidden="true">
					<Sparkles size={16} />
				</div>
			)}
			<div className="message-body">
				<div className="message-meta">
					<strong>{item.type === "user" ? t("you") : "Pi-Wm"}</strong>
					{item.type === "assistant" && item.status !== "complete" && !suppressFailure && (
						<span>{item.error ? "已暂停" : statusLabel(item.status, t)}</span>
					)}
					<time
						className="message-time"
						dateTime={new Date(item.createdAt).toISOString()}
						title={formatItemTimestamp(item.createdAt)}
					>
						{formatItemTime(item.createdAt, now)}
					</time>
					{actions && (
						<MessageActions
							text={text}
							busy={actions.busy}
							branchDisabled={actions.branchDisabled}
							branchTitle={actions.branchTitle}
							onFork={actions.onFork}
							{...(item.type === "user" ? { onEdit: actions.onEditStart } : {})}
						/>
					)}
				</div>
				<Content
					parts={visibleParts}
					onDownload={onDownload}
					onLoadArtifact={onLoadArtifact}
					renderedToolCalls={renderedToolCalls}
					imagesFirst={item.type === "user"}
					interrupted={item.type === "assistant" && (item.status === "error" || item.status === "aborted")}
				/>
				{item.type === "assistant" &&
					item.error &&
					!suppressFailure &&
					!toolFailureInTurn &&
					(failureActions ? (
						<FailureNotice error={item.error} actions={failureActions} />
					) : (
						<div className="message-error">
							<CircleAlert size={15} />
							{item.error}
						</div>
					))}
				{actions?.error && (
					<div className="message-error">
						<CircleAlert size={15} />
						{actions.error}
					</div>
				)}
			</div>
		</div>
	);
}

function LiveAssistantView({ item, compacting = false }: { item: LiveAssistant; compacting?: boolean }) {
	if (item.thinking.trim() === "" && item.text.trim() === "") return null;
	if (item.thinking.trim() !== "" && item.text.trim() === "") {
		if (compacting) return null;
		return (
			<div className="activity-row" role="status" aria-live="polite">
				<Activity size={14} />
				<span>正在分析请求</span>
			</div>
		);
	}
	return (
		<div className="message-row assistant streaming-row">
			<div className="message-avatar">
				<Sparkles size={16} />
			</div>
			<div className="message-body">
				<div className="message-meta">
					<strong>Pi-Wm</strong>
					<span className="live-label">实时</span>
				</div>
				{item.text && <Markdown text={item.text} className="prose streaming" />}
			</div>
		</div>
	);
}

function ThinkingActivity({ phase }: { phase: SessionSnapshot["session"]["phase"] }) {
	const label = phase === "retry" ? "正在恢复任务" : phase === "compaction" ? "正在整理上下文" : "正在处理请求";
	return (
		<div className="activity-row" role="status" aria-live="polite" aria-label={label}>
			<Activity size={14} />
			<span>{label}</span>
		</div>
	);
}

function RetryActivity({ retry }: { retry: LiveRetry & { waiting: boolean } }) {
	return (
		<section
			className="failure-notice recovery-notice"
			role="status"
			aria-live="polite"
			aria-label="正在自动重试"
			data-operation-id={retry.operationId}
		>
			<div className="failure-notice-heading">
				<RefreshCw size={16} className="recovery-spinner" />
				<strong>正在恢复连接</strong>
				<span className="recovery-counter">
					重试 {retry.nextAttempt - 1}/{retry.maxAttempts - 1}
				</span>
			</div>
			<p>
				{retry.waiting
					? `模型服务暂时未响应，${formatDelay(retry.delayMs)} 后自动重试。`
					: "正在重新请求模型，任务进度已保留。"}
			</p>
			<details className="failure-details">
				<summary>技术详情</summary>
				<pre>{redactDiagnostic(retry.error)}</pre>
			</details>
		</section>
	);
}

function LiveToolView({
	tool,
	awaitingApproval = false,
	onDownload,
	onLoadArtifact,
	onOpenSubagent,
}: {
	tool: LiveTool;
	onOpenSubagent?: (() => void) | undefined;
	awaitingApproval?: boolean;
	onDownload: (artifact: ArtifactRef) => Promise<void>;
	onLoadArtifact: (artifact: ArtifactRef) => Promise<Blob>;
}) {
	return (
		<div className="tool-row live-tool">
			<ToolCard
				toolName={tool.toolName}
				input={tool.input}
				status={awaitingApproval ? "awaiting_approval" : tool.status}
				onOpenSession={onOpenSubagent}
				webEvidence={tool.webEvidence}
				receiptText={tool.preview}
			>
				{tool.preview ? (
					<pre className="tool-output">
						{tool.preview}
						{tool.truncated ? "\n…" : ""}
					</pre>
				) : null}
			</ToolCard>
			{tool.artifact && (
				<ToolResult
					parts={[{ type: "artifact", artifact: tool.artifact }]}
					toolName={tool.toolName}
					onDownload={(artifact) => void onDownload(artifact)}
					onLoadArtifact={onLoadArtifact}
				/>
			)}
		</div>
	);
}

interface ComposerEdit {
	sessionId: string;
	itemId: string;
	text: string;
	artifacts: ArtifactRef[];
}

function Composer({
	disabled,
	sendDisabled,
	sendDisabledReason,
	active,
	models,
	selectedModel,
	modelSelectionDisabled,
	token,
	workspaceId,
	commands,
	skills,
	onSelectSkill,
	contextUsage,
	permission,
	permissionDisabled,
	thinkingLevel,
	thinkingSupported,
	thinkingLevels,
	thinkingDisabled,
	onSelectModel,
	onSelectPermission,
	onSelectThinking,
	onSend,
	onAbort,
	onUpload,
	onLoadArtifact,
	draftProjectName,
	onDetachDraftProject,
	editRequest,
	onCancelEdit,
}: {
	disabled: boolean;
	sendDisabled: boolean;
	sendDisabledReason?: string;
	active: boolean;
	models: ModelMetadata[];
	selectedModel: ModelMetadata | undefined;
	modelSelectionDisabled: boolean;
	token: string;
	workspaceId: string | undefined;
	commands: ComposerCommand[];
	skills: SkillSummary[];
	onSelectSkill: (id: string) => Promise<Skill | undefined>;
	contextUsage: ContextUsage | undefined;
	permission: PermissionValue;
	permissionDisabled: boolean;
	thinkingLevel: ThinkingLevel;
	thinkingSupported: boolean;
	thinkingLevels: readonly ThinkingLevel[];
	thinkingDisabled: boolean;
	onSelectModel: (model: ModelRef) => void;
	onSelectPermission: (value: PermissionValue) => Promise<void>;
	onSelectThinking: (level: ThinkingLevel) => Promise<void>;
	onSend: (text: string, artifacts: ArtifactRef[], queueMode: "steer" | "follow_up") => Promise<void>;
	onAbort: () => Promise<void>;
	onUpload: (file: File) => Promise<ArtifactRef>;
	onLoadArtifact: (artifact: ArtifactRef) => Promise<Blob>;
	draftProjectName?: string;
	onDetachDraftProject?: () => void;
	editRequest?: ComposerEdit | undefined;
	onCancelEdit: () => void;
}) {
	const t = useT();
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<ArtifactRef[]>([]);
	const [uploading, setUploading] = useState(false);
	const uploadInFlight = useRef(false);
	const [draggingFiles, setDraggingFiles] = useState(false);
	const [uploadError, setUploadError] = useState<string>();
	const [sendError, setSendError] = useState<string>();
	const fileInput = useRef<HTMLInputElement>(null);
	const dragDepth = useRef(0);
	const input = useRef<HTMLTextAreaElement>(null);
	const [queueMode, setQueueMode] = useState<"steer" | "follow_up">("steer");
	const [sending, setSending] = useState(false);
	const [selectingSkill, setSelectingSkill] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [trigger, setTrigger] = useState<Trigger>();
	const [dismissed, setDismissed] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [files, setFiles] = useState<WorkspaceEntry[]>([]);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string>();
	const [caret, setCaret] = useState<number>();
	const currentDraft = useRef({ text, attachments });
	currentDraft.current = { text, attachments };
	const savedDraft = useRef<typeof currentDraft.current | undefined>(undefined);
	useEffect(() => {
		if (!editRequest) return;
		savedDraft.current ??= currentDraft.current;
		setText(editRequest.text);
		setAttachments(editRequest.artifacts);
		setSendError(undefined);
		setUploadError(undefined);
		setTrigger(undefined);
		setCaret(editRequest.text.length);
	}, [editRequest]);
	const cancelEdit = () => {
		if (sending || uploading) return;
		const previous = savedDraft.current;
		setText(previous?.text ?? "");
		setAttachments(previous?.attachments ?? []);
		setCaret(previous?.text.length ?? 0);
		setTrigger(undefined);
		setSendError(undefined);
		setUploadError(undefined);
		savedDraft.current = undefined;
		onCancelEdit();
	};
	useEffect(() => {
		if (!active) setStopping(false);
	}, [active]);

	// The trigger is derived from the caret, so every interaction that can move
	// it (typing, clicking, arrow keys) re-reads the textarea selection.
	const syncTrigger = (element: HTMLTextAreaElement) => {
		setTrigger(detectTrigger(element.value, element.selectionStart ?? element.value.length));
	};
	useEffect(() => {
		if (caret === undefined) return;
		input.current?.focus();
		input.current?.setSelectionRange(caret, caret);
		setCaret(undefined);
	}, [caret]);

	const fileQuery = trigger?.kind === "file" && !dismissed && workspaceId ? trigger.query : undefined;
	useEffect(() => {
		if (fileQuery === undefined || !workspaceId) return;
		let cancelled = false;
		setSearching(true);
		const timer = setTimeout(() => {
			workspaceApi
				.search(token, workspaceId, fileQuery, 12)
				.then((result) => {
					if (cancelled) return;
					setFiles(result.entries);
					setSearchError(undefined);
				})
				.catch((error: unknown) => {
					if (cancelled) return;
					setFiles([]);
					setSearchError(error instanceof Error ? error.message : String(error));
				})
				.finally(() => {
					if (!cancelled) setSearching(false);
				});
		}, 110);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [fileQuery, token, workspaceId]);

	const items = useMemo(() => {
		if (!trigger || dismissed) return [];
		if (trigger.kind === "skill") return skillItems(skills, trigger.query);
		if (trigger.kind === "command") {
			const actions = commandItems(commands, trigger.query);
			const matches = skillItems(skills, trigger.query);
			if (trigger.query || matches.length === 0) return [...actions, ...matches];
			return [
				...actions.slice(0, 4),
				...matches,
				...actions.slice(4).map((item) => ({ ...item, group: t("moreCommands") })),
			];
		}
		return fileItems(files);
	}, [commands, dismissed, files, skills, trigger, t]);
	// Keyed on contents, not identity, so an unrelated re-render never drops the
	// highlight back to the first row mid-selection.
	const itemsKey = items.map((item) => item.id).join("\u0000");
	useEffect(() => {
		setActiveIndex(0);
	}, [itemsKey]);
	const menuOpen = trigger !== undefined && !dismissed && (trigger.kind === "file" ? workspaceId !== undefined : true);
	const goalDraft = /^\/goal(?:\s|$)/i.test(text.trim());
	const commandDraft = /^\/([A-Za-z0-9:._-]+)(?:\s+([\S\s]*))?$/.exec(text.trim());
	const localActionDraft =
		!editRequest && commandDraft
			? commands.find((entry) => entry.kind === "action" && entry.name === commandDraft[1])
			: undefined;

	const accept = (item: SuggestItem) => {
		if (!trigger || selectingSkill) return;
		if (item.skillId) {
			const nextText = text.slice(0, trigger.start) + text.slice(trigger.end);
			const nextCaret = trigger.start;
			setSelectingSkill(true);
			setSendError(undefined);
			setTrigger(undefined);
			void onSelectSkill(item.skillId)
				.then((selected) => {
					if (!selected) return;
					setText(nextText);
					setCaret(nextCaret);
				})
				.catch((error: unknown) => setSendError(error instanceof Error ? error.message : String(error)))
				.finally(() => {
					setSelectingSkill(false);
				});
			return;
		}
		if (item.action) {
			setText(text.slice(0, trigger.start) + text.slice(trigger.end));
			setTrigger(undefined);
			void Promise.resolve(item.action("")).catch((error: unknown) => {
				setSendError(error instanceof Error ? error.message : String(error));
			});
			return;
		}
		const value = trigger.kind === "file" ? quoteMention(item.value) : item.value;
		// Accepting a directory keeps the mention open so the next keystroke drills
		// into it; a quoted path cannot stay open because the quote ends the token.
		const drilling = trigger.kind === "file" && item.value.endsWith("/") && value === item.value;
		const completion = applyCompletion(text, trigger, value, { trailing: !drilling });
		setText(completion.text);
		setCaret(completion.caret);
		setTrigger(drilling ? { kind: "file", start: trigger.start, end: completion.caret, query: value } : undefined);
		input.current?.focus();
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const value = text.trim();
		if ((!value && attachments.length === 0) || disabled || sending || uploading || selectingSkill) return;
		// A prompt that is nothing but a local command runs here instead of being
		// sent to the runtime; anything after the name is passed as its argument.
		const command = /^\/([A-Za-z0-9:._-]+)(?:\s+([\S\s]*))?$/.exec(value);
		const local =
			!editRequest && command
				? commands.find((entry) => entry.kind === "action" && entry.name === command[1])
				: undefined;
		if (local?.run) {
			setSendError(undefined);
			try {
				await local.run(command?.[2]?.trim() ?? "");
				setText("");
				setTrigger(undefined);
			} catch (error) {
				setSendError(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (sendDisabled) {
			setSendError(sendDisabledReason ?? "Model unavailable");
			return;
		}
		setSending(true);
		setSendError(undefined);
		try {
			await onSend(value, attachments, queueMode);
			setText("");
			setAttachments([]);
		} catch (error) {
			setSendError(error instanceof Error ? error.message : String(error));
		} finally {
			setSending(false);
		}
	};

	const uploadFiles = async (incoming: File[]) => {
		if (disabled || incoming.length === 0) return;
		if (uploadInFlight.current || sending) {
			setUploadError(t("waitForUpload"));
			return;
		}
		const remaining = Math.max(0, 8 - attachments.length);
		const selected = incoming.slice(0, remaining);
		if (selected.length === 0) {
			setUploadError(t("attachmentLimit"));
			return;
		}
		uploadInFlight.current = true;
		setUploading(true);
		setUploadError(undefined);
		try {
			const results = await Promise.all(
				selected.map(async (file) => {
					try {
						return { ok: true as const, artifact: await onUpload(file) };
					} catch (error) {
						return {
							ok: false as const,
							file,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				})
			);
			const uploaded = results.flatMap((result) => (result.ok ? [result.artifact] : []));
			const errors = results.flatMap((result) => (result.ok ? [] : [`${result.file.name}：${result.error}`]));
			if (uploaded.length > 0) setAttachments((current) => [...current, ...uploaded].slice(0, 8));
			if (incoming.length > selected.length) errors.push(t("attachmentLimit"));
			setUploadError(errors.length > 0 ? errors.join("；") : undefined);
		} finally {
			uploadInFlight.current = false;
			setUploading(false);
		}
	};

	return (
		<form
			className={`composer ${draggingFiles ? "dragging-files" : ""}`}
			onSubmit={submit}
			onDragEnter={(event) => {
				if (disabled || !Array.from(event.dataTransfer.types).includes("Files")) return;
				event.preventDefault();
				dragDepth.current += 1;
				setDraggingFiles(true);
			}}
			onDragOver={(event) => {
				if (disabled || !Array.from(event.dataTransfer.types).includes("Files")) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = attachments.length >= 8 || uploading ? "none" : "copy";
			}}
			onDragLeave={(event) => {
				event.preventDefault();
				dragDepth.current = Math.max(0, dragDepth.current - 1);
				if (dragDepth.current === 0) setDraggingFiles(false);
			}}
			onDrop={(event) => {
				const droppedFiles = [...event.dataTransfer.files];
				if (droppedFiles.length === 0 && !Array.from(event.dataTransfer.types).includes("Files")) return;
				event.preventDefault();
				dragDepth.current = 0;
				setDraggingFiles(false);
				void uploadFiles(droppedFiles);
			}}
		>
			{draggingFiles && (
				<div className="composer-drop-zone" role="status">
					<Upload size={22} />
					<strong>{t("dropFiles")}</strong>
					<span>{t("multipleFilesHint")}</span>
				</div>
			)}
			{menuOpen && trigger && (
				<SuggestMenu
					trigger={trigger}
					items={items}
					activeIndex={activeIndex}
					loading={trigger.kind === "file" && searching}
					error={trigger.kind === "file" ? searchError : undefined}
					onPick={accept}
					onHover={setActiveIndex}
				/>
			)}
			<input
				className="visually-hidden"
				ref={fileInput}
				type="file"
				aria-label={t("chooseAttachments")}
				multiple
				onChange={(event) => {
					const files = [...(event.target.files ?? [])];
					event.target.value = "";
					void uploadFiles(files);
				}}
			/>
			{draftProjectName && onDetachDraftProject && (
				<div className="composer-project-context">
					<button
						type="button"
						className="composer-project-remove"
						aria-label={t("detachProject")}
						data-tooltip={t("detachProject")}
						onClick={onDetachDraftProject}
					>
						<Folder className="composer-project-folder" size={15} />
						<X className="composer-project-x" size={13} />
					</button>
					<span title={draftProjectName}>{draftProjectName}</span>
				</div>
			)}
			{(attachments.length > 0 || uploadError || sendError) && (
				<div className="composer-attachments">
					{attachments.map((artifact) => (
						<div
							className={`attachment-chip ${isPreviewableImageArtifact(artifact) ? "attachment-image" : ""}`}
							key={artifact.id}
						>
							{isPreviewableImageArtifact(artifact) ? (
								<div className="attachment-image-preview">
									<ArtifactMediaPreview artifact={artifact} onLoad={onLoadArtifact} />
								</div>
							) : (
								<FileCode2 size={14} />
							)}
							<span title={artifact.name}>{artifact.name}</span>
							<button
								type="button"
								className="attachment-remove"
								aria-label={t("removeArtifact", { name: artifact.name })}
								title={t("removeArtifact", { name: artifact.name })}
								onClick={() => setAttachments((current) => current.filter((item) => item.id !== artifact.id))}
							>
								<X size={13} />
							</button>
						</div>
					))}
					{uploadError && (
						<div className="attachment-error" role="alert">
							<CircleAlert size={13} />
							{uploadError}
						</div>
					)}
					{sendError && (
						<div className="attachment-error">
							<CircleAlert size={13} />
							{sendError}
						</div>
					)}
				</div>
			)}
			<textarea
				aria-label={t("message")}
				ref={input}
				placeholder={active ? t("activeTaskInstruction") : t("sendTaskPlaceholder")}
				value={text}
				aria-expanded={menuOpen}
				onPaste={(event) => {
					if (disabled || selectingSkill) return;
					const clipboard = event.clipboardData;
					const files = Array.from(clipboard.files);
					// Some clipboard providers expose files only through the item list.
					if (files.length === 0) {
						for (const item of Array.from(clipboard.items)) {
							if (item.kind !== "file") continue;
							const file = item.getAsFile();
							if (file) files.push(file);
						}
					}
					if (files.length === 0) return;
					// Preserve native text insertion and selection for mixed pastes.
					if (!clipboard.getData("text/plain")) event.preventDefault();
					void uploadFiles(files);
				}}
				onChange={(event) => {
					setText(event.target.value);
					setDismissed(false);
					syncTrigger(event.target);
				}}
				onClick={(event) => syncTrigger(event.currentTarget)}
				onBlur={() => setTrigger(undefined)}
				onKeyUp={(event) => {
					if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End")
						syncTrigger(event.currentTarget);
				}}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.keyCode === 229) return;
					if (menuOpen && items.length > 0) {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							setActiveIndex((current) => cycleIndex(current, event.key === "ArrowDown" ? 1 : -1, items.length));
							return;
						}
						if (event.key === "Enter" || event.key === "Tab") {
							const item = items[activeIndex] ?? items[0];
							if (item) {
								event.preventDefault();
								accept(item);
								return;
							}
						}
					}
					if (menuOpen && event.key === "Escape") {
						event.preventDefault();
						setDismissed(true);
						return;
					}
					if (editRequest && event.key === "Escape") {
						event.preventDefault();
						cancelEdit();
						return;
					}
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						event.currentTarget.form?.requestSubmit();
					}
				}}
				disabled={disabled}
				readOnly={selectingSkill}
				aria-busy={selectingSkill}
				rows={2}
			/>
			<div className="composer-actions">
				<div className="composer-left">
					{editRequest && (
						<button
							type="button"
							className="icon-button"
							title={t("cancelEdit")}
							aria-label={t("cancelEdit")}
							disabled={sending || uploading}
							onClick={cancelEdit}
						>
							<X size={17} />
						</button>
					)}
					<button
						type="button"
						className="icon-button"
						title={t("addAttachments")}
						disabled={disabled || uploading || attachments.length >= 8}
						onClick={() => fileInput.current?.click()}
					>
						<Paperclip size={17} />
					</button>
					{!active && (
						<PermissionPicker value={permission} disabled={permissionDisabled} onChange={onSelectPermission} />
					)}
					{goalDraft && (
						<span className="composer-goal-target" role="status" title={t("goalTargetHint")}>
							<Target size={15} />
							<span>{t("goal")}</span>
						</span>
					)}
					{uploading && (
						<span className="uploading-label" role="status">
							{t("uploading")}
						</span>
					)}
					{!uploading && contextUsage && <ContextPill usage={contextUsage} />}
					{active && (
						<div className="segmented" aria-label={t("queueMode")}>
							<button
								type="button"
								className={queueMode === "steer" ? "active" : ""}
								aria-pressed={queueMode === "steer"}
								onClick={() => setQueueMode("steer")}
							>
								{t("steerNow")}
							</button>
							<button
								type="button"
								className={queueMode === "follow_up" ? "active" : ""}
								aria-pressed={queueMode === "follow_up"}
								onClick={() => setQueueMode("follow_up")}
							>
								{t("followUp")}
							</button>
						</div>
					)}
				</div>
				<div className="composer-submit">
					<ThinkingPicker
						level={thinkingLevel}
						supported={thinkingSupported}
						supportedLevels={thinkingLevels}
						disabled={thinkingDisabled}
						models={models}
						selectedModel={selectedModel}
						modelSelectionDisabled={modelSelectionDisabled}
						onSelectModel={onSelectModel}
						onChange={onSelectThinking}
					/>
					{active && (
						<button
							className="stop-button"
							type="button"
							title={t("stopTask")}
							disabled={stopping}
							onClick={() => {
								setStopping(true);
								void onAbort().catch(() => setStopping(false));
							}}
						>
							<Square size={13} fill="currentColor" />
						</button>
					)}
					<button
						className="send-button"
						type="submit"
						aria-label={t("send")}
						title={sendDisabled && !localActionDraft ? (sendDisabledReason ?? "Model unavailable") : t("send")}
						disabled={
							disabled ||
							(sendDisabled && !localActionDraft) ||
							sending ||
							uploading ||
							selectingSkill ||
							(!text.trim() && attachments.length === 0)
						}
					>
						<Send size={17} />
					</button>
				</div>
			</div>
		</form>
	);
}

function WorkspaceFilesView({ token, workspaceId }: { token: string; workspaceId: string }) {
	const [directories, setDirectories] = useState<Record<string, WorkspaceDirectory>>({});
	const [expanded, setExpanded] = useState(() => new Set<string>(["."]));
	const [selected, setSelected] = useState<string>();
	const [file, setFile] = useState<WorkspaceFileView>();
	const [loadingPath, setLoadingPath] = useState<string>();
	const [error, setError] = useState<string>();

	const loadDirectory = async (path: string) => {
		setLoadingPath(path);
		setError(undefined);
		try {
			const value = await workspaceApi.list(token, workspaceId, path);
			setDirectories((current) => ({ ...current, [path]: value }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoadingPath(undefined);
		}
	};

	useEffect(() => {
		setDirectories({});
		setExpanded(new Set(["."]));
		setSelected(undefined);
		setFile(undefined);
		void loadDirectory(".");
	}, [token, workspaceId]);

	const toggleDirectory = (path: string) => {
		const next = new Set(expanded);
		if (next.has(path)) next.delete(path);
		else {
			next.add(path);
			if (!directories[path]) void loadDirectory(path);
		}
		setExpanded(next);
	};

	const openFile = async (path: string) => {
		setSelected(path);
		setLoadingPath(path);
		setError(undefined);
		try {
			setFile(await workspaceApi.read(token, workspaceId, path));
		} catch (cause) {
			setFile(undefined);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoadingPath(undefined);
		}
	};

	const renderDirectory = (path: string, depth: number): ReactNode => {
		const directory = directories[path];
		if (!directory)
			return loadingPath === path ? (
				<div className="tree-loading" key={`${path}-loading`}>
					加载中...
				</div>
			) : null;
		return directory.entries.map((entry) => {
			const isDirectory = entry.kind === "directory";
			const isExpanded = isDirectory && expanded.has(entry.path);
			return (
				<div className="tree-node" key={entry.path}>
					<button
						className={selected === entry.path ? "selected" : ""}
						style={{ paddingLeft: `${8 + depth * 15}px` }}
						title={entry.path}
						onClick={() => (isDirectory ? toggleDirectory(entry.path) : void openFile(entry.path))}
					>
						{isDirectory ? (
							<ChevronRight className={isExpanded ? "expanded" : ""} size={13} />
						) : (
							<span className="tree-spacer" />
						)}
						{isDirectory ? isExpanded ? <FolderOpen size={14} /> : <Folder size={14} /> : <FileText size={14} />}
						<span>{entry.name}</span>
					</button>
					{isDirectory && isExpanded && renderDirectory(entry.path, depth + 1)}
				</div>
			);
		});
	};

	return (
		<section className="code-workbench" aria-label="工作区文件">
			<aside className="workbench-sidebar">
				<div className="workbench-heading">
					<div>
						<strong>文件</strong>
						<span>工作区</span>
					</div>
					<button className="icon-button" title="刷新文件" onClick={() => void loadDirectory(".")}>
						<RefreshCw size={15} />
					</button>
				</div>
				<div className="file-tree">{renderDirectory(".", 0)}</div>
				{directories["."]?.truncated && <div className="workbench-notice">目录列表已截断</div>}
			</aside>
			<div className="workbench-content">
				<div className="editor-heading">
					<FileCode2 size={15} />
					<strong>{selected ?? "未选择文件"}</strong>
					{file && <span>{file.totalBytes.toLocaleString()} bytes</span>}
				</div>
				{error && (
					<div className="workbench-error">
						<CircleAlert size={15} />
						{error}
					</div>
				)}
				{selected && loadingPath === selected && <div className="workbench-empty">正在加载文件...</div>}
				{!loadingPath && !file && !error && (
					<div className="workbench-empty">
						<FileText size={24} />
						<span>选择文件以预览</span>
					</div>
				)}
				{file?.binary && (
					<div className="workbench-empty">
						<FileText size={24} />
						<span>暂不支持预览二进制文件</span>
					</div>
				)}
				{file && !file.binary && (
					<div className="code-scroll">
						<pre className="code-preview">
							<code>{file.content}</code>
						</pre>
						{file.truncated && (
							<div className="preview-truncated">预览已限制为 {file.bytesRead.toLocaleString()} 字节</div>
						)}
					</div>
				)}
			</div>
		</section>
	);
}

function SkillsView({
	skills,
	selectedSkill,
	onRefresh,
	onSelect,
	onClear,
	onManage,
}: {
	skills: SkillSummary[];
	selectedSkill: Skill | undefined;
	onRefresh: () => Promise<SkillSummary[]>;
	onSelect: (skillId: string) => Promise<Skill | undefined>;
	onClear: () => void;
	onManage: () => void;
}) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const select = async (skillId: string) => {
		setError(undefined);
		try {
			await onSelect(skillId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const refresh = async () => {
		setLoading(true);
		setError(undefined);
		try {
			await onRefresh();
		} catch {
			setError("技能列表刷新失败，请检查网关连接。");
		} finally {
			setLoading(false);
		}
	};
	return (
		<section className="skills-workbench" aria-label="技能">
			<aside className="skills-sidebar">
				<div className="workbench-heading">
					<div>
						<strong>技能</strong>
						<span>共 {skills.length} 个</span>
					</div>
					<button className="icon-button" title="管理技能" aria-label="管理技能" onClick={onManage}>
						<Settings size={15} />
					</button>
					<button className="icon-button" title="刷新技能" disabled={loading} onClick={() => void refresh()}>
						<RefreshCw size={15} />
					</button>
				</div>
				{error && (
					<div className="workbench-error">
						<CircleAlert size={14} />
						{error}
					</div>
				)}
				{skills.map((skill) => (
					<button
						className={`skill-entry ${selectedSkill?.id === skill.id ? "selected" : ""}`}
						key={skill.id}
						onClick={() => void select(skill.id)}
					>
						<BookOpen size={14} />
						<span>
							<strong>{skill.name}</strong>
							<small>{skill.description || "暂无说明"}</small>
						</span>
					</button>
				))}
				{!loading && skills.length === 0 && <div className="workbench-empty">未找到技能</div>}
			</aside>
			<div className="skills-content">
				{selectedSkill ? (
					<>
						<div className="editor-heading">
							<BookOpen size={15} />
							<strong>{selectedSkill.name}</strong>
							<span>{selectedSkill.path}</span>
							<button type="button" onClick={onClear}>
								取消技能
							</button>
						</div>
						{selectedSkill.truncated && (
							<div className="workbench-error" role="alert">
								技能超过 200 KiB，当前仅为截断预览，无法用于执行。请精简技能文件后刷新，或取消技能。
							</div>
						)}
						<p className="skill-description">{selectedSkill.description}</p>
						<pre className="skill-content">
							{selectedSkill.content}
							{selectedSkill.truncated ? "\n\n[内容已截断]" : ""}
						</pre>
					</>
				) : (
					<div className="workbench-empty">
						<BookOpen size={24} />
						<span>选择一个技能</span>
					</div>
				)}
			</div>
		</section>
	);
}

const TOOL_CATEGORY_LABELS: Record<ToolStatus["category"], string> = {
	filesystem: "文件",
	process: "进程",
	network: "网络",
	agent: "编排",
};

const TOOL_STATUS_LABELS: Record<ToolStatus["status"], string> = {
	ready: "可用",
	requires_configuration: "需要配置",
	disabled: "已禁用",
};

const SANDBOX_MODE_LABELS: Record<ToolStatus["sandboxModes"][number], string> = {
	read_only: "只读",
	workspace_write: "工作区写入",
	unrestricted: "不受限",
};

function executionLocationLabel(execution: ExecutionEnvironment | undefined, locale: "zh" | "en" = "zh"): string {
	if (!execution) return locale === "en" ? "Unknown location" : "执行位置未知";
	return execution.placement === "local_device"
		? locale === "en"
			? "This computer"
			: "用户电脑"
		: locale === "en"
			? "Remote server"
			: "远程服务器";
}

function processModeLabel(execution: ExecutionEnvironment | undefined): string {
	if (!execution) return "未连接";
	if (execution.processMode === "local") return "本地 Shell";
	if (execution.processMode === "docker") return "Docker";
	return "命令已禁用";
}

function ToolsView({
	tools,
	runtime,
	execution,
	onRefresh,
}: {
	tools: ToolStatus[];
	runtime: "pi" | "demo" | undefined;
	execution: ExecutionEnvironment | undefined;
	onRefresh: () => Promise<ToolStatus[]>;
}) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const refresh = async () => {
		setLoading(true);
		setError(undefined);
		try {
			await onRefresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	};
	const ready = tools.filter((tool) => tool.status === "ready").length;
	const configurable = tools.filter((tool) => tool.status === "requires_configuration").length;
	return (
		<section className="tools-workbench" aria-label="工具状态">
			<div className="tools-heading">
				<div>
					<Wrench size={17} />
					<span>
						<strong>Tools</strong>
						<small>
							{runtime === "pi" ? "Pi Agent" : runtime === "demo" ? "Demo" : "未连接"} ·{" "}
							{executionLocationLabel(execution)} · {processModeLabel(execution)}
						</small>
					</span>
				</div>
				<div className="tool-summary">
					<span>
						<i className="ready" />
						{ready} 可用
					</span>
					<span>
						<i className="config" />
						{configurable} 待配置
					</span>
					<span>
						<i className="disabled" />
						{tools.length - ready - configurable} 禁用
					</span>
				</div>
				<button className="icon-button" title="刷新工具状态" disabled={loading} onClick={() => void refresh()}>
					<RefreshCw size={15} />
				</button>
			</div>
			{error && (
				<div className="workbench-error">
					<CircleAlert size={14} />
					{error}
				</div>
			)}
			<div className="tool-status-table" role="table" aria-label="Agent 工具目录">
				<div className="tool-status-header" role="row">
					<span>工具</span>
					<span>类型</span>
					<span>状态</span>
					<span>执行后端</span>
					<span>沙箱模式</span>
				</div>
				{tools.map((tool) => (
					<div className="tool-status-row" role="row" key={tool.name}>
						<div className="tool-name">
							<code>{tool.name}</code>
							<small>
								{tool.label} · {tool.description}
							</small>
						</div>
						<span>{TOOL_CATEGORY_LABELS[tool.category]}</span>
						<span className={`tool-status ${tool.status}`}>
							<i />
							{TOOL_STATUS_LABELS[tool.status]}
						</span>
						<div className="tool-backend">
							<span>{tool.backend}</span>
							{tool.reason && <small>{tool.reason}</small>}
						</div>
						<div className="tool-sandbox-modes">
							{tool.sandboxModes.map((mode) => (
								<span key={mode}>{SANDBOX_MODE_LABELS[mode]}</span>
							))}
						</div>
					</div>
				))}
				{!loading && tools.length === 0 && (
					<div className="workbench-empty">
						<Wrench size={24} />
						<span>没有可显示的工具</span>
					</div>
				)}
			</div>
		</section>
	);
}

const GOAL_REVIEW_ROUND_CHOICES: readonly number[] = [1, 2, 3, 4, 5];

const AUTOMATION_RUN_ACTIVE_STATUSES: readonly AutomationRunSummary["status"][] = [
	"dispatching",
	"queued",
	"running",
	"awaiting_approval",
	"cancelling",
];
const AUTOMATION_STATUS_LABELS: Record<GoalAutomationSummary["status"], string> = {
	active: "运行中",
	paused: "已暂停",
	completed: "已完成",
};

function formatAutomationTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(timestamp);
}

function dateTimeLocalValue(timestamp: number): string {
	const date = new Date(timestamp);
	return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function automationScheduleLabel(schedule: AutomationSchedule): string {
	return schedule.kind === "calendar"
		? scheduleLabel(schedule)
		: schedule.kind === "once"
			? `一次 · ${formatAutomationTime(schedule.runAt)}`
			: `每 ${schedule.everyMinutes} 分钟 · ${formatAutomationTime(schedule.startsAt)} 起`;
}

function AutomationsView({
	automations,
	disabled,
	archived,
	draftContext,
	onCreate,
	onUpdate,
	onDelete,
	onSetEnabled,
	onTrigger,
	onListRuns,
	onRefresh,
	onOpenSession,
	onRespondApproval,
}: {
	automations: GoalAutomationSummary[];
	disabled: boolean;
	archived: boolean;
	draftContext:
		{ workspaces: WorkspaceSummary[]; workspaceId: string | undefined; modelName: string | undefined } | undefined;
	onCreate: (
		input: {
			objective: string;
			title?: string;
			schedule: AutomationSchedule;
			successCriteria?: string;
			maxRounds?: number;
			plan?: GoalPlanSpec;
		},
		workspaceId?: string
	) => Promise<GoalAutomationSummary>;
	onUpdate: (
		automationId: string,
		expectedUpdatedAt: number,
		input: {
			objective: string;
			title?: string;
			schedule: AutomationSchedule;
			successCriteria?: string;
			maxRounds?: number;
			plan?: GoalPlanSpec;
		}
	) => Promise<GoalAutomationSummary>;
	onDelete: (automationId: string, expectedUpdatedAt: number) => Promise<void>;
	onSetEnabled: (automationId: string, enabled: boolean) => Promise<GoalAutomationSummary>;
	onTrigger: (automationId: string) => Promise<AutomationRunSummary>;
	onListRuns: (automationId: string, limit?: number) => Promise<AutomationRunSummary[]>;
	onRespondApproval: (sessionId: string, approvalId: string, decision: "approve" | "deny") => Promise<void>;
	onRefresh: () => Promise<GoalAutomationSummary[]>;
	onOpenSession: (sessionId: string) => Promise<void>;
}) {
	const [selectedId, setSelectedId] = useState<string>();
	const [draftWorkspaceId, setDraftWorkspaceId] = useState<string>();
	const creationWorkspaceId =
		draftContext?.workspaces.find((workspace) => workspace.id === draftWorkspaceId)?.id ??
		draftContext?.workspaceId ??
		draftContext?.workspaces[0]?.id;
	const creationError = draftContext
		? !creationWorkspaceId
			? "项目不可用"
			: !draftContext.modelName
				? "请先添加并验证模型"
				: undefined
		: undefined;
	const [showCreate, setShowCreate] = useState(false);
	const [title, setTitle] = useState("");
	const [objective, setObjective] = useState("");
	const [scheduleKind, setScheduleKind] = useState<AutomationSchedule["kind"]>("interval");
	const [calendar, setCalendar] = useState<CalendarSchedule>({
		kind: "calendar",
		frequency: "daily",
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		hour: 9,
		minute: 0,
	});
	const [editing, setEditing] = useState<GoalAutomationSummary>();
	const [confirmDelete, setConfirmDelete] = useState<string>();
	const [scheduledAt, setScheduledAt] = useState(() => dateTimeLocalValue(Date.now() + 5 * 60_000));
	const [everyMinutes, setEveryMinutes] = useState(60);
	const [reviewEnabled, setReviewEnabled] = useState(false);
	const [successCriteria, setSuccessCriteria] = useState("");
	const [maxRounds, setMaxRounds] = useState(3);
	const [creating, setCreating] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [action, setAction] = useState<{ automationId: string; kind: "toggle" | "trigger" | "delete" }>();
	const [runs, setRuns] = useState<AutomationRunSummary[]>([]);
	const [runsLoading, setRunsLoading] = useState(false);
	const [formError, setFormError] = useState<string>();
	const [actionError, setActionError] = useState<string>();
	const selected = automations.find((automation) => automation.id === selectedId) ?? automations[0];
	const [planEnabled, setPlanEnabled] = useState(false);
	const [plan, setPlan] = useState<GoalPlanSpec>(newGoalPlan);
	const hasActiveRuns = runs.some((run) => AUTOMATION_RUN_ACTIVE_STATUSES.includes(run.status));
	const runRequest = useRef(0);
	const draftSchedule: AutomationSchedule =
		scheduleKind === "calendar"
			? calendar
			: scheduleKind === "once"
				? { kind: "once", runAt: new Date(scheduledAt).getTime() }
				: { kind: "interval", startsAt: new Date(scheduledAt).getTime(), everyMinutes };
	const beginEdit = (item: GoalAutomationSummary) => {
		setEditing(item);
		setTitle(item.title);
		setObjective(item.objective);
		setScheduleKind(item.schedule.kind);
		if (item.schedule.kind === "calendar") setCalendar(item.schedule);
		else {
			setScheduledAt(dateTimeLocalValue(item.schedule.kind === "once" ? item.schedule.runAt : item.schedule.startsAt));
			if (item.schedule.kind === "interval") setEveryMinutes(item.schedule.everyMinutes);
		}
		setReviewEnabled(!!item.successCriteria);
		setSuccessCriteria(item.successCriteria ?? "");
		setMaxRounds(item.maxRounds ?? 3);
		setPlanEnabled(!!item.plan);
		setPlan(item.plan ?? newGoalPlan());
		setFormError(undefined);
		setShowCreate(true);
	};

	useEffect(() => {
		if (!selectedId || !automations.some((automation) => automation.id === selectedId))
			setSelectedId(automations[0]?.id);
	}, [automations, selectedId]);

	const loadRuns = useCallback(
		async (automationId: string, quiet = false) => {
			const request = ++runRequest.current;
			if (!quiet) setRunsLoading(true);
			try {
				const nextRuns = await onListRuns(automationId);
				if (request !== runRequest.current) return;
				setRuns(nextRuns);
				setActionError(undefined);
			} catch (cause) {
				setActionError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (!quiet && request === runRequest.current) setRunsLoading(false);
			}
		},
		[onListRuns]
	);

	useEffect(() => {
		setRuns([]);
		setConfirmDelete(undefined);
		if (!selected) {
			++runRequest.current;
			return;
		}
		void loadRuns(selected.id);
		return () => {
			++runRequest.current;
		};
	}, [loadRuns, selected?.id]);

	useEffect(() => {
		if (!selected) return;
		const timer = setInterval(
			() => {
				void loadRuns(selected.id, true);
				void onRefresh().catch(() => undefined);
			},
			hasActiveRuns ? 1500 : 5000
		);
		return () => clearInterval(timer);
	}, [hasActiveRuns, loadRuns, selected?.id, onRefresh]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (creating || disabled || creationError) return;
		const normalizedObjective = objective.trim();
		const normalizedCriteria = successCriteria.trim();
		const timestamp = new Date(scheduledAt).getTime();
		if (!normalizedObjective) return setFormError("请填写自动化目标");
		if (scheduleKind !== "calendar" && !Number.isFinite(timestamp)) return setFormError("请选择有效的执行时间");
		if (scheduleKind === "calendar") {
			try {
				validateCalendarSchedule(calendar);
			} catch {
				return setFormError("请填写有效时区、时刻及至少一个星期。");
			}
		}
		if (
			scheduleKind === "interval" &&
			(!Number.isSafeInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 525_600)
		)
			return setFormError("执行间隔必须在 1 到 525600 分钟之间");
		if (reviewEnabled && !normalizedCriteria) return setFormError("启用评审循环时请填写成功标准");
		const schedule = draftSchedule;
		setCreating(true);
		setFormError(undefined);
		try {
			const input = {
				objective: normalizedObjective,
				schedule,
				...(planEnabled ? { plan } : {}),
				...(title.trim() ? { title: title.trim() } : {}),
				...(reviewEnabled ? { successCriteria: normalizedCriteria, maxRounds } : {}),
			};
			const created = editing
				? await onUpdate(editing.id, editing.updatedAt, input)
				: await onCreate(input, creationWorkspaceId);
			setEditing(undefined);
			setSelectedId(created.id);
			setShowCreate(false);
			setPlanEnabled(false);
			setPlan(newGoalPlan());
			setTitle("");
			setObjective("");
			setReviewEnabled(false);
			setSuccessCriteria("");
			setMaxRounds(3);
			setScheduledAt(dateTimeLocalValue(Date.now() + 5 * 60_000));
		} catch (cause) {
			setFormError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setCreating(false);
		}
	};

	const refresh = async () => {
		if (refreshing) return;
		setRefreshing(true);
		setActionError(undefined);
		try {
			await onRefresh();
			if (selected) await loadRuns(selected.id, true);
		} catch (cause) {
			setActionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRefreshing(false);
		}
	};

	const act = async (automation: GoalAutomationSummary, kind: "toggle" | "trigger" | "delete") => {
		if (action || disabled) return;
		setAction({ automationId: automation.id, kind });
		setActionError(undefined);
		try {
			if (kind === "delete") {
				await onDelete(automation.id, automation.updatedAt);
				setConfirmDelete(undefined);
				setShowCreate(false);
				setEditing(undefined);
			} else if (kind === "toggle") {
				await onSetEnabled(automation.id, automation.status !== "active");
			} else {
				const run = await onTrigger(automation.id);
				setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)]);
			}
		} catch (cause) {
			setActionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setAction(undefined);
		}
	};

	return (
		<section className="subagents-workbench automations-workbench" aria-label="自动化">
			<aside className="subagents-sidebar">
				<div className="workbench-heading">
					<div>
						<strong>自动化</strong>
						<span>{automations.length} 个计划</span>
					</div>
					<div className="automation-heading-actions">
						<button
							className="icon-button"
							type="button"
							title={showCreate ? "关闭创建表单" : "新建自动化"}
							disabled={disabled || creating}
							onClick={() => {
								setShowCreate((value) => !value);
								setEditing(undefined);
								setTitle("");
								setObjective("");
								setReviewEnabled(false);
								setPlanEnabled(false);
								setPlan(newGoalPlan());
								setFormError(undefined);
							}}
						>
							{showCreate ? <X size={15} /> : <Plus size={15} />}
						</button>
						<button
							className="icon-button"
							type="button"
							title="刷新自动化"
							disabled={refreshing}
							onClick={() => void refresh()}
						>
							<RefreshCw className={refreshing ? "spin" : ""} size={15} />
						</button>
					</div>
				</div>
				<div className="goal-readonly">
					本地服务运行、电脑唤醒时才会执行。错过多次合并补一次；沿用所属会话的项目、模型和权限，不会自动提权。
				</div>
				{showCreate && (
					<form className="subagent-create automation-create" onSubmit={(event) => void submit(event)}>
						<strong>{editing ? "编辑定时任务" : "新建定时任务"}</strong>
						{draftContext && (
							<>
								<label>
									<span>项目</span>
									<select
										value={creationWorkspaceId ?? ""}
										disabled={disabled || creating}
										onChange={(event) => setDraftWorkspaceId(event.target.value)}
									>
										{draftContext.workspaces.map((workspace) => (
											<option key={workspace.id} value={workspace.id}>
												{isImplicitWorkspace(workspace) ? "无项目（本地工作区）" : workspaceName(workspace.name)}
											</option>
										))}
									</select>
								</label>
								<div className="automation-context">关联会话模型：{draftContext.modelName ?? "未配置"}</div>
							</>
						)}
						<label>
							<span>目标</span>
							<textarea
								rows={3}
								maxLength={20_000}
								required
								placeholder="每次运行要完成的任务"
								value={objective}
								readOnly={disabled}
								onChange={(event) => setObjective(event.target.value)}
							/>
						</label>
						<label>
							<span>名称</span>
							<input
								maxLength={500}
								placeholder="自动生成"
								value={title}
								readOnly={disabled}
								onChange={(event) => setTitle(event.target.value)}
							/>
						</label>
						<div className="automation-schedule-kind" role="group" aria-label="日程类型">
							<button
								type="button"
								className={scheduleKind === "once" ? "active" : ""}
								aria-pressed={scheduleKind === "once"}
								onClick={() => setScheduleKind("once")}
							>
								一次
							</button>
							<button
								type="button"
								className={scheduleKind === "interval" ? "active" : ""}
								aria-pressed={scheduleKind === "interval"}
								onClick={() => setScheduleKind("interval")}
							>
								固定间隔
							</button>
							<button
								type="button"
								className={scheduleKind === "calendar" ? "active" : ""}
								aria-pressed={scheduleKind === "calendar"}
								onClick={() => setScheduleKind("calendar")}
							>
								日历日程
							</button>
						</div>
						{scheduleKind === "calendar" ? (
							<CalendarScheduleEditor value={calendar} onChange={setCalendar} disabled={disabled || creating} />
						) : (
							<label>
								<span>{scheduleKind === "once" ? "执行时间" : "开始时间"}</span>
								<input
									type="datetime-local"
									required
									value={scheduledAt}
									readOnly={disabled}
									onChange={(event) => setScheduledAt(event.target.value)}
								/>
							</label>
						)}
						{scheduleKind === "interval" && (
							<label>
								<span>间隔（分钟）</span>
								<input
									type="number"
									min={1}
									max={525_600}
									step={1}
									required
									value={everyMinutes}
									readOnly={disabled}
									onChange={(event) => setEveryMinutes(Number(event.target.value))}
								/>
							</label>
						)}
						<label className="goal-review-toggle">
							<input
								type="checkbox"
								checked={reviewEnabled}
								disabled={disabled || planEnabled}
								onChange={(event) => setReviewEnabled(event.target.checked)}
							/>
							<span>启用评审循环</span>
						</label>
						{reviewEnabled && (
							<>
								<label>
									<span>成功标准</span>
									<textarea
										rows={3}
										maxLength={4000}
										required
										placeholder="每次运行的验收条件"
										value={successCriteria}
										readOnly={disabled}
										onChange={(event) => setSuccessCriteria(event.target.value)}
									/>
								</label>
								<label className="goal-rounds">
									<span>最大轮次</span>
									<select
										aria-label="最大轮次"
										value={maxRounds}
										disabled={disabled}
										onChange={(event) => setMaxRounds(Number(event.target.value))}
									>
										{GOAL_REVIEW_ROUND_CHOICES.map((round) => (
											<option value={round} key={round}>
												{round} 轮
											</option>
										))}
									</select>
								</label>
							</>
						)}
						<label className="goal-review-toggle">
							<input
								type="checkbox"
								checked={planEnabled}
								disabled={disabled || creating}
								onChange={(event) => {
									setPlanEnabled(event.target.checked);
									if (event.target.checked) setReviewEnabled(false);
								}}
							/>
							<span>多步骤计划</span>
						</label>
						{planEnabled && <GoalPlanEditor value={plan} onChange={setPlan} disabled={disabled || creating} />}
						<button
							className="subagent-create-button"
							type="submit"
							disabled={
								disabled ||
								creating ||
								!!creationError ||
								!objective.trim() ||
								(reviewEnabled && !successCriteria.trim())
							}
							title={creationError}
						>
							{creating ? <RefreshCw className="spin" size={15} /> : <CalendarClock size={15} />}
							{creating ? "正在保存..." : editing ? "保存修改" : "创建自动化"}
						</button>
						<SchedulePreview schedule={draftSchedule} />
						{creationError && (
							<div className="workbench-error" role="alert">
								{creationError}
							</div>
						)}
						{formError && (
							<div className="workbench-error">
								<CircleAlert size={14} />
								{formError}
							</div>
						)}
					</form>
				)}
				{archived && (
					<div className="goal-readonly">
						<Archive size={14} />
						已归档会话为只读状态，自动化不会定时触发
					</div>
				)}
				<nav className="subagent-list" aria-label="自动化列表">
					{automations.map((automation) => (
						<button
							className={`subagent-entry ${selected?.id === automation.id ? "selected" : ""}`}
							type="button"
							key={automation.id}
							onClick={() => setSelectedId(automation.id)}
						>
							<i className={`subagent-status automation-status status-${automation.status}`} />
							<span>
								<strong>{automation.title}</strong>
								<small>
									{AUTOMATION_STATUS_LABELS[automation.status]} ·{" "}
									{automation.nextRunAt === undefined ? "无下次运行" : formatAutomationTime(automation.nextRunAt)}
								</small>
							</span>
						</button>
					))}
					{automations.length === 0 && <div className="subagent-list-empty">暂无自动化</div>}
				</nav>
			</aside>
			<div className="subagent-detail">
				{selected ? (
					<>
						<header className="subagent-detail-heading">
							<div>
								<CalendarClock size={16} />
								<span>
									<strong>{selected.title}</strong>
									<small>{selected.id}</small>
								</span>
							</div>
							<div className="goal-actions automation-actions">
								<button
									className="subagent-secondary-action"
									disabled={disabled || !!action || creating}
									onClick={() => beginEdit(selected)}
								>
									编辑
								</button>
								<button
									className="subagent-secondary-action"
									disabled={disabled || !!action || hasActiveRuns}
									onClick={() => setConfirmDelete(selected.id)}
								>
									删除
								</button>
								{selected.status !== "completed" && (
									<button
										className="subagent-secondary-action"
										type="button"
										title={selected.status === "active" ? "暂停自动化" : "恢复自动化"}
										disabled={disabled || action !== undefined}
										onClick={() => void act(selected, "toggle")}
									>
										{action?.automationId === selected.id && action.kind === "toggle" ? (
											<RefreshCw className="spin" size={13} />
										) : selected.status === "active" ? (
											<Pause size={13} />
										) : (
											<Power size={13} />
										)}
										{selected.status === "active" ? "暂停" : "恢复"}
									</button>
								)}
								<button
									className="goal-start"
									type="button"
									title="立即运行"
									disabled={disabled || action !== undefined}
									onClick={() => void act(selected, "trigger")}
								>
									{action?.automationId === selected.id && action.kind === "trigger" ? (
										<RefreshCw className="spin" size={13} />
									) : (
										<Play size={13} />
									)}
									立即运行
								</button>
							</div>
						</header>
						<div className="subagent-detail-scroll">
							<div className="subagent-meta">
								<span className={`subagent-status-label automation-status status-${selected.status}`}>
									<i />
									{AUTOMATION_STATUS_LABELS[selected.status]}
								</span>
								<span>{scheduleLabel(selected.schedule)}</span>
								{selected.nextRunAt !== undefined && <span>下次 {formatAutomationTime(selected.nextRunAt)}</span>}
								{selected.lastRunAt !== undefined && <span>上次 {formatAutomationTime(selected.lastRunAt)}</span>}
							</div>
							{confirmDelete === selected.id && (
								<div className="workbench-error" role="alert">
									<span>删除任务及运行记录？历史会话仍保留，此操作不可撤销。</span>
									<button disabled={!!action} onClick={() => void act(selected, "delete")}>
										确认删除
									</button>
									<button onClick={() => setConfirmDelete(undefined)}>取消</button>
								</div>
							)}
							{actionError && (
								<div className="workbench-error">
									<CircleAlert size={14} />
									{actionError}
								</div>
							)}
							<section className="subagent-section">
								<h2>目标</h2>
								<p>{selected.objective}</p>
							</section>
							<section className="subagent-section automation-schedule">
								<h2>日程</h2>
								<p>{automationScheduleLabel(selected.schedule)}</p>
								{selected.status === "active" && <SchedulePreview schedule={selected.schedule} />}
							</section>
							{selected.plan && (
								<section className="subagent-section">
									<h2>计划步骤</h2>
									<ol>
										{selected.plan.steps.map((step) => (
											<li key={step.id}>
												<strong>{step.title}</strong>
												<p>{step.objective}</p>
												{step.dependsOn.length > 0 && (
													<p>
														依赖：
														{step.dependsOn
															.map((id) => selected.plan!.steps.find((candidate) => candidate.id === id)?.title ?? id)
															.join("、")}
													</p>
												)}
											</li>
										))}
									</ol>
								</section>
							)}
							{selected.successCriteria && (
								<section className="subagent-section">
									<h2>成功标准</h2>
									<p>{selected.successCriteria}</p>
									<small className="automation-review-limit">最多 {selected.maxRounds} 轮评审</small>
								</section>
							)}
							<section className="subagent-section automation-runs-section">
								<div className="automation-section-heading">
									<h2>运行历史</h2>
									<button
										className="icon-button"
										type="button"
										title="刷新运行历史"
										disabled={runsLoading}
										onClick={() => void loadRuns(selected.id)}
									>
										<RefreshCw className={runsLoading ? "spin" : ""} size={14} />
									</button>
								</div>
								{runs.length > 0 ? (
									<ol className="automation-run-list">
										{runs.map((run) => (
											<li className={`automation-run status-${run.status}`} key={run.id}>
												<div className="automation-run-heading">
													<span className={`subagent-status-label status-${run.status}`}>
														<i />
														{statusLabel(run.status)}
													</span>
													<strong>{run.trigger === "manual" ? "手动触发" : "定时触发"}</strong>
													<small>{formatAutomationTime(run.triggeredAt)}</small>
												</div>
												<div className="automation-run-meta">
													<span>{formatTokens(run.usage.totalTokens)} Token</span>
													<span>{formatMoney(run.usage.costUsd)}</span>
													{run.finishedAt !== undefined && (
														<span>{formatDuration(run.triggeredAt, run.finishedAt)}</span>
													)}
												</div>
												{run.plan && <GoalPlanView plan={run.plan} onOpenSession={onOpenSession} />}
												{(run.pendingApprovals ?? []).map((approval) => (
													<ApprovalPanel
														key={approval.id}
														approval={approval}
														onRespond={async (decision) => {
															await onRespondApproval(approval.sessionId, approval.id, decision);
															await loadRuns(selected.id, true);
														}}
													/>
												))}
												{run.result !== undefined && <pre>{run.result || "运行已完成，但没有文本结果。"}</pre>}
												{run.error && (
													<div className="subagent-error">
														<CircleAlert size={14} />
														<span>{run.error}</span>
													</div>
												)}
												{run.runSessionId && (
													<button
														className="automation-open-run"
														type="button"
														onClick={() => void onOpenSession(run.runSessionId!)}
													>
														<MessageSquareCode size={13} />
														打开运行会话
													</button>
												)}
											</li>
										))}
									</ol>
								) : (
									<p className="goal-review-empty">{runsLoading ? "正在读取运行记录..." : "暂无运行记录。"}</p>
								)}
							</section>
						</div>
					</>
				) : (
					<div className="workbench-empty">
						<CalendarClock size={24} />
						<span>新建一个自动化</span>
					</div>
				)}
			</div>
		</section>
	);
}

const EMPTY_USAGE: Usage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
};

function aggregateDailyUsage(entries: UsageOverview["daily"]): {
	usage: Usage;
	turnCount: number;
	requestCount: number;
} {
	return entries.reduce(
		(total, entry) => ({
			usage: {
				inputTokens: total.usage.inputTokens + entry.usage.inputTokens,
				outputTokens: total.usage.outputTokens + entry.usage.outputTokens,
				cacheReadTokens: total.usage.cacheReadTokens + entry.usage.cacheReadTokens,
				cacheWriteTokens: total.usage.cacheWriteTokens + entry.usage.cacheWriteTokens,
				totalTokens: total.usage.totalTokens + entry.usage.totalTokens,
				costUsd: total.usage.costUsd + entry.usage.costUsd,
			},
			turnCount: total.turnCount + entry.turnCount,
			requestCount: total.requestCount + entry.requestCount,
		}),
		{ usage: { ...EMPTY_USAGE }, turnCount: 0, requestCount: 0 }
	);
}

function UsageSettings({
	overview,
	snapshot,
	workspaces,
	models,
	onRefresh,
}: {
	overview: UsageOverview | undefined;
	snapshot: SessionSnapshot | undefined;
	workspaces: WorkspaceSummary[];
	models: ModelMetadata[];
	onRefresh: (workspaceId: string | undefined, days: UsageRange) => Promise<UsageOverview | undefined>;
}) {
	const { locale, t } = useLocale();
	const [range, setRange] = useState<UsageRange>(7);
	const [scope, setScope] = useState("");
	const workspaceId = scope || undefined;
	const [data, setData] = useState<UsageOverview>();
	const [refreshKey, setRefreshKey] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const session = !workspaceId || snapshot?.session.workspaceId === workspaceId ? snapshot : undefined;

	useEffect(() => {
		if (scope && !workspaces.some((workspace) => workspace.id === scope)) setScope("");
	}, [scope, workspaces]);

	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(undefined);
		setData((current) =>
			current?.workspaceId === workspaceId && current?.daily.length === range ? current : undefined
		);
		void onRefresh(workspaceId, range)
			.then((next) => {
				if (!next) throw new Error(t("usageLoadFailed"));
				if (active) setData(next);
			})
			.catch((cause: unknown) => {
				if (active) setError(cause instanceof Error ? cause.message : t("usageLoadFailed"));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [workspaceId, range, onRefresh, overview?.generatedAt, refreshKey, t]);

	const selectRange = (nextRange: UsageRange) => {
		setRange(nextRange);
	};
	const period = useMemo(() => aggregateDailyUsage(data?.daily ?? []), [data?.daily]);
	const maxDailyTokens = Math.max(1, ...(data?.daily.map((entry) => entry.usage.totalTokens) ?? []));
	const tokenParts = [
		{ key: "input", label: t("usageInput"), value: period.usage.inputTokens },
		{ key: "output", label: t("usageOutput"), value: period.usage.outputTokens },
		{ key: "cache-read", label: t("usageCacheRead"), value: period.usage.cacheReadTokens },
		{ key: "cache-write", label: t("usageCacheWrite"), value: period.usage.cacheWriteTokens },
	];
	const tokenPartTotal = Math.max(
		1,
		tokenParts.reduce((total, part) => total + part.value, 0)
	);
	const modelRows = [...(session?.usageByModel ?? [])].sort(
		(left, right) => right.usage.totalTokens - left.usage.totalTokens
	);
	const maxModelTokens = Math.max(1, ...modelRows.map((entry) => entry.usage.totalTokens));
	const toolRows = [...(session?.usageByTool ?? [])]
		.sort((left, right) => right.callCount - left.callCount || right.usage.totalTokens - left.usage.totalTokens)
		.slice(0, 8);
	const modelLabel = (model: ModelRef) =>
		models.find((entry) => entry.model.provider === model.provider && entry.model.id === model.id)?.name ?? model.id;
	const updatedAt = data
		? new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			}).format(data.generatedAt)
		: undefined;
	const todayEntry = data?.daily.at(-1);
	const metrics = [
		{
			label: t("usageToday"),
			usage: data?.today,
			meta: todayEntry
				? t("usageRequestsTurns", { requests: todayEntry.requestCount, turns: todayEntry.turnCount })
				: "",
		},
		{
			label: t("usagePeriod", { days: range }),
			usage: data ? period.usage : undefined,
			meta: data ? t("usageRequestsTurns", { requests: period.requestCount, turns: period.turnCount }) : "",
		},
		{
			label: t("usageMonth"),
			usage: data?.month,
			meta: t("usageCalendarMonth"),
		},
		{
			label: t(workspaceId ? "usageWorkspaceAllTime" : "usageAllTime"),
			usage: data?.total,
			meta: data ? t("usageRequestsTurns", { requests: data.totalRequestCount, turns: data.totalTurnCount }) : "",
		},
	];

	return (
		<div className="usage-settings">
			<div className="usage-settings-toolbar">
				<div>
					<label htmlFor="usage-workspace-scope">{t("usageWorkspace")}</label>
					<select id="usage-workspace-scope" value={scope} onChange={(event) => setScope(event.target.value)}>
						<option value="">{t("usageAllWorkspaces")}</option>
						{workspaces.map((workspace) => (
							<option key={workspace.id} value={workspace.id}>
								{workspaceName(workspace.name)}
							</option>
						))}
					</select>
				</div>
				<div className="usage-settings-actions">
					<div className="usage-range-control" role="group" aria-label={t("usageRange")}>
						{([7, 14, 30] as const).map((days) => (
							<button
								key={days}
								type="button"
								aria-pressed={range === days}
								disabled={loading}
								onClick={() => selectRange(days)}
							>
								{t("usageLastDays", { days })}
							</button>
						))}
					</div>
					<button
						className="usage-refresh-button"
						type="button"
						title={t("usageRefresh")}
						aria-label={t("usageRefresh")}
						disabled={loading}
						onClick={() => setRefreshKey((key) => key + 1)}
					>
						<RefreshCw className={loading ? "spin" : ""} size={15} />
					</button>
				</div>
			</div>

			{error && <div className="usage-settings-error">{error}</div>}
			<div className="usage-metric-grid">
				{metrics.map((metric) => (
					<div className="usage-metric-card" key={metric.label}>
						<span>{metric.label}</span>
						<strong>{metric.usage ? formatTokens(metric.usage.totalTokens) : "--"}</strong>
						<div>
							<b>{metric.usage ? formatMoney(metric.usage.costUsd) : t("usageLoading")}</b>
							<small>{metric.meta}</small>
						</div>
					</div>
				))}
			</div>

			<section className="usage-settings-section usage-settings-trend-section">
				<div className="usage-settings-section-heading">
					<div>
						<h4>{t("usageTrend")}</h4>
						<p>{t("usageTrendHint", { days: range })}</p>
					</div>
					{updatedAt && (
						<time dateTime={new Date(data!.generatedAt).toISOString()}>{t("usageUpdatedAt", { time: updatedAt })}</time>
					)}
				</div>
				{data ? (
					<div
						className="usage-settings-chart"
						role="img"
						aria-label={t("usageTrendAria", { days: range })}
						style={{ "--usage-day-count": data.daily.length } as CSSProperties}
					>
						{data.daily.map((entry, index) => {
							const tickStep = range === 7 ? 1 : range === 14 ? 2 : 5;
							const showTick = index === 0 || index === data.daily.length - 1 || index % tickStep === 0;
							return (
								<div
									className="usage-settings-day"
									key={entry.date}
									title={`${entry.date} · ${formatTokens(entry.usage.totalTokens)} Token · ${formatMoney(entry.usage.costUsd)}`}
								>
									<div className="usage-settings-bar-track">
										<span
											style={
												{
													"--usage-bar-height": `${Math.max(entry.usage.totalTokens > 0 ? 5 : 2, Math.round((entry.usage.totalTokens / maxDailyTokens) * 100))}%`,
												} as CSSProperties
											}
										/>
									</div>
									<small className={showTick ? "" : "usage-tick-hidden"}>
										{index === data.daily.length - 1 ? t("usageToday") : entry.date.slice(5).replace("-", "/")}
									</small>
								</div>
							);
						})}
					</div>
				) : (
					<div className="usage-settings-placeholder">{t("usageLoading")}</div>
				)}
			</section>

			<div className="usage-settings-detail-grid">
				<section className="usage-settings-section">
					<div className="usage-settings-section-heading">
						<div>
							<h4>{t("usageComposition")}</h4>
							<p>{t("usageCompositionHint", { days: range })}</p>
						</div>
					</div>
					<div className="usage-composition-list">
						{tokenParts.map((part) => (
							<div className={`usage-composition-row usage-composition-${part.key}`} key={part.key}>
								<div>
									<span>{part.label}</span>
									<strong>{formatTokens(part.value)}</strong>
								</div>
								<div className="usage-composition-track">
									<span style={{ "--usage-share": `${(part.value / tokenPartTotal) * 100}%` } as CSSProperties} />
								</div>
							</div>
						))}
					</div>
				</section>

				<section className="usage-settings-section">
					<div className="usage-settings-section-heading">
						<div>
							<h4>{t("usageSessionModels")}</h4>
							<p>
								{session
									? t("usageCurrentSessionSummary", {
											tokens: formatTokens(session.usage.totalTokens),
											cost: formatMoney(session.usage.costUsd),
										})
									: t("usageNoActiveSession")}
							</p>
						</div>
					</div>
					{modelRows.length > 0 ? (
						<div className="usage-model-list">
							{modelRows.map((entry) => (
								<div className="usage-model-row" key={`${entry.model.provider}:${entry.model.id}`}>
									<div>
										<strong>{modelLabel(entry.model)}</strong>
										<small>{entry.model.provider}</small>
									</div>
									<span>{formatTokens(entry.usage.totalTokens)}</span>
									<small>{t("usageModelTurns", { count: entry.turnCount })}</small>
									<div className="usage-model-track">
										<span
											style={
												{ "--usage-share": `${(entry.usage.totalTokens / maxModelTokens) * 100}%` } as CSSProperties
											}
										/>
									</div>
								</div>
							))}
						</div>
					) : (
						<div className="usage-settings-placeholder compact">{t("usageNoModelData")}</div>
					)}
				</section>
			</div>

			<section className="usage-settings-section usage-tools-section">
				<div className="usage-settings-section-heading">
					<div>
						<h4>{t("usageSessionTools")}</h4>
						<p>{t("usageSessionToolsHint")}</p>
					</div>
				</div>
				{toolRows.length > 0 ? (
					<div className="usage-tool-list">
						{toolRows.map((tool) => (
							<div className="usage-tool-row" key={`${tool.mcpServerId ?? "builtin"}:${tool.toolName}`}>
								<div>
									<strong>{formatToolName(tool)}</strong>
									<small>{tool.mcpServerId ? "MCP" : t("usageBuiltInTool")}</small>
								</div>
								<span>{t("usageToolCalls", { count: tool.callCount })}</span>
								<span>{tool.durationMs === undefined ? "--" : formatDelay(tool.durationMs)}</span>
								<span>{formatMoney(tool.usage.costUsd)}</span>
							</div>
						))}
					</div>
				) : (
					<div className="usage-settings-placeholder compact">{t("usageNoToolData")}</div>
				)}
			</section>
		</div>
	);
}

function BudgetEditor({
	snapshot,
	overview,
	onSave,
}: {
	snapshot: SessionSnapshot;
	overview: UsageOverview | undefined;
	onSave: (budget: {
		costBudgetUsd?: number | null;
		tokenBudget?: number | null;
		budgetWarningThreshold?: number;
	}) => Promise<void>;
}) {
	const t = useT();
	const [editing, setEditing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const [costDraft, setCostDraft] = useState(snapshot.costBudgetUsd?.toString() ?? "");
	const [tokenDraft, setTokenDraft] = useState(snapshot.tokenBudget?.toString() ?? "");
	const [thresholdDraft, setThresholdDraft] = useState(
		String(Math.round((snapshot.budgetWarningThreshold ?? 0.8) * 100))
	);

	useEffect(() => {
		setCostDraft(snapshot.costBudgetUsd?.toString() ?? "");
		setTokenDraft(snapshot.tokenBudget?.toString() ?? "");
		setThresholdDraft(String(Math.round((snapshot.budgetWarningThreshold ?? 0.8) * 100)));
	}, [snapshot.session.id, snapshot.costBudgetUsd, snapshot.tokenBudget, snapshot.budgetWarningThreshold]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const cost = costDraft.trim() === "" ? null : Number(costDraft);
		const tokens = tokenDraft.trim() === "" ? null : Number(tokenDraft);
		const threshold = Number(thresholdDraft);
		if (cost !== null && (!Number.isFinite(cost) || cost <= 0)) return setError(t("costLimitInvalid"));
		if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0)) return setError(t("tokenLimitInvalid"));
		if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) return setError(t("warningThresholdInvalid"));
		setSaving(true);
		setError(undefined);
		try {
			await onSave({
				costBudgetUsd: cost,
				tokenBudget: tokens,
				budgetWarningThreshold: threshold / 100,
			});
			setEditing(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	const canEdit = snapshot.session.phase === "idle" && snapshot.session.archivedAt === undefined;
	const maxDailyTokens = Math.max(1, ...(overview?.daily.map((entry) => entry.usage.totalTokens) ?? []));
	return (
		<>
			<div className="rail-section-heading">
				<h2>{t("usage")}</h2>
				{!editing && (
					<button
						className="rail-icon-button"
						type="button"
						title={t("editBudget")}
						disabled={!canEdit}
						onClick={() => {
							setError(undefined);
							setEditing(true);
						}}
					>
						<Pencil size={13} />
					</button>
				)}
			</div>
			<div className="usage-periods">
				<div>
					<span>{t("usageToday")}</span>
					<strong>{overview ? formatTokens(overview.today.totalTokens) : "--"}</strong>
					<small>{overview ? formatMoney(overview.today.costUsd) : t("usageLoading")}</small>
				</div>
				<div>
					<span>{t("usageMonth")}</span>
					<strong>{overview ? formatTokens(overview.month.totalTokens) : "--"}</strong>
					<small>{overview ? formatMoney(overview.month.costUsd) : t("usageLoading")}</small>
				</div>
			</div>
			{overview && (
				<div className="usage-trend">
					<div className="usage-trend-heading">
						<span>{t("usageWeek")}</span>
						<span>Token</span>
					</div>
					<div className="usage-chart" role="img" aria-label={t("usageWeekAria")}>
						{overview.daily.map((entry, index) => (
							<div
								className="usage-day"
								key={entry.date}
								title={`${entry.date} · ${formatTokens(entry.usage.totalTokens)} Token · ${formatMoney(entry.usage.costUsd)}`}
							>
								<div className="usage-bar-track">
									<span
										style={
											{
												"--usage-bar": `${Math.max(entry.usage.totalTokens > 0 ? 5 : 2, Math.round((entry.usage.totalTokens / maxDailyTokens) * 100))}%`,
											} as CSSProperties
										}
									/>
								</div>
								<small>
									{index === overview.daily.length - 1 ? t("usageToday") : entry.date.slice(5).replace("-", "/")}
								</small>
							</div>
						))}
					</div>
				</div>
			)}
			<div className="usage-session">
				<span>{t("thisSession")}</span>
				<strong>
					{formatTokens(snapshot.usage.totalTokens)} <small>· {formatMoney(snapshot.usage.costUsd)}</small>
				</strong>
			</div>
			{snapshot.costBudgetUsd !== undefined && (
				<div className="kv">
					<span>{t("remainingCost")}</span>
					<strong>{formatMoney(Math.max(0, snapshot.costBudgetUsd - snapshot.usage.costUsd))}</strong>
				</div>
			)}
			{snapshot.tokenBudget !== undefined && (
				<div className="kv">
					<span>{t("remainingTokens")}</span>
					<strong>{formatTokens(Math.max(0, snapshot.tokenBudget - snapshot.usage.totalTokens))}</strong>
				</div>
			)}
			{((snapshot.costBudgetUsd !== undefined &&
				snapshot.usage.costUsd / snapshot.costBudgetUsd >= (snapshot.budgetWarningThreshold ?? 0.8)) ||
				(snapshot.tokenBudget !== undefined &&
					snapshot.usage.totalTokens / snapshot.tokenBudget >= (snapshot.budgetWarningThreshold ?? 0.8))) && (
				<div className="budget-warning">
					<CircleAlert size={13} />
					{t("usageWarning")}
				</div>
			)}
			{snapshot.budgetWarnings?.map((warning) => (
				<div className="budget-warning" key={warning.id}>
					<CircleAlert size={13} />
					{t("usageExceeded", {
						kind: warning.kind === "tokens" ? "Token" : t("cost"),
						percent: Math.round(warning.threshold * 100),
					})}
				</div>
			))}
			{editing && (
				<form className="budget-form" onSubmit={(event) => void submit(event)}>
					<label>
						<span>{t("costLimit")}</span>
						<input
							type="number"
							min="0.0001"
							step="0.0001"
							placeholder={t("unlimited")}
							value={costDraft}
							onChange={(event) => setCostDraft(event.target.value)}
						/>
					</label>
					<label>
						<span>{t("tokenLimit")}</span>
						<input
							type="number"
							min="1"
							step="1"
							placeholder={t("unlimited")}
							value={tokenDraft}
							onChange={(event) => setTokenDraft(event.target.value)}
						/>
					</label>
					<label>
						<span>{t("warningThreshold")}</span>
						<div className="budget-percent">
							<input
								type="number"
								min="1"
								max="100"
								step="1"
								value={thresholdDraft}
								onChange={(event) => setThresholdDraft(event.target.value)}
							/>
							<span>%</span>
						</div>
					</label>
					{error && <div className="budget-form-error">{error}</div>}
					<div className="budget-form-actions">
						<button type="button" title={t("cancelChanges")} disabled={saving} onClick={() => setEditing(false)}>
							<X size={14} />
						</button>
						<button type="submit" title={t("saveBudget")} disabled={saving}>
							<Check size={14} />
						</button>
					</div>
				</form>
			)}
		</>
	);
}

function RightRail({
	snapshot,
	usageOverview,
	runs,
	memories,
	contextUsage,
	onSetBudget,
	onManageMemory,
	onOpenEvaluation,
	onClose,
}: {
	snapshot: SessionSnapshot | undefined;
	usageOverview: UsageOverview | undefined;
	runs: RunSummary[];
	memories: MemoryRecord[];
	contextUsage: ContextUsage | undefined;
	onSetBudget: (budget: {
		costBudgetUsd?: number | null;
		tokenBudget?: number | null;
		budgetWarningThreshold?: number;
	}) => Promise<void>;
	onManageMemory: (memoryId: string, action: MemoryAction) => Promise<unknown>;
	onOpenEvaluation: (run: RunSummary) => void;
	onClose: () => void;
}) {
	const t = useT();
	const [memoryBusy, setMemoryBusy] = useState<string>();
	const memoryDisabled = !snapshot || snapshot.session.archivedAt !== undefined || snapshot.session.phase !== "idle";
	const manageMemory = async (memoryId: string, action: MemoryAction) => {
		setMemoryBusy(memoryId);
		try {
			await onManageMemory(memoryId, action);
		} finally {
			setMemoryBusy(undefined);
		}
	};
	return (
		<aside className="right-rail">
			{snapshot && <RunDiagnostics snapshot={snapshot} runs={runs} />}
			<div className="rail-section">
				<div className="rail-section-heading">
					<h2>{t("run")}</h2>
					<button
						className="rail-icon-button rail-mobile-close"
						type="button"
						title={t("closeRunPanel")}
						onClick={onClose}
					>
						<X size={14} />
					</button>
				</div>
				<div className="kv">
					<span>{t("status")}</span>
					<strong className={`phase phase-${snapshot?.session.phase ?? "idle"}`}>
						{statusLabel(snapshot?.session.phase ?? "idle", t)}
					</strong>
				</div>
				<div className="kv">
					<span>{t("sandbox")}</span>
					<strong>{sandboxLabel(snapshot?.sandboxMode, t)}</strong>
				</div>
				<div className="kv">
					<span>{t("approvalPolicy")}</span>
					<strong>{approvalPolicyLabel(snapshot?.approvalPolicy, t)}</strong>
				</div>
				<div className="kv">
					<span>{t("steerQueue")}</span>
					<strong>{snapshot?.queuedSteerCount ?? 0}</strong>
				</div>
				<div className="kv">
					<span>{t("followUpQueue")}</span>
					<strong>{snapshot?.queuedFollowUpCount ?? 0}</strong>
				</div>
			</div>
			<div className="rail-section">
				{contextUsage && <ContextMeter usage={contextUsage} />}
				{snapshot ? (
					<BudgetEditor snapshot={snapshot} overview={usageOverview} onSave={onSetBudget} />
				) : (
					<>
						<h2>{t("usage")}</h2>
						<div className="run-empty">{t("noSession")}</div>
					</>
				)}
			</div>
			<div className="rail-section">
				<h2>{t("recentRuns")}</h2>
				<div className="run-history">
					{runs.length === 0 && <div className="run-empty">{t("noRuns")}</div>}
					{runs.slice(0, 3).map((run) => (
						<div className="run-row" key={run.id} title={run.error}>
							<div className="run-row-heading">
								<span className={`run-dot run-${run.status}`} />
								<strong>
									{run.mode === "prompt" ? t("prompt") : run.mode === "steer" ? t("steer") : t("followUp")}
								</strong>
								<div className="run-row-actions">
									<span>{statusLabel(run.status, t)}</span>
									<RunDiagnosticButton run={run} onOpen={onOpenEvaluation} />
								</div>
							</div>
							<div className="run-meta">
								<span>{formatRunTime(run.createdAt)}</span>
								<span>{formatRunDuration(run, t)}</span>
								{run.attempt > 1 && <span>{t("attemptCount", { count: run.attempt })}</span>}
								{run.retryHistory && run.retryHistory.length > 0 && (
									<span>{t("retryCount", { count: run.retryHistory.length })}</span>
								)}
								{run.usage && (
									<span>
										{formatTokens(run.usage.totalTokens)} · {formatMoney(run.usage.costUsd)}
									</span>
								)}
								{run.model && (
									<span>
										{run.model.provider}/{run.model.id}
									</span>
								)}
								{run.tools && run.tools.length > 0 && (
									<span>{run.tools.map((tool) => formatToolObservation(tool, t)).join("; ")}</span>
								)}
								{run.traceId && <span title={run.traceId}>Trace {run.traceId.slice(0, 8)}</span>}
								{run.failureKind && <span>{failureKindLabel(run.failureKind, t)}</span>}
								{run.capabilityPlan && (
									<span title={run.capabilityPlan.digest}>
										{t("capabilityCount", { count: run.capabilityPlan.capabilityCount })}
									</span>
								)}
								{run.contextPlan && (
									<span title={run.contextPlan.digest}>
										{t("contextPlanSummary", {
											used: formatTokens(run.contextPlan.estimatedSystemTokens),
											total: formatTokens(run.contextPlan.availableSystemTokens),
											count: run.contextPlan.fragmentCount,
										})}
									</span>
								)}
								{run.hookEvents && run.hookEvents.length > 0 && <span>Hook {run.hookEvents.length}</span>}
								{run.trajectory && (
									<span title={t("structuralEvaluationHint")}>
										{t("trajectorySummary", {
											score: run.trajectory.evaluation.score,
											count: run.trajectory.eventCount,
										})}
									</span>
								)}
								{run.memoryCount && (
									<span title={t("runMemoryHint")}>{t("memoryCount", { count: run.memoryCount })}</span>
								)}
								{run.abortRequested && <span>{t("stopRequested")}</span>}
							</div>
							{run.error && (
								<div className={`run-error${run.failureKind?.startsWith("provider") ? " run-error-provider" : ""}`}>
									{redactDiagnostic(run.error)}
								</div>
							)}
							{run.retryHistory && run.retryHistory.length > 0 && (
								<details className="run-retries">
									<summary>
										{t("retryAttempt", {
											attempt: run.retryHistory.at(-1)?.attempt ?? 0,
											max: run.retryHistory.at(-1)?.maxAttempts ?? 0,
										})}
									</summary>
									{run.retryHistory.map((retry, index) => (
										<div className="retry-entry" key={`${retry.timestamp}-${index}`}>
											<div>
												<strong>{t("retryAttempt", { attempt: retry.attempt, max: retry.maxAttempts })}</strong>
												<span>
													{formatRunTime(retry.timestamp)} · {t("waitDelay", { delay: formatDelay(retry.delayMs) })}
												</span>
											</div>
											<p>{retry.error}</p>
										</div>
									))}
								</details>
							)}
							{run.hookEvents && run.hookEvents.length > 0 && (
								<details className="run-hooks">
									<summary>{t("hookDetails")}</summary>
									{run.hookEvents.map((event, index) => (
										<div className="hook-entry" key={`${event.hookId}-${event.point}-${event.startedAt}-${index}`}>
											<div>
												<strong>{event.hookId}</strong>
												<span>
													{HOOK_OUTCOME_LABELS[event.outcome] ? t(HOOK_OUTCOME_LABELS[event.outcome]!) : event.outcome}
												</span>
											</div>
											<p>
												{HOOK_POINT_LABELS[event.point] ? t(HOOK_POINT_LABELS[event.point]!) : event.point} ·{" "}
												{event.mode === "enforce" ? t("enforce") : t("observe")} · {formatDelay(event.durationMs)}
												{event.code ? ` · ${event.code}` : ""}
											</p>
										</div>
									))}
								</details>
							)}
							{run.contextPlan && (
								<details className="run-context">
									<summary>
										{t("contextDetails")}
										{run.contextPlan.omittedCount > 0 ? t("omittedCount", { count: run.contextPlan.omittedCount }) : ""}
									</summary>
									{run.contextPlan.fragments.map((fragment) => (
										<div className="context-entry" key={fragment.id}>
											<div>
												<strong>{fragment.id}</strong>
												<span>{formatTokens(fragment.renderedTokens)}</span>
											</div>
											<p>
												{CONTEXT_KIND_LABELS[fragment.kind] ? t(CONTEXT_KIND_LABELS[fragment.kind]!) : fragment.kind} ·{" "}
												{CONTEXT_CACHE_LABELS[fragment.cacheScope]
													? t(CONTEXT_CACHE_LABELS[fragment.cacheScope]!)
													: fragment.cacheScope}{" "}
												· {fragment.source}
												{fragment.truncated ? t("truncatedSuffix") : ""}
											</p>
										</div>
									))}
								</details>
							)}
							{run.trajectory && (
								<details className="run-trajectory">
									<summary>
										{t("structureScore", {
											score: run.trajectory.evaluation.score,
											integrity: t(run.trajectory.integrity ? "chainIntact" : "chainBroken"),
										})}
									</summary>
									<p className="trajectory-note">{t("structureNote")}</p>
									{run.trajectory.evaluation.criteria.map((criterion) => (
										<div className="trajectory-entry" key={criterion.id}>
											<div>
												<strong>
													{TRAJECTORY_CRITERION_LABELS[criterion.id]
														? t(TRAJECTORY_CRITERION_LABELS[criterion.id]!)
														: criterion.id}
												</strong>
												<span>{criterion.score}</span>
											</div>
											<p>{criterion.evidence}</p>
										</div>
									))}
								</details>
							)}
						</div>
					))}
				</div>
			</div>
			<div className="rail-section">
				<h2>{t("sessionMemory")}</h2>
				<div className="memory-history">
					{memories.length === 0 && <div className="run-empty">{t("noMemory")}</div>}
					{memories.slice(0, 5).map((record) => {
						const memory = record.memory;
						return (
							<details className="memory-row" key={memory.id}>
								<summary>
									<span>
										{t(MEMORY_REASON_LABELS[memory.reason])}
										{record.retention === "retained" ? t("retainedSuffix") : ""}
									</span>
									<time>{formatRunTime(memory.createdAt)}</time>
								</summary>
								<div className="memory-meta">
									{memory.tokensBefore !== undefined && (
										<span>
											{formatTokens(memory.tokensBefore)} →{" "}
											{memory.estimatedTokensAfter === undefined
												? t("unknown")
												: formatTokens(memory.estimatedTokensAfter)}
										</span>
									)}
									<span>Revision {memory.source.revision}</span>
								</div>
								<p>{memory.summary}</p>
								<div
									className="memory-source"
									title={`${memory.source.fromItemId ?? "?"} → ${memory.source.throughItemId ?? "?"}`}
								>
									{t("source")} {memory.source.fromItemId?.slice(0, 8) ?? "?"} →{" "}
									{memory.source.throughItemId?.slice(0, 8) ?? "?"}
								</div>
								<div className="memory-actions">
									<button
										type="button"
										aria-pressed={record.retention === "retained"}
										title={record.retention === "retained" ? t("releaseMemory") : t("retainMemory")}
										disabled={memoryDisabled || memoryBusy === memory.id}
										onClick={() =>
											void manageMemory(memory.id, record.retention === "retained" ? "release" : "promote")
										}
									>
										<Pin size={13} fill={record.retention === "retained" ? "currentColor" : "none"} />
									</button>
									<button
										type="button"
										title={t("forgetMemory")}
										disabled={memoryDisabled || memoryBusy === memory.id}
										onClick={() => void manageMemory(memory.id, "forget")}
									>
										<Trash2 size={13} />
									</button>
								</div>
							</details>
						);
					})}
				</div>
			</div>
			<div className="rail-section">
				<h2>{t("workspace")}</h2>
				<div className="rail-item">
					<ShieldCheck size={16} />
					<span>{t("isolatedExecution")}</span>
				</div>
				<div className="rail-item">
					<FileCode2 size={16} />
					<span>{t("transcriptCount", { count: snapshot?.transcript.length ?? 0 })}</span>
				</div>
			</div>
		</aside>
	);
}

function SessionNavigation({
	sessions,
	selectedSessionId,
	workspaceId,
	disabled,
	onBrowse,
	onSelect,
	onRename,
	onArchive,
	onSearch,
	onOpenMatch,
}: {
	sessions: SessionSummary[];
	selectedSessionId?: string;
	workspaceId?: string;
	disabled: boolean;
	onBrowse: (workspaceId: string, options: { query?: string; archived?: boolean }) => Promise<SessionSummary[]>;
	onSelect: (sessionId: string) => void;
	onRename: (sessionId: string, name: string) => Promise<void>;
	onArchive: (sessionId: string, archived: boolean) => Promise<void>;
	onSearch: SearchSessions;
	onOpenMatch: (sessionId: string, messageId: string) => Promise<void>;
}) {
	const t = useT();
	const [archived, setArchived] = useState(false);
	const [renamingId, setRenamingId] = useState<string>();
	const [nameDraft, setNameDraft] = useState("");
	const [busyId, setBusyId] = useState<string>();
	const [browsing, setBrowsing] = useState(false);
	const [error, setError] = useState<string>();

	useEffect(() => {
		if (!workspaceId || disabled) return;
		setArchived(false);
		const timer = setTimeout(() => {
			void onBrowse(workspaceId, { archived: false }).catch((cause) =>
				setError(cause instanceof Error ? cause.message : String(cause))
			);
		}, 180);
		return () => clearTimeout(timer);
	}, [disabled, onBrowse, workspaceId]);

	const switchArchiveView = async (nextArchived: boolean) => {
		if (!workspaceId || browsing) return;
		setBrowsing(true);
		setError(undefined);
		try {
			await onBrowse(workspaceId, { archived: nextArchived });
			setArchived(nextArchived);
			setRenamingId(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBrowsing(false);
		}
	};

	const submitRename = async (event: FormEvent) => {
		event.preventDefault();
		if (!renamingId || !nameDraft.trim()) return;
		setBusyId(renamingId);
		setError(undefined);
		try {
			await onRename(renamingId, nameDraft.trim());
			setRenamingId(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusyId(undefined);
		}
	};

	return (
		<div className="session-browser">
			<SessionSearch
				{...(workspaceId ? { workspaceId } : {})}
				archived={archived}
				disabled={disabled}
				search={onSearch}
				onOpen={onOpenMatch}
			/>
			{archived && (
				<div className="session-view-label">
					<Archive size={12} />
					<span>{t("archivedChats")}</span>
				</div>
			)}
			<nav className="session-nav" aria-label={t("sessions")}>
				{sessions.map((session) => (
					<div className={`session-entry ${selectedSessionId === session.id ? "selected" : ""}`} key={session.id}>
						{!archived && renamingId === session.id ? (
							<form className="session-rename" onSubmit={(event) => void submitRename(event)}>
								<input
									aria-label={t("sessionName")}
									autoFocus
									maxLength={500}
									placeholder={t("sessionTitlePlaceholder")}
									value={nameDraft}
									onChange={(event) => setNameDraft(event.target.value)}
								/>
								<button type="submit" title={t("saveName")} disabled={!nameDraft.trim() || busyId === session.id}>
									<Check size={13} />
								</button>
								<button type="button" title={t("cancelRename")} onClick={() => setRenamingId(undefined)}>
									<X size={13} />
								</button>
							</form>
						) : (
							<>
								<button className="session-open" type="button" onClick={() => onSelect(session.id)}>
									<span>{session.name || t("newChat")}</span>
									{session.phase === "turn" || session.phase === "compaction" || session.phase === "retry" ? (
										<LoaderCircle
											className="session-running spin"
											size={14}
											role="img"
											aria-label={t(STATUS_LABELS[session.phase]!)}
										/>
									) : (
										<i className={`session-phase dot-${session.phase}`} title={t(STATUS_LABELS[session.phase]!)} />
									)}
								</button>
								<div className={`session-actions ${archived ? "restore-only" : ""}`}>
									{archived ? (
										<button
											type="button"
											title={t("restoreChat")}
											aria-label={t("restoreChat")}
											disabled={session.phase !== "idle" || busyId === session.id}
											onClick={() => {
												setBusyId(session.id);
												setError(undefined);
												void onArchive(session.id, false)
													.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
													.finally(() => setBusyId(undefined));
											}}
										>
											<ArchiveRestore size={12} />
										</button>
									) : (
										<>
											<button
												type="button"
												title={t("renameSession")}
												disabled={session.phase !== "idle" || busyId === session.id}
												onClick={() => {
													setRenamingId(session.id);
													setNameDraft(session.name || "");
												}}
											>
												<Pencil size={12} />
											</button>
											<button
												type="button"
												title={t("archiveChat")}
												aria-label={t("archiveChat")}
												disabled={session.phase !== "idle" || busyId === session.id}
												onClick={() => {
													setBusyId(session.id);
													setError(undefined);
													void onArchive(session.id, true)
														.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
														.finally(() => setBusyId(undefined));
												}}
											>
												<Archive size={12} />
											</button>
										</>
									)}
								</div>
							</>
						)}
					</div>
				))}
				{sessions.length === 0 && (
					<div className="session-list-empty">{archived ? t("noArchivedChats") : t("noChats")}</div>
				)}
			</nav>
			<button
				className="session-archive-switch"
				type="button"
				disabled={disabled || browsing || !workspaceId}
				onClick={() => void switchArchiveView(!archived)}
			>
				{browsing ? (
					<RefreshCw className="spin" size={12} />
				) : archived ? (
					<ArrowLeft size={12} />
				) : (
					<Archive size={12} />
				)}
				<span>{archived ? t("backToChats") : t("viewArchivedChats")}</span>
			</button>
			{error && (
				<div className="session-list-error">
					<CircleAlert size={13} />
					{error}
				</div>
			)}
		</div>
	);
}

function ProjectNavigationItem({
	workspace,
	selected,
	expanded,
	disabled,
	removeDisabled,
	openFolderDisabled,
	onToggle,
	onNewSession,
	onRename,
	onRemove,
	onOpenFolder,
	children,
}: {
	workspace: WorkspaceSummary;
	selected: boolean;
	expanded: boolean;
	disabled: boolean;
	removeDisabled: boolean;
	openFolderDisabled: boolean;
	onToggle: () => void;
	onNewSession: () => Promise<void>;
	onRename: (name: string) => Promise<unknown>;
	onRemove: () => Promise<void>;
	onOpenFolder: () => Promise<void>;
	children?: ReactNode;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [nameDraft, setNameDraft] = useState(workspace.name);
	const [removeOpen, setRemoveOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	useEffect(() => {
		if (!menuOpen) return;
		const closeOutside = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
		};
		const closeWithEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenuOpen(false);
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeWithEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeWithEscape);
		};
	}, [menuOpen]);

	const submitRename = async (event: FormEvent) => {
		event.preventDefault();
		if (!nameDraft.trim()) return;
		setBusy(true);
		setError(undefined);
		try {
			await onRename(nameDraft.trim());
			setRenaming(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const runNewSession = async () => {
		setMenuOpen(false);
		setBusy(true);
		setError(undefined);
		try {
			await onNewSession();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const openFolder = async () => {
		setMenuOpen(false);
		setBusy(true);
		setError(undefined);
		try {
			await onOpenFolder();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await onRemove();
			setRemoveOpen(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	};

	return (
		<div ref={rootRef} className={`project-node ${expanded ? "expanded" : ""}`}>
			<div
				className="project-row-wrap"
				onContextMenu={(event) => {
					if (renaming) return;
					event.preventDefault();
					if (!disabled && !busy && !renaming) setMenuOpen(true);
				}}
			>
				{renaming ? (
					<form className="project-rename" onSubmit={(event) => void submitRename(event)}>
						<Folder size={17} />
						<input
							aria-label="项目名称"
							autoFocus
							maxLength={500}
							value={nameDraft}
							onChange={(event) => setNameDraft(event.target.value)}
						/>
						<button type="submit" title="保存名称" disabled={busy || !nameDraft.trim()}>
							<Check size={13} />
						</button>
						<button
							type="button"
							title="取消重命名"
							disabled={busy}
							onClick={() => {
								setRenaming(false);
								setNameDraft(workspace.name);
							}}
						>
							<X size={13} />
						</button>
					</form>
				) : (
					<>
						<button
							className={`project-row ${selected ? "selected" : ""}`}
							type="button"
							aria-expanded={expanded}
							onClick={onToggle}
						>
							{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
							<Folder size={17} />
							<span>{workspaceName(workspace.name)}</span>
						</button>
						<button
							className="project-more"
							type="button"
							aria-label={`${workspaceName(workspace.name)} 项目菜单`}
							aria-expanded={menuOpen}
							title="项目操作"
							disabled={disabled || busy}
							onClick={(event) => {
								event.stopPropagation();
								setMenuOpen((open) => !open);
							}}
						>
							<MoreHorizontal size={16} />
						</button>
					</>
				)}
				{menuOpen && (
					<div className="project-menu" role="menu">
						<button type="button" role="menuitem" onClick={() => void runNewSession()}>
							<Plus size={14} />
							<span>在此项目中新建对话</span>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={busy || openFolderDisabled}
							title={openFolderDisabled ? "仅支持在本地设备上打开项目目录" : undefined}
							onClick={() => void openFolder()}
						>
							<FolderOpen size={14} />
							<span>在资源管理器中打开</span>
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								setMenuOpen(false);
								setNameDraft(workspace.name);
								setRenaming(true);
							}}
						>
							<Pencil size={14} />
							<span>重命名项目</span>
						</button>
						<div className="project-menu-separator" />
						<button
							className="danger"
							type="button"
							role="menuitem"
							disabled={removeDisabled}
							title={removeDisabled ? "请先停止正在运行的会话" : undefined}
							onClick={() => {
								setMenuOpen(false);
								setRemoveOpen(true);
							}}
						>
							<Trash2 size={14} />
							<span>从侧边栏移除</span>
						</button>
					</div>
				)}
			</div>
			{error && (
				<div className="project-action-error">
					<CircleAlert size={13} />
					{error}
				</div>
			)}
			{children}
			{removeOpen && (
				<div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && setRemoveOpen(false)}>
					<div
						className="confirm-dialog"
						role="alertdialog"
						aria-modal="true"
						aria-labelledby={`remove-project-${workspace.id}`}
						onMouseDown={(event) => event.stopPropagation()}
					>
						<div className="confirm-dialog-icon">
							<Trash2 size={18} />
						</div>
						<div>
							<h2 id={`remove-project-${workspace.id}`}>移除“{workspaceName(workspace.name)}”？</h2>
							<p>项目会从侧边栏移除，磁盘上的文件和历史会话不会被删除。</p>
						</div>
						{error && (
							<div className="settings-error" role="alert">
								{error}
							</div>
						)}
						<div className="confirm-dialog-actions">
							<button type="button" disabled={busy} onClick={() => setRemoveOpen(false)}>
								取消
							</button>
							<button className="danger" type="button" disabled={busy} onClick={() => void remove()}>
								{busy ? "正在移除..." : "移除"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export function App() {
	const client = useWumingClient();
	const computer = useComputerUse(
		client.token,
		client.connection === "connected",
		client.executionEnvironment?.placement === "local_device"
	);
	const [workbenchView, setWorkbenchView] = useState<
		| "chat"
		| "automations"
		| "scheduled"
		| "files"
		| "changes"
		| "terminal"
		| "tools"
		| "skills"
		| "mcp"
		| "teams"
		| "subtasks"
	>("chat");
	const [terminalVisited, setTerminalVisited] = useState(false);
	useEffect(() => {
		if (workbenchView === "terminal") setTerminalVisited(true);
	}, [workbenchView]);
	const [childMenuOpen, setChildMenuOpen] = useState(false);
	const [browserOwner, setBrowserOwner] = useState<string>();
	const [browserTarget, setBrowserTarget] = useState<{ owner: string; url: string; sequence: number }>();
	const previewSeen = useRef(new Set<string>());
	const previewOwner = useRef("");
	const [skillManagerOpen, setSkillManagerOpen] = useState(false);
	const [mobileNav, setMobileNav] = useState(false);
	const [newChatBusy, setNewChatBusy] = useState(false);
	const [newChatError, setNewChatError] = useState<string>();
	const newChatPending = useRef(false);
	const focusNewChat = useRef(false);
	const [draftPermission, setDraftPermission] = useState(() => readStoredPermission(localStorage));
	const [draftThinking, setDraftThinking] = useState(() => readStoredThinking(localStorage));
	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		() => localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
	);
	const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
	const [resizingSidebar, setResizingSidebar] = useState(false);
	const [showRight, setShowRight] = useState(() => window.innerWidth > 1080);
	const [onboarding, setOnboarding] = useState(() => localStorage.getItem(ONBOARDING_STORAGE_KEY) !== "true");
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [welcomeComplete, setWelcomeComplete] = useState(false);
	const [desktopUnlocked, setDesktopUnlocked] = useState(
		() => !desktopConnection() || readDesktopWelcome(localStorage)
	);
	const [welcomeError, setWelcomeError] = useState<string>();
	const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
	const [projectDialogOpen, setProjectDialogOpen] = useState(false);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [evaluationRun, setEvaluationRun] = useState<RunSummary>();
	const theme = useTheme();
	const { locale, setLocale, t } = useLocale();
	const [collapsedProjectIds, setCollapsedProjectIds] = useState(() => new Set<string>());
	const [tokenDraft, setTokenDraft] = useState(client.token);
	const [connectSubmitted, setConnectSubmitted] = useState(false);
	const welcomeAttemptStarted = useRef(false);
	useEffect(() => {
		if (client.connection !== "connected" || !desktopUnlocked) return;
		setWelcomeComplete(true);
		setOnboarding(false);
		try {
			localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
		} catch {
			/* Keep the current session usable when storage is unavailable. */
		}
	}, [client.connection, desktopUnlocked]);
	useEffect(() => {
		if (client.connection === "connecting") welcomeAttemptStarted.current = true;
		if (
			!welcomeComplete &&
			connectSubmitted &&
			(client.connection === "error" || (client.connection === "disconnected" && welcomeAttemptStarted.current))
		) {
			setWelcomeError("密码不正确或服务暂时无法连接，请重试。");
		}
	}, [client.connection, connectSubmitted, welcomeComplete]);
	const [composerEdit, setComposerEdit] = useState<ComposerEdit>();
	const [messageBusyId, setMessageBusyId] = useState<string>();
	const [messageError, setMessageError] = useState<{ itemId: string; message: string }>();
	const transcriptRef = useRef<HTMLDivElement>(null);
	// The transcript follows new output only while the reader is at the tail.
	// Scrolling up to re-read something has to survive the next delta.
	const [following, setFollowing] = useState(true);
	const [searchTarget, setSearchTarget] = useState<{ sessionId: string; messageId: string }>();
	const [pendingTail, setPendingTail] = useState(false);
	const seenTailRef = useRef(0);
	const pinnedAtRef = useRef<number | undefined>(undefined);
	const localGateway =
		Boolean(desktopConnection()) || ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
	const onboardingRequiresModel =
		onboarding &&
		client.connection === "connected" &&
		client.capabilities.includes("model.custom") &&
		!client.models.some((model) => model.authenticated);
	const closeSettings = useCallback(() => {
		if (onboarding && (client.connection !== "connected" || onboardingRequiresModel)) return;
		if (onboarding) {
			localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
			setOnboarding(false);
		}
		setSettingsOpen(false);
	}, [client.connection, onboarding, onboardingRequiresModel]);
	const openSettings = useCallback((section: SettingsSection = "general") => {
		setSettingsSection(section);
		setSettingsOpen(true);
	}, []);
	const openUpdates = useCallback(() => {
		setMobileNav(false);
		openSettings("updates");
	}, [openSettings]);
	const desktopUpdates = useDesktopUpdates(openUpdates);
	const toggleSidebar = useCallback(() => {
		setSidebarCollapsed((collapsed) => {
			const next = !collapsed;
			localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
			return next;
		});
	}, []);
	const setAndStoreSidebarWidth = useCallback((width: number) => {
		const next = clampSidebarWidth(width);
		setSidebarWidth(next);
		localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
	}, []);
	const beginSidebarResize = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = sidebarWidth;
			let finalWidth = startWidth;
			setResizingSidebar(true);
			const move = (moveEvent: PointerEvent) => {
				finalWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
				setSidebarWidth(finalWidth);
			};
			const stop = () => {
				localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(finalWidth));
				setResizingSidebar(false);
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", stop);
				window.removeEventListener("pointercancel", stop);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", stop);
			window.addEventListener("pointercancel", stop);
		},
		[sidebarWidth]
	);
	const resizeSidebarWithKeyboard = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			const step = event.shiftKey ? 32 : 8;
			const next =
				event.key === "ArrowLeft"
					? sidebarWidth - step
					: event.key === "ArrowRight"
						? sidebarWidth + step
						: event.key === "Home"
							? MIN_SIDEBAR_WIDTH
							: event.key === "End"
								? MAX_SIDEBAR_WIDTH
								: undefined;
			if (next === undefined) return;
			event.preventDefault();
			setAndStoreSidebarWidth(next);
		},
		[setAndStoreSidebarWidth, sidebarWidth]
	);
	const connectGateway = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const password = tokenDraft.trim();
		if (!password) return;
		setConnectSubmitted(true);
		client.setToken(password);
	};
	const active = ["turn", "awaiting_approval", "compaction", "retry"].includes(
		client.snapshot?.session.phase ?? "idle"
	);
	const selectedWorkspace =
		client.workspaces.find((workspace) => workspace.id === client.selectedWorkspaceId) ?? client.workspaces[0];
	const browserSessionId = client.snapshot?.session.id ?? "workspace";
	const browserWorkspaceId = client.snapshot?.session.workspaceId ?? selectedWorkspace?.id;
	const browserKey = JSON.stringify([browserWorkspaceId, browserSessionId]);
	const browserOpen = browserOwner === browserKey && Boolean(browserWorkspaceId);
	useEffect(() => {
		if (browserOpen && showRight) setBrowserOwner(undefined);
	}, [browserOpen, showRight]);
	useEffect(() => {
		const open = (event: Event) => {
			const url = (event as CustomEvent<{ url: string }>).detail?.url;
			if (!window.wumingDesktop?.browser || typeof url !== "string") return;
			setBrowserOwner(browserKey);
			setShowRight(false);
			setBrowserTarget({ owner: browserKey, url, sequence: Date.now() });
		};
		window.addEventListener(OPEN_BROWSER_EVENT, open);
		const openLocalLink = (event: MouseEvent) => {
			if (
				!window.wumingDesktop?.browser ||
				event.defaultPrevented ||
				event.button !== 0 ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey ||
				event.altKey
			)
				return;
			const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
			if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
			const url = previewUrl("preview_start", { url: anchor.href });
			if (!url) return;
			event.preventDefault();
			open(new CustomEvent(OPEN_BROWSER_EVENT, { detail: { url } }));
		};
		document.addEventListener("click", openLocalLink);
		return () => {
			window.removeEventListener(OPEN_BROWSER_EVENT, open);
			document.removeEventListener("click", openLocalLink);
		};
	}, [browserKey]);
	useEffect(() => {
		if (!window.wumingDesktop?.browser) return;
		const completed = (client.snapshot?.transcript ?? []).flatMap((item) =>
			item.type === "tool" && !item.isError && item.status === "complete" ? [item] : []
		);
		if (previewOwner.current !== browserKey) {
			previewOwner.current = browserKey;
			previewSeen.current = new Set(completed.map((tool) => browserKey + tool.toolCallId));
		}
		for (const tool of [...completed, ...Object.values(client.liveTools)]) {
			const key = browserKey + tool.toolCallId;
			const url = tool.status === "complete" ? previewUrl(tool.toolName, tool.input) : undefined;
			if (!url || previewSeen.current.has(key)) continue;
			previewSeen.current.add(key);
			setBrowserOwner(browserKey);
			setShowRight(false);
			setBrowserTarget({ owner: browserKey, url, sequence: Date.now() });
		}
	}, [client.liveTools, client.snapshot?.transcript, browserKey]);
	useEffect(() => {
		if (client.connection === "connected" && selectedWorkspace && computer.state)
			void client.refreshSkills(selectedWorkspace.id).catch(() => {});
	}, [client.connection, selectedWorkspace?.id, computer.state?.enabled, client.refreshSkills]);
	const implicitWorkspace = useMemo(
		() => client.workspaces.find((workspace) => isImplicitWorkspace(workspace)),
		[client.workspaces]
	);
	const projectWorkspaces = useMemo(
		() => client.workspaces.filter((workspace) => !isImplicitWorkspace(workspace)),
		[client.workspaces]
	);
	const canCreateChat = client.connection === "connected" && !!selectedWorkspace;
	const startNewChat = useCallback(
		async (workspaceId?: string) => {
			if (!canCreateChat || newChatPending.current) return;
			const workspace = resolveNewChatWorkspace(
				client.workspaces,
				client.snapshot?.session.workspaceId ?? client.selectedWorkspaceId,
				workspaceId
			);
			if (!workspace) return;
			if (!client.snapshot && client.selectedWorkspaceId === workspace.id && workbenchView === "chat") {
				client.clearSelectedSkill();
				setMobileNav(false);
				requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
				return;
			}
			newChatPending.current = true;
			setNewChatBusy(true);
			setNewChatError(undefined);
			try {
				await client.beginNewChat(workspace.id);
				client.clearSelectedSkill();
				setDraftPermission(readStoredPermission(localStorage));
				setDraftThinking(readStoredThinking(localStorage));
				setWorkbenchView("chat");
				setMobileNav(false);
				focusNewChat.current = true;
			} catch (error) {
				setNewChatError(error instanceof Error ? error.message : String(error));
			} finally {
				newChatPending.current = false;
				setNewChatBusy(false);
			}
		},
		[canCreateChat, client, workbenchView]
	);
	useEffect(() => {
		if (newChatBusy || !focusNewChat.current || workbenchView !== "chat") return;
		const frame = requestAnimationFrame(() => {
			focusNewChat.current = false;
			document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [newChatBusy, workbenchView, client.snapshot?.session.id]);
	const evaluationArtifacts = useMemo(() => {
		const found = new Map<string, ArtifactRef>();
		for (const item of client.snapshot?.transcript ?? []) {
			if (!("content" in item) || !Array.isArray(item.content)) continue;
			for (const part of item.content) if (part.type === "artifact") found.set(part.artifact.id, part.artifact);
		}
		return [...found.values()];
	}, [client.snapshot?.transcript]);
	const selectedProject = isImplicitWorkspace(selectedWorkspace) ? undefined : selectedWorkspace;
	// Custom models are always usable; built-ins only once the gateway reports
	// working credentials for them.
	const composerModels = client.models.filter((model) => model.custom === true || model.authenticated);
	const selectedModel =
		composerModels.find(
			(model) => model.model.provider === client.selectedModel?.provider && model.model.id === client.selectedModel.id
		) ?? composerModels[0];
	// Context occupancy is judged against the model the session actually runs on,
	// which can differ from the one queued in the composer.
	const sessionModel = client.models.find(
		(model) => model.model.provider === client.snapshot?.model.provider && model.model.id === client.snapshot.model.id
	);
	const contextUsage = estimateContext(client.snapshot, sessionModel?.contextWindow);
	const openConversation = async (sessionId: string, messageId?: string) => {
		setSearchTarget(messageId ? { sessionId, messageId } : undefined);
		try {
			await client.attachSession(sessionId);
			setShowRight(false);
			setWorkbenchView("chat");
			setMobileNav(false);
			setNewChatError(undefined);
			setChildMenuOpen(false);
			return true;
		} catch (error) {
			setNewChatError(error instanceof Error ? error.message : String(error));
			return false;
		}
	};
	const openSearchMatch = async (sessionId: string, messageId: string) => {
		setFollowing(false);
		if (!(await openConversation(sessionId, messageId))) setSearchTarget(undefined);
	};
	useEffect(
		() =>
			window.wumingDesktop?.notifications?.onOpen(({ sessionId }) => {
				void client
					.attachSession(sessionId)
					.then(() => {
						setWorkbenchView("chat");
						setMobileNav(false);
						setSettingsOpen(false);
						setSearchTarget(undefined);
					})
					.catch((error) => setNewChatError(error instanceof Error ? error.message : String(error)));
			}),
		[client.attachSession]
	);
	useLayoutEffect(() => {
		if (!searchTarget || client.snapshot?.session.id !== searchTarget.sessionId || workbenchView !== "chat") return;
		const element = [...(transcriptRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])].find(
			(node) => node.dataset.messageId === searchTarget.messageId
		);
		if (!element) return;
		setFollowing(false);
		element.classList.add("search-target");
		element.scrollIntoView({ block: "center" });
		element.focus({ preventScroll: true });
		return () => element.classList.remove("search-target");
	}, [searchTarget, client.snapshot?.session.id, workbenchView]);

	const openToolSubagent = (toolCallId: string, input: unknown): (() => void) | undefined => {
		const child = findToolSubagent(client.subagents, toolCallId, input);
		return child
			? () => {
					void openConversation(child.sessionId);
				}
			: undefined;
	};
	// The picker drives the session's level, so it follows the session's model and
	// only falls back to the composer's queued model before the first session.
	const thinkingModel = client.snapshot ? (sessionModel ?? selectedModel) : selectedModel;
	const thinkingLevel = thinkingLevelForModel(thinkingModel, client.snapshot?.thinkingLevel ?? draftThinking);
	const transcript = client.snapshot?.transcript;
	const sessionGoals = useMemo(
		() => client.goals.filter((goal) => goal.parentSessionId === client.snapshot?.session.id),
		[client.goals, client.snapshot?.session.id]
	);
	const inlineGoal =
		sessionGoals.find((goal) =>
			["pending", "queued", "running", "awaiting_approval", "cancelling", "paused"].includes(goal.status)
		) ?? sessionGoals[0];
	const inlineGoalSkill = inlineGoal?.skillId
		? client.skills.find((skill) => skill.id === inlineGoal.skillId)
		: undefined;
	const reasoningPhase =
		client.snapshot !== undefined && ["turn", "retry", "compaction"].includes(client.snapshot.session.phase);
	const recovery = activeRecovery(client.snapshot, client.runs, client.liveRetry);
	const liveAssistantItems = Object.values(client.liveAssistants).filter(
		(item) =>
			!transcript?.some((saved) => saved.id === item.id) && (item.thinking.trim() !== "" || item.text.trim() !== "")
	);
	const liveAssistantLength = liveAssistantItems.reduce(
		(length, item) => length + item.thinking.length + item.text.length,
		0
	);
	const liveTrace = [
		...liveAssistantItems.map((item) => ({ kind: "assistant" as const, order: item.order, item })),
		...Object.values(client.liveTools)
			.filter((item) => !transcript?.some((saved) => saved.type === "tool" && saved.toolCallId === item.toolCallId))
			.map((item) => ({
				kind: "tool" as const,
				order: item.order,
				item,
			})),
	].sort((left, right) => left.order - right.order);
	const compactionStatus =
		client.liveCompaction?.sessionId === client.snapshot?.session.id
			? client.liveCompaction?.status
			: client.snapshot?.session.phase === "compaction"
				? "running"
				: undefined;
	const showThinkingActivity =
		reasoningPhase && liveTrace.length === 0 && recovery === undefined && compactionStatus !== "running";
	// A completed call appears in both its assistant request and its own result
	// item. Render the result card once; live calls carry their own input.
	const renderedToolCalls = useMemo(() => {
		const rendered = new Set<string>();
		for (const item of transcript ?? []) {
			if (item.type === "tool") rendered.add(item.toolCallId);
		}
		for (const tool of Object.values(client.liveTools)) rendered.add(tool.toolCallId);
		return rendered;
	}, [transcript, client.liveTools]);

	const traceEntries = [
		...(transcript ?? [])
			.filter((item) => item.type !== "assistant" || item.error || hasVisibleContent(item.content, renderedToolCalls))
			.map((item) => ({ kind: "saved" as const, item })),
		...liveTrace,
	];
	const traceGroups = groupConsecutiveTools(traceEntries, (entry) => {
		const item = entry.item;
		const tool =
			entry.kind === "tool"
				? entry.item
				: entry.kind === "saved" && entry.item.type === "tool"
					? entry.item
					: undefined;
		return {
			key: entry.kind === "tool" ? `tool:${entry.item.toolCallId}` : `message:${"id" in item ? item.id : ""}`,
			...(tool
				? {
						tool: {
							...tool,
							status: client.snapshot?.pendingApprovals.some((approval) => approval.toolCallId === tool.toolCallId)
								? ("awaiting_approval" as const)
								: tool.status,
							artifacts:
								"content" in tool
									? tool.content.flatMap((part) => (part.type === "artifact" ? [part.artifact] : []))
									: tool.artifact
										? [tool.artifact]
										: [],
						},
					}
				: {}),
		};
	});

	// Message-level actions. Both branching actions need an idle, writable,
	// connected session, so they share one gate and one explanation of it.
	const branchDisabled =
		client.connection !== "connected" || active || client.snapshot?.session.archivedAt !== undefined;
	const branchTitle =
		client.snapshot?.session.archivedAt !== undefined
			? "已归档会话为只读状态"
			: client.connection !== "connected"
				? "未连接到网关"
				: active
					? "会话正在运行，结束后可分叉"
					: "";
	const runMessageAction = async (itemId: string, action: () => Promise<void>) => {
		setMessageBusyId(itemId);
		setMessageError(undefined);
		try {
			await action();
			setComposerEdit(undefined);
		} catch (cause) {
			setMessageError({ itemId, message: cause instanceof Error ? cause.message : String(cause) });
		} finally {
			setMessageBusyId(undefined);
		}
	};
	const retryFailedTurn = (item: TranscriptItem) =>
		void runMessageAction(item.id, async () => {
			const items = transcript ?? [];
			const failedIndex = items.findIndex((candidate) => candidate.id === item.id);
			const previousUser = items
				.slice(0, failedIndex < 0 ? items.length : failedIndex)
				.reverse()
				.find((candidate) => candidate.type === "user");
			if (!previousUser || previousUser.type !== "user") throw new Error("找不到可重新执行的上一条请求");
			const artifacts = previousUser.content
				.filter(
					(part): part is Extract<(typeof previousUser.content)[number], { type: "artifact" }> =>
						part.type === "artifact"
				)
				.map((part) => part.artifact);
			jumpToLatest();
			const original = messageText(previousUser.content);
			const text = desktopContinuation(items, item.id)
				? `继续上一条未完成的桌面任务，不要从头重做。先检查当前应用和窗口，结合之前的工具结果，仅执行剩余步骤；结果不明确的点击、输入、提交或启动不能直接重复。原任务：\n${original}`
				: original;
			await client.sendPrompt(text, artifacts);
		});
	const messageActions = (item: TranscriptItem): MessageActionState => ({
		busy: messageBusyId !== undefined,
		branchDisabled,
		branchTitle,
		error: messageError?.itemId === item.id ? messageError.message : undefined,
		onFork: () => void runMessageAction(item.id, () => client.forkSession(item.id)),
		onEditStart: () => {
			if (!client.snapshot) return;
			setMessageError(undefined);
			setComposerEdit({
				sessionId: client.snapshot.session.id,
				itemId: item.id,
				text: messageText(item.content),
				artifacts: item.content.flatMap((part) => (part.type === "artifact" ? [part.artifact] : [])),
			});
		},
	});

	// Only chase the tail while the reader is parked at it: an unconditional
	// scrollIntoView here used to drag the view back down on every streamed delta,
	// which made it impossible to read earlier output during a running turn.
	//
	// The guard cannot rely on the scroll handler alone. Scroll events are
	// delivered at frame time, so with deltas landing every few milliseconds a
	// pin could fire in between and undo the reader's scroll before React ever
	// heard about it. Comparing against the offset this effect last pinned makes
	// the decision synchronous: a scrollTop that no longer matches means the
	// reader moved, and appended content alone never moves it.
	useLayoutEffect(() => {
		const element = transcriptRef.current;
		if (!element || !following) return;
		let detached = false;
		const pin = () => {
			if (detached) return;
			const pinned = pinnedAtRef.current;
			const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
			// Layout shrinkage clamps the offset; only an upward move detaches.
			if (pinned !== undefined && element.scrollTop < Math.min(pinned, maximum) - 1 && !isNearBottom(element)) {
				detached = true;
				setFollowing(false);
				return;
			}
			element.scrollTop = element.scrollHeight;
			pinnedAtRef.current = element.scrollTop;
		};
		// Tool previews and loaded media can grow without new text deltas.
		const resize = new ResizeObserver(pin);
		const observeChildren = () => {
			resize.disconnect();
			resize.observe(element);
			for (const child of element.children) resize.observe(child);
			pin();
		};
		const mutation = new MutationObserver(observeChildren);
		mutation.observe(element, { childList: true });
		observeChildren();
		return () => {
			resize.disconnect();
			mutation.disconnect();
		};
	}, [
		following,
		welcomeComplete,
		workbenchView,
		client.snapshot?.session.id,
		client.snapshot?.transcript.length,
		client.snapshot?.pendingApprovals.length,
		inlineGoal?.updatedAt,
		client.liveRetry,
		liveAssistantLength,
		showThinkingActivity,
	]);

	// How much output the tail holds. Item counts alone would miss a streaming
	// reply, whose deltas grow one live item in place, so the live text counts too.
	const tailSignal = useMemo(() => {
		let signal = transcript?.length ?? 0;
		signal += inlineGoal?.updatedAt ?? 0;
		signal += liveAssistantLength;
		signal += client.snapshot?.pendingApprovals.length ?? 0;
		signal += client.liveRetry ? 1 : 0;
		return signal;
	}, [
		transcript,
		inlineGoal?.updatedAt,
		client.snapshot?.pendingApprovals.length,
		client.liveRetry,
		liveAssistantLength,
	]);

	// Distinguishes "you scrolled up" from "you scrolled up and missed something",
	// so the pill only claims new content when content actually arrived.
	useEffect(() => {
		if (following) {
			seenTailRef.current = tailSignal;
			setPendingTail(false);
			return;
		}
		setPendingTail(tailSignal > seenTailRef.current);
	}, [following, tailSignal]);

	const jumpToLatest = () => {
		const element = transcriptRef.current;
		if (element) {
			element.scrollTop = element.scrollHeight;
			pinnedAtRef.current = element.scrollTop;
		}
		setFollowing(true);
	};

	// Item ids survive a fork, so an open editor would otherwise reappear on the
	// copy of the message in whichever session is attached next.
	useEffect(() => {
		setComposerEdit(undefined);
		setMessageError(undefined);
		setFollowing(searchTarget?.sessionId !== client.snapshot?.session.id);
		pinnedAtRef.current = undefined;
	}, [client.snapshot?.session.id]);

	const sessionId = client.snapshot?.session.id;
	const refreshCurrentAutomations = useCallback(
		() => (sessionId ? client.refreshAutomations(sessionId) : Promise.resolve([])),
		[client.refreshAutomations, sessionId]
	);
	const canCompact = client.capabilities.includes("session.compaction");
	const demoRuntime = client.toolRuntime === "demo";
	// Slash commands act on the shell and the session. They are memoised because
	// the composer resets its highlighted row whenever the list identity changes.
	const composerCommands = useMemo<ComposerCommand[]>(() => {
		const panel = (
			name: string,
			title: string,
			hint: string,
			view:
				"chat" | "automations" | "files" | "changes" | "terminal" | "tools" | "skills" | "mcp" | "teams" | "subtasks",
			icon: ReactNode
		): ComposerCommand => ({
			name,
			title,
			hint,
			kind: "action",
			icon,
			run: () => setWorkbenchView(view),
		});
		const commands: ComposerCommand[] = [
			{
				name: "goal",
				title: "在当前对话中设定目标",
				hint: "目标 goal objective",
				kind: "prompt",
				argumentHint: "<目标>",
				icon: <Target size={14} />,
			},
			{
				name: "new",
				title: "新对话",
				hint: "新建 会话 new session",
				kind: "action",
				icon: <Plus size={14} />,
				run: startNewChat,
			},
			{
				name: "fork",
				title: "从当前会话分叉出副本",
				hint: "分叉 复制 branch",
				kind: "action",
				icon: <GitBranch size={14} />,
				run: () => client.forkSession(),
			},
			{
				name: "rename",
				title: "重命名当前会话",
				hint: "重命名 改名",
				kind: "action",
				argumentHint: "<名称>",
				icon: <Pencil size={14} />,
				run: async (argument) => {
					if (!sessionId) throw new Error(t("noSession"));
					if (!argument) throw new Error("请提供新的会话名称，例如 /rename 需求梳理");
					await client.renameSession(sessionId, argument);
				},
			},
			{
				name: "archive",
				title: "归档当前聊天",
				hint: "归档 结束",
				kind: "action",
				icon: <Archive size={14} />,
				run: async () => {
					if (!sessionId) throw new Error(t("noSession"));
					await client.archiveSession(sessionId, true);
				},
			},
			{
				name: "think",
				title: `思考强度（当前 ${thinkingLabel(thinkingLevel)}）`,
				hint: "思考 推理 thinking",
				kind: "action",
				argumentHint: `<${THINKING_LEVELS.join("|")}>`,
				icon: <BrainCircuit size={14} />,
				run: async (argument) => {
					const level = THINKING_LEVELS.find((candidate) => candidate === argument);
					if (!level) throw new Error(`请提供思考强度：${THINKING_LEVELS.join(" / ")}`);
					await client.setSessionThinking(level);
				},
			},
			...(canCompact
				? [
						{
							name: "compact",
							title: "压缩上下文，可附带保留要求",
							hint: "压缩 精简 compact",
							kind: "action" as const,
							argumentHint: "[保留要求]",
							icon: <Sparkles size={14} />,
							run: (argument: string) => client.compactSession(argument || undefined).then(() => undefined),
						},
					]
				: []),
			panel("files", "打开文件面板", "文件 目录", "files", <Folder size={14} />),
			panel("changes", "打开更改面板", "更改 diff 变更", "changes", <GitCompareArrows size={14} />),
			panel("terminal", "打开终端", "终端 命令行", "terminal", <TerminalSquare size={14} />),
			panel("tools", "查看工具清单", "工具", "tools", <Wrench size={14} />),
			panel("skills", "查看技能", t("contextSkill"), "skills", <BookOpen size={14} />),
			panel("mcp", "查看 MCP 服务", "mcp 服务", "mcp", <Plug size={14} />),
			...(client.snapshot && client.capabilities.includes("subagents")
				? [
						panel("teams", "Agent Teams 协作工作台", "团队 成员 通信 依赖 teams", "teams", <Users size={14} />),
						{
							name: "agents",
							title: "查看子对话",
							hint: "子代理 对话 切换",
							kind: "action" as const,
							icon: <GitBranch size={14} />,
							run: () => setChildMenuOpen(true),
						},
					]
				: []),
			panel("automations", "查看自动化", "自动化 定时 计划", "automations", <CalendarClock size={14} />),
			...(client.capabilities.includes("agent.teams")
				? [
						{
							name: "team",
							title: "启动 Agent Team",
							hint: "团队 协作",
							kind: "prompt" as const,
							argumentHint: "<目标>",
							icon: <Users size={14} />,
						},
					]
				: []),
			panel("chat", "回到对话", "对话 聊天", "chat", <MessageSquareCode size={14} />),
		];
		if (demoRuntime) {
			for (const [name, title] of [
				["demo-rich", "演示：完整工具卡片与富文本"],
				["approval", "演示：触发一次工具批准"],
				["long", "演示：长流式输出"],
				["inject", "演示：注入一条记录"],
				["retry-once", "演示：首次失败后自动重试"],
				["demo-fail", "演示：最终失败与恢复操作"],
			] as const) {
				commands.push({ name, title, hint: "演示 demo", kind: "prompt", icon: <Play size={14} /> });
			}
		}
		return commands;
	}, [canCompact, client, demoRuntime, sessionId, thinkingLevel, startNewChat, t]);

	// The palette is the mouse-and-keyboard twin of the slash registry: the same
	// commands, plus the navigation that has no place in a prompt.
	const paletteEntries = useMemo<PaletteEntry[]>(() => {
		const entries: PaletteEntry[] = composerCommands.map((command) => ({
			id: `command:${command.name}`,
			group: "命令",
			label: `/${command.name}`,
			detail: command.title,
			badge: command.kind === "prompt" ? "发送给运行时" : command.argumentHint ? "需要参数" : undefined,
			icon: command.icon,
			keywords: [command.hint ?? ""],
			argumentHint: command.argumentHint,
			run:
				command.kind === "prompt"
					? () => client.sendPrompt(`/${command.name}`, [], "steer")
					: (argument: string) => command.run?.(argument),
		}));
		for (const item of skillItems(client.skills, "")) {
			entries.push({
				id: item.id,
				group: t("contextSkill"),
				label: item.label,
				detail: item.detail,
				badge: item.badge,
				icon: item.icon,
				keywords: [item.value],
				run: async () => {
					if (!selectedWorkspace) throw new Error("未选择工作区");
					const selected = await client.getSkill(selectedWorkspace.id, item.skillId!);
					if (!selected) return;
					setWorkbenchView("chat");
					requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
				},
			});
		}
		for (const session of client.sessions) {
			if (session.id === sessionId) continue;
			entries.push({
				id: `session:${session.id}`,
				group: t("sessions"),
				label: session.name || DEFAULT_SESSION_TITLE,
				detail: statusLabel(session.phase, t),
				badge: session.archivedAt === undefined ? undefined : "已归档",
				icon: <MessageSquareCode size={14} />,
				keywords: [session.id],
				run: () => client.attachSession(session.id).then(() => undefined),
			});
		}
		if (projectWorkspaces.length > 0) {
			for (const workspace of projectWorkspaces) {
				if (workspace.id === selectedWorkspace?.id) continue;
				entries.push({
					id: `workspace:${workspace.id}`,
					group: t("workspace"),
					label: workspaceName(workspace.name),
					detail: "切换工作区",
					icon: <Folder size={14} />,
					run: () => client.selectWorkspace(workspace.id),
				});
			}
		}
		entries.push(
			{
				id: "shell:sidebar",
				group: "外壳",
				label: sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar"),
				detail: `${modifierLabel()} B`,
				icon: sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />,
				keywords: ["左侧栏 sidebar"],
				run: toggleSidebar,
			},
			{
				id: "shell:rail",
				group: "外壳",
				label: showRight ? "隐藏运行面板" : "显示运行面板",
				detail: `${modifierLabel()} Shift B`,
				icon: <PanelRight size={14} />,
				keywords: ["运行面板 rail"],
				run: () => setShowRight((value) => !value),
			},
			{
				id: "shell:shortcuts",
				group: "外壳",
				label: "查看快捷键",
				detail: `${modifierLabel()} /`,
				icon: <Command size={14} />,
				keywords: ["快捷键 shortcuts"],
				run: () => setShortcutsOpen(true),
			},
			{
				id: "shell:theme",
				group: "外壳",
				label: theme.resolved === "dark" ? "切换到浅色主题" : "切换到深色主题",
				detail: `当前：${themeLabel(theme.choice)}`,
				icon: theme.resolved === "dark" ? <Sun size={14} /> : <MoonStar size={14} />,
				keywords: ["主题 theme 深色 dark 浅色 light"],
				run: () => theme.toggle(),
			},
			{
				id: "shell:theme-system",
				group: "外壳",
				label: "主题跟随系统",
				detail: "由操作系统决定深浅",
				icon: <MoonStar size={14} />,
				keywords: ["主题 theme system 系统"],
				run: () => theme.setChoice("system"),
			},
			{
				id: "shell:settings",
				group: "外壳",
				label: "打开设置",
				detail: "网关连接与模型",
				icon: <Settings size={14} />,
				keywords: ["设置 settings"],
				run: () => openSettings(),
			}
		);
		return entries;
	}, [
		client,
		composerCommands,
		openSettings,
		projectWorkspaces,
		selectedWorkspace?.id,
		sessionId,
		showRight,
		sidebarCollapsed,
		theme,
		toggleSidebar,
		t,
	]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			// A component that already handled the chord marks it, so the composer's
			// own Escape and Enter bindings keep priority over the shell's.
			if (event.defaultPrevented || event.isComposing || typeof event.key !== "string") return;
			const chord = event.metaKey || event.ctrlKey;
			const key = event.key.toLowerCase();
			if (chord && event.altKey && !event.shiftKey && key === "n") {
				event.preventDefault();
				if (
					!event.repeat &&
					!event.isComposing &&
					!settingsOpen &&
					!projectDialogOpen &&
					!skillManagerOpen &&
					!paletteOpen &&
					!shortcutsOpen
				)
					void startNewChat();
				return;
			}
			if (chord && key === "k") {
				event.preventDefault();
				setPaletteOpen((open) => !open);
				return;
			}
			if (chord && key === "b") {
				event.preventDefault();
				if (event.shiftKey) setShowRight((value) => !value);
				else toggleSidebar();
				return;
			}
			if (chord && key === "/") {
				event.preventDefault();
				setShortcutsOpen((open) => !open);
				return;
			}
			if (event.key !== "Escape") return;
			// Overlays unwind from the top; with nothing stacked, Escape is the
			// fastest way to stop a running turn.
			if (projectDialogOpen) setProjectDialogOpen(false);
			else if (paletteOpen) setPaletteOpen(false);
			else if (shortcutsOpen) setShortcutsOpen(false);
			else if (settingsOpen) closeSettings();
			else if (mobileNav) setMobileNav(false);
			else if (active) void client.abortTurn().catch(() => undefined);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [
		active,
		client,
		closeSettings,
		mobileNav,
		paletteOpen,
		projectDialogOpen,
		settingsOpen,
		shortcutsOpen,
		skillManagerOpen,
		startNewChat,
		toggleSidebar,
	]);

	const themeSetting = <ThemeSettings theme={theme} locale={locale} />;
	const languageSetting = (
		<div className="language-setting">
			<div>
				<span className="settings-section-title">{t("language")}</span>
				<p className="settings-hint">{t("languageHint")}</p>
			</div>
			<div className="segmented" role="group" aria-label={t("language")}>
				{(["zh", "en"] as const).map((choice) => (
					<button
						key={choice}
						type="button"
						className={locale === choice ? "active" : ""}
						aria-pressed={locale === choice}
						onClick={() => setLocale(choice)}
					>
						{localeLabel(choice)}
					</button>
				))}
			</div>
		</div>
	);
	const executionSetting = (
		<div className={`execution-setting placement-${client.executionEnvironment?.placement ?? "unknown"}`}>
			<div>
				<span className="settings-section-title">{t("executionLocation")}</span>
				<p className="settings-hint">
					{client.executionEnvironment?.placement === "local_device"
						? t("executionLocalHint", { shell: client.executionEnvironment.shell })
						: client.executionEnvironment?.placement === "server"
							? t("executionServerHint")
							: t("executionUnknownHint")}
				</p>
			</div>
			<span className="execution-location-badge">{executionLocationLabel(client.executionEnvironment, locale)}</span>
		</div>
	);
	const gatewayPasswordForm = (
		<GatewayPasswordForm
			draft={tokenDraft}
			status={client.connection}
			submitted={connectSubmitted}
			onChange={(value) => {
				setTokenDraft(value);
				setConnectSubmitted(false);
			}}
			onSubmit={connectGateway}
		/>
	);
	const customModelSettings = client.capabilities.includes("model.custom") ? (
		<CustomModelSettings
			models={client.models}
			onListMedia={client.listCustomMediaModels}
			revision={client.modelSettingsRevision}
			onDiscover={client.discoverCustomModels}
			onListServices={client.listCustomModelServices}
			onRefreshService={client.refreshCustomModelService}
			onRemoveService={client.removeCustomModelService}
			onGet={client.getCustomModelSettings}
			onConfigure={async (configs) => {
				const configured = await client.configureCustomModels(configs);
				const selected = configured.at(-1);
				if (selected && client.snapshot?.session.phase === "idle") await client.setSessionModel(selected.model);
				return configured;
			}}
			onTest={client.testCustomModel}
			onRemove={client.removeCustomModel}
		/>
	) : (
		<div className="settings-empty-state">
			<Bot size={22} />
			<strong>{t("customModelsUnavailable")}</strong>
		</div>
	);
	if (!welcomeComplete) {
		return (
			<WelcomeScreen
				busy={!welcomeError && client.connection === "connecting" && desktopUnlocked}
				error={welcomeError}
				onEdit={() => {
					setWelcomeError(undefined);
					setConnectSubmitted(false);
				}}
				onSubmit={(password) => {
					setWelcomeError(undefined);
					welcomeAttemptStarted.current = false;
					if (desktopConnection()) {
						if (!isDesktopWelcomePassword(password)) {
							setWelcomeError("密码不正确，再试一次吧。");
							return;
						}
						try {
							localStorage.setItem(DESKTOP_WELCOME_KEY, "true");
						} catch {
							/* Session-only unlock. */
						}
						setDesktopUnlocked(true);
						setConnectSubmitted(true);
					} else {
						setTokenDraft(password);
						setConnectSubmitted(true);
						client.setToken(password);
					}
				}}
			/>
		);
	}
	const settingsSections: Array<{
		id: SettingsSection;
		label: string;
		hint: string;
		icon: ReactNode;
		count?: number;
	}> = [
		...(client.capabilities.includes("agent.teams")
			? [
					{
						id: "agents" as const,
						label: "Agents",
						hint: locale === "en" ? "Reusable roles" : "角色模板",
						icon: <Users size={17} />,
					},
				]
			: []),
		{
			id: "general",
			label: t("generalSettings"),
			hint: t("generalSettingsHint"),
			icon: <Settings size={17} />,
		},
		{
			id: "models",
			label: t("modelSettings"),
			hint: t("modelSettingsHint"),
			icon: <Bot size={17} />,
			count: client.models.filter((model) => model.custom).length,
		},
		...(client.capabilities.includes("model.official")
			? [
					{
						id: "official" as const,
						label: t("officialAccountSettings"),
						hint: t("officialAccountSettingsHint"),
						icon: <UserRound size={17} />,
					},
				]
			: []),
		{
			id: "usage",
			label: t("usageSettings"),
			hint: t("usageSettingsHint"),
			icon: <BarChart3 size={17} />,
		},
		{
			id: "computer",
			label: "Computer Use",
			hint: locale === "en" ? "Desktop control" : "桌面控制",
			icon: <Command size={17} />,
		},
		{
			id: "connection",
			label: t("connectionSettings"),
			hint: t("connectionSettingsHint"),
			icon: <Plug size={17} />,
		},
		...(desktopUpdates.enabled
			? [
					{
						id: "updates" as const,
						label: t("desktopUpdates"),
						hint: t("desktopUpdatesHint"),
						icon: <Download size={17} />,
					},
				]
			: []),
	];

	return (
		<div
			className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${resizingSidebar ? "resizing-sidebar" : ""} ${browserOpen ? "with-browser" : ""} ${!browserOpen && showRight && workbenchView === "chat" && client.snapshot ? "with-right" : ""}`}
			style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
		>
			<aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
				<div className="brand-row">
					<img className="brand-mark" src={clover} alt="" width={32} height={32} />
					<strong>Pi-Wm</strong>
					<button
						className="icon-button desktop-sidebar-toggle"
						type="button"
						title={`${t("collapseSidebar")} (${modifierLabel()} B)`}
						aria-label={t("collapseSidebar")}
						onClick={toggleSidebar}
					>
						<PanelLeftClose size={18} />
					</button>
					<button className="icon-button mobile-close" title={t("closeNavigation")} onClick={() => setMobileNav(false)}>
						<X size={18} />
					</button>
				</div>
				<button
					className="new-chat-button sidebar-new-chat"
					type="button"
					aria-label={t("newChat")}
					title={`${t("startNewChat")} (${modifierLabel()} Alt N)`}
					onClick={() => void startNewChat()}
					disabled={!canCreateChat || newChatBusy}
					aria-busy={newChatBusy}
				>
					{newChatBusy ? <RefreshCw className="spin" size={18} /> : <SquarePen size={18} />}
					<span>{newChatBusy ? t("newChatBusy") : t("newChat")}</span>
				</button>
				{client.capabilities.includes("automations") && (
					<button
						className={"sidebar-scheduled" + (workbenchView === "scheduled" ? " selected" : "")}
						onClick={() => {
							setWorkbenchView("scheduled");
							setMobileNav(false);
							setShowRight(false);
						}}
					>
						<CalendarClock size={18} />
						<span>定时任务</span>
					</button>
				)}
				<section className="project-section">
					<div className="project-section-heading">
						<span className="nav-label">{t("projects")}</span>
						<div className="project-heading-actions">
							<button
								type="button"
								title={t("openProject")}
								disabled={client.connection !== "connected"}
								onClick={() => setProjectDialogOpen(true)}
							>
								<FolderOpen size={16} />
							</button>
						</div>
					</div>
					<nav className="project-tree" aria-label={t("projects")}>
						{projectWorkspaces.map((workspace) => {
							const selected = workspace.id === selectedWorkspace?.id;
							const expanded = selected && !collapsedProjectIds.has(workspace.id);
							return (
								<ProjectNavigationItem
									key={workspace.id}
									workspace={workspace}
									selected={selected}
									expanded={expanded}
									disabled={client.connection !== "connected"}
									removeDisabled={selected && active}
									openFolderDisabled={client.executionEnvironment?.placement !== "local_device"}
									onToggle={() => {
										setCollapsedProjectIds((current) => {
											const next = new Set(current);
											if (selected && expanded) next.add(workspace.id);
											else next.delete(workspace.id);
											return next;
										});
										if (!selected) void client.selectWorkspace(workspace.id);
									}}
									onNewSession={() => startNewChat(workspace.id)}
									onRename={(name) => client.renameProject(workspace.id, name)}
									onRemove={() => client.removeProject(workspace.id)}
									onOpenFolder={() => workspaceApi.openProjectFolder(client.token, workspace.id)}
								>
									{expanded && (
										<div className="project-conversations">
											<SessionNavigation
												sessions={client.sessions}

												{...(client.snapshot ? { selectedSessionId: client.snapshot.session.id } : {})}
												workspaceId={workspace.id}
												disabled={client.connection !== "connected"}
												onBrowse={client.browseSessions}
												onSearch={client.searchSessions}
												onOpenMatch={openSearchMatch}
												onSelect={(sessionId) => void openConversation(sessionId)}
												onRename={client.renameSession}
												onArchive={client.archiveSession}
											/>
										</div>
									)}
								</ProjectNavigationItem>
							);
						})}
						{projectWorkspaces.length === 0 && <div className="project-tree-empty">{t("noProjects")}</div>}
						{implicitWorkspace && isImplicitWorkspace(selectedWorkspace) && (
							<section className="recent-conversations" aria-labelledby="recent-conversations-heading">
								<div className="recent-conversations-heading">
									<span className="nav-label" id="recent-conversations-heading">
										{t("recent")}
									</span>
								</div>
								<div className="projectless-conversations">
									<SessionNavigation
										sessions={client.sessions}

										{...(client.snapshot ? { selectedSessionId: client.snapshot.session.id } : {})}
										workspaceId={implicitWorkspace.id}
										disabled={client.connection !== "connected"}
										onBrowse={client.browseSessions}
										onSearch={client.searchSessions}
										onOpenMatch={openSearchMatch}
										onSelect={(sessionId) => void openConversation(sessionId)}
										onRename={client.renameSession}
										onArchive={client.archiveSession}
									/>
								</div>
							</section>
						)}
					</nav>
				</section>
				<div className="sidebar-footer">
					<DesktopUpdateNotice model={desktopUpdates} onOpen={openUpdates} />
					<button
						onClick={() => {
							setMobileNav(false);
							openSettings();
						}}
					>
						<Settings size={16} /> {t("settings")}
					</button>
					<div className={`connection ${client.connection}`}>
						<i />
						{client.connection === "connected" ? t("connected") : statusLabel(client.connection, t)}
					</div>
				</div>
			</aside>
			{!sidebarCollapsed && (
				<div
					className="sidebar-resizer"
					role="separator"
					aria-label={t("resizeSidebar")}
					aria-orientation="vertical"
					aria-valuemin={MIN_SIDEBAR_WIDTH}
					aria-valuemax={MAX_SIDEBAR_WIDTH}
					aria-valuenow={sidebarWidth}
					tabIndex={0}
					onPointerDown={beginSidebarResize}
					onKeyDown={resizeSidebarWithKeyboard}
					onDoubleClick={() => setAndStoreSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
				/>
			)}

			<main className="workspace-main">
				<header className="topbar">
					<div className="topbar-title">
						<button className="icon-button mobile-menu" title={t("openNavigation")} onClick={() => setMobileNav(true)}>
							<Menu size={19} />
						</button>
						{sidebarCollapsed && (
							<button
								className="icon-button desktop-sidebar-toggle sidebar-open-button"
								type="button"
								title={`${t("expandSidebar")} (${modifierLabel()} B)`}
								aria-label={t("expandSidebar")}
								onClick={toggleSidebar}
							>
								<PanelLeftOpen size={18} />
							</button>
						)}
						<button
							className="new-chat-button topbar-new-chat"
							type="button"
							aria-label={t("newChat")}
							title={`${t("startNewChat")} (${modifierLabel()} Alt N)`}
							onClick={() => void startNewChat()}
							disabled={!canCreateChat || newChatBusy}
							aria-busy={newChatBusy}
						>
							{newChatBusy ? <RefreshCw className="spin" size={16} /> : <SquarePen size={16} />}
							{newChatBusy ? t("newChatBusy") : t("newChat")}
						</button>
						{workbenchView !== "teams" && client.snapshot?.session.parentSessionId && (
							<button
								className="icon-button subagent-back"
								type="button"
								title={t("parentConversation")}
								aria-label={t("parentConversation")}
								onClick={() => void openConversation(client.snapshot!.session.parentSessionId!)}
							>
								<ArrowLeft size={18} />
							</button>
						)}
						<div>
							{workbenchView === "teams" && <h1>Agent Teams</h1>}
							{workbenchView === "teams" ? (
								<span>{selectedWorkspace ? workspaceName(selectedWorkspace.name) : t("noProject")}</span>
							) : (
								(!client.snapshot ||
									client.snapshot.session.archivedAt ||
									selectedProject ||
									client.snapshot.session.parentSessionId) && (
									<span>
										{!client.snapshot
											? selectedProject
												? workspaceName(selectedProject.name)
												: t("noProject")
											: client.snapshot.session.parentSessionId
												? t("agentConversation")
												: client.snapshot.session.archivedAt
													? t("archived")
													: ""}
										{client.snapshot &&
										(client.snapshot.session.parentSessionId || client.snapshot.session.archivedAt) &&
										selectedProject
											? " · "
											: ""}
										{client.snapshot && selectedProject ? workspaceName(selectedProject.name) : ""}
									</span>
								)
							)}
						</div>
					</div>
					<div className="workbench-tabs" role="tablist" aria-label={t("workspaceViews")}>
						<button
							role="tab"
							aria-selected={workbenchView === "chat"}
							className={workbenchView === "chat" ? "active" : ""}
							title={t("chat")}
							onClick={() => setWorkbenchView("chat")}
						>
							<MessageSquareCode size={15} />
							<span>{t("chat")}</span>
						</button>
						{client.capabilities.includes("automations") && (
							<button
								role="tab"
								aria-selected={workbenchView === "scheduled"}
								className={workbenchView === "scheduled" ? "active" : ""}
								title={locale === "en" ? "Scheduled tasks" : "定时任务"}
								aria-label={locale === "en" ? "Scheduled tasks" : "定时任务"}
								onClick={() => {
									setWorkbenchView("scheduled");
									setShowRight(false);
								}}
							>
								<CalendarClock size={15} />
								<span>{locale === "en" ? "Scheduled tasks" : "定时任务"}</span>
							</button>
						)}
						<button
							role="tab"
							aria-selected={workbenchView === "files"}
							className={workbenchView === "files" ? "active" : ""}
							title={t("files")}
							onClick={() => setWorkbenchView("files")}
						>
							<Folder size={15} />
							<span>{t("files")}</span>
						</button>
						{(client.capabilities.includes("agent.teams") || client.capabilities.includes("subagents")) && (
							<button
								role="tab"
								aria-selected={workbenchView === "teams"}
								className={workbenchView === "teams" ? "active" : ""}
								title="Agent Teams"
								aria-label="Agent Teams"
								onClick={() => setWorkbenchView("teams")}
							>
								<Users size={15} />
								<span>{locale === "en" ? "Teams" : "团队"}</span>
							</button>
						)}
						{client.capabilities.includes("subagents") && (
							<button
								role="tab"
								aria-selected={workbenchView === "subtasks"}
								className={workbenchView === "subtasks" ? "active" : ""}
								title={locale === "en" ? "Subtasks" : "子任务"}
								aria-label={locale === "en" ? "Subtasks" : "子任务"}
								onClick={() => setWorkbenchView("subtasks")}
							>
								<GitBranch size={15} />
								<span>{locale === "en" ? "Subtasks" : "子任务"}</span>
							</button>
						)}
						<button
							role="tab"
							aria-selected={workbenchView === "changes"}
							className={workbenchView === "changes" ? "active" : ""}
							title={t("changes")}
							onClick={() => setWorkbenchView("changes")}
						>
							<GitBranch size={15} />
							<span>{t("changes")}</span>
						</button>
						<button
							role="tab"
							aria-selected={workbenchView === "terminal"}
							className={workbenchView === "terminal" ? "active" : ""}
							title={t("terminal")}
							onClick={() => setWorkbenchView("terminal")}
						>
							<TerminalSquare size={15} />
							<span>{t("terminal")}</span>
						</button>
						{client.capabilities.includes("tools") && (
							<button
								role="tab"
								aria-selected={workbenchView === "tools"}
								className={workbenchView === "tools" ? "active" : ""}
								title={t("tools")}
								onClick={() => setWorkbenchView("tools")}
							>
								<Wrench size={15} />
								<span>{t("tools")}</span>
							</button>
						)}
						<button
							role="tab"
							aria-selected={workbenchView === "skills"}
							className={workbenchView === "skills" ? "active" : ""}
							title={t("skills")}
							onClick={() => setWorkbenchView("skills")}
						>
							<BookOpen size={15} />
							<span>{t("skills")}</span>
						</button>
						<button
							role="tab"
							aria-selected={workbenchView === "mcp"}
							className={workbenchView === "mcp" ? "active" : ""}
							title={t("mcp")}
							onClick={() => setWorkbenchView("mcp")}
						>
							<Plug size={15} />
							<span>{t("mcp")}</span>
						</button>
					</div>
					<div className="topbar-actions">
						{window.wumingDesktop?.browser && browserWorkspaceId && (
							<button
								type="button"
								className={"icon-button" + (browserOpen ? " pressed" : "")}
								title={locale === "en" ? "Browser preview" : "浏览器预览"}
								aria-label={locale === "en" ? "Browser preview" : "浏览器预览"}
								aria-pressed={browserOpen}
								onClick={() => {
									setBrowserOwner(browserOpen ? undefined : browserKey);
									setBrowserTarget(undefined);
									setShowRight(false);
								}}
							>
								<Globe size={17} />
							</button>
						)}
						{client.snapshot && client.capabilities.includes("subagents") && (
							<ChildConversationMenu
								key={client.snapshot.session.id}
								session={client.snapshot.session}
								children={client.subagents}
								open={childMenuOpen}
								onOpenChange={setChildMenuOpen}
								disabled={client.connection !== "connected"}
								load={client.refreshSubagents}
								onSelect={openConversation}
								onCancel={client.cancelSubagent}
							/>
						)}
						<button
							className="icon-button"
							type="button"
							title={`${t("commandPalette")}（${modifierLabel()} K）`}
							aria-label={t("commandPalette")}
							onClick={() => setPaletteOpen(true)}
						>
							<Command size={17} />
						</button>
						{workbenchView === "chat" && client.snapshot && client.capabilities.includes("session.compaction") && (
							<button
								className="icon-button"
								title={t("statusCompaction")}
								disabled={
									client.connection !== "connected" || active || client.snapshot.session.archivedAt !== undefined
								}
								onClick={() => void client.compactSession()}
							>
								<RefreshCw size={16} />
							</button>
						)}
						{workbenchView === "chat" && client.snapshot && (
							<button
								className="icon-button"
								title={t("forkConversation")}
								disabled={
									client.connection !== "connected" || active || client.snapshot.session.archivedAt !== undefined
								}
								onClick={() => void client.forkSession()}
							>
								<GitBranch size={17} />
							</button>
						)}
						{workbenchView === "chat" && client.snapshot && (
							<button
								className={`icon-button ${showRight ? "pressed" : ""}`}
								title={t("showOrHideRail")}
								onClick={() => setShowRight((value) => !value)}
							>
								<PanelRight size={18} />
							</button>
						)}
						<button
							className="icon-button"
							type="button"
							title={`${t("switchTheme")}（${t("currentTheme", { theme: themeLabel(theme.choice, locale) })}）`}
							aria-label={t("switchTheme")}
							onClick={() => theme.toggle()}
						>
							{theme.resolved === "dark" ? <Sun size={17} /> : <MoonStar size={17} />}
						</button>
					</div>
				</header>

				{newChatError && (
					<div className="new-chat-error" role="alert">
						<CircleAlert size={16} />
						<span>{newChatError}</span>
						<button
							className="icon-button"
							type="button"
							aria-label={t("closeNewChatError")}
							onClick={() => setNewChatError(undefined)}
						>
							<X size={14} />
						</button>
					</div>
				)}
				{workbenchView === "chat" && (
					<section className="conversation">
						<div
							className="transcript"
							ref={transcriptRef}
							onScroll={() => {
								const element = transcriptRef.current;
								if (!element) return;
								const pinned = pinnedAtRef.current;
								if (isNearBottom(element)) setFollowing(true);
								else if (pinned === undefined || element.scrollTop < pinned - 1) setFollowing(false);
							}}
						>
							{!client.snapshot && (
								<div className="empty-state">
									<div className="empty-icon">
										<Sparkles size={24} />
									</div>
									<h2>
										{selectedProject
											? t("projectTaskPrompt", { project: workspaceName(selectedProject.name) })
											: t("startTask")}
									</h2>
									<p>{t("describeTask")}</p>
								</div>
							)}
							{client.snapshot &&
								client.snapshot.transcript.length === 0 &&
								inlineGoal === undefined &&
								Object.keys(client.liveAssistants).length === 0 &&
								Object.keys(client.liveTools).length === 0 && (
									<div className="empty-state">
										<div className="empty-icon">
											<Sparkles size={24} />
										</div>
										<h2>{t("startTask")}</h2>
										<p>{t("describeActiveTask")}</p>
										<ul className="empty-hints">
											<li>
												<code>@</code>
												<span>{t("quoteWorkspaceFiles")}</span>
											</li>
											<li>
												<code>/</code>
												<span>{t("quickCommands")}</span>
											</li>
											<li>
												<kbd>{modifierLabel()}</kbd>
												<kbd>K</kbd>
												<span>{t("commandPalette")}</span>
											</li>
											<li>
												<kbd>Shift</kbd>
												<kbd>Enter</kbd>
												<span>{t("lineBreak")}</span>
											</li>
										</ul>
									</div>
								)}
							{traceGroups.map((group) => (
								<ToolGroup tools={group.tools} key={`${client.snapshot?.session.id}:${group.key}`}>
									{group.entries.map((entry) => {
										if (entry.kind === "assistant")
											return (
												<LiveAssistantView
													item={entry.item}
													compacting={compactionStatus === "running"}
													key={`assistant:${entry.item.id}`}
												/>
											);
										if (entry.kind === "tool")
											return (
												<LiveToolView
													tool={entry.item}
													onOpenSubagent={
														entry.item.toolName === "subagent"
															? openToolSubagent(entry.item.toolCallId, entry.item.input)
															: undefined
													}
													onDownload={client.downloadArtifact}
													onLoadArtifact={client.loadArtifact}
													awaitingApproval={
														client.snapshot?.pendingApprovals.some(
															(approval) => approval.toolCallId === entry.item.toolCallId
														) ?? false
													}
													key={`tool:${entry.item.toolCallId}`}
												/>
											);
										const item = entry.item;
										const failureRun =
											item.type === "assistant" && item.error
												? client.runs.find((run) => item.id === `${run.id}:error`)
												: undefined;
										return (
											<TranscriptItemView
												item={item}
												onOpenSubagent={
													item.type === "tool" && item.toolName === "subagent"
														? openToolSubagent(item.toolCallId, item.input)
														: undefined
												}
												key={item.id}
												transcript={client.snapshot?.transcript ?? []}
												turnActive={reasoningPhase}
												now={Date.now()}
												onDownload={client.downloadArtifact}
												onLoadArtifact={client.loadArtifact}
												renderedToolCalls={renderedToolCalls}
												actions={item.type === "tool" ? undefined : messageActions(item)}
												failureActions={
													item.type === "assistant" && item.error
														? {
																run: failureRun,
																resumeDesktop: desktopContinuation(client.snapshot?.transcript ?? [], item.id),
																busy: messageBusyId === item.id,
																disabled: branchDisabled,
																disabledTitle: branchTitle,
																onRetry: () => retryFailedTurn(item),
																onOpenSettings: () => openSettings("models"),
																onOpenUsage: () => openSettings("usage"),
															}
														: undefined
												}
											/>
										);
									})}
								</ToolGroup>
							))}
							{compactionStatus && <CompactionActivity status={compactionStatus} />}
							{recovery && compactionStatus !== "running" && (
								<RetryActivity key={recovery.operationId} retry={recovery} />
							)}
							{client.snapshot?.pendingApprovals.map((approval) => (
								<ApprovalPanel
									key={approval.id}
									approval={approval}
									onRespond={(decision) => client.respondApproval(approval.sessionId, approval.id, decision)}
								/>
							))}
							{showThinkingActivity && <ThinkingActivity phase={client.snapshot!.session.phase} />}
							{inlineGoal && (
								<GoalActivityCard
									goal={inlineGoal}
									skill={inlineGoalSkill}
									activity={client.liveGoalActivities[inlineGoal.id]}
									onStart={client.startGoal}
									onPause={client.pauseGoal}
									onResume={client.resumeGoal}
									onCancel={client.cancelGoal}
									onDelete={client.deleteGoal}
									onOpenRun={async (sessionId) => {
										await client.attachSession(sessionId);
										setShowRight(false);
										setWorkbenchView("chat");
									}}
								/>
							)}
							{client.error && (
								<div className="global-error">
									<CircleAlert size={16} />
									{client.error}
								</div>
							)}
						</div>
						<div className="composer-wrap">
							<TeamLaunchNotice
								transcript={client.snapshot?.transcript ?? []}
								onOpen={(teamId) => {
									if (selectedWorkspace) localStorage.setItem(`wuming.teamId.${selectedWorkspace.id}`, teamId);
									setWorkbenchView("teams");
								}}
							/>
							{client.selectedSkill && (
								<div
									className={client.selectedSkill.truncated ? "workbench-error" : "composer-selected-skill"}
									role={client.selectedSkill.truncated ? "alert" : "status"}
								>
									<BookOpen size={14} />
									<span>
										{client.selectedSkill.truncated ? t("skillTruncated") : t("currentSkill")}
										{client.selectedSkill.name}
									</span>
									<button
										className="icon-button"
										type="button"
										aria-label={t("cancelSkill")}
										title={t("cancelSkill")}
										onClick={client.clearSelectedSkill}
									>
										<X size={13} />
									</button>
								</div>
							)}
							{client.snapshot && !following && (
								<button
									className={`jump-latest${pendingTail ? " live" : ""}`}
									type="button"
									onClick={jumpToLatest}
									aria-label={pendingTail ? t("scrollToBottomNew") : t("scrollToBottom")}
								>
									{pendingTail ? <span className="jump-dot" aria-hidden="true" /> : <ArrowDown size={14} />}
									{pendingTail ? t("newContent") : t("scrollToBottom")}
								</button>
							)}
							<Composer
								key={client.snapshot?.session.id ?? "draft:new-chat"}
								editRequest={composerEdit?.sessionId === client.snapshot?.session.id ? composerEdit : undefined}
								onCancelEdit={() => setComposerEdit(undefined)}
								disabled={
									newChatBusy ||
									messageBusyId !== undefined ||
									client.snapshot?.session.archivedAt !== undefined ||
									client.connection !== "connected" ||
									!selectedWorkspace
								}
								sendDisabled={!selectedModel}
								sendDisabledReason={t("defaultModelEmpty")}
								active={active}
								models={composerModels}
								selectedModel={selectedModel}
								modelSelectionDisabled={
									client.connection !== "connected" || active || client.snapshot?.session.archivedAt !== undefined
								}
								token={client.token}
								workspaceId={selectedWorkspace?.id}
								commands={composerCommands}
								skills={client.skills}
								onSelectSkill={(id) =>
									selectedWorkspace ? client.getSkill(selectedWorkspace.id, id) : Promise.resolve(undefined)
								}
								contextUsage={contextUsage}
								permission={{
									sandboxMode: client.snapshot?.sandboxMode ?? draftPermission.sandboxMode,
									approvalPolicy: client.snapshot?.approvalPolicy ?? draftPermission.approvalPolicy,
								}}
								permissionDisabled={
									client.connection !== "connected" || active || client.snapshot?.session.archivedAt !== undefined
								}
								thinkingLevel={thinkingLevel}
								thinkingSupported={thinkingModel?.reasoning === true}
								thinkingLevels={supportedThinkingLevels(thinkingModel)}
								thinkingDisabled={
									client.connection !== "connected" || active || client.snapshot?.session.archivedAt !== undefined
								}
								onSelectModel={(model) => {
									client.selectModel(model);
									if (
										client.snapshot?.session.phase === "idle" &&
										(client.snapshot.model.provider !== model.provider || client.snapshot.model.id !== model.id)
									) {
										void client.setSessionModel(model);
									}
								}}
								onSelectPermission={async (value) => {
									if (client.snapshot) await client.setSessionPolicy(value.sandboxMode, value.approvalPolicy);
									else writeStoredPermission(localStorage, value);
									setDraftPermission(value);
								}}
								onSelectThinking={async (level) => {
									if (client.snapshot) await client.setSessionThinking(level);
									else writeStoredThinking(localStorage, level);
									setDraftThinking(level);
								}}
								onSend={async (text, artifacts, queueMode) => {
									if (/^\/team\s*$/.test(text.trim()) || (client.selectedSkill?.id === "team" && !text.trim()))
										throw new Error("请提供团队任务目标，例如 /team 帮我做一个图书管理系统");
									if (client.selectedSkill?.truncated)
										throw new Error("所选技能内容已截断，无法执行。请先精简技能文件或取消技能。");
									// Sending is an explicit request to watch the answer arrive.
									jumpToLatest();
									if (composerEdit && composerEdit.sessionId === client.snapshot?.session.id) {
										const anchor = anchorBefore(transcript ?? [], composerEdit.itemId);
										setMessageBusyId(composerEdit.itemId);
										try {
											// An anchorless fork copies everything; editing the first prompt needs a fresh session.
											if (anchor === undefined) await client.createSession();
											else await client.forkSession(anchor);
											await client.sendPrompt(text, artifacts, queueMode);
											setComposerEdit(undefined);
										} finally {
											setMessageBusyId(undefined);
										}
										return;
									}
									const committingDraft = !client.snapshot;
									if (committingDraft) {
										newChatPending.current = true;
										setNewChatBusy(true);
										setNewChatError(undefined);
									}
									try {
										if (committingDraft) await client.createSession();
										const goalMatch = text.trim().match(/^\/goal\s+(.+)$/is);
										if (goalMatch) {
											const objective = goalMatch[1];
											if (!objective) throw new Error("目标内容不能为空");
											const created = await client.createGoal({
												objective: objective.trim(),
												...(client.selectedSkill ? { skillId: client.selectedSkill.id } : {}),
											});
											await client.startGoal(created.id);
										} else {
											await client.sendPrompt(text, artifacts, queueMode);
										}
									} finally {
										if (committingDraft) {
											newChatPending.current = false;
											setNewChatBusy(false);
										}
									}
								}}
								onAbort={client.abortTurn}
								onUpload={client.uploadArtifact}
								onLoadArtifact={client.loadArtifact}
								{...(!client.snapshot && selectedProject && implicitWorkspace
									? {
											draftProjectName: workspaceName(selectedProject.name),
											onDetachDraftProject: () => void startNewChat(implicitWorkspace.id),
										}
									: {})}
							/>
						</div>
					</section>
				)}
				{workbenchView === "teams" &&
					(selectedWorkspace ? (
						<PersistentAgentTeams
							key={selectedWorkspace.id}
							workspaceId={selectedWorkspace.id}
							connected={client.connection === "connected"}
							available={client.capabilities.includes("agent.teams")}
							listTeams={client.listTeams}
							command={client.teamCommand}
							onOpen={openConversation}
							onChat={() => setWorkbenchView("chat")}
						/>
					) : (
						<section className="teams-workbench" aria-label="Agent Teams">
							<div className="teams-empty">
								<Users size={32} />
								<h3>{locale === "en" ? "No project selected" : "尚未选择项目"}</h3>
								<button type="button" onClick={() => setWorkbenchView("chat")}>
									{t("chat")}
								</button>
							</div>
						</section>
					))}
				{workbenchView === "subtasks" &&
					(client.snapshot ? (
						<AgentTeamsWorkbench
							key={client.snapshot.session.id}
							snapshot={client.snapshot}
							subagents={client.subagents}
							goals={client.goals}
							connected={client.connection === "connected"}
							canCreate={client.canCreateSubagent}
							canPlan={client.capabilities.includes("goals")}
							onCreateMember={client.createSubagent}
							onCreatePlan={client.createGoal}
							onStartPlan={client.startGoal}
							onStopPlan={client.cancelGoal}
							onStopMember={client.cancelSubagent}
							onOpen={openConversation}
							onApprove={client.respondApproval}
							onRefresh={() =>
								Promise.all([
									client.refreshSubagents(client.snapshot!.session.id),
									...(client.capabilities.includes("goals") ? [client.refreshGoals(client.snapshot!.session.id)] : []),
								])
							}
						/>
					) : (
						<section className="teams-workbench">
							<div className="teams-empty">
								<button type="button" onClick={() => setWorkbenchView("chat")}>
									{t("chat")}
								</button>
							</div>
						</section>
					))}
				{workbenchView === "scheduled" && (
					<ScheduledTasks
						request={client.scheduledRequest}
						workspaces={client.workspaces}
						models={client.models}
						connected={client.connection === "connected"}
						onOpenSession={async (id) => {
							await client.attachSession(id);
							setShowRight(false);
							setWorkbenchView("chat");
						}}
					/>
				)}
				{workbenchView === "automations" && (
					<AutomationsView
						automations={client.automations}
						disabled={
							newChatBusy || client.snapshot?.session.archivedAt !== undefined || client.connection !== "connected"
						}
						draftContext={
							client.snapshot
								? undefined
								: {
										workspaces: client.workspaces,
										workspaceId: selectedWorkspace?.id,
										modelName: selectedModel?.name,
									}
						}
						archived={client.snapshot?.session.archivedAt !== undefined}
						onCreate={async (input, workspaceId) => {
							if (newChatPending.current) throw new Error("正在创建关联会话");
							const committingDraft = !client.snapshot;
							if (committingDraft) {
								newChatPending.current = true;
								setNewChatBusy(true);
							}
							try {
								return await client.createAutomation(input, workspaceId);
							} finally {
								if (committingDraft) {
									newChatPending.current = false;
									setNewChatBusy(false);
								}
							}
						}}
						onUpdate={client.updateAutomation}
						onDelete={client.deleteAutomation}
						onSetEnabled={client.setAutomationEnabled}
						onTrigger={client.triggerAutomation}
						onListRuns={client.listAutomationRuns}
						onRespondApproval={client.respondApproval}
						onRefresh={refreshCurrentAutomations}
						onOpenSession={async (sessionId) => {
							await client.attachSession(sessionId);
							setShowRight(false);
							setWorkbenchView("chat");
						}}
					/>
				)}
				{workbenchView === "files" && selectedWorkspace && (
					<WorkspaceFilesView token={client.token} workspaceId={selectedWorkspace.id} />
				)}
				{workbenchView === "changes" && selectedWorkspace && (
					<WorkspaceChangesView token={client.token} workspaceId={selectedWorkspace.id} />
				)}
				{terminalVisited && client.token && (
					<Suspense fallback={<div className="workbench-empty">{t("loadingTerminal")}</div>}>
						<TerminalWorkbench
							key={client.token}
							token={client.token}
							{...(selectedWorkspace ? { workspaceId: selectedWorkspace.id } : {})}
							active={workbenchView === "terminal"}
						/>
					</Suspense>
				)}
				{workbenchView === "tools" && selectedWorkspace && (
					<ToolsView
						tools={client.tools}
						runtime={client.toolRuntime}
						execution={client.executionEnvironment}
						onRefresh={() => client.refreshTools(selectedWorkspace.id)}
					/>
				)}
				{workbenchView === "skills" && selectedWorkspace && (
					<SkillsView
						skills={client.skills}
						selectedSkill={client.selectedSkill}
						onRefresh={() => client.refreshSkills(selectedWorkspace.id)}
						onSelect={(skillId) => client.getSkill(selectedWorkspace.id, skillId)}
						onClear={client.clearSelectedSkill}
						onManage={() => setSkillManagerOpen(true)}
					/>
				)}
				{workbenchView === "skills" && selectedWorkspace && skillManagerOpen && (
					<SkillManagerDialog
						key={selectedWorkspace.id}
						workspaceId={selectedWorkspace.id}
						onCommand={client.manageSkills}
						onClose={() => setSkillManagerOpen(false)}
					/>
				)}
				{workbenchView === "mcp" && selectedWorkspace && (
					<McpView
						key={selectedWorkspace.id}
						workspaceId={selectedWorkspace.id}
						available={client.capabilities.includes("mcp")}
						onCommand={client.manageMcp}
						servers={client.mcpServers}
						selectedServer={client.selectedMcpServer}
						onRefresh={() => client.refreshMcp(selectedWorkspace.id)}
						onSelect={(serverId) => client.getMcp(selectedWorkspace.id, serverId)}
					/>
				)}
			</main>

			{browserOpen && browserWorkspaceId && (
				<BrowserPanel
					key={browserKey}
					workspaceId={browserWorkspaceId}
					sessionId={browserSessionId}
					initialUrl={browserTarget?.owner === browserKey ? browserTarget : undefined}
					onClose={() => {
						setBrowserOwner(undefined);
						setBrowserTarget(undefined);
					}}
				/>
			)}
			{!browserOpen && showRight && workbenchView === "chat" && client.snapshot && (
				<RightRail
					snapshot={client.snapshot}
					usageOverview={client.usageOverview}
					runs={client.runs}
					memories={client.memories}
					contextUsage={contextUsage}
					onSetBudget={client.setSessionBudget}
					onManageMemory={client.manageMemory}
					onOpenEvaluation={setEvaluationRun}
					onClose={() => setShowRight(false)}
				/>
			)}
			{!browserOpen && showRight && workbenchView === "chat" && client.snapshot && (
				<button className="right-rail-scrim" aria-label={t("closeRunPanel")} onClick={() => setShowRight(false)} />
			)}
			{mobileNav && (
				<button className="mobile-scrim" aria-label={t("closeNavigation")} onClick={() => setMobileNav(false)} />
			)}
			{paletteOpen && <CommandPalette entries={paletteEntries} onClose={() => setPaletteOpen(false)} />}
			{shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
			{projectDialogOpen && (
				<ProjectImportDialog
					local={localGateway}
					onOpenLocal={client.openLocalProject}
					onImport={client.importProject}
					onClose={() => setProjectDialogOpen(false)}
				/>
			)}
			{evaluationRun && client.snapshot && (
				<EvaluationDialog
					run={evaluationRun}
					workspaceId={client.snapshot.session.workspaceId}
					datasets={client.evaluationDatasets}
					artifacts={evaluationArtifacts}
					enabled={client.capabilities.includes("evaluation")}
					onRefreshDatasets={client.refreshEvaluationDatasets}
					onCreateDataset={client.createEvaluationDataset}
					onDeleteDataset={client.deleteEvaluationDataset}
					onListEvaluations={client.listRunEvaluations}
					onEvaluate={client.runEvaluation}
					onAttest={client.createRunAttestation}
					onCopyDiagnostic={() => writeClipboardText(runDiagnostic(client.snapshot, evaluationRun))}
					onClose={() => setEvaluationRun(undefined)}
				/>
			)}

			{settingsOpen && (
				<div
					className={`modal-backdrop ${onboarding ? "" : "settings-backdrop"}`}
					role="presentation"
					onMouseDown={closeSettings}
				>
					<div
						className={`settings-dialog ${onboarding ? "onboarding-dialog" : ""}`}
						role="dialog"
						aria-modal="true"
						aria-labelledby="settings-title"
						onMouseDown={(event) => event.stopPropagation()}
					>
						{onboarding ? (
							<>
								<div className="dialog-header">
									<h2 id="settings-title">{t("firstSetup")}</h2>
									{client.connection === "connected" && !onboardingRequiresModel && (
										<button
											className="icon-button"
											title={t("completeSetup")}
											aria-label={t("completeSetup")}
											onClick={closeSettings}
										>
											<X size={18} />
										</button>
									)}
								</div>
								{client.connection !== "connected" ? (
									<GatewayPasswordForm
										draft={tokenDraft}
										status={client.connection}
										submitted={connectSubmitted}
										firstUse
										onChange={(value) => {
											setTokenDraft(value);
											setConnectSubmitted(false);
										}}
										onSubmit={connectGateway}
									/>
								) : (
									<>
										<div className="onboarding-success" role="status">
											<ShieldCheck size={18} />
											<div>
												<strong>{t("onboardingConnected")}</strong>
												<span>{t("onboardingConnectedHint")}</span>
											</div>
										</div>
										{themeSetting}
										{languageSetting}
										{executionSetting}
										<div className="onboarding-model-setting">
											<div>
												<span className="settings-section-title">{t("defaultModel")}</span>
												<p className="settings-hint">{t("defaultModelHint")}</p>
											</div>
											<select
												aria-label={t("defaultModelControl")}
												value={client.selectedModel ? JSON.stringify(client.selectedModel) : ""}
												onChange={(event) => client.selectModel(JSON.parse(event.target.value) as ModelRef)}
											>
												{!client.models.some((model) => model.authenticated) && (
													<option value="">{t("defaultModelEmpty")}</option>
												)}
												{client.models
													.filter((model) => model.authenticated)
													.map((model) => (
														<option
															key={`${model.model.provider}:${model.model.id}`}
															value={JSON.stringify(model.model)}
														>
															{model.name}
														</option>
													))}
											</select>
										</div>
										{localGateway ? (
											<details className="gateway-settings">
												<summary>{t("gatewayConnection")}</summary>
												{gatewayPasswordForm}
											</details>
										) : (
											gatewayPasswordForm
										)}
										{client.capabilities.includes("model.custom") && customModelSettings}
									</>
								)}
							</>
						) : (
							<>
								<header className="settings-shell-header">
									<h2 id="settings-title">{t("settings")}</h2>
									<button className="icon-button" title={t("close")} aria-label={t("close")} onClick={closeSettings}>
										<X size={18} />
									</button>
								</header>
								<div className="settings-shell-layout">
									<nav className="settings-navigation" aria-label={t("settingsNavigation")}>
										{settingsSections.map((section) => (
											<button
												key={section.id}
												type="button"
												className={settingsSection === section.id ? "active" : ""}
												aria-current={settingsSection === section.id ? "page" : undefined}
												aria-controls={`settings-panel-${section.id}`}
												onClick={() => setSettingsSection(section.id)}
											>
												{section.icon}
												<span>
													<strong>{section.label}</strong>
													<small>{section.hint}</small>
												</span>
												{section.count !== undefined && <b>{section.count}</b>}
											</button>
										))}
									</nav>
									<div className="settings-content">
										<section
											id="settings-panel-general"
											className="settings-pane"
											hidden={settingsSection !== "general"}
										>
											<div className="settings-page-header">
												<h3>{t("generalSettings")}</h3>
												<p>{t("generalSettingsDescription")}</p>
											</div>
											<div className="settings-list">
												{themeSetting}
												{languageSetting}
												<TaskNotificationSettings />
											</div>
										</section>
										{client.capabilities.includes("model.official") && (
											<section
												id="settings-panel-official"
												className="settings-pane"
												hidden={settingsSection !== "official"}
											>
												<div className="settings-page-header">
													<h3>{t("officialAccountSettings")}</h3>
												</div>
												<OfficialAccountSettings
													request={client.officialAccounts}
													onModelsChanged={client.refreshModels}
												/>
											</section>
										)}
										{settingsSection === "agents" && selectedWorkspace && (
											<section id="settings-panel-agents" className="settings-pane">
												<AgentTemplateSettings
													key={selectedWorkspace.id}
													workspaceId={selectedWorkspace.id}
													connected={client.connection === "connected"}
													models={client.models}
													tools={client.tools}
													request={client.agentTemplates}
												/>
											</section>
										)}
										<section id="settings-panel-models" className="settings-pane" hidden={settingsSection !== "models"}>
											<div className="settings-page-header">
												<h3>{t("modelSettings")}</h3>
												<p>{t("modelSettingsDescription")}</p>
											</div>
											{customModelSettings}
											{client.capabilities.includes("model.media") && (
												<MediaModelSettings
													onSetDefaultVideo={client.setDefaultVideoModel}
													onRemoveVideo={client.removeVideoModel}
													onSetDefaultImage={client.setDefaultImageModel}
													onRemoveImage={client.removeImageModel}
													revision={client.modelSettingsRevision}
													onListCatalog={client.listCustomMediaModels}
													onRemoveCatalog={client.removeCustomModel}
													onConfigureCatalog={client.configureCustomModels}
													connected={client.connection === "connected"}
													onList={client.listMediaModels}
													onSave={client.setMediaModel}
													onRemove={client.removeMediaModel}
													onDiscover={client.discoverMediaModels}
												/>
											)}
										</section>
										<section
											id="settings-panel-computer"
											className="settings-pane"
											hidden={settingsSection !== "computer"}
										>
											<ComputerUseSettings model={computer} />
										</section>
										<section
											id="settings-panel-usage"
											className="settings-pane usage-settings-pane"
											hidden={settingsSection !== "usage"}
										>
											<div className="settings-page-header">
												<h3>{t("usageSettings")}</h3>
												<p>{t("usageSettingsDescription")}</p>
											</div>
											<UsageSettings
												overview={client.usageOverview}
												snapshot={client.snapshot}
												workspaces={client.workspaces}
												models={client.models}
												onRefresh={client.getUsageOverview}
											/>
										</section>
										{desktopUpdates.enabled && (
											<section
												id="settings-panel-updates"
												className="settings-pane"
												hidden={settingsSection !== "updates"}
											>
												<DesktopUpdateSettings model={desktopUpdates} />
											</section>
										)}
										<section
											id="settings-panel-connection"
											className="settings-pane"
											hidden={settingsSection !== "connection"}
										>
											<div className="settings-page-header">
												<h3>{t("connectionSettings")}</h3>
												<p>{t("connectionSettingsDescription")}</p>
											</div>
											{executionSetting}
											<div className="settings-connection-section">
												<div className="settings-subsection-header">
													<div>
														<span className="settings-section-title">{t("gatewayConnection")}</span>
														<p className="settings-hint">{t("gatewayConnectionHint")}</p>
													</div>
													<span className={`settings-connection-status connection ${client.connection}`}>
														<i />
														{client.connection === "connected" ? t("connected") : statusLabel(client.connection, t)}
													</span>
												</div>
												{gatewayPasswordForm}
											</div>
										</section>
									</div>
								</div>
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

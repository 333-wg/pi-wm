import { GoalPlanEditor, GoalPlanView, newGoalPlan } from "./components/GoalPlan";
import { CompactionActivity } from "./components/CompactionActivity.js";
import { GoalActivityCard } from "./components/GoalActivityCard";
import { SkillManagerDialog } from "./components/SkillManagerDialog.js";
import { MediaModelSettings } from "./components/MediaModelSettings.js";
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
	Hourglass,
	TerminalSquare,
	Trash2,
	Upload,
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
import type {
	ApprovalRequest,
	ArtifactRef,
	AutomationRunSummary,
	AutomationSchedule,
	CommandResult,
	CustomModelApi,
	CustomModelConfig,
	CustomModelConnection,
	CustomModelService,
	CustomModelSettings as CustomModelSettingsValue,
	ContentPart,
	ExecutionEnvironment,
	GoalSummary,
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
	McpServer,
	McpServerSummary,
	SubagentSummary,
	ThinkingLevel,
	Usage,
	UsageToolSummary,
	UsageOverview,
	ToolStatus,
} from "@wuming/protocol";
import { type LiveAssistant, type LiveRetry, type LiveTool, useWumingClient } from "./use-wuming-client.js";
import { workspaceApi } from "./workspace-api.js";
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
import { ThinkingPicker, thinkingLabel } from "./components/ThinkingPicker.js";
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
import { isNearBottom } from "./lib/scroll.js";
import { themeLabel, type ThemeChoice } from "./lib/theme.js";
import { localeLabel, useLocale, useT } from "./lib/locale.js";
import { isImplicitWorkspace, resolveNewChatWorkspace } from "./lib/workspaces.js";
import { useTheme } from "./use-theme.js";
import { applyCompletion, cycleIndex, detectTrigger, quoteMention, type Trigger } from "./lib/suggest.js";
const TerminalView = lazy(() => import("./terminal-view.js").then((module) => ({ default: module.TerminalView })));

function formatMoney(value: number): string {
	if (value === 0) return "$0.00";
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

const STATUS_LABELS: Record<string, string> = {
	idle: "空闲",
	turn: "执行中",
	running: "运行中",
	queued: "排队中",
	awaiting_approval: "等待批准",
	compaction: "整理上下文",
	retry: "重试中",
	cancelling: "正在取消",
	paused: "已暂停",
	cancelled: "已取消",
	aborted: "已中止",
	complete: "已完成",
	completed: "已完成",
	failed: "失败",
	connected: "已连接",
	connecting: "连接中",
	reconnecting: "重新连接中",
	disconnected: "已断开",
	dispatching: "正在分派",
	ready: "就绪",
	closed: "已关闭",
	error: "错误",
	pending: "等待中",
	approved: "已批准",
	denied: "已拒绝",
};

const ONBOARDING_STORAGE_KEY = "wuming.onboarding.complete";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "wuming.sidebar.collapsed";
type SettingsSection = "general" | "models" | "usage" | "connection";
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

function statusLabel(value: string): string {
	return STATUS_LABELS[value] ?? value.replaceAll("_", " ");
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

function riskLabel(value: string): string {
	return ({ low: "低风险", medium: "中风险", high: "高风险" } as Record<string, string>)[value] ?? value;
}

function sandboxLabel(value: string | undefined): string {
	if (!value) return "-";
	return (
		({ read_only: "只读", workspace_write: "工作区可写", unrestricted: "完全访问" } as Record<string, string>)[value] ??
		value.replaceAll("_", " ")
	);
}

function approvalPolicyLabel(value: string | undefined): string {
	if (!value) return "-";
	return (
		({ on_risk: "遇到风险时询问", always: "始终询问", never: "从不询问" } as Record<string, string>)[value] ??
		value.replaceAll("_", " ")
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
						<span>{local ? "使用这台电脑上的文件和文件夹" : "导入到 Wuming 工作区"}</span>
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
	onDiscover,
	onListServices,
	onRefreshService,
	onRemoveService,
	onGet,
	onConfigure,
	onTest,
	onRemove,
}: {
	models: Array<{ model: { provider: string; id: string }; name: string; custom?: boolean }>;
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
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [discovery, setDiscovery] = useState<Extract<CommandResult, { type: "model.custom.discovered" }>>();
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [modelQuery, setModelQuery] = useState("");
	const [name, setName] = useState("");
	const [api, setApi] = useState<CustomModelApi>("openai-completions");
	const [contextWindow, setContextWindow] = useState("128000");
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
		void onListServices()
			.then((loaded) => {
				if (active) setServices(loaded);
			})
			.catch((cause) => {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			active = false;
		};
	}, [onListServices]);
	const resetDiscovery = () => {
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
					id: editing.model.id,
					name: editing.name,
					api: editing.api,
					baseUrl: editing.baseUrl,
					input: editing.input,
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
		savedModels.filter((model) => model.model.provider === discovery?.provider).map((model) => model.model.id)
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
					<button className="primary-button" disabled={editBusy}>
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
									<label className={`model-option ${savedIds.has(model.id) ? "already-added" : ""}`} key={model.id}>
										<input
											type="checkbox"
											disabled={savedIds.has(model.id)}
											checked={savedIds.has(model.id) || selectedIds.includes(model.id)}
											onChange={() => toggleModel(model.id)}
										/>
										<span>
											<strong>{model.name}</strong>
											{model.name !== model.id && <small>{model.id}</small>}
										</span>
										{savedIds.has(model.id) && <small className="model-added-label">{t("alreadyAdded")}</small>}
									</label>
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

function formatRunDuration(run: RunSummary): string {
	return formatDuration(
		run.startedAt,
		run.finishedAt ?? (run.status === "running" ? Date.now() : run.updatedAt),
		run.status === "queued" ? "排队中" : "暂无耗时"
	);
}

function formatDuration(startedAt: number | undefined, end: number, unavailable = "暂无耗时"): string {
	if (startedAt === undefined) return unavailable;
	const milliseconds = Math.max(0, end - startedAt);
	if (milliseconds < 1000) return `${milliseconds}ms`;
	const seconds = Math.round(milliseconds / 1000);
	return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatElapsedDuration(milliseconds: number): string {
	if (milliseconds < 1000) return "0 秒";
	const seconds = Math.floor(milliseconds / 1000);
	return seconds < 60 ? seconds + " 秒" : Math.floor(seconds / 60) + " 分 " + (seconds % 60) + " 秒";
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

const FAILURE_KIND_LABELS: Record<string, string> = {
	provider: "模型服务错误",
	provider_auth: "模型认证失败",
	provider_rate_limit: "模型服务限流",
	provider_timeout: "模型响应超时",
	provider_network: "模型网络故障",
	tool: "工具执行失败",
	user_abort: "用户已停止",
	runtime_restart: "服务重启中断",
	budget: "用量超出限额",
	unknown: "运行未完成",
};

const HOOK_POINT_LABELS: Record<string, string> = {
	"operation.before_execute": "执行前",
	"operation.after_execute": "执行后",
	"operation.on_error": "错误处理",
};

const HOOK_OUTCOME_LABELS: Record<string, string> = {
	completed: "通过",
	denied: "已阻止",
	denial_ignored: "建议已忽略",
	failed: "失败",
	timed_out: "超时",
};

const CONTEXT_KIND_LABELS: Record<string, string> = {
	system: "系统",
	policy: "策略",
	skill: "技能",
	workspace: "工作区",
	memory: "记忆",
};

const CONTEXT_CACHE_LABELS: Record<string, string> = {
	stable: "稳定缓存",
	session: "会话缓存",
	turn: "单轮",
};

const TRAJECTORY_CRITERION_LABELS: Record<string, string> = {
	integrity: "完整性",
	completion: "完成状态",
	reliability: "可靠性",
	policy: "策略执行",
	observability: "可观测性",
};

const MEMORY_REASON_LABELS: Record<MemoryRecord["memory"]["reason"], string> = {
	manual: "手动整理",
	threshold: "阈值整理",
	overflow: "溢出恢复",
};

function failureKindLabel(value: string): string {
	return FAILURE_KIND_LABELS[value] ?? value;
}

function redactDiagnostic(value: string): string {
	return value
		.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [已隐藏]")
		.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "$1-[已隐藏]")
		.replace(/((?:api[_ -]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]");
}

function runDiagnostic(snapshot: SessionSnapshot | undefined, run: RunSummary): string {
	return [
		"Wuming 运行诊断",
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
	return (
		<button
			className="run-diagnostic-button"
			type="button"
			title="打开运行评测与诊断"
			aria-label="打开运行评测与诊断"
			onClick={() => onOpen(run)}
		>
			<Activity size={12} />
		</button>
	);
}

function formatToolName(tool: UsageToolSummary): string {
	return tool.mcpServerId && tool.mcpToolName ? `${tool.mcpServerId}/${tool.mcpToolName}` : tool.toolName;
}

function formatToolOutcome(tool: UsageToolSummary): string | undefined {
	const parts = [
		tool.succeededCount ? `${tool.succeededCount} 成功` : undefined,
		tool.failedCount ? `${tool.failedCount} 失败` : undefined,
		tool.abortedCount ? `${tool.abortedCount} 已中止` : undefined,
	].filter((value): value is string => value !== undefined);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function formatToolObservation(tool: UsageToolSummary): string {
	return [
		`${formatToolName(tool)} x${tool.callCount}`,
		tool.durationMs === undefined ? undefined : formatDelay(tool.durationMs),
		formatToolOutcome(tool),
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
}: {
	parts: ContentPart[];
	onDownload?: ((artifact: ArtifactRef) => Promise<void>) | undefined;
	onLoadArtifact?: ((artifact: ArtifactRef) => Promise<Blob>) | undefined;
	renderedToolCalls?: Set<string> | undefined;
	imagesFirst?: boolean;
	showImageDownload?: boolean;
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
					return <ToolCard toolName={part.toolName} input={part.input} status="pending" key={index} />;
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
	if (imageInputUnsupported(error)) return "当前模型不支持图片理解";
	if (/browser_open|url parameter|Stream ended without finish_reason/i.test(error)) {
		return "浏览器步骤未完成";
	}
	if (/stream ended|premature close|terminated/i.test(error)) {
		return "模型响应中断";
	}
	if (kind) return failureKindLabel(kind);
	return "这一步没有完成";
}

function failureAdvice(error: string, kind: RunSummary["failureKind"]): string {
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
			return "当前会话的 Token 或费用限额已用尽，请先调整用量限额。";
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
	const retries = actions.run?.retryHistory?.length ?? 0;
	const title = failureTitle(error, kind);
	const action =
		kind === "provider_auth" ? "settings" : kind === "budget" ? "usage" : kind === "user_abort" ? undefined : "retry";
	return (
		<section className="failure-notice" role="alert">
			<div className="failure-notice-heading">
				<CircleAlert size={16} />
				<strong>{title}</strong>
			</div>
			<p>{failureAdvice(error, kind)}</p>
			{retries > 0 && (
				<div className="failure-retry-summary">
					已自动重试 {retries} 次，共尝试 {Math.max(actions.run?.attempt ?? 1, retries + 1)} 次
				</div>
			)}
			<details className="failure-details">
				<summary>技术详情</summary>
				<pre>{redactDiagnostic(error)}</pre>
			</details>
			{action && (
				<div className="failure-actions">
					{action === "retry" && (
						<button
							type="button"
							disabled={actions.busy || actions.disabled}
							title={actions.disabled ? actions.disabledTitle : "重新执行上一条请求"}
							onClick={actions.onRetry}
						>
							<RefreshCw size={14} />
							{actions.busy ? "正在重新执行..." : "重新执行"}
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
}: {
	item: TranscriptItem;
	onDownload: (artifact: ArtifactRef) => Promise<void>;
	onLoadArtifact: (artifact: ArtifactRef) => Promise<Blob>;
	renderedToolCalls?: Set<string> | undefined;
	actions?: MessageActionState | undefined;
	failureActions?: FailureActionState | undefined;
	now: number;
	transcript: TranscriptItem[];
}) {
	if (item.type === "tool") {
		const media = item.content.filter((part) => part.type === "artifact" && isPreviewableMediaArtifact(part.artifact));
		return (
			<div className={`tool-row ${item.isError ? "tool-error" : ""}`}>
				<ToolCard toolName={item.toolName} input={item.input} status={item.status as ToolStatusValue}>
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
	const toolFailureInTurn = item.type === "assistant" && item.error ? hasToolFailureInTurn(transcript, item.id) : false;
	if (toolFailureInTurn && !hasVisibleContent(item.content, renderedToolCalls)) return null;

	const text = messageText(item.content);
	return (
		<div className={`message-row ${item.type}`}>
			{item.type !== "user" && (
				<div className="message-avatar" aria-hidden="true">
					<Sparkles size={16} />
				</div>
			)}
			<div className="message-body">
				<div className="message-meta">
					<strong>{item.type === "user" ? "你" : "Wuming"}</strong>
					{item.type === "assistant" && item.status !== "complete" && <span>{statusLabel(item.status)}</span>}
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
					parts={item.content}
					onDownload={onDownload}
					onLoadArtifact={onLoadArtifact}
					renderedToolCalls={renderedToolCalls}
					imagesFirst={item.type === "user"}
				/>
				{item.type === "assistant" &&
					item.error &&
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
					<strong>Wuming</strong>
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

function RetryActivity({ retry }: { retry: LiveRetry }) {
	return (
		<div className="activity-row retry-activity" role="status" aria-live="assertive" aria-label="正在自动重试">
			<RefreshCw size={14} />
			<span>
				{failureKindLabel(retry.failureKind)}，{formatDelay(retry.delayMs)} 后自动重试
			</span>
			<small>
				第 {retry.nextAttempt}/{retry.maxAttempts} 次
			</small>
		</div>
	);
}

function LiveToolView({
	tool,
	awaitingApproval = false,
	onDownload,
	onLoadArtifact,
}: {
	tool: LiveTool;
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

function ApprovalPanel({
	approval,
	onRespond,
}: {
	approval: ApprovalRequest;
	onRespond: (decision: "approve" | "deny") => Promise<void>;
}) {
	const [responding, setResponding] = useState<"approve" | "deny" | undefined>();
	const [error, setError] = useState<string>();
	const respond = async (decision: "approve" | "deny") => {
		setResponding(decision);
		setError(undefined);
		try {
			await onRespond(decision);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setResponding(undefined);
		}
	};
	return (
		<section className={`approval-panel risk-${approval.risk}`} aria-label="需要批准工具调用">
			<div className="approval-icon">
				<ShieldAlert size={18} />
			</div>
			<div className="approval-copy">
				<div className="approval-heading">
					<strong>需要批准工具调用</strong>
					<span>{riskLabel(approval.risk)}</span>
				</div>
				<p>{approval.summary}</p>
				<div className="approval-capabilities">
					{approval.capabilities.map((capability, index) => (
						<code key={`${capability.type}-${index}`}>{capability.type}</code>
					))}
				</div>
				{error && (
					<div className="message-error">
						<CircleAlert size={14} />
						{error}
					</div>
				)}
			</div>
			<div className="approval-actions">
				<button className="approval-deny" disabled={responding !== undefined} onClick={() => void respond("deny")}>
					<X size={15} /> 拒绝
				</button>
				<button className="approval-allow" disabled={responding !== undefined} onClick={() => void respond("approve")}>
					<Check size={15} /> 允许
				</button>
			</div>
		</section>
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
			return [...actions.slice(0, 4), ...matches, ...actions.slice(4).map((item) => ({ ...item, group: "更多命令" }))];
		}
		return fileItems(files);
	}, [commands, dismissed, files, skills, trigger]);
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
			setUploadError("请等待当前上传或发送完成后，再添加附件");
			return;
		}
		const remaining = Math.max(0, 8 - attachments.length);
		const selected = incoming.slice(0, remaining);
		if (selected.length === 0) {
			setUploadError("每条消息最多添加 8 个附件");
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
			if (incoming.length > selected.length) errors.push("每条消息最多添加 8 个附件");
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
					<strong>松开即可添加文件</strong>
					<span>支持任意文件，可一次添加多个</span>
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
				aria-label="选择附件"
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
						aria-label="不在项目中工作"
						data-tooltip="不在项目中工作"
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
								aria-label={`移除 ${artifact.name}`}
								title={`移除 ${artifact.name}`}
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
				aria-label="消息"
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
							title="取消编辑"
							aria-label="取消编辑"
							disabled={sending || uploading}
							onClick={cancelEdit}
						>
							<X size={17} />
						</button>
					)}
					<button
						type="button"
						className="icon-button"
						title="添加附件"
						disabled={disabled || uploading || attachments.length >= 8}
						onClick={() => fileInput.current?.click()}
					>
						<Paperclip size={17} />
					</button>
					{!active && (
						<PermissionPicker value={permission} disabled={permissionDisabled} onChange={onSelectPermission} />
					)}
					{goalDraft && (
						<span className="composer-goal-target" role="status" title="发送后在当前对话中运行目标">
							<Target size={15} />
							<span>目标</span>
						</span>
					)}
					{uploading && (
						<span className="uploading-label" role="status">
							正在上传...
						</span>
					)}
					{!uploading && contextUsage && <ContextPill usage={contextUsage} />}
					{active && (
						<div className="segmented" aria-label="排队方式">
							<button
								type="button"
								className={queueMode === "steer" ? "active" : ""}
								onClick={() => setQueueMode("steer")}
							>
								立即补充
							</button>
							<button
								type="button"
								className={queueMode === "follow_up" ? "active" : ""}
								onClick={() => setQueueMode("follow_up")}
							>
								后续任务
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
							title="停止任务"
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
						aria-label="发送"
						title={sendDisabled && !localActionDraft ? (sendDisabledReason ?? "Model unavailable") : "发送"}
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

function McpView({
	servers,
	selectedServer,
	onRefresh,
	onSelect,
}: {
	servers: McpServerSummary[];
	selectedServer: McpServer | undefined;
	onRefresh: () => Promise<McpServerSummary[]>;
	onSelect: (serverId: string) => Promise<McpServer | undefined>;
}) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const select = async (serverId: string) => {
		setError(undefined);
		try {
			await onSelect(serverId);
		} catch {
			setError("MCP 工具发现失败。请检查服务启动、协议响应及目录上限，然后刷新或点击服务重试。");
		}
	};
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
	return (
		<section className="skills-workbench" aria-label="MCP 服务">
			<aside className="skills-sidebar">
				<div className="workbench-heading">
					<div>
						<strong>MCP</strong>
						<span>已配置 {servers.length} 个</span>
					</div>
					<button className="icon-button" title="刷新 MCP 服务" disabled={loading} onClick={() => void refresh()}>
						<RefreshCw size={15} />
					</button>
				</div>
				{error && (
					<div className="workbench-error">
						<CircleAlert size={14} />
						{error}
					</div>
				)}
				{servers.map((server) => (
					<button
						className={`skill-entry ${selectedServer?.id === server.id ? "selected" : ""}`}
						key={server.id}
						onClick={() => void select(server.id)}
					>
						<Plug size={14} />
						<span>
							<strong>{server.name}</strong>
							<small>
								{server.discoveryStatus === "disabled"
									? "已禁用 · 不会启动"
									: server.discoveryStatus === "failed"
										? "工具发现失败 · 点击重试"
										: server.trusted
											? `${server.toolCount} 个工具 · ${server.readOnly ? "只读" : "需要批准"}`
											: "未由服务端授信"}
							</small>
						</span>
					</button>
				))}
				{!loading && servers.length === 0 && <div className="workbench-empty">尚未配置 MCP 服务</div>}
			</aside>
			<div className="skills-content">
				{selectedServer ? (
					<>
						<div className="editor-heading">
							<Plug size={15} />
							<strong>{selectedServer.name}</strong>
							<span>{selectedServer.transport}</span>
						</div>
						<div className="mcp-tool-list">
							{selectedServer.tools.map((tool) => (
								<article className="mcp-tool" key={tool.name}>
									<div>
										<strong>{tool.name}</strong>
										<span>{tool.description || "暂无说明"}</span>
									</div>
									{tool.inputSchema && <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>}
								</article>
							))}
							{selectedServer.tools.length === 0 && (
								<div className="workbench-empty">
									{selectedServer.discoveryStatus === "disabled"
										? "服务已禁用，不会启动"
										: selectedServer.trusted
											? "该服务未提供工具"
											: "服务未授信，不会启动"}
								</div>
							)}
						</div>
					</>
				) : (
					<div className="workbench-empty">
						<Plug size={24} />
						<span>选择一个 MCP 服务</span>
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

type SubagentFilter = "all" | "active" | "completed" | "attention";

const SUBAGENT_ACTIVE_STATUSES: readonly SubagentSummary["status"][] = [
	"queued",
	"running",
	"awaiting_approval",
	"cancelling",
];

function SubagentsView({
	subagents,
	depth,
	canCreate,
	disabled,
	onCreate,
	onCancel,
	onOpenSession,
	onRespondApproval,
	onRefresh,
}: {
	subagents: SubagentSummary[];
	depth: number;
	canCreate: boolean;
	disabled: boolean;
	onCreate: (input: {
		task: string;
		name?: string;
		costBudgetUsd?: number;
		tokenBudget?: number;
	}) => Promise<SubagentSummary>;
	onCancel: (subagentId: string) => Promise<SubagentSummary>;
	onOpenSession: (sessionId: string) => Promise<void>;
	onRespondApproval: (sessionId: string, approvalId: string, decision: "approve" | "deny") => Promise<void>;
	onRefresh: () => Promise<SubagentSummary[]>;
}) {
	const [selectedId, setSelectedId] = useState<string>();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<SubagentFilter>("all");
	const [task, setTask] = useState("");
	const [name, setName] = useState("");
	const [costBudget, setCostBudget] = useState("");
	const [tokenBudget, setTokenBudget] = useState("");
	const [creating, setCreating] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string>();
	const taskInput = useRef<HTMLTextAreaElement>(null);
	const counts = useMemo(
		() => ({
			all: subagents.length,
			active: subagents.filter((subagent) => SUBAGENT_ACTIVE_STATUSES.includes(subagent.status)).length,
			completed: subagents.filter((subagent) => subagent.status === "completed").length,
			attention: subagents.filter((subagent) => subagent.status === "failed" || subagent.status === "cancelled").length,
		}),
		[subagents]
	);
	const visibleSubagents = useMemo(() => {
		const normalizedQuery = query.trim().toLocaleLowerCase();
		return subagents.filter((subagent) => {
			const matchesQuery =
				!normalizedQuery || `${subagent.name}\n${subagent.task}`.toLocaleLowerCase().includes(normalizedQuery);
			const matchesStatus =
				filter === "all" ||
				(filter === "active" && SUBAGENT_ACTIVE_STATUSES.includes(subagent.status)) ||
				(filter === "completed" && subagent.status === "completed") ||
				(filter === "attention" && (subagent.status === "failed" || subagent.status === "cancelled"));
			return matchesQuery && matchesStatus;
		});
	}, [filter, query, subagents]);
	const selected = visibleSubagents.find((subagent) => subagent.id === selectedId) ?? visibleSubagents[0];

	useEffect(() => {
		if (!selectedId || !visibleSubagents.some((subagent) => subagent.id === selectedId))
			setSelectedId(visibleSubagents[0]?.id);
	}, [selectedId, visibleSubagents]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const normalizedTask = task.trim();
		const cost = costBudget.trim() ? Number(costBudget) : undefined;
		const tokens = tokenBudget.trim() ? Number(tokenBudget) : undefined;
		if (!normalizedTask) return setError("请填写任务内容");
		if (cost !== undefined && (!Number.isFinite(cost) || cost <= 0)) return setError("费用限额必须大于 0");
		if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens <= 0))
			return setError("Token 限额必须是正整数");
		setCreating(true);
		setError(undefined);
		try {
			const created = await onCreate({
				task: normalizedTask,
				...(name.trim() ? { name: name.trim() } : {}),
				...(cost === undefined ? {} : { costBudgetUsd: cost }),
				...(tokens === undefined ? {} : { tokenBudget: tokens }),
			});
			setSelectedId(created.id);
			setTask("");
			setName("");
			setCostBudget("");
			setTokenBudget("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setCreating(false);
		}
	};

	const refresh = async () => {
		setRefreshing(true);
		setError(undefined);
		try {
			await onRefresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRefreshing(false);
		}
	};

	const cancel = async () => {
		if (!selected) return;
		setCancelling(true);
		setError(undefined);
		try {
			await onCancel(selected.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setCancelling(false);
		}
	};

	const openSession = async () => {
		if (!selected || opening) return;
		setOpening(true);
		setError(undefined);
		try {
			await onOpenSession(selected.sessionId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setOpening(false);
		}
	};

	const reuse = () => {
		if (!selected) return;
		setTask(selected.task);
		setName(selected.name);
		setCostBudget(selected.costBudgetUsd?.toString() ?? "");
		setTokenBudget(selected.tokenBudget?.toString() ?? "");
		setError(undefined);
		requestAnimationFrame(() => taskInput.current?.focus());
	};

	const active = selected && SUBAGENT_ACTIVE_STATUSES.includes(selected.status);
	return (
		<section className="subagents-workbench" aria-label="子智能体">
			<aside className="subagents-sidebar">
				<div className="workbench-heading">
					<div>
						<strong>智能体</strong>
						<span>
							{depth > 0 ? `第 ${depth} 层 · ` : ""}
							{subagents.length} 个任务
						</span>
					</div>
					<button className="icon-button" title="刷新智能体" disabled={refreshing} onClick={() => void refresh()}>
						<RefreshCw size={15} />
					</button>
				</div>
				{canCreate ? (
					<form className="subagent-create" onSubmit={(event) => void submit(event)}>
						<label>
							<span>任务</span>
							<textarea
								ref={taskInput}
								rows={4}
								maxLength={20_000}
								placeholder="调查问题并汇报结果"
								value={task}
								onChange={(event) => setTask(event.target.value)}
							/>
						</label>
						<label>
							<span>名称</span>
							<input
								maxLength={500}
								placeholder="可选"
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
						</label>
						<div className="subagent-budget-fields">
							<label>
								<span>费用限额（USD）</span>
								<input
									inputMode="decimal"
									placeholder="继承主会话"
									value={costBudget}
									onChange={(event) => setCostBudget(event.target.value)}
								/>
							</label>
							<label>
								<span>Token 限额</span>
								<input
									inputMode="numeric"
									placeholder="继承主会话"
									value={tokenBudget}
									onChange={(event) => setTokenBudget(event.target.value)}
								/>
							</label>
						</div>
						<button className="subagent-create-button" type="submit" disabled={disabled || creating || !task.trim()}>
							<Plus size={15} />
							{creating ? "正在创建..." : "创建智能体"}
						</button>
					</form>
				) : (
					<div className="subagent-depth-limit">
						<ShieldAlert size={15} />
						<span>
							<strong>已到达 3 层上限</strong>
							<small>当前智能体不能继续委派，可返回上层管理协作树。</small>
						</span>
					</div>
				)}
				{error && (
					<div className="workbench-error">
						<CircleAlert size={14} />
						{error}
					</div>
				)}
				<div className="subagent-list-controls">
					<label className="subagent-search">
						<Search size={13} />
						<input
							aria-label="搜索智能体"
							placeholder="搜索名称或任务"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<div className="subagent-filters" role="tablist" aria-label="智能体状态筛选">
						{(
							[
								["all", "全部"],
								["active", "进行中"],
								["completed", "已完成"],
								["attention", "需关注"],
							] as const
						).map(([value, label]) => (
							<button
								role="tab"
								aria-selected={filter === value}
								className={filter === value ? "active" : ""}
								type="button"
								key={value}
								onClick={() => setFilter(value)}
							>
								<span>{label}</span>
								<small>{counts[value]}</small>
							</button>
						))}
					</div>
				</div>
				<nav className="subagent-list" aria-label="智能体任务">
					{visibleSubagents.map((subagent) => (
						<button
							className={`subagent-entry ${selected?.id === subagent.id ? "selected" : ""}`}
							type="button"
							key={subagent.id}
							onClick={() => setSelectedId(subagent.id)}
						>
							<i className={`subagent-status status-${subagent.status}`} />
							<span>
								<strong>{subagent.name}</strong>
								<small>
									{statusLabel(subagent.status)} · {formatRunTime(subagent.updatedAt)}
								</small>
							</span>
						</button>
					))}
					{subagents.length === 0 && <div className="subagent-list-empty">暂无智能体任务</div>}
					{subagents.length > 0 && visibleSubagents.length === 0 && (
						<div className="subagent-list-empty">没有符合条件的任务</div>
					)}
				</nav>
			</aside>
			<div className="subagent-detail">
				{selected ? (
					<>
						<header className="subagent-detail-heading">
							<div>
								<Bot size={16} />
								<span>
									<strong>{selected.name}</strong>
									<small>
										{selected.model.provider}/{selected.model.id}
									</small>
								</span>
							</div>
							<div className="subagent-actions">
								<button
									className="subagent-secondary-action"
									type="button"
									title={canCreate ? "复制任务配置" : "当前已到达智能体层级上限"}
									disabled={opening || !canCreate}
									onClick={reuse}
								>
									<Copy size={13} />
									复制任务
								</button>
								<button
									className="subagent-primary-action"
									type="button"
									title="打开智能体完整对话"
									disabled={opening}
									onClick={() => void openSession()}
								>
									{opening ? <RefreshCw className="spin" size={13} /> : <MessageSquareCode size={13} />}
									{opening ? "正在打开" : "打开对话"}
								</button>
								{active && (
									<button
										className="subagent-cancel"
										type="button"
										title="取消智能体任务"
										disabled={cancelling || selected.status === "cancelling"}
										onClick={() => void cancel()}
									>
										<Square size={13} />
										{selected.status === "cancelling" ? "正在取消" : "取消"}
									</button>
								)}
							</div>
						</header>
						<div className="subagent-detail-scroll">
							<div className="subagent-meta">
								<span className={`subagent-status-label status-${selected.status}`}>
									<i />
									{statusLabel(selected.status)}
								</span>
								<span>第 {selected.depth} 层</span>
								<span>{formatTokens(selected.usage.totalTokens)} Token</span>
								<span>{formatMoney(selected.usage.costUsd)}</span>
								{selected.startedAt && (
									<span>
										{formatDuration(
											selected.startedAt,
											selected.finishedAt ??
												(["running", "awaiting_approval", "cancelling"].includes(selected.status)
													? Date.now()
													: selected.updatedAt)
										)}
									</span>
								)}
								{selected.costBudgetUsd && <span>限额 {formatMoney(selected.costBudgetUsd)}</span>}
								{selected.tokenBudget && <span>限额 {formatTokens(selected.tokenBudget)} Token</span>}
							</div>
							<section className="subagent-section">
								<h2>任务</h2>
								<p>{selected.task}</p>
							</section>
							{selected.pendingApprovals.map((approval) => (
								<ApprovalPanel
									key={approval.id}
									approval={approval}
									onRespond={(decision) => onRespondApproval(selected.sessionId, approval.id, decision)}
								/>
							))}
							{selected.result !== undefined && (
								<section className="subagent-section">
									<h2>结果</h2>
									{selected.result ? (
										<Markdown text={selected.result} className="prose subagent-result" />
									) : (
										<p>任务已完成，但没有文本结果。</p>
									)}
								</section>
							)}
							{selected.error && (
								<section className="subagent-error">
									<CircleAlert size={15} />
									<span>{selected.error}</span>
								</section>
							)}
							{active && selected.pendingApprovals.length === 0 && (
								<div className="subagent-running">
									<Activity size={17} />
									<span>
										{selected.status === "queued"
											? "等待开始"
											: selected.status === "cancelling"
												? "正在停止任务"
												: "正在工作"}
									</span>
								</div>
							)}
						</div>
					</>
				) : (
					<div className="workbench-empty">
						<Bot size={24} />
						<span>
							{subagents.length === 0
								? canCreate
									? "创建一个智能体任务"
									: "当前层级不可继续委派"
								: "没有符合条件的任务"}
						</span>
					</div>
				)}
			</div>
		</section>
	);
}

const GOAL_ACTIVE_STATUSES: readonly GoalSummary["status"][] = ["queued", "running", "awaiting_approval", "cancelling"];
const GOAL_REVIEW_ROUND_CHOICES: readonly number[] = [1, 2, 3, 4, 5];

const GOAL_REVIEW_PHASE_LABELS: Record<NonNullable<GoalSummary["reviewPhase"]>, string> = {
	pending: "尚未开始",
	executing: "正在执行",
	reviewing: "正在评审",
	passed: "评审通过",
	failed: "评审未通过",
	cancelled: "已取消",
};

/** The review phase is finer grained than the goal status: a goal being reviewed still reports "running". */
function goalActivityLabel(goal: GoalSummary): string {
	if (goal.status === "cancelling") return "正在停止";
	if (goal.status === "awaiting_approval") return "等待批准工具调用";
	if (goal.status === "queued") return "等待开始";
	if (goal.reviewPhase === "reviewing")
		return goal.round === undefined ? "正在评审结果" : `正在评审第 ${goal.round} 轮结果`;
	if (goal.reviewPhase === "executing" && goal.round !== undefined) return `正在执行第 ${goal.round} 轮`;
	return "正在执行";
}

function GoalsView({
	goals,
	focusGoalId,
	disabled,
	archived,
	onCreate,
	onStart,
	onPause,
	onResume,
	onCancel,
	onDelete,
	onRespondApproval,
	onRefresh,
	onOpenSession,
}: {
	goals: GoalSummary[];
	focusGoalId: string | undefined;
	disabled: boolean;
	archived: boolean;
	onCreate: (input: {
		objective: string;
		title?: string;
		successCriteria?: string;
		maxRounds?: number;
		plan?: GoalPlanSpec;
	}) => Promise<GoalSummary>;
	onStart: (goalId: string) => Promise<GoalSummary>;
	onPause: (goalId: string) => Promise<GoalSummary>;
	onResume: (goalId: string) => Promise<GoalSummary>;
	onCancel: (goalId: string) => Promise<GoalSummary>;
	onDelete: (goalId: string) => Promise<string>;
	onRespondApproval: (sessionId: string, approvalId: string, decision: "approve" | "deny") => Promise<void>;
	onRefresh: () => Promise<GoalSummary[]>;
	onOpenSession: (sessionId: string) => Promise<void>;
}) {
	const [selectedId, setSelectedId] = useState<string>();
	const [title, setTitle] = useState("");
	const [objective, setObjective] = useState("");
	const [reviewEnabled, setReviewEnabled] = useState(false);
	const [successCriteria, setSuccessCriteria] = useState("");
	const [maxRounds, setMaxRounds] = useState(3);
	const [creating, setCreating] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [action, setAction] = useState<{ goalId: string; kind: "start" | "pause" | "resume" | "cancel" | "delete" }>();
	const [formError, setFormError] = useState<string>();
	const [actionError, setActionError] = useState<string>();
	const [now, setNow] = useState(() => Date.now());
	const selected = goals.find((goal) => goal.id === selectedId) ?? goals[0];
	const [planEnabled, setPlanEnabled] = useState(false);
	const [plan, setPlan] = useState<GoalPlanSpec>(newGoalPlan);

	useEffect(() => {
		if (!selectedId || !goals.some((goal) => goal.id === selectedId)) setSelectedId(goals[0]?.id);
	}, [goals, selectedId]);

	useEffect(() => {
		if (focusGoalId && goals.some((goal) => goal.id === focusGoalId)) setSelectedId(focusGoalId);
	}, [focusGoalId, goals]);

	useEffect(() => {
		if (!selected || !GOAL_ACTIVE_STATUSES.includes(selected.status)) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [selected?.id, selected?.status]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (creating || disabled) return;
		const normalizedObjective = objective.trim();
		if (!normalizedObjective) return setFormError("请填写目标描述");
		const normalizedCriteria = successCriteria.trim();
		if (reviewEnabled && !normalizedCriteria) return setFormError("启用评审循环时请填写成功标准");
		setCreating(true);
		setFormError(undefined);
		try {
			const created = await onCreate({
				objective: normalizedObjective,
				...(title.trim() ? { title: title.trim() } : {}),
				...(planEnabled ? { plan } : {}),
				...(reviewEnabled ? { successCriteria: normalizedCriteria, maxRounds } : {}),
			});
			setSelectedId(created.id);
			setActionError(undefined);
			setPlanEnabled(false);
			setPlan(newGoalPlan());
			setTitle("");
			setObjective("");
			setSuccessCriteria("");
			setReviewEnabled(false);
			setMaxRounds(3);
		} catch (cause) {
			setFormError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setCreating(false);
		}
	};

	const refresh = async () => {
		if (refreshing) return;
		setRefreshing(true);
		setFormError(undefined);
		try {
			await onRefresh();
		} catch (cause) {
			setFormError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRefreshing(false);
		}
	};

	const act = async (goalId: string, kind: "start" | "pause" | "resume" | "cancel" | "delete") => {
		if (action || disabled) return;
		setAction({ goalId, kind });
		setActionError(undefined);
		try {
			if (kind === "start") await onStart(goalId);
			else if (kind === "pause") await onPause(goalId);
			else if (kind === "resume") await onResume(goalId);
			else if (kind === "cancel") await onCancel(goalId);
			else await onDelete(goalId);
		} catch (cause) {
			setActionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setAction(undefined);
		}
	};

	const active = selected !== undefined && GOAL_ACTIVE_STATUSES.includes(selected.status);
	const starting = selected !== undefined && action?.goalId === selected.id && action.kind === "start";
	const cancelling = selected !== undefined && action?.goalId === selected.id && action.kind === "cancel";
	const pausing = selected !== undefined && action?.goalId === selected.id && action.kind === "pause";
	const resuming = selected !== undefined && action?.goalId === selected.id && action.kind === "resume";
	const elapsedMs = selected
		? selected.pausedAt !== undefined
			? (selected.accumulatedRunMs ?? 0)
			: (selected.accumulatedRunMs ?? 0) +
				(selected.startedAt === undefined ? 0 : Math.max(0, (selected.finishedAt ?? now) - selected.startedAt))
		: 0;
	return (
		<section className="subagents-workbench goals-workbench" aria-label="目标">
			<aside className="subagents-sidebar">
				<div className="workbench-heading">
					<div>
						<strong>目标</strong>
						<span>{goals.length} 个目标</span>
					</div>
					<button className="icon-button" title="刷新目标" disabled={refreshing} onClick={() => void refresh()}>
						<RefreshCw className={refreshing ? "spin" : ""} size={15} />
					</button>
				</div>
				<form className="subagent-create goal-create" onSubmit={(event) => void submit(event)}>
					<label>
						<span>目标</span>
						<textarea
							rows={4}
							maxLength={20_000}
							required
							placeholder="交付内容与完成条件"
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
									placeholder="评审判定通过的条件"
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
						disabled={disabled || creating || !objective.trim() || (reviewEnabled && !successCriteria.trim())}
					>
						{creating ? <RefreshCw className="spin" size={15} /> : <Plus size={15} />}
						{creating ? "正在创建..." : "创建目标"}
					</button>
				</form>
				{archived && (
					<div className="goal-readonly">
						<Archive size={14} />
						已归档会话为只读状态，无法创建或控制目标
					</div>
				)}
				{formError && (
					<div className="workbench-error">
						<CircleAlert size={14} />
						{formError}
					</div>
				)}
				<nav className="subagent-list" aria-label="目标列表">
					{goals.map((goal) => (
						<button
							className={`subagent-entry ${selected?.id === goal.id ? "selected" : ""}`}
							type="button"
							key={goal.id}
							onClick={() => setSelectedId(goal.id)}
						>
							<i className={`subagent-status status-${goal.status}`} />
							<span>
								<strong>{goal.title}</strong>
								<small>
									{statusLabel(goal.status)} · {formatRunTime(goal.updatedAt)}
								</small>
							</span>
						</button>
					))}
					{goals.length === 0 && <div className="subagent-list-empty">暂无目标</div>}
				</nav>
			</aside>
			<div className="subagent-detail">
				{selected ? (
					<>
						<header className="subagent-detail-heading">
							<div>
								<Target size={16} />
								<span>
									<strong>{selected.title}</strong>
									<small>{selected.id}</small>
								</span>
							</div>
							<div className="goal-actions">
								{selected.status === "pending" && (
									<button
										className="goal-start"
										type="button"
										title="启动目标"
										disabled={disabled || action !== undefined}
										onClick={() => void act(selected.id, "start")}
									>
										{starting ? <RefreshCw className="spin" size={13} /> : <Play size={13} />}
										{starting ? "正在启动" : "启动"}
									</button>
								)}
								{selected.status === "paused" && (
									<button
										className="goal-start"
										type="button"
										title="继续目标"
										disabled={disabled || action !== undefined}
										onClick={() => void act(selected.id, "resume")}
									>
										{resuming ? <RefreshCw className="spin" size={13} /> : <Play size={13} />}
										{resuming ? "正在继续" : "继续"}
									</button>
								)}
								{GOAL_ACTIVE_STATUSES.includes(selected.status) && (
									<button
										className="goal-start"
										type="button"
										title="暂停目标"
										disabled={disabled || action !== undefined}
										onClick={() => void act(selected.id, "pause")}
									>
										{pausing ? <RefreshCw className="spin" size={13} /> : <Pause size={13} />}
										{pausing ? "正在暂停" : "暂停"}
									</button>
								)}
								{(selected.status === "pending" || active) && (
									<button
										className="subagent-cancel"
										type="button"
										title="取消目标"
										disabled={disabled || action !== undefined || selected.status === "cancelling"}
										onClick={() => void act(selected.id, "cancel")}
									>
										{cancelling ? <RefreshCw className="spin" size={13} /> : <Square size={13} />}
										{selected.status === "cancelling" ? "正在取消" : cancelling ? "正在取消" : "取消"}
									</button>
								)}
								{(selected.status === "paused" || ["completed", "failed", "cancelled"].includes(selected.status)) && (
									<button
										className="subagent-cancel"
										type="button"
										title="删除目标"
										disabled={disabled || action !== undefined}
										onClick={() => void act(selected.id, "delete")}
									>
										{action?.kind === "delete" ? <RefreshCw className="spin" size={13} /> : <Trash2 size={13} />}
										{action?.kind === "delete" ? "正在删除" : "删除"}
									</button>
								)}
							</div>
						</header>
						<div className="subagent-detail-scroll">
							<div className="subagent-meta">
								<span className={`subagent-status-label status-${selected.status}`}>
									<i />
									{statusLabel(selected.status)}
								</span>
								<span>{formatTokens(selected.usage.totalTokens)} Token</span>
								<span>{formatMoney(selected.usage.costUsd)}</span>
								{(selected.startedAt !== undefined || selected.accumulatedRunMs !== undefined) && (
									<span>已运行 {formatElapsedDuration(elapsedMs)}</span>
								)}
							</div>
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
							{selected.plan && <GoalPlanView plan={selected.plan} onOpenSession={onOpenSession} />}
							{selected.status === "pending" && (
								<div className="goal-pending">
									<Hourglass size={15} />
									<span>目标已创建但尚未启动，点击“启动”开始后台执行。</span>
								</div>
							)}
							{selected.successCriteria && (
								<section className="subagent-section">
									<h2>成功标准</h2>
									<p>{selected.successCriteria}</p>
								</section>
							)}
							{selected.reviewPhase !== undefined && (
								<section className="subagent-section goal-review-section">
									<h2>评审循环</h2>
									<div className="goal-review-meta">
										<span className={`goal-review-phase phase-${selected.reviewPhase}`}>
											<i />
											{GOAL_REVIEW_PHASE_LABELS[selected.reviewPhase]}
										</span>
										{selected.maxRounds !== undefined && (
											<span>
												{(selected.round ?? 0) >= 1
													? `第 ${selected.round}/${selected.maxRounds} 轮`
													: `最多 ${selected.maxRounds} 轮`}
											</span>
										)}
									</div>
									{selected.reviewHistory !== undefined && selected.reviewHistory.length > 0 ? (
										<ol className="goal-review-history" aria-label="评审记录">
											{selected.reviewHistory.map((record) => (
												<li className={`goal-review-record verdict-${record.verdict}`} key={record.round}>
													<div className="goal-review-record-heading">
														<strong>第 {record.round} 轮</strong>
														<span className="goal-review-verdict">
															{record.verdict === "pass" ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
															{record.verdict === "pass" ? "通过" : "未通过"}
														</span>
														<small>{formatRunTime(record.reviewedAt)}</small>
													</div>
													<p className="goal-review-feedback">{record.feedback || "评审未给出说明。"}</p>
													{record.checks !== undefined && (
														<ul className="goal-review-checks" aria-label={`第 ${record.round} 轮验收项`}>
															{record.checks.map((check, index) => (
																<li className={`status-${check.status}`} key={`${check.criterion}-${index}`}>
																	<div>
																		{check.status === "pass" ? <Check size={12} /> : <X size={12} />}
																		<strong>{check.criterion}</strong>
																	</div>
																	<p>{check.evidence}</p>
																</li>
															))}
														</ul>
													)}
													<div className="goal-review-tools">
														<Wrench size={11} />
														<strong>工具轨迹</strong>
														{record.toolsUsed?.length ? (
															record.toolsUsed.map((tool) => <code key={tool}>{tool}</code>)
														) : (
															<small>本轮未记录工具调用</small>
														)}
													</div>
												</li>
											))}
										</ol>
									) : (
										<p className="goal-review-empty">尚无评审记录。</p>
									)}
								</section>
							)}
							<section className="subagent-section goal-usage-section">
								<h2>用量</h2>
								<dl className="goal-usage">
									<div>
										<dt>输入</dt>
										<dd>{formatTokens(selected.usage.inputTokens)}</dd>
									</div>
									<div>
										<dt>输出</dt>
										<dd>{formatTokens(selected.usage.outputTokens)}</dd>
									</div>
									<div>
										<dt>缓存读</dt>
										<dd>{formatTokens(selected.usage.cacheReadTokens)}</dd>
									</div>
									<div>
										<dt>缓存写</dt>
										<dd>{formatTokens(selected.usage.cacheWriteTokens)}</dd>
									</div>
									<div>
										<dt>合计</dt>
										<dd>{formatTokens(selected.usage.totalTokens)}</dd>
									</div>
									<div>
										<dt>成本</dt>
										<dd>{formatMoney(selected.usage.costUsd)}</dd>
									</div>
								</dl>
							</section>
							{selected.pendingApprovals.map((approval) => (
								<ApprovalPanel
									key={approval.id}
									approval={approval}
									onRespond={(decision) => onRespondApproval(approval.sessionId, approval.id, decision)}
								/>
							))}
							{selected.result !== undefined && (
								<section className="subagent-section">
									<h2>结果</h2>
									<pre>{selected.result || "目标已完成，但没有文本结果。"}</pre>
								</section>
							)}
							{selected.error && (
								<section className="subagent-error">
									<CircleAlert size={15} />
									<span>{selected.error}</span>
								</section>
							)}
							{active && selected.pendingApprovals.length === 0 && (
								<div className="subagent-running">
									<Activity size={17} />
									<span>{goalActivityLabel(selected)}</span>
								</div>
							)}
						</div>
					</>
				) : (
					<div className="workbench-empty">
						<Target size={24} />
						<span>创建一个目标</span>
					</div>
				)}
			</div>
		</section>
	);
}

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
	return schedule.kind === "once"
		? `一次 · ${formatAutomationTime(schedule.runAt)}`
		: `每 ${schedule.everyMinutes} 分钟 · ${formatAutomationTime(schedule.startsAt)} 起`;
}

function AutomationsView({
	automations,
	disabled,
	archived,
	onCreate,
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
	onCreate: (input: {
		objective: string;
		title?: string;
		schedule: AutomationSchedule;
		successCriteria?: string;
		maxRounds?: number;
		plan?: GoalPlanSpec;
	}) => Promise<GoalAutomationSummary>;
	onSetEnabled: (automationId: string, enabled: boolean) => Promise<GoalAutomationSummary>;
	onTrigger: (automationId: string) => Promise<AutomationRunSummary>;
	onListRuns: (automationId: string, limit?: number) => Promise<AutomationRunSummary[]>;
	onRespondApproval: (sessionId: string, approvalId: string, decision: "approve" | "deny") => Promise<void>;
	onRefresh: () => Promise<GoalAutomationSummary[]>;
	onOpenSession: (sessionId: string) => Promise<void>;
}) {
	const [selectedId, setSelectedId] = useState<string>();
	const [showCreate, setShowCreate] = useState(false);
	const [title, setTitle] = useState("");
	const [objective, setObjective] = useState("");
	const [scheduleKind, setScheduleKind] = useState<AutomationSchedule["kind"]>("interval");
	const [scheduledAt, setScheduledAt] = useState(() => dateTimeLocalValue(Date.now() + 5 * 60_000));
	const [everyMinutes, setEveryMinutes] = useState(60);
	const [reviewEnabled, setReviewEnabled] = useState(false);
	const [successCriteria, setSuccessCriteria] = useState("");
	const [maxRounds, setMaxRounds] = useState(3);
	const [creating, setCreating] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [action, setAction] = useState<{ automationId: string; kind: "toggle" | "trigger" }>();
	const [runs, setRuns] = useState<AutomationRunSummary[]>([]);
	const [runsLoading, setRunsLoading] = useState(false);
	const [formError, setFormError] = useState<string>();
	const [actionError, setActionError] = useState<string>();
	const selected = automations.find((automation) => automation.id === selectedId) ?? automations[0];
	const [planEnabled, setPlanEnabled] = useState(false);
	const [plan, setPlan] = useState<GoalPlanSpec>(newGoalPlan);
	const hasActiveRuns = runs.some((run) => AUTOMATION_RUN_ACTIVE_STATUSES.includes(run.status));

	useEffect(() => {
		if (!selectedId || !automations.some((automation) => automation.id === selectedId))
			setSelectedId(automations[0]?.id);
	}, [automations, selectedId]);

	const loadRuns = useCallback(
		async (automationId: string, quiet = false) => {
			if (!quiet) setRunsLoading(true);
			try {
				const nextRuns = await onListRuns(automationId);
				setRuns(nextRuns);
				setActionError(undefined);
			} catch (cause) {
				setActionError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (!quiet) setRunsLoading(false);
			}
		},
		[onListRuns]
	);

	useEffect(() => {
		if (!selected) {
			setRuns([]);
			return;
		}
		void loadRuns(selected.id);
	}, [loadRuns, selected?.id]);

	useEffect(() => {
		if (!selected || !hasActiveRuns) return;
		const timer = setInterval(() => void loadRuns(selected.id, true), 1500);
		return () => clearInterval(timer);
	}, [hasActiveRuns, loadRuns, selected?.id]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (creating || disabled) return;
		const normalizedObjective = objective.trim();
		const normalizedCriteria = successCriteria.trim();
		const timestamp = new Date(scheduledAt).getTime();
		if (!normalizedObjective) return setFormError("请填写自动化目标");
		if (!Number.isFinite(timestamp)) return setFormError("请选择有效的执行时间");
		if (
			scheduleKind === "interval" &&
			(!Number.isSafeInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 525_600)
		)
			return setFormError("执行间隔必须在 1 到 525600 分钟之间");
		if (reviewEnabled && !normalizedCriteria) return setFormError("启用评审循环时请填写成功标准");
		const schedule: AutomationSchedule =
			scheduleKind === "once"
				? { kind: "once", runAt: timestamp }
				: { kind: "interval", startsAt: timestamp, everyMinutes };
		setCreating(true);
		setFormError(undefined);
		try {
			const created = await onCreate({
				objective: normalizedObjective,
				schedule,
				...(planEnabled ? { plan } : {}),
				...(title.trim() ? { title: title.trim() } : {}),
				...(reviewEnabled ? { successCriteria: normalizedCriteria, maxRounds } : {}),
			});
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

	const act = async (automation: GoalAutomationSummary, kind: "toggle" | "trigger") => {
		if (action || disabled) return;
		setAction({ automationId: automation.id, kind });
		setActionError(undefined);
		try {
			if (kind === "toggle") {
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
							disabled={disabled}
							onClick={() => {
								setShowCreate((value) => !value);
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
				{showCreate && (
					<form className="subagent-create automation-create" onSubmit={(event) => void submit(event)}>
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
						</div>
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
							disabled={disabled || creating || !objective.trim() || (reviewEnabled && !successCriteria.trim())}
						>
							{creating ? <RefreshCw className="spin" size={15} /> : <CalendarClock size={15} />}
							{creating ? "正在创建..." : "创建自动化"}
						</button>
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
								<span>
									{selected.schedule.kind === "once" ? "一次性" : `每 ${selected.schedule.everyMinutes} 分钟`}
								</span>
								{selected.nextRunAt !== undefined && <span>下次 {formatAutomationTime(selected.nextRunAt)}</span>}
								{selected.lastRunAt !== undefined && <span>上次 {formatAutomationTime(selected.lastRunAt)}</span>}
							</div>
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
	workspaceId,
	workspaceName,
	models,
	onRefresh,
}: {
	overview: UsageOverview | undefined;
	snapshot: SessionSnapshot | undefined;
	workspaceId: string | undefined;
	workspaceName: string;
	models: ModelMetadata[];
	onRefresh: (days: UsageRange) => Promise<UsageOverview | undefined>;
}) {
	const { locale, t } = useLocale();
	const [range, setRange] = useState<UsageRange>(7);
	const [data, setData] = useState<UsageOverview | undefined>(overview);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const session = snapshot?.session.workspaceId === workspaceId ? snapshot : undefined;

	useEffect(() => {
		setRange(7);
		setData(overview?.workspaceId === workspaceId ? overview : undefined);
		setError(undefined);
	}, [workspaceId]);

	useEffect(() => {
		if (!overview || overview.workspaceId !== workspaceId) return;
		setData((current) =>
			range === 7 || !current
				? overview
				: {
						...current,
						generatedAt: overview.generatedAt,
						total: overview.total,
						totalTurnCount: overview.totalTurnCount,
						totalRequestCount: overview.totalRequestCount,
						today: overview.today,
						month: overview.month,
					}
		);
	}, [overview, range, workspaceId]);

	const refresh = async (nextRange: UsageRange) => {
		if (!workspaceId) return;
		setLoading(true);
		setError(undefined);
		try {
			const next = await onRefresh(nextRange);
			if (!next) throw new Error(t("usageLoadFailed"));
			setData(next);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("usageLoadFailed"));
		} finally {
			setLoading(false);
		}
	};

	const selectRange = (nextRange: UsageRange) => {
		setRange(nextRange);
		void refresh(nextRange);
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
			label: t("usageAllTime"),
			usage: data?.total,
			meta: data ? t("usageRequestsTurns", { requests: data.totalRequestCount, turns: data.totalTurnCount }) : "",
		},
	];

	if (!workspaceId) {
		return (
			<div className="settings-empty-state usage-settings-empty">
				<BarChart3 size={22} />
				<strong>{t("usageNoWorkspace")}</strong>
			</div>
		);
	}

	return (
		<div className="usage-settings">
			<div className="usage-settings-toolbar">
				<div>
					<span>{t("usageWorkspace")}</span>
					<strong>{workspaceName}</strong>
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
						onClick={() => void refresh(range)}
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
		if (cost !== null && (!Number.isFinite(cost) || cost <= 0)) return setError("费用限额必须大于 0");
		if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0)) return setError("Token 限额必须是正整数");
		if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100)
			return setError("预警阈值必须在 1 到 100 之间");
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
				<h2>用量</h2>
				{!editing && (
					<button
						className="rail-icon-button"
						type="button"
						title="编辑会话限额"
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
					<span>今天</span>
					<strong>{overview ? formatTokens(overview.today.totalTokens) : "--"}</strong>
					<small>{overview ? formatMoney(overview.today.costUsd) : "正在统计"}</small>
				</div>
				<div>
					<span>本月</span>
					<strong>{overview ? formatTokens(overview.month.totalTokens) : "--"}</strong>
					<small>{overview ? formatMoney(overview.month.costUsd) : "正在统计"}</small>
				</div>
			</div>
			{overview && (
				<div className="usage-trend">
					<div className="usage-trend-heading">
						<span>近 7 天</span>
						<span>Token</span>
					</div>
					<div className="usage-chart" role="img" aria-label="最近 7 天 Token 用量">
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
								<small>{index === overview.daily.length - 1 ? "今天" : entry.date.slice(5).replace("-", "/")}</small>
							</div>
						))}
					</div>
				</div>
			)}
			<div className="usage-session">
				<span>本次会话</span>
				<strong>
					{formatTokens(snapshot.usage.totalTokens)} <small>· {formatMoney(snapshot.usage.costUsd)}</small>
				</strong>
			</div>
			{snapshot.costBudgetUsd !== undefined && (
				<div className="kv">
					<span>剩余费用</span>
					<strong>{formatMoney(Math.max(0, snapshot.costBudgetUsd - snapshot.usage.costUsd))}</strong>
				</div>
			)}
			{snapshot.tokenBudget !== undefined && (
				<div className="kv">
					<span>剩余 Token</span>
					<strong>{formatTokens(Math.max(0, snapshot.tokenBudget - snapshot.usage.totalTokens))}</strong>
				</div>
			)}
			{((snapshot.costBudgetUsd !== undefined &&
				snapshot.usage.costUsd / snapshot.costBudgetUsd >= (snapshot.budgetWarningThreshold ?? 0.8)) ||
				(snapshot.tokenBudget !== undefined &&
					snapshot.usage.totalTokens / snapshot.tokenBudget >= (snapshot.budgetWarningThreshold ?? 0.8))) && (
				<div className="budget-warning">
					<CircleAlert size={13} />
					用量预警
				</div>
			)}
			{snapshot.budgetWarnings?.map((warning) => (
				<div className="budget-warning" key={warning.id}>
					<CircleAlert size={13} />
					{warning.kind === "tokens" ? "Token" : "费用"}用量已超过 {Math.round(warning.threshold * 100)}%
				</div>
			))}
			{editing && (
				<form className="budget-form" onSubmit={(event) => void submit(event)}>
					<label>
						<span>费用限额（USD）</span>
						<input
							type="number"
							min="0.0001"
							step="0.0001"
							placeholder="不限"
							value={costDraft}
							onChange={(event) => setCostDraft(event.target.value)}
						/>
					</label>
					<label>
						<span>Token 限额</span>
						<input
							type="number"
							min="1"
							step="1"
							placeholder="不限"
							value={tokenDraft}
							onChange={(event) => setTokenDraft(event.target.value)}
						/>
					</label>
					<label>
						<span>预警阈值</span>
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
						<button type="button" title="取消修改" disabled={saving} onClick={() => setEditing(false)}>
							<X size={14} />
						</button>
						<button type="submit" title="保存会话限额" disabled={saving}>
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
			<div className="rail-section">
				<div className="rail-section-heading">
					<h2>运行</h2>
					<button className="rail-icon-button rail-mobile-close" type="button" title="关闭运行面板" onClick={onClose}>
						<X size={14} />
					</button>
				</div>
				<div className="kv">
					<span>状态</span>
					<strong className={`phase phase-${snapshot?.session.phase ?? "idle"}`}>
						{statusLabel(snapshot?.session.phase ?? "idle")}
					</strong>
				</div>
				<div className="kv">
					<span>沙箱</span>
					<strong>{sandboxLabel(snapshot?.sandboxMode)}</strong>
				</div>
				<div className="kv">
					<span>批准策略</span>
					<strong>{approvalPolicyLabel(snapshot?.approvalPolicy)}</strong>
				</div>
				<div className="kv">
					<span>即时补充队列</span>
					<strong>{snapshot?.queuedSteerCount ?? 0}</strong>
				</div>
				<div className="kv">
					<span>后续任务队列</span>
					<strong>{snapshot?.queuedFollowUpCount ?? 0}</strong>
				</div>
			</div>
			<div className="rail-section">
				{contextUsage && <ContextMeter usage={contextUsage} />}
				{snapshot ? (
					<BudgetEditor snapshot={snapshot} overview={usageOverview} onSave={onSetBudget} />
				) : (
					<>
						<h2>用量</h2>
						<div className="run-empty">未选择会话</div>
					</>
				)}
			</div>
			<div className="rail-section">
				<h2>最近运行</h2>
				<div className="run-history">
					{runs.length === 0 && <div className="run-empty">暂无运行记录</div>}
					{runs.slice(0, 3).map((run) => (
						<div className="run-row" key={run.id} title={run.error}>
							<div className="run-row-heading">
								<span className={`run-dot run-${run.status}`} />
								<strong>{run.mode === "prompt" ? "提问" : run.mode === "steer" ? "即时补充" : "后续任务"}</strong>
								<div className="run-row-actions">
									<span>{statusLabel(run.status)}</span>
									<RunDiagnosticButton run={run} onOpen={onOpenEvaluation} />
								</div>
							</div>
							<div className="run-meta">
								<span>{formatRunTime(run.createdAt)}</span>
								<span>{formatRunDuration(run)}</span>
								{run.attempt > 1 && <span>第 {run.attempt} 次尝试</span>}
								{run.retryHistory && run.retryHistory.length > 0 && <span>已重试 {run.retryHistory.length} 次</span>}
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
								{run.tools && run.tools.length > 0 && <span>{run.tools.map(formatToolObservation).join("; ")}</span>}
								{run.traceId && <span title={run.traceId}>Trace {run.traceId.slice(0, 8)}</span>}
								{run.failureKind && <span>{failureKindLabel(run.failureKind)}</span>}
								{run.capabilityPlan && (
									<span title={run.capabilityPlan.digest}>能力 {run.capabilityPlan.capabilityCount}</span>
								)}
								{run.contextPlan && (
									<span title={run.contextPlan.digest}>
										上下文 {formatTokens(run.contextPlan.estimatedSystemTokens)}/
										{formatTokens(run.contextPlan.availableSystemTokens)} · {run.contextPlan.fragmentCount} 片段
									</span>
								)}
								{run.hookEvents && run.hookEvents.length > 0 && <span>Hook {run.hookEvents.length}</span>}
								{run.trajectory && (
									<span title="结构性评测，不判断回答的语义正确性">
										轨迹 {run.trajectory.evaluation.score} · {run.trajectory.eventCount}
									</span>
								)}
								{run.memoryCount && <span title="本次运行产生的持久化压缩记忆">记忆 {run.memoryCount}</span>}
								{run.abortRequested && <span>已请求停止</span>}
							</div>
							{run.error && <div className="run-error">{run.error}</div>}
							{run.retryHistory && run.retryHistory.length > 0 && (
								<details className="run-retries">
									<summary>
										重试 {run.retryHistory.at(-1)?.attempt}/{run.retryHistory.at(-1)?.maxAttempts}
									</summary>
									{run.retryHistory.map((retry, index) => (
										<div className="retry-entry" key={`${retry.timestamp}-${index}`}>
											<div>
												<strong>
													重试 {retry.attempt}/{retry.maxAttempts}
												</strong>
												<span>
													{formatRunTime(retry.timestamp)} · 等待 {formatDelay(retry.delayMs)}
												</span>
											</div>
											<p>{retry.error}</p>
										</div>
									))}
								</details>
							)}
							{run.hookEvents && run.hookEvents.length > 0 && (
								<details className="run-hooks">
									<summary>Hook 明细</summary>
									{run.hookEvents.map((event, index) => (
										<div className="hook-entry" key={`${event.hookId}-${event.point}-${event.startedAt}-${index}`}>
											<div>
												<strong>{event.hookId}</strong>
												<span>{HOOK_OUTCOME_LABELS[event.outcome] ?? event.outcome}</span>
											</div>
											<p>
												{HOOK_POINT_LABELS[event.point] ?? event.point} · {event.mode === "enforce" ? "强制" : "观察"} ·{" "}
												{formatDelay(event.durationMs)}
												{event.code ? ` · ${event.code}` : ""}
											</p>
										</div>
									))}
								</details>
							)}
							{run.contextPlan && (
								<details className="run-context">
									<summary>
										上下文明细
										{run.contextPlan.omittedCount > 0 ? ` · 省略 ${run.contextPlan.omittedCount}` : ""}
									</summary>
									{run.contextPlan.fragments.map((fragment) => (
										<div className="context-entry" key={fragment.id}>
											<div>
												<strong>{fragment.id}</strong>
												<span>{formatTokens(fragment.renderedTokens)}</span>
											</div>
											<p>
												{CONTEXT_KIND_LABELS[fragment.kind] ?? fragment.kind} ·{" "}
												{CONTEXT_CACHE_LABELS[fragment.cacheScope] ?? fragment.cacheScope} · {fragment.source}
												{fragment.truncated ? " · 已截断" : ""}
											</p>
										</div>
									))}
								</details>
							)}
							{run.trajectory && (
								<details className="run-trajectory">
									<summary>
										结构评测 {run.trajectory.evaluation.score}/100 · {run.trajectory.integrity ? "链完整" : "链异常"}
									</summary>
									<p className="trajectory-note">仅评估执行结构与证据完整性，不判断回答语义正确性。</p>
									{run.trajectory.evaluation.criteria.map((criterion) => (
										<div className="trajectory-entry" key={criterion.id}>
											<div>
												<strong>{TRAJECTORY_CRITERION_LABELS[criterion.id] ?? criterion.id}</strong>
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
				<h2>会话记忆</h2>
				<div className="memory-history">
					{memories.length === 0 && <div className="run-empty">暂无压缩记忆</div>}
					{memories.slice(0, 5).map((record) => {
						const memory = record.memory;
						return (
							<details className="memory-row" key={memory.id}>
								<summary>
									<span>
										{MEMORY_REASON_LABELS[memory.reason]}
										{record.retention === "retained" ? " · 已保留" : ""}
									</span>
									<time>{formatRunTime(memory.createdAt)}</time>
								</summary>
								<div className="memory-meta">
									{memory.tokensBefore !== undefined && (
										<span>
											{formatTokens(memory.tokensBefore)} →{" "}
											{memory.estimatedTokensAfter === undefined ? "未知" : formatTokens(memory.estimatedTokensAfter)}
										</span>
									)}
									<span>Revision {memory.source.revision}</span>
								</div>
								<p>{memory.summary}</p>
								<div
									className="memory-source"
									title={`${memory.source.fromItemId ?? "?"} → ${memory.source.throughItemId ?? "?"}`}
								>
									来源 {memory.source.fromItemId?.slice(0, 8) ?? "?"} →{" "}
									{memory.source.throughItemId?.slice(0, 8) ?? "?"}
								</div>
								<div className="memory-actions">
									<button
										type="button"
										aria-pressed={record.retention === "retained"}
										title={record.retention === "retained" ? "取消保留" : "保留此记忆"}
										disabled={memoryDisabled || memoryBusy === memory.id}
										onClick={() =>
											void manageMemory(memory.id, record.retention === "retained" ? "release" : "promote")
										}
									>
										<Pin size={13} fill={record.retention === "retained" ? "currentColor" : "none"} />
									</button>
									<button
										type="button"
										title="忘记此记忆"
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
				<h2>工作区</h2>
				<div className="rail-item">
					<ShieldCheck size={16} />
					<span>隔离执行</span>
				</div>
				<div className="rail-item">
					<FileCode2 size={16} />
					<span>{snapshot?.transcript.length ?? 0} 条对话记录</span>
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
}: {
	sessions: SessionSummary[];
	selectedSessionId?: string;
	workspaceId?: string;
	disabled: boolean;
	onBrowse: (workspaceId: string, options: { query?: string; archived?: boolean }) => Promise<SessionSummary[]>;
	onSelect: (sessionId: string) => void;
	onRename: (sessionId: string, name: string) => Promise<void>;
	onArchive: (sessionId: string, archived: boolean) => Promise<void>;
}) {
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
			{archived && (
				<div className="session-view-label">
					<Archive size={12} />
					<span>归档聊天</span>
				</div>
			)}
			<nav className="session-nav" aria-label="会话">
				{sessions.map((session) => (
					<div className={`session-entry ${selectedSessionId === session.id ? "selected" : ""}`} key={session.id}>
						{!archived && renamingId === session.id ? (
							<form className="session-rename" onSubmit={(event) => void submitRename(event)}>
								<input
									aria-label="会话名称"
									autoFocus
									maxLength={500}
									placeholder="输入会话标题"
									value={nameDraft}
									onChange={(event) => setNameDraft(event.target.value)}
								/>
								<button type="submit" title="保存名称" disabled={!nameDraft.trim() || busyId === session.id}>
									<Check size={13} />
								</button>
								<button type="button" title="取消重命名" onClick={() => setRenamingId(undefined)}>
									<X size={13} />
								</button>
							</form>
						) : (
							<>
								<button className="session-open" type="button" onClick={() => onSelect(session.id)}>
									<span>{session.name || DEFAULT_SESSION_TITLE}</span>
									<i className={`session-phase dot-${session.phase}`} />
								</button>
								<div className={`session-actions ${archived ? "restore-only" : ""}`}>
									{archived ? (
										<button
											type="button"
											title="恢复聊天"
											aria-label="恢复聊天"
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
												title="重命名会话"
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
												title="归档聊天"
												aria-label="归档聊天"
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
				{sessions.length === 0 && <div className="session-list-empty">{archived ? "暂无归档聊天" : "暂无聊天"}</div>}
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
				<span>{archived ? "返回聊天" : "查看归档聊天"}</span>
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
	onToggle,
	onNewSession,
	onRename,
	onRemove,
	children,
}: {
	workspace: WorkspaceSummary;
	selected: boolean;
	expanded: boolean;
	disabled: boolean;
	removeDisabled: boolean;
	onToggle: () => void;
	onNewSession: () => Promise<void>;
	onRename: (name: string) => Promise<unknown>;
	onRemove: () => Promise<void>;
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
					event.preventDefault();
					if (!disabled && !renaming) setMenuOpen(true);
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
	const [workbenchView, setWorkbenchView] = useState<
		"chat" | "agents" | "goals" | "automations" | "files" | "changes" | "terminal" | "tools" | "skills" | "mcp"
	>("chat");
	const [goalFocusId, setGoalFocusId] = useState<string>();
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
	const [settingsOpen, setSettingsOpen] = useState(() => localStorage.getItem(ONBOARDING_STORAGE_KEY) !== "true");
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
	const [composerEdit, setComposerEdit] = useState<ComposerEdit>();
	const [messageBusyId, setMessageBusyId] = useState<string>();
	const [messageError, setMessageError] = useState<{ itemId: string; message: string }>();
	const transcriptRef = useRef<HTMLDivElement>(null);
	// The transcript follows new output only while the reader is at the tail.
	// Scrolling up to re-read something has to survive the next delta.
	const [following, setFollowing] = useState(true);
	const [pendingTail, setPendingTail] = useState(false);
	const seenTailRef = useRef(0);
	const pinnedAtRef = useRef<number | undefined>(undefined);
	const localGateway = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
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
	const liveAssistantItems = Object.values(client.liveAssistants).filter(
		(item) => item.thinking.trim() !== "" || item.text.trim() !== ""
	);
	const liveAssistantLength = liveAssistantItems.reduce(
		(length, item) => length + item.thinking.length + item.text.length,
		0
	);
	const liveTrace = [
		...liveAssistantItems.map((item) => ({ kind: "assistant" as const, order: item.order, item })),
		...Object.values(client.liveTools).map((item) => ({
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
		reasoningPhase && liveTrace.length === 0 && client.liveRetry === undefined && compactionStatus !== "running";
	// A completed call appears in both its assistant request and its own result
	// item. Render the result card once; live calls carry their own input.
	const renderedToolCalls = useMemo(() => {
		const rendered = new Set<string>();
		for (const item of transcript ?? []) {
			if (item.type === "tool") rendered.add(item.toolCallId);
		}
		return rendered;
	}, [transcript]);

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
			await client.sendPrompt(messageText(previousUser.content), artifacts);
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
		setFollowing(true);
		pinnedAtRef.current = undefined;
	}, [client.snapshot?.session.id]);

	const sessionId = client.snapshot?.session.id;
	const canCompact = client.capabilities.includes("session.compaction");
	const demoRuntime = client.toolRuntime === "demo";
	// Slash commands act on the shell and the session. They are memoised because
	// the composer resets its highlighted row whenever the list identity changes.
	const composerCommands = useMemo<ComposerCommand[]>(() => {
		const panel = (
			name: string,
			title: string,
			hint: string,
			view: "chat" | "agents" | "goals" | "automations" | "files" | "changes" | "terminal" | "tools" | "skills" | "mcp",
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
					if (!sessionId) throw new Error("未选择会话");
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
					if (!sessionId) throw new Error("未选择会话");
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
			panel("skills", "查看技能", "技能", "skills", <BookOpen size={14} />),
			panel("mcp", "查看 MCP 服务", "mcp 服务", "mcp", <Plug size={14} />),
			panel("agents", "查看子智能体", "智能体 子代理", "agents", <Bot size={14} />),
			panel("automations", "查看自动化", "自动化 定时 计划", "automations", <CalendarClock size={14} />),
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
	}, [canCompact, client, demoRuntime, sessionId, thinkingLevel, startNewChat]);

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
				group: "技能",
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
					requestAnimationFrame(() =>
						document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')?.focus()
					);
				},
			});
		}
		for (const session of client.sessions) {
			if (session.id === sessionId) continue;
			entries.push({
				id: `session:${session.id}`,
				group: "会话",
				label: session.name || DEFAULT_SESSION_TITLE,
				detail: statusLabel(session.phase),
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
					group: "工作区",
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
				label: sidebarCollapsed ? "展开侧边栏" : "收起侧边栏",
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
	]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			// A component that already handled the chord marks it, so the composer's
			// own Escape and Enter bindings keep priority over the shell's.
			if (event.defaultPrevented) return;
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

	const themeSetting = (
		<div className="theme-setting">
			<div>
				<span className="settings-section-title">{t("appearance")}</span>
				<p className="settings-hint">{t("appearanceHint")}</p>
			</div>
			<div className="segmented" role="group" aria-label={t("theme")}>
				{(["system", "light", "dark"] as ThemeChoice[]).map((choice) => (
					<button
						key={choice}
						type="button"
						className={theme.choice === choice ? "active" : ""}
						aria-pressed={theme.choice === choice}
						onClick={() => theme.setChoice(choice)}
					>
						{themeLabel(choice, locale)}
					</button>
				))}
			</div>
		</div>
	);
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
	const settingsSections: Array<{
		id: SettingsSection;
		label: string;
		hint: string;
		icon: ReactNode;
		count?: number;
	}> = [
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
		{
			id: "usage",
			label: t("usageSettings"),
			hint: t("usageSettingsHint"),
			icon: <BarChart3 size={17} />,
		},
		{
			id: "connection",
			label: t("connectionSettings"),
			hint: t("connectionSettingsHint"),
			icon: <Plug size={17} />,
		},
	];

	return (
		<div
			className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${resizingSidebar ? "resizing-sidebar" : ""} ${showRight && workbenchView === "chat" && client.snapshot ? "with-right" : ""}`}
			style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
		>
			<aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
				<div className="brand-row">
					<div className="brand-mark">W</div>
					<strong>Wuming</strong>
					<button
						className="icon-button desktop-sidebar-toggle"
						type="button"
						title={`收起侧边栏（${modifierLabel()} B）`}
						aria-label="收起侧边栏"
						onClick={toggleSidebar}
					>
						<PanelLeftClose size={18} />
					</button>
					<button className="icon-button mobile-close" title="关闭导航" onClick={() => setMobileNav(false)}>
						<X size={18} />
					</button>
				</div>
				<button
					className="new-chat-button sidebar-new-chat"
					type="button"
					aria-label="新对话"
					title={`开始新对话（${modifierLabel()} Alt N）`}
					onClick={() => void startNewChat()}
					disabled={!canCreateChat || newChatBusy}
					aria-busy={newChatBusy}
				>
					{newChatBusy ? <RefreshCw className="spin" size={18} /> : <SquarePen size={18} />}
					<span>{newChatBusy ? "正在新建…" : "新对话"}</span>
				</button>
				<section className="project-section">
					<div className="project-section-heading">
						<span className="nav-label">项目</span>
						<div className="project-heading-actions">
							<button
								type="button"
								title="打开项目"
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
								>
									{expanded && (
										<div className="project-conversations">
											<SessionNavigation
												sessions={client.sessions}
												{...(client.snapshot ? { selectedSessionId: client.snapshot.session.id } : {})}
												workspaceId={workspace.id}
												disabled={client.connection !== "connected"}
												onBrowse={client.browseSessions}
												onSelect={(sessionId) => {
													void client.attachSession(sessionId);
													setMobileNav(false);
												}}
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
										onSelect={(sessionId) => {
											void client.attachSession(sessionId);
											setMobileNav(false);
										}}
										onRename={client.renameSession}
										onArchive={client.archiveSession}
									/>
								</div>
							</section>
						)}
					</nav>
				</section>
				<div className="sidebar-footer">
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
						{client.connection === "connected" ? t("connected") : statusLabel(client.connection)}
					</div>
				</div>
			</aside>
			{!sidebarCollapsed && (
				<div
					className="sidebar-resizer"
					role="separator"
					aria-label="调整侧边栏宽度"
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
								title={`展开侧边栏（${modifierLabel()} B）`}
								aria-label="展开侧边栏"
								onClick={toggleSidebar}
							>
								<PanelLeftOpen size={18} />
							</button>
						)}
						<button
							className="new-chat-button topbar-new-chat"
							type="button"
							aria-label={t("newChat")}
							title={`开始新对话（${modifierLabel()} Alt N）`}
							onClick={() => void startNewChat()}
							disabled={!canCreateChat || newChatBusy}
							aria-busy={newChatBusy}
						>
							{newChatBusy ? <RefreshCw className="spin" size={16} /> : <SquarePen size={16} />}
							{newChatBusy ? t("newChatBusy") : t("newChat")}
						</button>
						{client.snapshot?.session.parentSessionId && (
							<button
								className="icon-button subagent-back"
								type="button"
								title="返回主会话"
								aria-label="返回主会话"
								onClick={() => void client.attachSession(client.snapshot!.session.parentSessionId!)}
							>
								<ArrowLeft size={18} />
							</button>
						)}
						<div>
							<h1>{client.snapshot?.session.name || DEFAULT_SESSION_TITLE}</h1>
							{(!client.snapshot ||
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
								title="整理上下文"
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
								title="派生会话"
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
							aria-label="关闭新建对话错误"
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
							{client.snapshot?.transcript.map((item) => {
								const failureRun =
									item.type === "assistant" && item.error
										? client.runs.find((run) => item.id === `${run.id}:error`)
										: undefined;
								return (
									<TranscriptItemView
										item={item}
										key={item.id}
										transcript={client.snapshot?.transcript ?? []}
										now={Date.now()}
										onDownload={client.downloadArtifact}
										onLoadArtifact={client.loadArtifact}
										renderedToolCalls={renderedToolCalls}
										actions={item.type === "tool" ? undefined : messageActions(item)}
										failureActions={
											item.type === "assistant" && item.error
												? {
														run: failureRun,
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
							{liveTrace.map((entry) =>
								entry.kind === "assistant" ? (
									<LiveAssistantView
										item={entry.item}
										compacting={compactionStatus === "running"}
										key={`assistant:${entry.item.id}`}
									/>
								) : (
									<LiveToolView
										tool={entry.item}
										onDownload={client.downloadArtifact}
										onLoadArtifact={client.loadArtifact}
										awaitingApproval={
											client.snapshot?.pendingApprovals.some(
												(approval) => approval.toolCallId === entry.item.toolCallId
											) ?? false
										}
										key={`tool:${entry.item.toolCallId}`}
									/>
								)
							)}
							{compactionStatus && <CompactionActivity status={compactionStatus} />}
							{client.liveRetry && compactionStatus !== "running" && <RetryActivity retry={client.liveRetry} />}
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
									onOpen={() => {
										setGoalFocusId(inlineGoal.id);
										setWorkbenchView("goals");
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
							{client.selectedSkill && (
								<div
									className={client.selectedSkill.truncated ? "workbench-error" : "composer-selected-skill"}
									role={client.selectedSkill.truncated ? "alert" : "status"}
								>
									<BookOpen size={14} />
									<span>
										{client.selectedSkill.truncated ? "技能内容已截断，无法执行：" : "当前技能："}
										{client.selectedSkill.name}
									</span>
									<button
										className="icon-button"
										type="button"
										aria-label="取消技能"
										title="取消技能"
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
									aria-label={pendingTail ? "回到底部，有新内容" : "回到底部"}
								>
									{pendingTail ? <span className="jump-dot" aria-hidden="true" /> : <ArrowDown size={14} />}
									{pendingTail ? "有新内容" : "回到底部"}
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
				{workbenchView === "agents" && (
					<SubagentsView
						subagents={client.subagents}
						depth={client.subagentDepth}
						canCreate={client.canCreateSubagent}
						disabled={
							!client.snapshot || client.snapshot.session.archivedAt !== undefined || client.connection !== "connected"
						}
						onCreate={client.createSubagent}
						onCancel={client.cancelSubagent}
						onOpenSession={async (sessionId) => {
							await client.attachSession(sessionId);
							setShowRight(false);
							setWorkbenchView("chat");
						}}
						onRespondApproval={client.respondApproval}
						onRefresh={() =>
							client.snapshot ? client.refreshSubagents(client.snapshot.session.id) : Promise.resolve([])
						}
					/>
				)}
				{workbenchView === "goals" && (
					<GoalsView
						goals={client.goals}
						focusGoalId={goalFocusId}
						disabled={
							!client.snapshot || client.snapshot.session.archivedAt !== undefined || client.connection !== "connected"
						}
						archived={client.snapshot?.session.archivedAt !== undefined}
						onCreate={client.createGoal}
						onStart={client.startGoal}
						onPause={client.pauseGoal}
						onResume={client.resumeGoal}
						onCancel={client.cancelGoal}
						onDelete={client.deleteGoal}
						onRespondApproval={client.respondApproval}
						onRefresh={() => (client.snapshot ? client.refreshGoals(client.snapshot.session.id) : Promise.resolve([]))}
						onOpenSession={async (sessionId) => {
							await client.attachSession(sessionId);
							setShowRight(false);
							setWorkbenchView("chat");
						}}
					/>
				)}
				{workbenchView === "automations" && (
					<AutomationsView
						automations={client.automations}
						disabled={
							!client.snapshot || client.snapshot.session.archivedAt !== undefined || client.connection !== "connected"
						}
						archived={client.snapshot?.session.archivedAt !== undefined}
						onCreate={client.createAutomation}
						onSetEnabled={client.setAutomationEnabled}
						onTrigger={client.triggerAutomation}
						onListRuns={client.listAutomationRuns}
						onRespondApproval={client.respondApproval}
						onRefresh={() =>
							client.snapshot ? client.refreshAutomations(client.snapshot.session.id) : Promise.resolve([])
						}
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
				{workbenchView === "terminal" && selectedWorkspace && (
					<Suspense fallback={<div className="workbench-empty">正在加载终端...</div>}>
						<TerminalView token={client.token} workspaceId={selectedWorkspace.id} />
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
						servers={client.mcpServers}
						selectedServer={client.selectedMcpServer}
						onRefresh={() => client.refreshMcp(selectedWorkspace.id)}
						onSelect={(serverId) => client.getMcp(selectedWorkspace.id, serverId)}
					/>
				)}
			</main>

			{showRight && workbenchView === "chat" && client.snapshot && (
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
			{showRight && workbenchView === "chat" && client.snapshot && (
				<button className="right-rail-scrim" aria-label="关闭运行面板" onClick={() => setShowRight(false)} />
			)}
			{mobileNav && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
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
											</div>
										</section>
										<section id="settings-panel-models" className="settings-pane" hidden={settingsSection !== "models"}>
											<div className="settings-page-header">
												<h3>{t("modelSettings")}</h3>
												<p>{t("modelSettingsDescription")}</p>
											</div>
											{customModelSettings}
											{client.capabilities.includes("model.media") && (
												<MediaModelSettings
													connected={client.connection === "connected"}
													onList={client.listMediaModels}
													onSave={client.setMediaModel}
													onRemove={client.removeMediaModel}
													onDiscover={client.discoverMediaModels}
												/>
											)}
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
												workspaceId={selectedWorkspace?.id}
												workspaceName={selectedWorkspace ? workspaceName(selectedWorkspace.name) : t("noProject")}
												models={client.models}
												onRefresh={(days) => client.refreshUsageOverview(selectedWorkspace!.id, days)}
											/>
										</section>
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
														{client.connection === "connected" ? t("connected") : statusLabel(client.connection)}
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

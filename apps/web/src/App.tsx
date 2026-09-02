import {
	Activity,
	BookOpen,
	Archive,
	ArchiveRestore,
	Bot,
	Check,
	BrainCircuit,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	Copy,
	Download,
	FileCode2,
	FileText,
	Folder,
	FolderOpen,
	GitBranch,
	GitCompareArrows,
	TerminalSquare,
	Trash2,
	Menu,
	MessageSquareCode,
	Plug,
	PanelRight,
	Paperclip,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	Send,
	Settings,
	ShieldAlert,
	ShieldCheck,
	Sparkles,
	Square,
	SquareTerminal,
	Wrench,
	X,
} from "lucide-react";
import { lazy, Suspense, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type {
	ApprovalRequest,
	ArtifactRef,
	CommandResult,
	CustomModelApi,
	CustomModelConfig,
	CustomModelConnection,
	CustomModelService,
	CustomModelSettings as CustomModelSettingsValue,
	ContentPart,
	GitDiff,
	GitStatus,
	GitStatusEntry,
	ModelMetadata,
	ModelRef,
	RunSummary,
	SessionSnapshot,
	SessionSummary,
	TranscriptItem,
	WorkspaceDirectory,
	WorkspaceFileView,
	Skill,
	SkillSummary,
	McpServer,
	McpServerSummary,
	SubagentSummary,
	UsageToolSummary,
	ToolStatus,
} from "@wuming/protocol";
import { type LiveAssistant, type LiveTool, useWumingClient } from "./use-wuming-client.js";
import { workspaceApi } from "./workspace-api.js";
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
	aborted: "已中止",
	complete: "已完成",
	completed: "已完成",
	failed: "失败",
	connected: "已连接",
	connecting: "连接中",
	reconnecting: "重新连接中",
	disconnected: "已断开",
	ready: "就绪",
	closed: "已关闭",
	error: "错误",
	pending: "等待中",
	approved: "已批准",
	denied: "已拒绝",
};

function statusLabel(value: string): string {
	return STATUS_LABELS[value] ?? value.replaceAll("_", " ");
}

function riskLabel(value: string): string {
	return ({ low: "低风险", medium: "中风险", high: "高风险" } as Record<string, string>)[value] ?? value;
}

function sandboxLabel(value: string | undefined): string {
	if (!value) return "-";
	return ({ read_only: "只读", workspace_write: "工作区可写", danger_full_access: "完全访问" } as Record<string, string>)[value] ?? value.replaceAll("_", " ");
}

function approvalPolicyLabel(value: string | undefined): string {
	if (!value) return "-";
	return ({ on_risk: "遇到风险时询问", always: "始终询问", never: "从不询问" } as Record<string, string>)[value] ?? value.replaceAll("_", " ");
}

function workspaceName(name: string): string {
	return name === "Local workspace" ? "本地工作区" : name;
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
	onDiscover: (connection: CustomModelConnection) => Promise<Extract<CommandResult, { type: "model.custom.discovered" }>>;
	onListServices: () => Promise<CustomModelService[]>;
	onRefreshService: (provider: string) => Promise<Extract<CommandResult, { type: "model.custom.discovered" }>>;
	onRemoveService: (provider: string) => Promise<void>;
	onGet: (model: { provider: string; id: string }) => Promise<CustomModelSettingsValue>;
	onConfigure: (configs: CustomModelConfig[]) => Promise<Array<Extract<CommandResult, { type: "model.custom.configured" }>["model"]>>;
	onTest: (model: { provider: string; id: string }) => Promise<number>;
	onRemove: (model: { provider: string; id: string }) => Promise<void>;
}) {
	const [services, setServices] = useState<CustomModelService[]>([]);
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [discovery, setDiscovery] = useState<Extract<CommandResult, { type: "model.custom.discovered" }>>();
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [modelQuery, setModelQuery] = useState("");
	const [name, setName] = useState("");
	const [api, setApi] = useState<CustomModelApi>("openai-completions");
	const [reasoning, setReasoning] = useState(false);
	const [imageInput, setImageInput] = useState(false);
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
		void onListServices().then((loaded) => { if (active) setServices(loaded); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [onListServices]);
	const resetDiscovery = () => { setDiscovery(undefined); setSelectedIds([]); setModelQuery(""); setMessage(undefined); setError(undefined); };
	const discover = async () => {
		setBusy(true); setError(undefined); setMessage(undefined);
		try {
			if (!baseUrl.trim() || !apiKey) throw new Error("请填写 Base URL 和 API Key");
			const result = await onDiscover({ baseUrl: baseUrl.trim(), apiKey });
			setDiscovery(result); setBaseUrl(result.baseUrl); setApiKey(""); setApi(result.api); setSelectedIds([]); setModelQuery(""); setAddOpen(false);
			await reloadServices();
			setMessage(`模型服务已加密保存，获取到 ${result.models.length} 个模型`);
		} catch (cause) {
			setDiscovery(undefined); setSelectedIds([]); setError(cause instanceof Error ? cause.message : String(cause));
		} finally { setBusy(false); }
	};
	const refreshService = async (service: CustomModelService) => {
		setLoadingService(service.provider); setError(undefined); setMessage(undefined);
		try {
			const result = await onRefreshService(service.provider);
			setDiscovery(result); setApi(result.api); setSelectedIds([]); setModelQuery(""); setName(""); setAddOpen(false);
			setMessage(`已使用保存的密钥获取 ${result.models.length} 个模型`);
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setLoadingService(undefined); }
	};
	const removeService = async (service: CustomModelService) => {
		setLoadingService(service.provider); setError(undefined); setMessage(undefined);
		try {
			await onRemoveService(service.provider);
			if (discovery?.provider === service.provider) setDiscovery(undefined);
			await reloadServices();
			setMessage("模型服务已删除");
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setLoadingService(undefined); }
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true); setError(undefined); setMessage(undefined);
		try {
			if (!discovery || selectedIds.length === 0) throw new Error("请先获取模型并至少选择一个模型");
			const configs: CustomModelConfig[] = selectedIds.map((id) => {
				const selected = discovery.models.find((model) => model.id === id);
				return {
					provider: discovery.provider, id, name: selectedIds.length === 1 && name.trim() ? name.trim() : selected?.name || id,
					api, baseUrl: discovery.baseUrl, reasoning, input: imageInput ? ["text", "image"] : ["text"],
					contextWindow: Number(contextWindow), maxOutputTokens: Number(maxOutputTokens),
				};
			});
			await onConfigure(configs);
			setDiscovery(undefined); setSelectedIds([]); setModelQuery(""); setName("");
			await reloadServices();
			setMessage(`已添加 ${configs.length} 个模型`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally { setBusy(false); }
	};
	const testSavedModel = async (model: { provider: string; id: string }) => {
		const key = `${model.provider}/${model.id}`;
		setTestingModel(key); setError(undefined); setMessage(undefined);
		try { setMessage(`${model.id} 测试成功，耗时 ${await onTest(model)}ms`); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setTestingModel(undefined); }
	};
	const startEditing = async (model: { provider: string; id: string }) => {
		setError(undefined); setMessage(undefined); setEditBusy(true);
		try { setEditing(await onGet(model)); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setEditBusy(false); }
	};
	const saveEdit = async (event: FormEvent) => {
		event.preventDefault();
		if (!editing) return;
		setError(undefined); setMessage(undefined); setEditBusy(true);
		try {
			await onConfigure([{
				provider: editing.model.provider,
				id: editing.model.id,
				name: editing.name,
				api: editing.api,
				baseUrl: editing.baseUrl,
				reasoning: editing.reasoning,
				input: editing.input,
				contextWindow: editing.contextWindow,
				maxOutputTokens: editing.maxOutputTokens,
			}]);
			setMessage(`${editing.name} 已更新`); setEditing(undefined);
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setEditBusy(false); }
	};
	const removeModel = async (model: { provider: string; id: string }) => {
		setError(undefined); setMessage(undefined);
		try { await onRemove(model); await reloadServices(); setMessage(`${model.id} 已删除，模型服务仍然保留`); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
	};
	const savedIds = new Set(savedModels.filter((model) => model.model.provider === discovery?.provider).map((model) => model.model.id));
	const visibleModels = discovery?.models.filter((model) => {
		const query = modelQuery.trim().toLowerCase();
		return !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query);
	}) ?? [];
	const toggleModel = (id: string) => { if (!savedIds.has(id)) setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); };
	return <div className="custom-model-settings">
		<div className="settings-section-title">自定义模型</div>
		<p className="settings-hint">模型服务和 API 凭据加密保存在服务端，可随时继续添加该服务下的模型。</p>
		{message && <div className="settings-success">{message}</div>}{error && <div className="settings-error">{error}</div>}
		{services.length > 0 && <div className="saved-models-heading"><strong>已保存服务</strong><span>{services.length}</span></div>}
		{services.map((service) => <div className="custom-model-row custom-model-service-row" key={service.provider}>
			<span className="custom-model-copy"><strong>{new URL(service.baseUrl).host}</strong><small>{service.baseUrl}</small><small className="credential-status"><ShieldCheck size={12} />密钥已加密保存 · {service.modelCount} 个模型</small></span>
			<div className="custom-model-row-actions"><button type="button" className="icon-button" title="刷新并管理模型" disabled={loadingService === service.provider} onClick={() => void refreshService(service)}><RefreshCw className={loadingService === service.provider ? "spin" : ""} size={14} /></button><button type="button" className="icon-button" title={service.modelCount > 0 ? "请先删除该服务下的模型" : "删除模型服务"} disabled={service.modelCount > 0 || loadingService === service.provider} onClick={() => void removeService(service)}><Trash2 size={14} /></button></div>
		</div>)}
		{savedModels.length > 0 && <div className="saved-models-heading"><strong>已添加模型</strong><span>{savedModels.length}</span></div>}
		{savedModels.map((model) => { const key = `${model.model.provider}/${model.model.id}`; return <div className="custom-model-row" key={key}><span className="custom-model-copy"><strong>{model.name}</strong><small>{model.model.id}</small></span><div className="custom-model-row-actions"><button type="button" className="icon-button" title="编辑模型" disabled={editBusy} onClick={() => void startEditing(model.model)}><Pencil size={14} /></button><button type="button" className="icon-button" title="测试模型" disabled={testingModel === key} onClick={() => void testSavedModel(model.model)}><Activity size={14} /></button><button type="button" className="icon-button" title="删除模型" onClick={() => void removeModel(model.model)}><Trash2 size={14} /></button></div></div>; })}
		{editing && <form className="custom-model-edit" onSubmit={(event) => void saveEdit(event)}>
			<div className="custom-model-edit-heading"><span><strong>编辑模型</strong><small>{editing.model.id}</small></span><button type="button" className="icon-button" title="取消编辑" onClick={() => setEditing(undefined)}><X size={14} /></button></div>
			<div className="model-service-reference"><span>模型服务</span><strong>{new URL(editing.baseUrl).host}</strong><small>{editing.baseUrl}</small></div>
			<label>名称<input value={editing.name} onChange={(event) => setEditing((current) => current ? { ...current, name: event.target.value } : current)} required /></label>
			<div className="custom-model-inline"><label>上下文长度<input type="number" min="1" value={editing.contextWindow} onChange={(event) => setEditing((current) => current ? { ...current, contextWindow: Number(event.target.value) } : current)} required /></label><label>最大输出<input type="number" min="1" value={editing.maxOutputTokens} onChange={(event) => setEditing((current) => current ? { ...current, maxOutputTokens: Number(event.target.value) } : current)} required /></label></div>
			<div className="custom-model-checks"><label><input type="checkbox" checked={editing.reasoning} onChange={(event) => setEditing((current) => current ? { ...current, reasoning: event.target.checked } : current)} /> 推理模型</label><label><input type="checkbox" checked={editing.input.includes("image")} onChange={(event) => setEditing((current) => current ? { ...current, input: event.target.checked ? ["text", "image"] : ["text"] } : current)} /> 支持图片</label></div>
			<button className="primary-button" disabled={editBusy}>{editBusy ? "正在保存..." : "保存修改"}</button>
		</form>}
		<details className="custom-model-add" open={addOpen} onToggle={(event) => setAddOpen(event.currentTarget.open)}>
			<summary><Plus size={14} />添加模型服务</summary>
			<div className="custom-model-form">
				<label>Base URL<input type="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); resetDiscovery(); }} placeholder="https://api.example.com/v1" required /></label>
				<label>API Key<input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); resetDiscovery(); }} placeholder="输入新服务的 API Key" required /></label>
				<button type="button" className="secondary-button custom-model-test" disabled={busy || !baseUrl.trim() || !apiKey} onClick={() => void discover()}><RefreshCw className={busy ? "spin" : ""} size={14} />{busy ? "正在保存并获取..." : "保存服务并获取模型"}</button>
			</div>
		</details>
		{discovery && <form className="custom-model-form custom-model-catalog" onSubmit={(event) => void submit(event)}>
			<div className="custom-model-edit-heading"><span><strong>添加服务模型</strong><small>{discovery.baseUrl}</small></span><button type="button" className="icon-button" title="关闭模型列表" onClick={() => { setDiscovery(undefined); setSelectedIds([]); }}><X size={14} /></button></div>
			<div className="model-picker">
				<div className="model-picker-heading"><span>模型</span><small>已选择 {selectedIds.length} 个</small></div>
				<input aria-label="筛选模型" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型" />
				<div className="model-picker-actions"><button type="button" onClick={() => setSelectedIds(discovery.models.filter((model) => !savedIds.has(model.id)).map((model) => model.id))}><Check size={12} />选择未添加</button><button type="button" onClick={() => setSelectedIds([])}><X size={12} />清空</button></div>
				<div className="model-picker-list">{visibleModels.length > 0 ? visibleModels.map((model) => <label className={`model-option ${savedIds.has(model.id) ? "already-added" : ""}`} key={model.id}><input type="checkbox" disabled={savedIds.has(model.id)} checked={savedIds.has(model.id) || selectedIds.includes(model.id)} onChange={() => toggleModel(model.id)} /><span><strong>{model.name}</strong>{model.name !== model.id && <small>{model.id}</small>}</span>{savedIds.has(model.id) && <small className="model-added-label">已添加</small>}</label>) : <div className="model-picker-empty">没有匹配的模型</div>}</div>
			</div>
			{selectedIds.length === 1 && <label><span>名称 <span className="optional-label">可选</span></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={discovery.models.find((model) => model.id === selectedIds[0])?.name ?? selectedIds[0]} /></label>}
			<details className="custom-model-advanced"><summary>高级设置</summary>
				<label>接口协议<select value={api} onChange={(event) => setApi(event.target.value as CustomModelApi)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
				<div className="custom-model-inline"><label>上下文长度<input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} required /></label><label>最大输出<input type="number" min="1" value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} required /></label></div>
				<div className="custom-model-checks"><label><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} /> 推理模型</label><label><input type="checkbox" checked={imageInput} onChange={(event) => setImageInput(event.target.checked)} /> 支持图片</label></div>
			</details>
			<button className="primary-button" disabled={busy || selectedIds.length === 0}><Plus size={14} />{busy ? "正在添加..." : selectedIds.length > 0 ? `添加 ${selectedIds.length} 个模型` : "添加模型"}</button>
		</form>}
	</div>;
}

function formatTokens(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
}

function formatRunDuration(run: RunSummary): string {
	return formatDuration(run.startedAt, run.finishedAt ?? (run.status === "running" ? Date.now() : run.updatedAt), run.status === "queued" ? "排队中" : "暂无耗时");
}

function formatDuration(startedAt: number | undefined, end: number, unavailable = "暂无耗时"): string {
	if (startedAt === undefined) return unavailable;
	const milliseconds = Math.max(0, end - startedAt);
	if (milliseconds < 1000) return `${milliseconds}ms`;
	const seconds = Math.round(milliseconds / 1000);
	return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatRunTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function formatDelay(milliseconds: number): string {
	return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 0 : 1)}s`;
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
	unknown: "未知故障",
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

function RunDiagnosticButton({ snapshot, run }: { snapshot: SessionSnapshot | undefined; run: RunSummary }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await writeClipboardText(runDiagnostic(snapshot, run));
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	};
	return <button className="run-diagnostic-button" type="button" title={copied ? "诊断信息已复制" : "复制脱敏诊断信息"} aria-label={copied ? "诊断信息已复制" : "复制诊断信息"} onClick={() => void copy()}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>;
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
	].filter((value): value is string => value !== undefined).join(" · ");
}

function Content({ parts, onDownload }: { parts: ContentPart[]; onDownload?: (artifact: ArtifactRef) => Promise<void> }) {
	return (
		<div className="message-content">
			{parts.map((part, index) => {
				if (part.type === "text") return <div className="prose" key={index}>{part.text}</div>;
				if (part.type === "thinking") {
					return (
						<details className="thinking" key={index}>
							<summary><BrainCircuit size={14} /> 思考过程</summary>
							<div>{part.redacted ? "推理内容已隐藏。" : part.text}</div>
						</details>
					);
				}
				if (part.type === "tool_call") {
					return (
						<div className="inline-tool" key={index}>
							<SquareTerminal size={15} />
							<strong>{part.toolName}</strong>
							<code>{JSON.stringify(part.input)}</code>
						</div>
					);
				}
				return (
					<div className="artifact-line" key={index}>
						<FileCode2 size={15} /> <span>{part.artifact.name}</span>
						{onDownload && <button type="button" title={`下载 ${part.artifact.name}`} onClick={() => void onDownload(part.artifact)}><Download size={14} /></button>}
					</div>
				);
			})}
		</div>
	);
}

function TranscriptItemView({ item, onDownload }: { item: TranscriptItem; onDownload: (artifact: ArtifactRef) => Promise<void> }) {
	if (item.type === "tool") {
		return (
			<div className={`tool-row ${item.isError ? "tool-error" : ""}`}>
				<div className="tool-title">
					<SquareTerminal size={15} />
					<strong>{item.toolName}</strong>
					<span>{statusLabel(item.status)}</span>
				</div>
				<Content parts={item.content} onDownload={onDownload} />
			</div>
		);
	}

	return (
		<div className={`message-row ${item.type}`}>
			<div className="message-avatar" aria-hidden="true">
				{item.type === "user" ? "U" : <Sparkles size={16} />}
			</div>
			<div className="message-body">
				<div className="message-meta">
					<strong>{item.type === "user" ? "你" : "Wuming"}</strong>
					{item.type === "assistant" && item.status !== "complete" && <span>{statusLabel(item.status)}</span>}
				</div>
				<Content parts={item.content} onDownload={onDownload} />
				{item.type === "assistant" && item.error && (
					<div className="message-error"><CircleAlert size={15} />{item.error}</div>
				)}
			</div>
		</div>
	);
}

function LiveAssistantView({ item }: { item: LiveAssistant }) {
	return (
		<div className="message-row assistant streaming-row">
			<div className="message-avatar"><Sparkles size={16} /></div>
			<div className="message-body">
				<div className="message-meta"><strong>Wuming</strong><span className="live-label">实时</span></div>
				{item.thinking && (
					<details className="thinking" open>
						<summary><BrainCircuit size={14} /> 思考过程</summary>
						<div>{item.thinking}</div>
					</details>
				)}
				{item.text && <div className="prose">{item.text}<span className="cursor" /></div>}
			</div>
		</div>
	);
}

function ThinkingActivity({ phase }: { phase: SessionSnapshot["session"]["phase"] }) {
	const label = phase === "retry" ? "正在重试" : phase === "compaction" ? "正在整理上下文" : "正在思考";
	return (
		<div className="message-row assistant thinking-activity" role="status" aria-live="polite" aria-label={label}>
			<div className="message-avatar thinking-avatar" aria-hidden="true"><BrainCircuit size={16} /></div>
			<div className="message-body">
				<div className="message-meta"><strong>Wuming</strong><span>处理中</span></div>
				<div className="thinking-state">
					<span className="thinking-bars" aria-hidden="true"><i /><i /><i /><i /></span>
					<span>{label}</span>
				</div>
			</div>
		</div>
	);
}

function LiveToolView({ tool }: { tool: LiveTool }) {
	return (
		<div className="tool-row live-tool">
			<div className="tool-title"><Activity size={15} /><strong>{tool.toolName}</strong><span>运行中</span></div>
			{tool.preview && <pre>{tool.preview}</pre>}
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
			<div className="approval-icon"><ShieldAlert size={18} /></div>
			<div className="approval-copy">
				<div className="approval-heading"><strong>需要批准工具调用</strong><span>{riskLabel(approval.risk)}</span></div>
				<p>{approval.summary}</p>
				<div className="approval-capabilities">
					{approval.capabilities.map((capability, index) => (
						<code key={`${capability.type}-${index}`}>{capability.type}</code>
					))}
				</div>
				{error && <div className="message-error"><CircleAlert size={14} />{error}</div>}
			</div>
			<div className="approval-actions">
				<button className="approval-deny" disabled={responding !== undefined} onClick={() => void respond("deny")}><X size={15} /> 拒绝</button>
				<button className="approval-allow" disabled={responding !== undefined} onClick={() => void respond("approve")}><Check size={15} /> 允许</button>
			</div>
		</section>
	);
}

function Composer({
	disabled,
	active,
	models,
	selectedModel,
	modelSelectionDisabled,
	onSelectModel,
	onSend,
	onAbort,
	onUpload,
}: {
	disabled: boolean;
	active: boolean;
	models: ModelMetadata[];
	selectedModel: ModelMetadata | undefined;
	modelSelectionDisabled: boolean;
	onSelectModel: (model: ModelRef) => void;
	onSend: (text: string, artifacts: ArtifactRef[], queueMode: "steer" | "follow_up") => Promise<void>;
	onAbort: () => Promise<void>;
	onUpload: (file: File) => Promise<ArtifactRef>;
}) {
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<ArtifactRef[]>([]);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string>();
	const [sendError, setSendError] = useState<string>();
	const fileInput = useRef<HTMLInputElement>(null);
	const [queueMode, setQueueMode] = useState<"steer" | "follow_up">("steer");
	const [sending, setSending] = useState(false);
	const [stopping, setStopping] = useState(false);
	useEffect(() => {
		if (!active) setStopping(false);
	}, [active]);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const value = text.trim();
		if ((!value && attachments.length === 0) || disabled || sending || uploading) return;
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

	return (
		<form className="composer" onSubmit={submit}>
			<input
				className="visually-hidden"
				ref={fileInput}
				type="file"
				aria-label="选择附件"
				multiple
				accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.yaml,.yml,.toml,.xml,.csv,.tsv,.js,.jsx,.ts,.tsx,.css,.html,.py,.go,.rs,.java,.c,.h,.cpp,.hpp,.cs,.php,.rb,.swift,.sh,.ps1,.sql,.graphql,.proto,.diff,.patch"
				onChange={(event) => {
					const files = [...(event.target.files ?? [])].slice(0, Math.max(0, 8 - attachments.length));
					event.target.value = "";
					if (files.length === 0) return;
					setUploading(true);
					setUploadError(undefined);
					void (async () => {
						try {
							const uploaded: ArtifactRef[] = [];
							for (const file of files) uploaded.push(await onUpload(file));
							setAttachments((current) => [...current, ...uploaded]);
						} catch (error) {
							setUploadError(error instanceof Error ? error.message : String(error));
						} finally {
							setUploading(false);
						}
					})();
				}}
			/>
			<textarea
				aria-label="消息"
				placeholder={active ? "为当前任务补充指令" : "给 Wuming 发送任务或问题"}
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						event.currentTarget.form?.requestSubmit();
					}
				}}
				disabled={disabled}
				rows={2}
			/>
			{(attachments.length > 0 || uploadError || sendError) && (
				<div className="composer-attachments">
					{attachments.map((artifact) => (
						<div className="attachment-chip" key={artifact.id}>
							<FileCode2 size={14} />
							<span>{artifact.name}</span>
							<button type="button" title={`移除 ${artifact.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== artifact.id))}><X size={13} /></button>
						</div>
					))}
					{uploadError && <div className="attachment-error"><CircleAlert size={13} />{uploadError}</div>}
					{sendError && <div className="attachment-error"><CircleAlert size={13} />{sendError}</div>}
				</div>
			)}
			<div className="composer-actions">
				<div className="composer-left">
					<button type="button" className="icon-button" title="添加附件" disabled={disabled || uploading || attachments.length >= 8} onClick={() => fileInput.current?.click()}><Paperclip size={17} /></button>
					{uploading && <span className="uploading-label">正在上传...</span>}
					{active && (
						<div className="segmented" aria-label="排队方式">
							<button type="button" className={queueMode === "steer" ? "active" : ""} onClick={() => setQueueMode("steer")}>立即补充</button>
							<button type="button" className={queueMode === "follow_up" ? "active" : ""} onClick={() => setQueueMode("follow_up")}>后续任务</button>
						</div>
					)}
				</div>
				<div className="composer-submit">
					<label className="composer-model">
						<Bot size={14} />
						<select
							aria-label="模型"
							title={selectedModel?.name ?? "请在设置中添加模型"}
							value={selectedModel ? `${selectedModel.model.provider}/${selectedModel.model.id}` : ""}
							disabled={modelSelectionDisabled || models.length === 0}
							onChange={(event) => {
								const model = models.find((candidate) => `${candidate.model.provider}/${candidate.model.id}` === event.target.value);
								if (model) onSelectModel(model.model);
							}}
						>
							{models.length === 0 && <option value="">请在设置中添加模型</option>}
							{models.map((model) => <option value={`${model.model.provider}/${model.model.id}`} disabled={!model.authenticated} key={`${model.model.provider}/${model.model.id}`}>{model.name}{model.authenticated ? "" : "（不可用）"}</option>)}
						</select>
					</label>
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
					<button className="send-button" type="submit" title="发送" disabled={disabled || sending || uploading || (!text.trim() && attachments.length === 0)}>
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
		if (!directory) return loadingPath === path ? <div className="tree-loading" key={`${path}-loading`}>加载中...</div> : null;
		return directory.entries.map((entry) => {
			const isDirectory = entry.kind === "directory";
			const isExpanded = isDirectory && expanded.has(entry.path);
			return (
				<div className="tree-node" key={entry.path}>
					<button
						className={selected === entry.path ? "selected" : ""}
						style={{ paddingLeft: `${8 + depth * 15}px` }}
						title={entry.path}
						onClick={() => isDirectory ? toggleDirectory(entry.path) : void openFile(entry.path)}
					>
						{isDirectory ? <ChevronRight className={isExpanded ? "expanded" : ""} size={13} /> : <span className="tree-spacer" />}
						{isDirectory ? (isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />) : <FileText size={14} />}
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
				<div><strong>文件</strong><span>工作区</span></div>
				<button className="icon-button" title="刷新文件" onClick={() => void loadDirectory(".")}><RefreshCw size={15} /></button>
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
			{error && <div className="workbench-error"><CircleAlert size={15} />{error}</div>}
			{selected && loadingPath === selected && <div className="workbench-empty">正在加载文件...</div>}
			{!loadingPath && !file && !error && <div className="workbench-empty"><FileText size={24} /><span>选择文件以预览</span></div>}
			{file?.binary && <div className="workbench-empty"><FileText size={24} /><span>暂不支持预览二进制文件</span></div>}
			{file && !file.binary && (
				<div className="code-scroll">
					<pre className="code-preview"><code>{file.content}</code></pre>
					{file.truncated && <div className="preview-truncated">预览已限制为 {file.bytesRead.toLocaleString()} 字节</div>}
				</div>
			)}
		</div>
		</section>
	);
}

function gitStatusLabel(entry: GitStatusEntry): string {
	if (entry.indexStatus === "?" && entry.worktreeStatus === "?") return "U";
	if (entry.worktreeStatus !== " ") return entry.worktreeStatus;
	return entry.indexStatus;
}

function DiffContent({ diff }: { diff: GitDiff }) {
	const lines = diff.content.split("\n");
	if (lines.length > 10_000) return <pre className="diff-plain">{diff.content}</pre>;
	return (
		<pre className="diff-view">
			{lines.map((line, index) => {
				const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
					? "header"
					: line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "delete" : "context";
				return <span className={`diff-line ${kind}`} key={index}>{line || " "}</span>;
			})}
		</pre>
	);
}

function ChangesView({ token, workspaceId }: { token: string; workspaceId: string }) {
	const [status, setStatus] = useState<GitStatus>();
	const [selected, setSelected] = useState<GitStatusEntry>();
	const [staged, setStaged] = useState(false);
	const [diff, setDiff] = useState<GitDiff>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();

	const loadDiff = async (entry: GitStatusEntry, nextStaged: boolean) => {
		setSelected(entry);
		setStaged(nextStaged);
		setLoading(true);
		setError(undefined);
		try {
			setDiff(await workspaceApi.diff(token, workspaceId, entry.path, nextStaged));
		} catch (cause) {
			setDiff(undefined);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	};

	const refresh = async () => {
		setLoading(true);
		setError(undefined);
		try {
			const value = await workspaceApi.status(token, workspaceId);
			setStatus(value);
			const current = value.entries.find((entry) => entry.path === selected?.path) ?? value.entries[0];
			if (current) {
				const hasWorking = current.worktreeStatus !== " ";
				const hasStaged = current.indexStatus !== " " && current.indexStatus !== "?";
				await loadDiff(current, hasStaged && !hasWorking);
			} else {
				setSelected(undefined);
				setDiff(undefined);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => { void refresh(); }, [token, workspaceId]);
	const hasWorking = selected ? selected.worktreeStatus !== " " : false;
	const hasStaged = selected ? selected.indexStatus !== " " && selected.indexStatus !== "?" : false;

	return (
		<section className="code-workbench" aria-label="Git 更改">
		<aside className="workbench-sidebar">
			<div className="workbench-heading">
				<div><strong>更改</strong><span>{status?.branch ?? "Git"}</span></div>
				<button className="icon-button" title="刷新更改" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} /></button>
			</div>
			{status && !status.isRepository && <div className="workbench-notice">当前工作区不是 Git 仓库</div>}
			<div className="changes-list">
				{status?.entries.map((entry) => {
					const entryWorking = entry.worktreeStatus !== " ";
					const entryStaged = entry.indexStatus !== " " && entry.indexStatus !== "?";
					return (
						<button className={selected?.path === entry.path ? "selected" : ""} key={`${entry.path}-${entry.originalPath ?? ""}`} onClick={() => void loadDiff(entry, entryStaged && !entryWorking)}>
							<span className={`status-code status-${gitStatusLabel(entry).toLowerCase()}`}>{gitStatusLabel(entry)}</span>
							<span>{entry.path}</span>
						</button>
					);
				})}
			</div>
			{status?.entries.length === 0 && status.isRepository && <div className="workbench-notice">工作区没有未提交更改</div>}
			{status?.truncated && <div className="workbench-notice">状态列表已截断</div>}
		</aside>
		<div className="workbench-content">
			<div className="editor-heading">
				<GitCompareArrows size={15} />
				<strong>{selected?.path ?? "未选择更改"}</strong>
				{selected && hasWorking && hasStaged && (
					<div className="segmented diff-mode" aria-label="差异范围">
						<button type="button" className={!staged ? "active" : ""} onClick={() => void loadDiff(selected, false)}>工作区</button>
						<button type="button" className={staged ? "active" : ""} onClick={() => void loadDiff(selected, true)}>已暂存</button>
					</div>
				)}
			</div>
			{error && <div className="workbench-error"><CircleAlert size={15} />{error}</div>}
			{loading && !diff && <div className="workbench-empty">正在加载差异...</div>}
			{!loading && !diff && !error && <div className="workbench-empty"><GitCompareArrows size={24} /><span>选择一个已更改文件</span></div>}
			{diff && <div className="diff-scroll"><DiffContent diff={diff} />{diff.truncated && <div className="preview-truncated">差异内容已截断</div>}</div>}
		</div>
	</section>
	);
}

function SkillsView({ skills, selectedSkill, onRefresh, onSelect }: { skills: SkillSummary[]; selectedSkill: Skill | undefined; onRefresh: () => Promise<SkillSummary[]>; onSelect: (skillId: string) => Promise<Skill | undefined> }) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const refresh = async () => {
		setLoading(true); setError(undefined);
		try { await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setLoading(false); }
	};
	return <section className="skills-workbench" aria-label="技能">
		<aside className="skills-sidebar">
			<div className="workbench-heading"><div><strong>技能</strong><span>共 {skills.length} 个</span></div><button className="icon-button" title="刷新技能" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} /></button></div>
			{error && <div className="workbench-error"><CircleAlert size={14} />{error}</div>}
			{skills.map((skill) => <button className={`skill-entry ${selectedSkill?.id === skill.id ? "selected" : ""}`} key={skill.id} onClick={() => void onSelect(skill.id)}><BookOpen size={14} /><span><strong>{skill.name}</strong><small>{skill.description || "暂无说明"}</small></span></button>)}
			{!loading && skills.length === 0 && <div className="workbench-empty">未找到技能</div>}
		</aside>
		<div className="skills-content">{selectedSkill ? <><div className="editor-heading"><BookOpen size={15} /><strong>{selectedSkill.name}</strong><span>{selectedSkill.path}</span></div><p className="skill-description">{selectedSkill.description}</p><pre className="skill-content">{selectedSkill.content}{selectedSkill.truncated ? "\n\n[内容已截断]" : ""}</pre></> : <div className="workbench-empty"><BookOpen size={24} /><span>选择一个技能</span></div>}</div>
	</section>;
}

function McpView({ servers, selectedServer, onRefresh, onSelect }: { servers: McpServerSummary[]; selectedServer: McpServer | undefined; onRefresh: () => Promise<McpServerSummary[]>; onSelect: (serverId: string) => Promise<McpServer | undefined> }) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const refresh = async () => {
		setLoading(true); setError(undefined);
		try { await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setLoading(false); }
	};
	return <section className="skills-workbench" aria-label="MCP 服务">
		<aside className="skills-sidebar">
			<div className="workbench-heading"><div><strong>MCP</strong><span>已配置 {servers.length} 个</span></div><button className="icon-button" title="刷新 MCP 服务" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} /></button></div>
			{error && <div className="workbench-error"><CircleAlert size={14} />{error}</div>}
			{servers.map((server) => <button className={`skill-entry ${selectedServer?.id === server.id ? "selected" : ""}`} key={server.id} onClick={() => void onSelect(server.id)}><Plug size={14} /><span><strong>{server.name}</strong><small>{server.trusted ? `${server.toolCount} 个工具 · ${server.readOnly ? "只读" : "需要批准"}` : "未由服务端授信"}</small></span></button>)}
			{!loading && servers.length === 0 && <div className="workbench-empty">尚未配置 MCP 服务</div>}
		</aside>
		<div className="skills-content">{selectedServer ? <><div className="editor-heading"><Plug size={15} /><strong>{selectedServer.name}</strong><span>{selectedServer.transport}</span></div><div className="mcp-tool-list">{selectedServer.tools.map((tool) => <article className="mcp-tool" key={tool.name}><div><strong>{tool.name}</strong><span>{tool.description || "暂无说明"}</span></div>{tool.inputSchema && <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>}</article>)}{selectedServer.tools.length === 0 && <div className="workbench-empty">{selectedServer.trusted ? "该服务未提供工具" : "服务未授信，不会启动"}</div>}</div></> : <div className="workbench-empty"><Plug size={24} /><span>选择一个 MCP 服务</span></div>}</div>
	</section>;
}

const TOOL_CATEGORY_LABELS: Record<ToolStatus["category"], string> = {
	filesystem: "文件",
	process: "进程",
	network: "网络",
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

function ToolsView({ tools, runtime, onRefresh }: { tools: ToolStatus[]; runtime: "pi" | "demo" | undefined; onRefresh: () => Promise<ToolStatus[]> }) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const refresh = async () => {
		setLoading(true);
		setError(undefined);
		try { await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setLoading(false); }
	};
	const ready = tools.filter((tool) => tool.status === "ready").length;
	const configurable = tools.filter((tool) => tool.status === "requires_configuration").length;
	return <section className="tools-workbench" aria-label="工具状态">
		<div className="tools-heading">
			<div><Wrench size={17} /><span><strong>Tools</strong><small>{runtime === "pi" ? "Pi Agent" : runtime === "demo" ? "Demo" : "未连接"}</small></span></div>
			<div className="tool-summary"><span><i className="ready" />{ready} 可用</span><span><i className="config" />{configurable} 待配置</span><span><i className="disabled" />{tools.length - ready - configurable} 禁用</span></div>
			<button className="icon-button" title="刷新工具状态" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} /></button>
		</div>
		{error && <div className="workbench-error"><CircleAlert size={14} />{error}</div>}
		<div className="tool-status-table" role="table" aria-label="Agent 工具目录">
			<div className="tool-status-header" role="row"><span>工具</span><span>类型</span><span>状态</span><span>执行后端</span><span>沙箱模式</span></div>
			{tools.map((tool) => <div className="tool-status-row" role="row" key={tool.name}>
				<div className="tool-name"><code>{tool.name}</code><small>{tool.label} · {tool.description}</small></div>
				<span>{TOOL_CATEGORY_LABELS[tool.category]}</span>
				<span className={`tool-status ${tool.status}`}><i />{TOOL_STATUS_LABELS[tool.status]}</span>
				<div className="tool-backend"><span>{tool.backend}</span>{tool.reason && <small>{tool.reason}</small>}</div>
				<div className="tool-sandbox-modes">{tool.sandboxModes.map((mode) => <span key={mode}>{SANDBOX_MODE_LABELS[mode]}</span>)}</div>
			</div>)}
			{!loading && tools.length === 0 && <div className="workbench-empty"><Wrench size={24} /><span>没有可显示的工具</span></div>}
		</div>
	</section>;
}

function SubagentsView({
	subagents,
	disabled,
	onCreate,
	onCancel,
	onRespondApproval,
	onRefresh,
}: {
	subagents: SubagentSummary[];
	disabled: boolean;
	onCreate: (input: { task: string; name?: string; costBudgetUsd?: number; tokenBudget?: number }) => Promise<SubagentSummary>;
	onCancel: (subagentId: string) => Promise<SubagentSummary>;
	onRespondApproval: (sessionId: string, approvalId: string, decision: "approve" | "deny") => Promise<void>;
	onRefresh: () => Promise<SubagentSummary[]>;
}) {
	const [selectedId, setSelectedId] = useState<string>();
	const [task, setTask] = useState("");
	const [name, setName] = useState("");
	const [costBudget, setCostBudget] = useState("");
	const [tokenBudget, setTokenBudget] = useState("");
	const [creating, setCreating] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const [error, setError] = useState<string>();
	const selected = subagents.find((subagent) => subagent.id === selectedId) ?? subagents[0];

	useEffect(() => {
		if (!selectedId || !subagents.some((subagent) => subagent.id === selectedId)) setSelectedId(subagents[0]?.id);
	}, [selectedId, subagents]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const normalizedTask = task.trim();
		const cost = costBudget.trim() ? Number(costBudget) : undefined;
		const tokens = tokenBudget.trim() ? Number(tokenBudget) : undefined;
		if (!normalizedTask) return setError("请填写任务内容");
		if (cost !== undefined && (!Number.isFinite(cost) || cost <= 0)) return setError("费用限额必须大于 0");
		if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens <= 0)) return setError("Token 限额必须是正整数");
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
		try { await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setRefreshing(false); }
	};

	const cancel = async () => {
		if (!selected) return;
		setCancelling(true);
		setError(undefined);
		try { await onCancel(selected.id); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setCancelling(false); }
	};

	const active = selected && ["queued", "running", "awaiting_approval", "cancelling"].includes(selected.status);
	return (
		<section className="subagents-workbench" aria-label="子智能体">
			<aside className="subagents-sidebar">
				<div className="workbench-heading">
					<div><strong>智能体</strong><span>{subagents.length} 个任务</span></div>
					<button className="icon-button" title="刷新智能体" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={15} /></button>
				</div>
				<form className="subagent-create" onSubmit={(event) => void submit(event)}>
					<label><span>任务</span><textarea rows={4} maxLength={20_000} placeholder="调查问题并汇报结果" value={task} onChange={(event) => setTask(event.target.value)} /></label>
					<label><span>名称</span><input maxLength={500} placeholder="可选" value={name} onChange={(event) => setName(event.target.value)} /></label>
					<div className="subagent-budget-fields">
						<label><span>费用限额（USD）</span><input inputMode="decimal" placeholder="继承主会话" value={costBudget} onChange={(event) => setCostBudget(event.target.value)} /></label>
						<label><span>Token 限额</span><input inputMode="numeric" placeholder="继承主会话" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} /></label>
					</div>
					<button className="subagent-create-button" type="submit" disabled={disabled || creating || !task.trim()}><Plus size={15} />{creating ? "正在创建..." : "创建智能体"}</button>
				</form>
				{error && <div className="workbench-error"><CircleAlert size={14} />{error}</div>}
				<nav className="subagent-list" aria-label="智能体任务">
					{subagents.map((subagent) => (
						<button className={`subagent-entry ${selected?.id === subagent.id ? "selected" : ""}`} type="button" key={subagent.id} onClick={() => setSelectedId(subagent.id)}>
							<i className={`subagent-status status-${subagent.status}`} />
							<span><strong>{subagent.name}</strong><small>{statusLabel(subagent.status)} · {formatRunTime(subagent.updatedAt)}</small></span>
						</button>
					))}
					{subagents.length === 0 && <div className="subagent-list-empty">暂无智能体任务</div>}
				</nav>
			</aside>
			<div className="subagent-detail">
				{selected ? (
					<>
						<header className="subagent-detail-heading">
							<div><Bot size={16} /><span><strong>{selected.name}</strong><small>{selected.model.provider}/{selected.model.id}</small></span></div>
							{active && <button className="subagent-cancel" type="button" title="取消智能体任务" disabled={cancelling || selected.status === "cancelling"} onClick={() => void cancel()}><Square size={13} />{selected.status === "cancelling" ? "正在取消" : "取消"}</button>}
						</header>
						<div className="subagent-detail-scroll">
							<div className="subagent-meta">
								<span className={`subagent-status-label status-${selected.status}`}><i />{statusLabel(selected.status)}</span>
								<span>{formatTokens(selected.usage.totalTokens)} Token</span>
								<span>{formatMoney(selected.usage.costUsd)}</span>
								{selected.startedAt && <span>{formatDuration(selected.startedAt, selected.finishedAt ?? (["running", "awaiting_approval", "cancelling"].includes(selected.status) ? Date.now() : selected.updatedAt))}</span>}
								{selected.costBudgetUsd && <span>限额 {formatMoney(selected.costBudgetUsd)}</span>}
								{selected.tokenBudget && <span>限额 {formatTokens(selected.tokenBudget)} Token</span>}
							</div>
							<section className="subagent-section"><h2>任务</h2><p>{selected.task}</p></section>
							{selected.pendingApprovals.map((approval) => <ApprovalPanel key={approval.id} approval={approval} onRespond={(decision) => onRespondApproval(selected.sessionId, approval.id, decision)} />)}
							{selected.result !== undefined && <section className="subagent-section"><h2>结果</h2><pre>{selected.result || "任务已完成，但没有文本结果。"}</pre></section>}
							{selected.error && <section className="subagent-error"><CircleAlert size={15} /><span>{selected.error}</span></section>}
							{active && selected.pendingApprovals.length === 0 && <div className="subagent-running"><Activity size={17} /><span>{selected.status === "queued" ? "等待开始" : selected.status === "cancelling" ? "正在停止任务" : "正在工作"}</span></div>}
						</div>
					</>
				) : <div className="workbench-empty"><Bot size={24} /><span>创建一个智能体任务</span></div>}
			</div>
		</section>
	);
}

function BudgetEditor({ snapshot, onSave }: { snapshot: SessionSnapshot; onSave: (budget: { costBudgetUsd?: number | null; tokenBudget?: number | null; budgetWarningThreshold?: number }) => Promise<void> }) {
	const [editing, setEditing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const [costDraft, setCostDraft] = useState(snapshot.costBudgetUsd?.toString() ?? "");
	const [tokenDraft, setTokenDraft] = useState(snapshot.tokenBudget?.toString() ?? "");
	const [thresholdDraft, setThresholdDraft] = useState(String(Math.round((snapshot.budgetWarningThreshold ?? 0.8) * 100)));

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
		if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) return setError("预警阈值必须在 1 到 100 之间");
		setSaving(true);
		setError(undefined);
		try {
			await onSave({ costBudgetUsd: cost, tokenBudget: tokens, budgetWarningThreshold: threshold / 100 });
			setEditing(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	const canEdit = snapshot.session.phase === "idle" && snapshot.session.archivedAt === undefined;
	return (
		<>
			<div className="rail-section-heading">
				<h2>用量</h2>
				{!editing && <button className="rail-icon-button" type="button" title="编辑会话限额" disabled={!canEdit} onClick={() => { setError(undefined); setEditing(true); }}><Pencil size={13} /></button>}
			</div>
			<div className="metric"><strong>{formatTokens(snapshot.usage.totalTokens)}</strong><span>Token</span></div>
			<div className="metric"><strong>{formatMoney(snapshot.usage.costUsd)}</strong><span>费用</span></div>
			{snapshot.usageByModel && snapshot.usageByModel.length > 0 && <div className="usage-breakdown"><div className="usage-breakdown-title">按模型</div>{snapshot.usageByModel.map((entry) => <div className="usage-breakdown-row" key={`${entry.model.provider}/${entry.model.id}`}><span>{entry.model.provider}/{entry.model.id}</span><strong>{formatTokens(entry.usage.totalTokens)} · {formatMoney(entry.usage.costUsd)}</strong></div>)}</div>}
			{snapshot.usageByTool && snapshot.usageByTool.length > 0 && <div className="usage-breakdown"><div className="usage-breakdown-title">按工具</div>{snapshot.usageByTool.map((entry) => <div className="usage-breakdown-row" key={entry.toolName}><span>{formatToolObservation(entry)}</span><strong>{formatTokens(entry.usage.totalTokens)} · {formatMoney(entry.usage.costUsd)}</strong></div>)}</div>}
			{snapshot.usageByTurn && snapshot.usageByTurn.length > 0 && <div className="usage-breakdown"><div className="usage-breakdown-title">按轮次</div>{snapshot.usageByTurn.slice(-5).reverse().map((entry) => <div className="usage-breakdown-row" key={entry.turnId}><span>{entry.mode === "prompt" ? "提问" : entry.mode} · {entry.requests.length} 次请求</span><strong>{formatTokens(entry.usage.totalTokens)} · {formatMoney(entry.usage.costUsd)}</strong></div>)}</div>}
			{snapshot.costBudgetUsd !== undefined && <div className="kv"><span>剩余费用</span><strong>{formatMoney(Math.max(0, snapshot.costBudgetUsd - snapshot.usage.costUsd))}</strong></div>}
			{snapshot.tokenBudget !== undefined && <div className="kv"><span>剩余 Token</span><strong>{formatTokens(Math.max(0, snapshot.tokenBudget - snapshot.usage.totalTokens))}</strong></div>}
			{((snapshot.costBudgetUsd !== undefined && snapshot.usage.costUsd / snapshot.costBudgetUsd >= (snapshot.budgetWarningThreshold ?? 0.8)) || (snapshot.tokenBudget !== undefined && snapshot.usage.totalTokens / snapshot.tokenBudget >= (snapshot.budgetWarningThreshold ?? 0.8))) && <div className="budget-warning"><CircleAlert size={13} />用量预警</div>}
			{snapshot.budgetWarnings?.map((warning) => <div className="budget-warning" key={warning.id}><CircleAlert size={13} />{warning.kind === "tokens" ? "Token" : "费用"}用量已超过 {Math.round(warning.threshold * 100)}%</div>)}
			{editing && <form className="budget-form" onSubmit={(event) => void submit(event)}>
				<label><span>费用限额（USD）</span><input type="number" min="0.0001" step="0.0001" placeholder="不限" value={costDraft} onChange={(event) => setCostDraft(event.target.value)} /></label>
				<label><span>Token 限额</span><input type="number" min="1" step="1" placeholder="不限" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} /></label>
				<label><span>预警阈值</span><div className="budget-percent"><input type="number" min="1" max="100" step="1" value={thresholdDraft} onChange={(event) => setThresholdDraft(event.target.value)} /><span>%</span></div></label>
				{error && <div className="budget-form-error">{error}</div>}
				<div className="budget-form-actions">
					<button type="button" title="取消修改" disabled={saving} onClick={() => setEditing(false)}><X size={14} /></button>
					<button type="submit" title="保存会话限额" disabled={saving}><Check size={14} /></button>
				</div>
			</form>}
		</>
	);
}

function RightRail({ snapshot, runs, onSetBudget, onClose }: { snapshot: SessionSnapshot | undefined; runs: RunSummary[]; onSetBudget: (budget: { costBudgetUsd?: number | null; tokenBudget?: number | null; budgetWarningThreshold?: number }) => Promise<void>; onClose: () => void }) {
	return (
		<aside className="right-rail">
			<div className="rail-section">
				<div className="rail-section-heading"><h2>运行</h2><button className="rail-icon-button rail-mobile-close" type="button" title="关闭运行面板" onClick={onClose}><X size={14} /></button></div>
				<div className="kv"><span>状态</span><strong className={`phase phase-${snapshot?.session.phase ?? "idle"}`}>{statusLabel(snapshot?.session.phase ?? "idle")}</strong></div>
				<div className="kv"><span>沙箱</span><strong>{sandboxLabel(snapshot?.sandboxMode)}</strong></div>
				<div className="kv"><span>批准策略</span><strong>{approvalPolicyLabel(snapshot?.approvalPolicy)}</strong></div>
				<div className="kv"><span>即时补充队列</span><strong>{snapshot?.queuedSteerCount ?? 0}</strong></div>
				<div className="kv"><span>后续任务队列</span><strong>{snapshot?.queuedFollowUpCount ?? 0}</strong></div>
			</div>
			<div className="rail-section">
				{snapshot ? <BudgetEditor snapshot={snapshot} onSave={onSetBudget} /> : <><h2>用量</h2><div className="run-empty">未选择会话</div></>}
			</div>
			<div className="rail-section">
				<h2>最近运行</h2>
				<div className="run-history">
					{runs.length === 0 && <div className="run-empty">暂无运行记录</div>}
					{runs.map((run) => (
						<div className="run-row" key={run.id} title={run.error}>
							<div className="run-row-heading">
								<span className={`run-dot run-${run.status}`} />
								<strong>{run.mode === "prompt" ? "提问" : run.mode === "steer" ? "即时补充" : "后续任务"}</strong>
								<div className="run-row-actions"><span>{statusLabel(run.status)}</span><RunDiagnosticButton snapshot={snapshot} run={run} /></div>
							</div>
							<div className="run-meta">
								<span>{formatRunTime(run.createdAt)}</span>
								<span>{formatRunDuration(run)}</span>
								{run.attempt > 1 && <span>第 {run.attempt} 次尝试</span>}
								{run.retryHistory && run.retryHistory.length > 0 && <span>已重试 {run.retryHistory.length} 次</span>}
								{run.usage && <span>{formatTokens(run.usage.totalTokens)} · {formatMoney(run.usage.costUsd)}</span>}
								{run.model && <span>{run.model.provider}/{run.model.id}</span>}
								{run.tools && run.tools.length > 0 && <span>{run.tools.map(formatToolObservation).join("; ")}</span>}
								{run.traceId && <span title={run.traceId}>Trace {run.traceId.slice(0, 8)}</span>}
								{run.failureKind && <span>{failureKindLabel(run.failureKind)}</span>}
								{run.abortRequested && <span>已请求停止</span>}
							</div>
							{run.error && <div className="run-error">{run.error}</div>}
							{run.retryHistory && run.retryHistory.length > 0 && <details className="run-retries">
								<summary>重试 {run.retryHistory.at(-1)?.attempt}/{run.retryHistory.at(-1)?.maxAttempts}</summary>
								{run.retryHistory.map((retry, index) => <div className="retry-entry" key={`${retry.timestamp}-${index}`}>
									<div><strong>重试 {retry.attempt}/{retry.maxAttempts}</strong><span>{formatRunTime(retry.timestamp)} · 等待 {formatDelay(retry.delayMs)}</span></div>
									<p>{retry.error}</p>
								</div>)}
							</details>}
						</div>
					))}
				</div>
			</div>
			<div className="rail-section">
				<h2>工作区</h2>
				<div className="rail-item"><ShieldCheck size={16} /><span>隔离执行</span></div>
				<div className="rail-item"><FileCode2 size={16} /><span>{snapshot?.transcript.length ?? 0} 条对话记录</span></div>
			</div>
		</aside>
	);
}

function SessionNavigation({
	sessions,
	selectedSessionId,
	workspaceId,
	archived,
	query,
	disabled,
	onQueryChange,
	onCollectionChange,
	onRefresh,
	onSelect,
	onRename,
	onArchive,
}: {
	sessions: SessionSummary[];
	selectedSessionId?: string;
	workspaceId?: string;
	archived: boolean;
	query: string;
	disabled: boolean;
	onQueryChange: (query: string) => void;
	onCollectionChange: (archived: boolean) => Promise<void>;
	onRefresh: (workspaceId: string, options: { query?: string; archived?: boolean }) => Promise<SessionSummary[]>;
	onSelect: (sessionId: string) => void;
	onRename: (sessionId: string, name: string) => Promise<void>;
	onArchive: (sessionId: string, archived: boolean) => Promise<void>;
}) {
	const [renamingId, setRenamingId] = useState<string>();
	const [nameDraft, setNameDraft] = useState("");
	const [busyId, setBusyId] = useState<string>();
	const [error, setError] = useState<string>();

	useEffect(() => {
		if (!workspaceId || disabled) return;
		const timer = setTimeout(() => {
			void onRefresh(workspaceId, { query, archived }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
		}, 180);
		return () => clearTimeout(timer);
	}, [archived, disabled, onRefresh, query, workspaceId]);

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
			<div className="session-browser-heading">
				<span className="nav-label">{archived ? "已归档" : "会话"}</span>
				<button
					type="button"
					className={`session-collection-toggle ${archived ? "pressed" : ""}`}
					title={archived ? "显示活跃会话" : "显示已归档会话"}
					disabled={disabled || !workspaceId}
					onClick={() => {
						setError(undefined);
						void onCollectionChange(!archived).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
					}}
				>
					{archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
				</button>
			</div>
			<label className="session-search">
				<Search size={14} />
				<input aria-label="搜索会话" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索会话" />
				{query && <button type="button" title="清空搜索" onClick={() => onQueryChange("")}><X size={13} /></button>}
			</label>
			<nav className="session-nav" aria-label={archived ? "已归档会话" : "会话"}>
				{sessions.map((session) => (
					<div className={`session-entry ${selectedSessionId === session.id ? "selected" : ""}`} key={session.id}>
						{renamingId === session.id ? (
							<form className="session-rename" onSubmit={(event) => void submitRename(event)}>
								<input aria-label="会话名称" autoFocus maxLength={500} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} />
								<button type="submit" title="保存名称" disabled={!nameDraft.trim() || busyId === session.id}><Check size={13} /></button>
								<button type="button" title="取消重命名" onClick={() => setRenamingId(undefined)}><X size={13} /></button>
							</form>
						) : (
							<>
								<button className="session-open" type="button" onClick={() => onSelect(session.id)}>
									<MessageSquareCode size={15} />
									<span>{session.name || "未命名会话"}</span>
									<i className={`session-phase dot-${session.phase}`} />
								</button>
								<div className="session-actions">
									<button type="button" title="重命名会话" disabled={session.phase !== "idle" || busyId === session.id} onClick={() => { setRenamingId(session.id); setNameDraft(session.name || "未命名会话"); }}><Pencil size={12} /></button>
									<button
										type="button"
										title={archived ? "恢复会话" : "归档会话"}
										disabled={session.phase !== "idle" || busyId === session.id}
										onClick={() => {
											setBusyId(session.id);
											setError(undefined);
											void onArchive(session.id, !archived)
												.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
												.finally(() => setBusyId(undefined));
										}}
									>
										{archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
									</button>
								</div>
							</>
						)}
					</div>
				))}
				{sessions.length === 0 && <div className="session-list-empty">暂无{archived ? "已归档" : ""}会话</div>}
			</nav>
			{error && <div className="session-list-error"><CircleAlert size={13} />{error}</div>}
		</div>
	);
}

export function App() {
	const client = useWumingClient();
	const [workbenchView, setWorkbenchView] = useState<"chat" | "agents" | "files" | "changes" | "terminal" | "tools" | "skills" | "mcp">("chat");
	const [mobileNav, setMobileNav] = useState(false);
	const [showRight, setShowRight] = useState(() => window.innerWidth > 1080);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [sessionQuery, setSessionQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const [tokenDraft, setTokenDraft] = useState(client.token);
	const endRef = useRef<HTMLDivElement>(null);
	const localGateway = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
	const active = ["turn", "awaiting_approval", "compaction", "retry"].includes(client.snapshot?.session.phase ?? "idle");
	const selectedWorkspace = client.workspaces.find((workspace) => workspace.id === client.selectedWorkspaceId) ?? client.workspaces[0];
	const composerModels = client.models.filter((model) => model.custom === true);
	const selectedModel = composerModels.find((model) =>
		model.model.provider === client.selectedModel?.provider && model.model.id === client.selectedModel.id,
	) ?? composerModels[0];
	const showThinkingActivity = client.snapshot !== undefined
		&& ["turn", "retry", "compaction"].includes(client.snapshot.session.phase)
		&& Object.keys(client.liveAssistants).length === 0
		&& Object.keys(client.liveTools).length === 0;

	useEffect(() => {
		endRef.current?.scrollIntoView({ block: "end" });
	}, [client.snapshot?.transcript.length, client.liveAssistants, client.liveTools, showThinkingActivity]);

	return (
		<div className={`app-shell ${showRight && workbenchView === "chat" ? "with-right" : ""}`}>
			<aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
				<div className="brand-row">
					<div className="brand-mark">W</div>
					<strong>Wuming</strong>
					<button className="icon-button mobile-close" title="关闭导航" onClick={() => setMobileNav(false)}><X size={18} /></button>
				</div>
				<label className="workspace-select">
					<span>工作区</span>
					<select
						aria-label="工作区"
						value={selectedWorkspace?.id ?? ""}
						disabled={client.connection !== "connected" || client.workspaces.length === 0}
						onChange={(event) => void client.selectWorkspace(event.target.value)}
					>
						{client.workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspaceName(workspace.name)}</option>)}
					</select>
					<ChevronDown size={15} />
				</label>
				<button className="new-session" onClick={() => { setSessionQuery(""); setShowArchived(false); void client.createSession(); }} disabled={client.connection !== "connected" || !client.models.length}>
					<Plus size={16} /> 新建会话
				</button>
				<SessionNavigation
					sessions={client.sessions}
					{...(client.snapshot ? { selectedSessionId: client.snapshot.session.id } : {})}
					{...(selectedWorkspace ? { workspaceId: selectedWorkspace.id } : {})}
					archived={showArchived}
					query={sessionQuery}
					disabled={client.connection !== "connected"}
					onQueryChange={setSessionQuery}
					onCollectionChange={async (archived) => {
						if (!selectedWorkspace) return;
						setShowArchived(archived);
						await client.browseSessions(selectedWorkspace.id, { query: sessionQuery, archived });
					}}
					onRefresh={client.refreshSessions}
					onSelect={(sessionId) => { void client.attachSession(sessionId); setMobileNav(false); }}
					onRename={client.renameSession}
					onArchive={client.archiveSession}
				/>
				<div className="sidebar-footer">
					<button onClick={() => { setMobileNav(false); setSettingsOpen(true); }}><Settings size={16} /> 设置</button>
					<div className={`connection ${client.connection}`}><i />{statusLabel(client.connection)}</div>
				</div>
			</aside>

			<main className="workspace-main">
				<header className="topbar">
					<div className="topbar-title">
						<button className="icon-button mobile-menu" title="打开导航" onClick={() => setMobileNav(true)}><Menu size={19} /></button>
							<div><h1>{client.snapshot?.session.name || "新会话"}</h1><span>{client.snapshot?.session.archivedAt ? "已归档 · " : ""}{selectedWorkspace ? workspaceName(selectedWorkspace.name) : "本地工作区"}</span></div>
					</div>
					<div className="workbench-tabs" role="tablist" aria-label="工作区视图">
						<button role="tab" aria-selected={workbenchView === "chat"} className={workbenchView === "chat" ? "active" : ""} title="对话" onClick={() => setWorkbenchView("chat")}><MessageSquareCode size={15} /><span>对话</span></button>
						{client.capabilities.includes("subagents") && <button role="tab" aria-selected={workbenchView === "agents"} className={workbenchView === "agents" ? "active" : ""} title="智能体" onClick={() => setWorkbenchView("agents")}><Bot size={15} /><span>智能体</span></button>}
						<button role="tab" aria-selected={workbenchView === "files"} className={workbenchView === "files" ? "active" : ""} title="文件" onClick={() => setWorkbenchView("files")}><Folder size={15} /><span>文件</span></button>
						<button role="tab" aria-selected={workbenchView === "changes"} className={workbenchView === "changes" ? "active" : ""} title="更改" onClick={() => setWorkbenchView("changes")}><GitBranch size={15} /><span>更改</span></button>
						<button role="tab" aria-selected={workbenchView === "terminal"} className={workbenchView === "terminal" ? "active" : ""} title="终端" onClick={() => setWorkbenchView("terminal")}><TerminalSquare size={15} /><span>终端</span></button>
						{client.capabilities.includes("tools") && <button role="tab" aria-selected={workbenchView === "tools"} className={workbenchView === "tools" ? "active" : ""} title="工具" onClick={() => setWorkbenchView("tools")}><Wrench size={15} /><span>工具</span></button>}
						<button role="tab" aria-selected={workbenchView === "skills"} className={workbenchView === "skills" ? "active" : ""} title="技能" onClick={() => setWorkbenchView("skills")}><BookOpen size={15} /><span>技能</span></button>
						<button role="tab" aria-selected={workbenchView === "mcp"} className={workbenchView === "mcp" ? "active" : ""} title="MCP" onClick={() => setWorkbenchView("mcp")}><Plug size={15} /><span>MCP</span></button>
					</div>
					<div className="topbar-actions">
						{workbenchView === "chat" && client.snapshot && client.capabilities.includes("session.compaction") && <button
							className="icon-button"
							title="整理上下文"
							disabled={client.connection !== "connected" || active || client.snapshot.session.archivedAt !== undefined}
							onClick={() => void client.compactSession()}
						><RefreshCw size={16} /></button>}
						{workbenchView === "chat" && client.snapshot && <button
							className="icon-button"
							title="派生会话"
							disabled={client.connection !== "connected" || active || client.snapshot.session.archivedAt !== undefined}
							onClick={() => void client.forkSession()}
						><GitBranch size={17} /></button>}
						{workbenchView === "chat" && <button className={`icon-button ${showRight ? "pressed" : ""}`} title="显示或隐藏运行面板" onClick={() => setShowRight((value) => !value)}><PanelRight size={18} /></button>}
					</div>
				</header>

				{workbenchView === "chat" && <section className="conversation">
					<div className="transcript">
						{client.snapshot?.pendingApprovals.map((approval) => (
							<ApprovalPanel
								key={approval.id}
								approval={approval}
								onRespond={(decision) => client.respondApproval(approval.sessionId, approval.id, decision)}
							/>
						))}
						{!client.snapshot && (
							<div className="empty-state">
								<div className="empty-icon"><MessageSquareCode size={24} /></div>
								<h2>{client.sessions.length ? "请选择一个会话" : "可以开始新会话了"}</h2>
							</div>
						)}
						{client.snapshot?.transcript.map((item) => <TranscriptItemView item={item} key={item.id} onDownload={client.downloadArtifact} />)}
						{Object.values(client.liveAssistants).map((item) => <LiveAssistantView item={item} key={item.id} />)}
						{Object.values(client.liveTools).map((tool) => <LiveToolView tool={tool} key={tool.toolCallId} />)}
						{showThinkingActivity && <ThinkingActivity phase={client.snapshot!.session.phase} />}
						{client.error && <div className="global-error"><CircleAlert size={16} />{client.error}</div>}
						<div ref={endRef} />
					</div>
					<div className="composer-wrap">
						<Composer
							key={client.snapshot?.session.id ?? "no-session"}
							disabled={!client.snapshot || client.snapshot.session.archivedAt !== undefined || client.connection !== "connected"}
							active={active}
							models={composerModels}
							selectedModel={selectedModel}
							modelSelectionDisabled={client.connection !== "connected" || active || client.snapshot?.session.archivedAt !== undefined}
							onSelectModel={(model) => {
								client.selectModel(model);
								if (client.snapshot?.session.phase === "idle" &&
									(client.snapshot.model.provider !== model.provider || client.snapshot.model.id !== model.id)) {
									void client.setSessionModel(model);
								}
							}}
							onSend={client.sendPrompt}
							onAbort={client.abortTurn}
							onUpload={client.uploadArtifact}
						/>
					</div>
				</section>}
				{workbenchView === "agents" && <SubagentsView
					subagents={client.subagents}
					disabled={!client.snapshot || client.snapshot.session.archivedAt !== undefined || client.connection !== "connected"}
					onCreate={client.createSubagent}
					onCancel={client.cancelSubagent}
					onRespondApproval={client.respondApproval}
					onRefresh={() => client.snapshot ? client.refreshSubagents(client.snapshot.session.id) : Promise.resolve([])}
				/>}
				{workbenchView === "files" && selectedWorkspace && <WorkspaceFilesView token={client.token} workspaceId={selectedWorkspace.id} />}
				{workbenchView === "changes" && selectedWorkspace && <ChangesView token={client.token} workspaceId={selectedWorkspace.id} />}
				{workbenchView === "terminal" && selectedWorkspace && (
					<Suspense fallback={<div className="workbench-empty">正在加载终端...</div>}>
						<TerminalView token={client.token} workspaceId={selectedWorkspace.id} />
					</Suspense>
				)}
				{workbenchView === "tools" && selectedWorkspace && <ToolsView tools={client.tools} runtime={client.toolRuntime} onRefresh={() => client.refreshTools(selectedWorkspace.id)} />}
				{workbenchView === "skills" && selectedWorkspace && <SkillsView skills={client.skills} selectedSkill={client.selectedSkill} onRefresh={() => client.refreshSkills(selectedWorkspace.id)} onSelect={(skillId) => client.getSkill(selectedWorkspace.id, skillId)} />}
				{workbenchView === "mcp" && selectedWorkspace && <McpView servers={client.mcpServers} selectedServer={client.selectedMcpServer} onRefresh={() => client.refreshMcp(selectedWorkspace.id)} onSelect={(serverId) => client.getMcp(selectedWorkspace.id, serverId)} />}
			</main>

			{showRight && workbenchView === "chat" && <RightRail snapshot={client.snapshot} runs={client.runs} onSetBudget={client.setSessionBudget} onClose={() => setShowRight(false)} />}
			{showRight && workbenchView === "chat" && <button className="right-rail-scrim" aria-label="关闭运行面板" onClick={() => setShowRight(false)} />}
			{mobileNav && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}

			{settingsOpen && (
				<div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
					<div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
						<div className="dialog-header"><h2 id="settings-title">设置</h2><button className="icon-button" title="关闭" onClick={() => setSettingsOpen(false)}><X size={18} /></button></div>
						{localGateway ? <details className="gateway-settings"><summary>网关连接</summary><label>服务令牌<input type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} /></label><div className="dialog-actions"><button className="secondary-button" onClick={() => { client.setToken(tokenDraft); setSettingsOpen(false); }}>重新连接</button></div></details> : <><label>服务令牌<input type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} /></label><div className="dialog-actions"><button className="primary-button" onClick={() => { client.setToken(tokenDraft); setSettingsOpen(false); }}>重新连接</button></div></>}
						{client.capabilities.includes("model.custom") && <CustomModelSettings models={client.models} onDiscover={client.discoverCustomModels} onListServices={client.listCustomModelServices} onRefreshService={client.refreshCustomModelService} onRemoveService={client.removeCustomModelService} onGet={client.getCustomModelSettings} onConfigure={async (configs) => {
							const configured = await client.configureCustomModels(configs);
							const selected = configured.at(-1);
							if (selected && client.snapshot?.session.phase === "idle") await client.setSessionModel(selected.model);
							return configured;
						}} onTest={client.testCustomModel} onRemove={client.removeCustomModel} />}
					</div>
				</div>
			)}
		</div>
	);
}

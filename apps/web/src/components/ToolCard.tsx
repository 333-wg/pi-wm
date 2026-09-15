import {
	Activity,
	AppWindow,
	Bot,
	Braces,
	Bug,
	Camera,
	ChevronRight,
	CircleAlert,
	CircleCheck,
	Clock,
	CloudSun,
	Download,
	FileDiff,
	FilePen,
	FileSearch,
	FileText,
	FolderSearch,
	FolderTree,
	Globe,
	ListChecks,
	MousePointerClick,
	PanelTopClose,
	Plug,
	ScanSearch,
	Search,
	ShieldAlert,
	SquareTerminal,
	Wrench,
	Image,
	Video,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { ArtifactRef, ContentPart, WebEvidence } from "@wuming/protocol";
import { CodeBlock } from "./CodeBlock";
import { ImageViewer } from "./ImageViewer.js";
import { DiffStat, EditDiff, editDiffStat } from "./DiffView";

export type ToolStatusValue = "pending" | "awaiting_approval" | "running" | "complete" | "error" | "aborted";

const statusText: Record<ToolStatusValue, string> = {
	pending: "排队中",
	awaiting_approval: "等待批准",
	running: "运行中",
	complete: "已完成",
	error: "失败",
	aborted: "已取消",
};

const extensionLanguages: Record<string, string> = {
	ts: "ts",
	tsx: "tsx",
	mts: "ts",
	js: "js",
	jsx: "jsx",
	mjs: "js",
	cjs: "js",
	json: "json",
	jsonc: "json",
	py: "python",
	rb: "ruby",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	ps1: "powershell",
	css: "css",
	scss: "scss",
	less: "less",
	html: "html",
	htm: "html",
	vue: "vue",
	xml: "xml",
	svg: "svg",
	md: "markdown",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	ini: "ini",
	sql: "sql",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cpp: "cpp",
	patch: "diff",
	diff: "diff",
};

export function languageFromPath(path: string): string {
	const extension = /\.([A-Za-z0-9+]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
	return extensionLanguages[extension] ?? "";
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function scalar(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function shortPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length <= 2) return normalized;
	return `…/${parts.slice(-2).join("/")}`;
}

interface EditBlock {
	oldText: string;
	newText: string;
}

function readEdits(input: unknown): EditBlock[] {
	const raw = asRecord(input).edits;
	if (!Array.isArray(raw)) return [];
	const blocks: EditBlock[] = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		const oldText = asText(record.oldText) ?? asText(record.old_text);
		const newText = asText(record.newText) ?? asText(record.new_text);
		if (oldText === undefined && newText === undefined) continue;
		blocks.push({ oldText: oldText ?? "", newText: newText ?? "" });
	}
	return blocks;
}

type PlanStepStatus = "pending" | "in_progress" | "completed";

const planStatusText: Record<PlanStepStatus, string> = {
	pending: "待办",
	in_progress: "进行中",
	completed: "已完成",
};
const planStatusMark: Record<PlanStepStatus, string> = {
	pending: "○",
	in_progress: "▸",
	completed: "✓",
};

/** Reads `update_plan`'s steps, tolerating a partially streamed argument object. */
function readPlan(input: Record<string, unknown>): Array<{ step: string; status: PlanStepStatus }> {
	const raw = input.plan;
	if (!Array.isArray(raw)) return [];
	const steps: Array<{ step: string; status: PlanStepStatus }> = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		const step = asText(record.step);
		if (step === undefined) continue;
		const status = asText(record.status);
		steps.push({
			step,
			status: status === "completed" || status === "in_progress" ? status : "pending",
		});
	}
	return steps;
}

export interface ToolDescription {
	icon: ReactNode;
	verb: string;
	target?: string;
	title?: string;
	meta?: ReactNode;
	body?: ReactNode;
	/** Raw arguments worth showing when nothing more specific was recognised. */
	fallbackArgs?: boolean;
	/** Read-only calls stay collapsed so the transcript keeps its shape. */
	quiet?: boolean;
}

export function describeTool(toolName: string, input: unknown): ToolDescription {
	const args = asRecord(input);
	const size = 15;
	if (toolName === "media_model_status") {
		return { icon: <Image size={size} />, verb: "查看生成模型配置", quiet: true };
	}
	if (toolName === "generate_image" || toolName === "generate_video" || toolName === "get_generated_video") {
		return {
			icon: toolName === "generate_image" ? <Image size={size} /> : <Video size={size} />,
			verb: toolName === "generate_image" ? "生成图片" : toolName === "generate_video" ? "生成视频" : "获取视频",
			target: asText(args.prompt) ?? asText(args.jobId) ?? "",
			fallbackArgs: true,
		};
	}
	if (toolName === "read_file") {
		const path = asText(args.path) ?? "";
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		const range =
			offset !== undefined && limit !== undefined
				? `行 ${offset}–${offset + limit - 1}`
				: offset !== undefined
					? `从第 ${offset} 行`
					: limit !== undefined
						? `前 ${limit} 行`
						: undefined;
		return {
			icon: <FileText size={size} />,
			verb: "读取",
			target: shortPath(path),
			title: path,
			meta: range,
			quiet: true,
		};
	}
	if (toolName === "write_file") {
		const path = asText(args.path) ?? "";
		const content = asText(args.content) ?? "";
		const lines = content.length === 0 ? 0 : content.split("\n").length;
		return {
			icon: <FilePen size={size} />,
			verb: "写入",
			target: shortPath(path),
			title: path,
			meta: `${lines} 行`,
			body: content ? <CodeBlock code={content} lang={languageFromPath(path)} /> : undefined,
		};
	}
	if (toolName === "edit") {
		const path = asText(args.path) ?? "";
		const blocks = readEdits(args);
		let added = 0;
		let removed = 0;
		for (const block of blocks) {
			const stat = editDiffStat(block.oldText, block.newText);
			added += stat.added;
			removed += stat.removed;
		}
		return {
			icon: <FileDiff size={size} />,
			verb: "编辑",
			target: shortPath(path),
			title: path,
			meta: (
				<>
					{blocks.length > 1 ? <span>{blocks.length} 处</span> : null}
					<DiffStat added={added} removed={removed} />
				</>
			),
			body: blocks.length ? (
				<div className="tool-edits">
					{blocks.map((block, index) => (
						<div className="tool-edit" key={index}>
							{blocks.length > 1 ? <span className="tool-edit-label">第 {index + 1} 处</span> : null}
							<EditDiff before={block.oldText} after={block.newText} numbered={false} />
						</div>
					))}
				</div>
			) : undefined,
		};
	}
	if (toolName === "grep") {
		const pattern = asText(args.pattern) ?? "";
		const scope = asText(args.glob) ?? asText(args.path);
		const mode = asText(args.output_mode);
		return {
			icon: <FileSearch size={size} />,
			verb: "检索",
			target: pattern,
			title: pattern,
			meta:
				[scope, mode === "files" ? "仅路径" : mode === "count" ? "仅计数" : undefined].filter(Boolean).join(" · ") ||
				undefined,
			quiet: true,
		};
	}
	if (toolName === "glob") {
		const pattern = asText(args.pattern) ?? "";
		const scope = asText(args.path);
		return {
			icon: <FolderSearch size={size} />,
			verb: "匹配",
			target: pattern,
			title: pattern,
			meta: scope,
			quiet: true,
		};
	}
	if (toolName === "ls") {
		const path = asText(args.path) ?? ".";
		const depth = typeof args.depth === "number" ? args.depth : undefined;
		return {
			icon: <FolderTree size={size} />,
			verb: "列出",
			target: shortPath(path),
			title: path,
			meta: depth !== undefined && depth > 1 ? `${depth} 层` : undefined,
			quiet: true,
		};
	}
	if (toolName === "exec") {
		const command = asText(args.command) ?? "";
		const first = command.split("\n")[0] ?? "";
		const multiline = command.includes("\n");
		return {
			icon: <SquareTerminal size={size} />,
			verb: "执行",
			target: first,
			title: command,
			body: multiline ? <CodeBlock code={command} lang="bash" /> : undefined,
		};
	}
	if (toolName === "shell") {
		const command = asText(args.command) ?? asText(args.cmd) ?? "";
		const first = command.split("\n")[0] ?? "";
		const multiline = command.includes("\n");
		return {
			icon: <SquareTerminal size={size} />,
			verb: "shell",
			target: first,
			title: command,
			body: multiline ? <CodeBlock code={command} lang="bash" /> : undefined,
		};
	}
	if (toolName === "run_python") {
		const code = asText(args.code) ?? "";
		return {
			icon: <Braces size={size} />,
			verb: "运行 Python",
			meta: `${code === "" ? 0 : code.split("\n").length} 行`,
			body: code ? <CodeBlock code={code} lang="python" /> : undefined,
		};
	}
	if (toolName === "web_fetch") {
		const url = asText(args.url) ?? "";
		return { icon: <Globe size={size} />, verb: "抓取网页", target: url, title: url, quiet: true };
	}
	if (toolName === "web_search" || toolName === "browser_search") {
		const query = asText(args.query) ?? asText(args.q) ?? "";
		return { icon: <Search size={size} />, verb: "搜索", target: query, title: query, quiet: true };
	}
	if (toolName === "browser_open") {
		const url = asText(args.url) ?? "";
		const viewport =
			typeof args.width === "number" && typeof args.height === "number" ? `${args.width}x${args.height}` : undefined;
		return {
			icon: <AppWindow size={size} />,
			verb: "打开页面",
			target: url,
			title: url,
			meta: viewport,
			quiet: true,
		};
	}
	if (toolName === "browser_snapshot") {
		const selector = asText(args.selector);
		return {
			icon: <ScanSearch size={size} />,
			verb: "检查页面",
			...(selector ? { target: selector, title: selector } : {}),
			quiet: true,
		};
	}
	if (toolName === "browser_action") {
		const action = asText(args.action) ?? "操作";
		const target =
			asText(args.ref) ??
			asText(args.tab_id) ??
			asText(args.selector) ??
			asText(args.name) ??
			asText(args.text) ??
			asText(args.url);
		return {
			icon: <MousePointerClick size={size} />,
			verb: `页面 · ${action}`,
			...(target ? { target, title: target } : {}),
		};
	}
	if (toolName === "browser_screenshot") {
		return {
			icon: <Camera size={size} />,
			verb: "页面截图",
			meta: args.full_page === true ? "完整页面" : "当前视口",
			quiet: true,
		};
	}
	if (toolName === "browser_diagnostics") {
		return {
			icon: <Bug size={size} />,
			verb: "浏览器诊断",
			meta: args.clear === true ? "读取后清空" : undefined,
			quiet: true,
		};
	}
	if (toolName === "browser_tabs") {
		return { icon: <AppWindow size={size} />, verb: "查看标签页", quiet: true };
	}
	if (toolName === "browser_close") {
		return { icon: <PanelTopClose size={size} />, verb: "关闭浏览器", quiet: true };
	}
	if (toolName === "preview_start") {
		const command = asText(args.command) ?? "";
		const url = asText(args.url);
		return {
			icon: <SquareTerminal size={size} />,
			verb: "启动预览",
			target: command,
			title: command,
			meta: url,
		};
	}
	if (toolName === "preview_status") {
		return { icon: <Activity size={size} />, verb: "预览状态", quiet: true };
	}
	if (toolName === "preview_stop") {
		return { icon: <PanelTopClose size={size} />, verb: "停止预览", quiet: true };
	}
	if (toolName === "weather") {
		const location = asText(args.location) ?? asText(args.city) ?? "";
		return { icon: <CloudSun size={size} />, verb: "天气", target: location, quiet: true };
	}
	if (toolName === "update_plan") {
		const steps = readPlan(args);
		const done = steps.filter((step) => step.status === "completed").length;
		const active = steps.find((step) => step.status === "in_progress");
		const explanation = asText(args.explanation)?.trim();
		return {
			icon: <ListChecks size={size} />,
			verb: "计划",
			...(active === undefined ? {} : { target: active.step, title: active.step }),
			meta: steps.length > 0 ? `${done}/${steps.length}` : undefined,
			body:
				steps.length > 0 || explanation ? (
					<>
						{explanation ? <p className="tool-plain">{explanation}</p> : null}
						{steps.length > 0 ? (
							<ol className="tool-plan">
								{steps.map((step, index) => (
									<li
										className={`tool-plan-step ${step.status}`}
										key={index}
										aria-label={`${planStatusText[step.status]}：${step.step}`}
									>
										<span aria-hidden="true">{planStatusMark[step.status]}</span>
										<span>{step.step}</span>
									</li>
								))}
							</ol>
						) : null}
					</>
				) : undefined,
		};
	}
	if (toolName === "subagent") {
		const task = asText(args.task) ?? "";
		const first = task.split("\n")[0] ?? "";
		const budget = typeof args.cost_budget_usd === "number" ? `$${args.cost_budget_usd}` : undefined;
		return {
			icon: <Bot size={size} />,
			verb: "子代理",
			target: asText(args.name) ?? first,
			title: task,
			meta: budget,
			body: task === first ? undefined : <p className="tool-plain">{task}</p>,
		};
	}
	const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName);
	if (mcp) {
		return {
			icon: <Plug size={size} />,
			verb: `MCP · ${mcp[1] ?? ""}`,
			target: mcp[2] ?? toolName,
			title: toolName,
			fallbackArgs: true,
		};
	}
	return { icon: <Wrench size={size} />, verb: toolName, fallbackArgs: true };
}

function StatusIndicator({ status }: { status: ToolStatusValue }) {
	const icon =
		status === "complete" ? (
			<CircleCheck size={12} />
		) : status === "error" || status === "aborted" ? (
			<CircleAlert size={12} />
		) : status === "awaiting_approval" ? (
			<ShieldAlert size={12} />
		) : status === "running" ? (
			<Activity size={12} />
		) : (
			<Clock size={12} />
		);
	return (
		<span className={`tool-state ${status}`}>
			{icon}
			<span>{statusText[status]}</span>
		</span>
	);
}

/**
 * True when a tool's text result only restates what its card already renders.
 * `update_plan` hands the rendered plan back to the model as its result, and the
 * card draws that same plan as a checklist — showing both says it twice. A failed
 * call is the exception: there the text carries the validation error.
 */
export function resultEchoesCard(toolName: string, isError?: boolean): boolean {
	return toolName === "update_plan" && isError !== true;
}

export function isPreviewableImageArtifact(artifact: ArtifactRef): boolean {
	return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(artifact.mimeType.toLowerCase());
}

export function isPreviewableMediaArtifact(artifact: ArtifactRef): boolean {
	return isPreviewableImageArtifact(artifact) || ["video/mp4", "video/webm"].includes(artifact.mimeType.toLowerCase());
}

export function ArtifactMediaPreview({
	artifact,
	onLoad,
	onDownload,
	showDownload = true,
}: {
	artifact: ArtifactRef;
	onLoad: (artifact: ArtifactRef) => Promise<Blob>;
	onDownload?: ((artifact: ArtifactRef) => void) | undefined;
	showDownload?: boolean;
}) {
	const [url, setUrl] = useState<string>();
	const [failed, setFailed] = useState(false);
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		let disposed = false;
		let objectUrl: string | undefined;
		setUrl(undefined);
		setFailed(false);
		setExpanded(false);
		void onLoad(artifact)
			.then((blob) => {
				objectUrl = URL.createObjectURL(blob);
				if (disposed) URL.revokeObjectURL(objectUrl);
				else setUrl(objectUrl);
			})
			.catch(() => {
				if (!disposed) setFailed(true);
			});
		return () => {
			disposed = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [artifact.id, onLoad]);
	if (failed)
		return (
			<div className="media-model-error" role="alert">
				{showDownload ? "媒体预览加载失败，可下载文件查看。" : "媒体预览加载失败。"}
				{showDownload && isPreviewableImageArtifact(artifact) && onDownload && (
					<button
						type="button"
						className="image-download"
						title="下载图片"
						aria-label="下载图片"
						onClick={() => onDownload(artifact)}
					>
						<Download size={15} />
					</button>
				)}
			</div>
		);
	return url ? (
		artifact.mimeType.toLowerCase().startsWith("video/") ? (
			<video
				className="tool-video-preview"
				src={url}
				controls
				playsInline
				preload="metadata"
				aria-label={artifact.name}
				onError={() => setFailed(true)}
			/>
		) : (
			<div className="image-preview">
				<button
					type="button"
					className="image-thumbnail"
					title={`查看 ${artifact.name}`}
					aria-label={`查看 ${artifact.name}`}
					onClick={() => setExpanded(true)}
				>
					<img
						className="tool-image-preview"
						src={url}
						alt={artifact.name}
						loading="lazy"
						onError={() => setFailed(true)}
					/>
				</button>
				{showDownload && (
					<a className="image-download" href={url} download={artifact.name} title="下载图片" aria-label="下载图片">
						<Download size={15} />
					</a>
				)}
				{expanded && (
					<ImageViewer url={url} name={artifact.name} showDownload={showDownload} onClose={() => setExpanded(false)} />
				)}
			</div>
		)
	) : (
		<div className="tool-image-loading" aria-label={`正在载入 ${artifact.name}`} />
	);
}

export function ToolResult({
	parts,
	toolName,
	input,
	isError,
	onDownload,
	onLoadArtifact,
}: {
	parts: ContentPart[];
	toolName: string;
	input?: unknown;
	isError?: boolean;
	onDownload?: (artifact: ArtifactRef) => void;
	onLoadArtifact?: (artifact: ArtifactRef) => Promise<Blob>;
}) {
	const path = asText(asRecord(input).path);
	const lang = toolName === "read_file" && path ? languageFromPath(path) : "";
	const echoesInput = resultEchoesCard(toolName, isError);
	const nodes: ReactNode[] = [];
	for (const [index, part] of parts.entries()) {
		if (part.type === "text") {
			if (
				echoesInput ||
				part.text.trim() === "" ||
				(toolName === "browser_screenshot" && part.text.startsWith("[Image result: image/"))
			)
				continue;
			nodes.push(
				lang ? (
					<CodeBlock code={part.text} lang={lang} key={index} />
				) : (
					<pre className="tool-output" key={index}>
						{part.text}
					</pre>
				)
			);
			continue;
		}
		if (part.type === "artifact") {
			if (onLoadArtifact && isPreviewableMediaArtifact(part.artifact)) {
				nodes.push(
					<ArtifactMediaPreview
						artifact={part.artifact}
						onLoad={onLoadArtifact}
						onDownload={onDownload}
						key={`preview-${index}`}
					/>
				);
				if (isPreviewableImageArtifact(part.artifact)) continue;
			}
			nodes.push(
				<div className="artifact-line" key={index}>
					<FileText size={14} /> <span>{part.artifact.name}</span>
					{onDownload ? (
						<button type="button" title={`下载 ${part.artifact.name}`} onClick={() => onDownload(part.artifact)}>
							<Download size={14} />
						</button>
					) : null}
				</div>
			);
		}
	}
	if (nodes.length === 0) return null;
	return <div className="tool-result">{nodes}</div>;
}

export function ToolCard({
	toolName,
	input,
	status,
	webEvidence,
	children,
}: {
	toolName: string;
	input: unknown;
	status: ToolStatusValue;
	webEvidence?: WebEvidence | undefined;
	children?: ReactNode;
}) {
	const description = describeTool(toolName, input);
	const failed = status === "error" || status === "aborted";
	const hasDetail = Boolean(description.body) || Boolean(children) || Boolean(description.fallbackArgs);
	// Keep intermediate tool attempts compact. The final assistant failure is
	// rendered at the end of the turn; raw tool diagnostics stay on demand.
	const [open, setOpen] = useState(() => status === "awaiting_approval");
	const expandable = hasDetail;
	const args = asRecord(input);
	const argEntries = description.fallbackArgs ? Object.entries(args) : [];
	useEffect(() => {
		if (status === "awaiting_approval") setOpen(true);
	}, [status]);
	return (
		<div className={`tool-trace ${status}${open ? " open" : ""}`}>
			<button
				type="button"
				className="tool-trace-summary"
				onClick={() => expandable && setOpen(!open)}
				aria-expanded={expandable ? open : undefined}
				disabled={!expandable}
			>
				<ChevronRight size={14} className="tool-caret" />
				<span className="tool-icon">{description.icon}</span>
				<span className="tool-verb">{description.verb}</span>
				{description.target ? (
					<span className="tool-target" title={description.title ?? description.target}>
						{description.target}
					</span>
				) : null}
				{description.meta ? <span className="tool-meta">{description.meta}</span> : null}
				{status === "complete" && webEvidence ? (
					<span className={"tool-evidence " + webEvidence.level} title={webEvidence.note}>
						{
							{
								candidate_links: "候选链接",
								page_content: "页面已读取",
								insufficient_content: "内容不足",
								access_blocked: "访问受阻",
							}[webEvidence.level]
						}
					</span>
				) : null}
				<StatusIndicator status={status} />
			</button>
			{open ? (
				<div className="tool-trace-detail">
					{argEntries.length > 0 ? (
						<dl className="tool-args">
							{argEntries.map(([key, value]) => (
								<div className="tool-arg" key={key}>
									<dt>{key}</dt>
									<dd>{scalar(value) ?? JSON.stringify(value, null, 2)}</dd>
								</div>
							))}
						</dl>
					) : null}
					{description.body}
					{children}
				</div>
			) : null}
		</div>
	);
}

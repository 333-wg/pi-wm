import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Copy, Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import type {
	AgentTemplate,
	AgentTemplateConfig,
	Command,
	CommandResult,
	ModelMetadata,
	ThinkingLevel,
	ToolStatus,
} from "@wuming/protocol";
import { useLocale, useT } from "../lib/locale.js";
import { thinkingLabel } from "./ThinkingPicker.js";
import "./agent-template-settings.css";

type TemplateCommand = Extract<Command, { type: `agent.template.${string}` }>;
type Catalog = Extract<CommandResult, { type: "agent.templates" }>;
type Scope = "user" | "project";
const colors = {
	green: "var(--green)",
	blue: "var(--blue)",
	amber: "var(--amber)",
	red: "var(--red)",
	purple: "#9c62bb",
	cyan: "#198c9e",
};
const domainTools = [
	"read_file",
	"grep",
	"glob",
	"ls",
	"environment_status",
	"write_file",
	"edit",
	"exec",
	"run_python",
	"web_search",
	"web_fetch",
	"browser_open",
	"browser_snapshot",
	"browser_action",
	"skill_list",
	"skill_load",
	"memory_search",
];
const excludedTools = new Set([
	"subagent",
	"Agent",
	"TeamCreate",
	"TeamFinish",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"SendMessage",
	"AgentTemplates",
	"skill_install",
	"skill_uninstall",
	"skill_set_enabled",
	"mcp_configure",
	"mcp_trust",
	"mcp_untrust",
]);
const blank = (): AgentTemplateConfig => ({
	name: "",
	description: "",
	systemPrompt: "",
	tools: { mode: "all" },
	color: "green",
});
const key = (item: AgentTemplate) => `${item.scope}:${item.name}`;
const priority = { user: 0, project: 1, builtin: 2 };
const modelKey = (model?: { provider: string; id: string }) => (model ? JSON.stringify(model) : "");

export function AgentTemplateSettings({
	workspaceId,
	connected,
	models,
	tools,
	request,
}: {
	workspaceId: string;
	connected: boolean;
	models: ModelMetadata[];
	tools: ToolStatus[];
	request: (command: TemplateCommand) => Promise<Catalog>;
}) {
	const { locale } = useLocale();
	const t = useT();
	const label = (zh: string, en: string) => (locale === "en" ? en : zh);
	const [catalog, setCatalog] = useState<Catalog>();
	const [selected, setSelected] = useState<AgentTemplate>();
	const [draft, setDraft] = useState<AgentTemplateConfig>();
	const [scope, setScope] = useState<Scope>("user");
	const [extraTools, setExtraTools] = useState("");
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);
	const epoch = useRef(0);
	useEffect(() => {
		const version = ++epoch.current;
		if (connected)
			void request({ type: "agent.template.list", workspaceId })
				.then((value) => {
					if (epoch.current === version) setCatalog(value);
				})
				.catch((cause) => {
					if (epoch.current === version) setError(String(cause));
				});
		return () => {
			epoch.current++;
		};
	}, [connected, request, workspaceId]);
	const availableTools = useMemo(
		() =>
			[...new Set([...domainTools, ...tools.map((tool) => tool.name)])]
				.filter((name) => !excludedTools.has(name))
				.sort(),
		[tools]
	);
	const sorted = [...(catalog?.templates ?? [])].sort(
		(a, b) => priority[a.scope] - priority[b.scope] || a.name.localeCompare(b.name)
	);
	const canEdit = connected && !busy && (scope === "user" ? catalog?.canEditUser : catalog?.canEditProject);
	const builtin = selected?.scope === "builtin";
	const locked = !canEdit || builtin;
	const scopeLabel = (value: AgentTemplate["scope"]) =>
		value === "builtin"
			? label("内置", "Built-in")
			: value === "user"
				? label("用户", "User")
				: label("项目", "Project");
	const open = (item?: AgentTemplate, copy = false) => {
		setSelected(copy ? undefined : item);
		const next = item
			? {
					name: item.name,
					description: item.description,
					systemPrompt: item.systemPrompt,
					tools: item.tools,
					color: item.color,
					...(item.model ? { model: item.model } : {}),
					...(item.thinkingLevel ? { thinkingLevel: item.thinkingLevel } : {}),
				}
			: blank();
		if (copy) next.name = `${next.name.slice(0, 58)}-copy`;
		setDraft(structuredClone(next));
		setScope(item && !copy && item.scope !== "builtin" ? item.scope : catalog?.canEditUser ? "user" : "project");
		setExtraTools("");
		setError("");
		setSaved(false);
	};
	const update = (patch: Partial<AgentTemplateConfig>) => {
		setDraft((value) => (value ? { ...value, ...patch } : value));
		setSaved(false);
	};
	const mutate = async (command: TemplateCommand) => {
		const version = epoch.current;
		setBusy(true);
		setError("");
		setSaved(false);
		try {
			const value = await request(command);
			if (version !== epoch.current) return;
			setCatalog(value);
			if (command.type === "agent.template.save") {
				const item = value.templates.find(
					(entry) => entry.name === command.template.name && entry.scope === command.scope
				);
				if (item) open(item);
				setSaved(true);
			} else if (command.type === "agent.template.delete") {
				setDraft(undefined);
				setSelected(undefined);
			} else if (selected) {
				const current = value.templates.find((item) => key(item) === key(selected));
				if (current) open(current);
				else {
					setDraft(undefined);
					setSelected(undefined);
				}
			}
		} catch (cause) {
			if (version === epoch.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (version === epoch.current) setBusy(false);
		}
	};
	const activeModel = models.find((model) => modelKey(model.model) === modelKey(draft?.model));
	const levels: readonly ThinkingLevel[] =
		draft?.model && activeModel
			? activeModel.reasoning
				? (activeModel.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
				: ["off"]
			: ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	return (
		<div className="agent-template-settings">
			<header className="settings-page-header agent-template-heading">
				<h3>Agents</h3>
				<div>
					<button
						type="button"
						className="icon-button"
						title={label("刷新模板", "Refresh templates")}
						aria-label={label("刷新模板", "Refresh templates")}
						disabled={!connected || busy}
						onClick={() => void mutate({ type: "agent.template.list", workspaceId })}
					>
						<RefreshCw size={16} />
					</button>
					<button
						type="button"
						disabled={!connected || busy || (!catalog?.canEditUser && !catalog?.canEditProject)}
						onClick={() => open()}
					>
						<Plus size={16} />
						{label("创建 Agent", "Create Agent")}
					</button>
				</div>
			</header>
			{error && (
				<p role="alert" className="agent-template-error">
					{error}
				</p>
			)}
			<div className="agent-template-layout">
				<aside className="agent-template-list">
					<label className="agent-template-search">
						<Search size={15} />
						<input
							type="search"
							aria-label={label("搜索 Agent", "Search Agents")}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					{!catalog && <p role="status">{label("加载中", "Loading")}</p>}
					{(["user", "project", "builtin"] as const).map((group) => (
						<section key={group}>
							<h4>{scopeLabel(group)}</h4>
							{sorted
								.filter(
									(item) =>
										item.scope === group &&
										`${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())
								)
								.map((item) => {
									const effective = sorted.find((entry) => entry.name === item.name);
									return (
										<button
											type="button"
											key={key(item)}
											aria-label={`${scopeLabel(group)} ${item.name}`}
											aria-pressed={selected && key(selected) === key(item)}
											disabled={busy}
											onClick={() => open(item)}
										>
											<Bot size={18} style={{ color: colors[item.color] }} />
											<span>
												<strong>{item.name}</strong>
												<small>{item.description}</small>
												{effective && key(effective) !== key(item) && (
													<small>
														{label("被覆盖：", "Overridden by: ")}
														{scopeLabel(effective.scope)}
													</small>
												)}
											</span>
										</button>
									);
								})}
						</section>
					))}
				</aside>
				{draft ? (
					<form
						className="agent-template-editor"
						aria-label={label("Agent 配置", "Agent configuration")}
						onSubmit={(event) => {
							event.preventDefault();
							const policy =
								draft.tools.mode === "custom"
									? {
											mode: "custom" as const,
											names: [...new Set([...draft.tools.names, ...extraTools.split(/[\s,]+/).filter(Boolean)])],
										}
									: draft.tools;
							void mutate({
								type: "agent.template.save",
								workspaceId,
								scope,
								template: { ...draft, tools: policy },
								expectedRevision: selected && selected.scope !== "builtin" ? selected.revision : 0,
							});
						}}
					>
						<header>
							<h4>{selected?.name ?? label("新 Agent", "New Agent")}</h4>
							<div>
								{selected && (
									<button
										type="button"
										className="icon-button"
										title={label("复制 Agent", "Duplicate Agent")}
										aria-label={label("复制 Agent", "Duplicate Agent")}
										disabled={busy || (!catalog?.canEditUser && !catalog?.canEditProject)}
										onClick={() => open(selected, true)}
									>
										<Copy size={16} />
									</button>
								)}
								{selected && !builtin && (
									<button
										type="button"
										className="icon-button"
										title={label("删除 Agent", "Delete Agent")}
										aria-label={label("删除 Agent", "Delete Agent")}
										disabled={!canEdit}
										onClick={() => {
											if (window.confirm(`${label("删除 Agent", "Delete Agent")} ${selected.name}?`))
												void mutate({
													type: "agent.template.delete",
													workspaceId,
													scope,
													name: selected.name,
													expectedRevision: selected.revision,
												});
										}}
									>
										<Trash2 size={16} />
									</button>
								)}
							</div>
						</header>
						<div className="agent-template-fields">
							<label>
								{label("名称", "Name")}
								<input
									aria-label={label("Agent 名称", "Agent name")}
									required
									pattern="[a-z][a-z0-9_-]{0,63}"
									maxLength={64}
									value={draft.name}
									disabled={Boolean(selected) || !canEdit}
									onChange={(event) => update({ name: event.target.value })}
								/>
							</label>
							<label>
								{label("配置范围", "Scope")}
								<select
									aria-label={label("配置范围", "Scope")}
									value={scope}
									disabled={!canEdit || Boolean(selected && !builtin)}
									onChange={(event) => {
										setScope(event.target.value as Scope);
										setSaved(false);
									}}
								>
									<option value="user" disabled={!catalog?.canEditUser}>
										{label("用户（全部项目）", "User (all projects)")}
									</option>
									<option value="project" disabled={!catalog?.canEditProject}>
										{label("当前项目", "Current project")}
									</option>
								</select>
							</label>
							<label className="agent-template-wide">
								{label("描述", "Description")}
								<textarea
									aria-label={label("描述", "Description")}
									rows={2}
									required
									maxLength={2000}
									value={draft.description}
									disabled={locked}
									onChange={(event) => update({ description: event.target.value })}
								/>
							</label>
							<label>
								{label("模型", "Model")}
								<select
									aria-label={label("模型", "Model")}
									value={modelKey(draft.model)}
									disabled={!canEdit}
									onChange={(event) => {
										const next = { ...draft };
										if (event.target.value) next.model = JSON.parse(event.target.value);
										else delete next.model;
										delete next.thinkingLevel;
										setDraft(next);
										setSaved(false);
									}}
								>
									<option value="">{label("继承 Lead", "Inherit Lead")}</option>
									{draft.model && !activeModel && (
										<option value={modelKey(draft.model)}>
											{draft.model.provider}/{draft.model.id} ({label("不可用", "Unavailable")})
										</option>
									)}
									{models.map((model) => (
										<option key={modelKey(model.model)} value={modelKey(model.model)} disabled={!model.authenticated}>
											{model.name} · {model.model.provider}
										</option>
									))}
								</select>
							</label>
							<label>
								{label("思考强度", "Thinking effort")}
								<select
									aria-label={label("思考强度", "Thinking effort")}
									value={draft.thinkingLevel ?? ""}
									disabled={!canEdit}
									onChange={(event) => {
										const next = { ...draft };
										if (event.target.value) next.thinkingLevel = event.target.value as ThinkingLevel;
										else delete next.thinkingLevel;
										setDraft(next);
										setSaved(false);
									}}
								>
									<option value="">{label("继承 Lead", "Inherit Lead")}</option>
									{[...new Set([...levels, ...(draft.thinkingLevel ? [draft.thinkingLevel] : [])])].map((level) => (
										<option key={level} value={level}>
											{thinkingLabel(level, t)}
										</option>
									))}
								</select>
							</label>
							<label className="agent-template-wide">
								{label("系统提示词", "System prompt")}
								<textarea
									aria-label={label("系统提示词", "System prompt")}
									rows={7}
									required
									maxLength={16000}
									value={draft.systemPrompt}
									disabled={locked}
									onChange={(event) => update({ systemPrompt: event.target.value })}
								/>
							</label>
							<fieldset className="agent-template-wide" disabled={locked}>
								<legend>{label("业务工具", "Domain tools")}</legend>
								<div className="agent-template-modes">
									{(["all", "none", "custom"] as const).map((mode) => (
										<label key={mode}>
											<input
												type="radio"
												name="agent-tools"
												checked={draft.tools.mode === mode}
												onChange={() => update({ tools: mode === "custom" ? { mode, names: [] } : { mode } })}
											/>
											{mode === "all"
												? label("全部", "All")
												: mode === "none"
													? label("无", "None")
													: label("自定义", "Custom")}
										</label>
									))}
								</div>
								{draft.tools.mode === "custom" && (
									<>
										<div className="agent-template-tool-grid">
											{[...new Set([...availableTools, ...draft.tools.names])].map((name) => (
												<label key={name}>
													<input
														type="checkbox"
														checked={draft.tools.mode === "custom" && draft.tools.names.includes(name)}
														onChange={(event) => {
															if (draft.tools.mode === "custom")
																update({
																	tools: {
																		mode: "custom",
																		names: event.target.checked
																			? [...draft.tools.names, name]
																			: draft.tools.names.filter((value) => value !== name),
																	},
																});
														}}
													/>
													{name}
												</label>
											))}
										</div>
										<label>
											{label("其他工具名称", "Additional tool names")}
											<input
												value={extraTools}
												onChange={(event) => {
													setExtraTools(event.target.value);
													setSaved(false);
												}}
											/>
										</label>
									</>
								)}
							</fieldset>
							<fieldset className="agent-template-wide" disabled={locked}>
								<legend>{label("颜色", "Color")}</legend>
								<div className="agent-template-colors">
									{Object.entries(colors).map(([color, css]) => (
										<button
											type="button"
											key={color}
											style={{ background: css }}
											title={color}
											aria-label={color}
											aria-pressed={draft.color === color}
											onClick={() => update({ color: color as AgentTemplateConfig["color"] })}
										/>
									))}
								</div>
							</fieldset>
						</div>
						<footer>
							<button type="submit" disabled={!canEdit}>
								<Save size={16} />
								{builtin ? label("保存覆盖", "Save override") : label("保存 Agent", "Save Agent")}
							</button>
							{saved && <span role="status">{label("已保存", "Saved")}</span>}
						</footer>
					</form>
				) : (
					<div className="agent-template-empty">
						<Bot size={32} />
						<span>{label("Agent 模板", "Agent templates")}</span>
					</div>
				)}
			</div>
		</div>
	);
}

import { CircleAlert, Plus, Save, Trash2, Upload, X } from "lucide-react";
import { useState } from "react";
import type { JsonValue, McpServerConfiguration } from "@wuming/protocol";
import { useFocusTrap } from "../use-focus-trap.js";
import { importMcpConfigurations } from "../lib/mcp-config.js";

interface Props {
	initial?: McpServerConfiguration;
	existingIds: string[];
	onSave: (config: McpServerConfiguration) => Promise<void>;
	onClose: () => void;
}

export function McpConfigDialog({ initial, existingIds, onSave, onClose }: Props) {
	const dialog = useFocusTrap<HTMLDivElement>();
	const [config, setConfig] = useState<McpServerConfiguration>(
		initial ?? { id: "", name: "", transport: "stdio", command: "", args: [], enabled: true, readOnly: false }
	);
	const [args, setArgs] = useState(JSON.stringify(initial?.args ?? [], null, 2));
	const [imports, setImports] = useState<McpServerConfiguration[]>([]);
	const [json, setJson] = useState("");
	const [mode, setMode] = useState<"form" | "import">("form");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const update = (key: string, value: JsonValue) => setConfig((current) => ({ ...current, [key]: value }));
	const stdio = config.transport === "stdio";
	const secretField = stdio ? "env" : "headers";
	const secrets = Object.entries((config[secretField] ?? {}) as Record<string, string | null>);
	const setSecrets = (values: Array<[string, string | null]>) => update(secretField, Object.fromEntries(values));
	const load = (value: McpServerConfiguration) => {
		setConfig(value);
		setArgs(JSON.stringify(value.args ?? [], null, 2));
		setMode("form");
		setError(undefined);
	};
	const save = async () => {
		setError(undefined);
		let candidate: McpServerConfiguration;
		try {
			let parsedArgs: unknown = [];
			if (stdio) {
				try {
					parsedArgs = JSON.parse(args);
				} catch {
					throw new Error("启动参数必须是 JSON 字符串数组");
				}
			}
			const values: Record<string, unknown> = { ...config, ...(stdio ? { args: parsedArgs } : {}) };
			if (typeof values.name === "string" && !values.name.trim()) delete values.name;
			delete values[stdio ? "headers" : "env"];
			if (!stdio) {
				delete values.command;
				delete values.args;
				delete values.cwd;
			} else delete values.url;
			candidate = importMcpConfigurations(JSON.stringify(values))[0]!;
			if (!initial && existingIds.includes(String(candidate.id))) throw new Error("该服务 ID 已存在，请从服务列表编辑");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "配置无效");
			return;
		}
		setBusy(true);
		try {
			await onSave(candidate);
			onClose();
		} catch {
			setError("保存失败，请检查字段、工作区权限及网关连接。原有配置可能已保存，请刷新确认状态。");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div
			className="skill-manager-overlay"
			onKeyDown={(event) => {
				if (event.key === "Escape" && !busy) {
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<div
				className="mcp-config-dialog"
				ref={dialog}
				role="dialog"
				aria-modal="true"
				aria-labelledby="mcp-config-title"
			>
				<header>
					<h2 id="mcp-config-title">{initial ? "编辑 MCP 服务" : "新增 MCP 服务"}</h2>
					<button className="icon-button" title="关闭配置" disabled={busy} onClick={onClose}>
						<X size={18} />
					</button>
				</header>
				{!initial && (
					<div className="mcp-mode" role="tablist" aria-label="配置方式">
						<button role="tab" aria-selected={mode === "form"} onClick={() => setMode("form")}>
							手动填写
						</button>
						<button role="tab" aria-selected={mode === "import"} onClick={() => setMode("import")}>
							<Upload size={14} />
							导入 JSON
						</button>
					</div>
				)}
				<div className="mcp-config-body">
					{error && (
						<div className="workbench-error" role="alert">
							<CircleAlert size={16} />
							{error}
						</div>
					)}
					{mode === "import" ? (
						<div className="mcp-fields">
							<label>
								JSON 配置
								<textarea
									rows={12}
									value={json}
									spellCheck={false}
									autoComplete="off"
									onChange={(event) => setJson(event.target.value)}
								/>
							</label>
							<button
								className="secondary-button"
								onClick={() => {
									try {
										const values = importMcpConfigurations(json);
										setImports(values);
										setJson("");
										load(values[0]!);
									} catch (cause) {
										setError(cause instanceof Error ? cause.message : "配置无效");
									}
								}}
							>
								<Upload size={14} />
								解析配置
							</button>
						</div>
					) : (
						<form
							id="mcp-config-form"
							onSubmit={(event) => {
								event.preventDefault();
								void save();
							}}
						>
							<fieldset disabled={busy} className="mcp-fields">
								{imports.length > 1 && (
									<label>
										选择导入的服务
										<select
											value={String(config.id)}
											onChange={(event) => load(imports.find((entry) => entry.id === event.target.value)!)}
										>
											{imports.map((entry) => (
												<option key={String(entry.id)} value={String(entry.id)}>
													{String(entry.name ?? entry.id)}
												</option>
											))}
										</select>
									</label>
								)}
								<div className="mcp-field-row">
									<label>
										服务 ID
										<input
											required
											maxLength={100}
											disabled={Boolean(initial)}
											value={String(config.id ?? "")}
											onChange={(event) => update("id", event.target.value)}
										/>
									</label>
									<label>
										显示名称
										<input
											maxLength={200}
											value={String(config.name ?? "")}
											onChange={(event) => update("name", event.target.value)}
										/>
									</label>
								</div>
								<label>
									传输方式
									<select
										value={String(config.transport)}
										onChange={(event) => update("transport", event.target.value)}
									>
										<option value="stdio">本地进程 · stdio</option>
										<option value="streamable-http">Streamable HTTP</option>
										<option value="sse">SSE</option>
									</select>
								</label>
								{stdio ? (
									<>
										<label>
											启动命令
											<input
												required
												value={String(config.command ?? "")}
												onChange={(event) => update("command", event.target.value)}
											/>
										</label>
										<label>
											启动参数（JSON 数组）
											<textarea
												rows={3}
												value={args}
												spellCheck={false}
												onChange={(event) => setArgs(event.target.value)}
											/>
										</label>
										<label>
											工作目录
											<input
												value={String(config.cwd ?? "")}
												onChange={(event) =>
													setConfig((current) => {
														const next = { ...current };
														if (event.target.value) next.cwd = event.target.value;
														else delete next.cwd;
														return next;
													})
												}
											/>
										</label>
									</>
								) : (
									<label>
										服务地址
										<input
											required
											type="url"
											autoComplete="off"
											value={String(config.url ?? "")}
											onChange={(event) => update("url", event.target.value)}
										/>
									</label>
								)}
								<section className="mcp-credentials" aria-label={stdio ? "环境变量" : "请求头"}>
									{secrets.length > 0 && (
										<p className="mcp-secret-warning">凭据将明文保存在工作区配置文件中，请勿提交到代码仓库。</p>
									)}
									<div className="mcp-inline-heading">
										<strong>{stdio ? "环境变量" : "请求头"}</strong>
										<button
											type="button"
											className="icon-button"
											title="添加变量"
											disabled={secrets.length >= 32}
											onClick={() => {
												let key = stdio ? "VARIABLE" : "X-Header";
												while (secrets.some(([name]) => name === key)) key += stdio ? "_2" : "-2";
												setSecrets([...secrets, [key, ""]]);
											}}
										>
											<Plus size={15} />
										</button>
									</div>
									{secrets.map(([key, value], index) => (
										<div className="mcp-secret-row" key={index}>
											<input
												aria-label={"变量名 " + (index + 1)}
												value={key}
												disabled={value === null}
												spellCheck={false}
												onChange={(event) => {
													const name = event.target.value;
													if (secrets.some(([other], i) => i !== index && other === name)) return;
													setSecrets(secrets.map((entry, i) => (i === index ? [name, value] : entry)));
												}}
											/>
											<input
												aria-label={"变量值 " + (index + 1)}
												type="password"
												autoComplete="new-password"
												value={value ?? ""}
												placeholder={value === null ? "已保存" : "值"}
												onChange={(event) =>
													setSecrets(
														secrets.map((entry, i) =>
															i === index ? [key, event.target.value || (value === null ? null : "")] : entry
														)
													)
												}
											/>
											<button
												type="button"
												className="icon-button"
												title={"删除变量 " + (index + 1)}
												onClick={() => setSecrets(secrets.filter((_, i) => i !== index))}
											>
												<Trash2 size={14} />
											</button>
										</div>
									))}
								</section>
								<div className="mcp-checks">
									<label>
										<input
											type="checkbox"
											checked={config.enabled !== false}
											onChange={(event) => update("enabled", event.target.checked)}
										/>
										启用配置
									</label>
									<label>
										<input
											type="checkbox"
											checked={config.readOnly === true}
											onChange={(event) => update("readOnly", event.target.checked)}
										/>
										所有工具均为只读
									</label>
								</div>
								<details>
									<summary>高级设置</summary>
									<div className="mcp-fields">
										<div className="mcp-field-row">
											{[
												["startupTimeoutMs", "启动超时（毫秒）"],
												["requestTimeoutMs", "请求超时（毫秒）"],
											].map(([key, label]) => (
												<label key={key}>
													{label}
													<input
														type="number"
														min={1}
														max={300000}
														value={String(config[key!] ?? "")}
														onChange={(event) =>
															setConfig((current) => {
																const next = { ...current };
																if (event.target.value) next[key!] = Number(event.target.value);
																else delete next[key!];
																return next;
															})
														}
													/>
												</label>
											))}
										</div>
										{[
											["enabledTools", "允许的工具"],
											["disabledTools", "禁用的工具"],
										].map(([key, label]) => (
											<label key={key}>
												{label}
												<textarea
													rows={2}
													value={Array.isArray(config[key!]) ? (config[key!] as string[]).join("\n") : ""}
													onChange={(event) =>
														setConfig((current) => {
															const next = { ...current };
															const names = event.target.value.split("\n");
															if (event.target.value) next[key!] = names;
															else delete next[key!];
															return next;
														})
													}
												/>
											</label>
										))}
									</div>
								</details>
							</fieldset>
						</form>
					)}
				</div>
				<footer>
					<button className="secondary-button" disabled={busy} onClick={onClose}>
						取消
					</button>
					{mode === "form" && (
						<button className="primary-button" type="submit" form="mcp-config-form" disabled={busy}>
							<Save size={14} />
							{busy ? "保存中" : "保存配置"}
						</button>
					)}
				</footer>
			</div>
		</div>
	);
}

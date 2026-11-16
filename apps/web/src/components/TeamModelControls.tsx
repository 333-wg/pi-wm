import { useEffect, useRef, useState } from "react";
import { ArrowRight, GitBranch, Link2, SlidersHorizontal, X } from "lucide-react";
import type { AgentTeam, ModelMetadata, ModelRef } from "@wuming/protocol";
import { useLocale } from "../lib/locale";
import { modelKey } from "../lib/team-studio";

export function TeamModelPicker({
	models,
	value,
	onChange,
	disabled,
	label,
}: {
	models: ModelMetadata[];
	value?: ModelRef | undefined;
	onChange: (model: ModelRef) => void;
	disabled?: boolean;
	label: string;
}) {
	const { locale } = useLocale();
	const known = models.some((entry) => modelKey(entry.model) === modelKey(value));
	return (
		<select
			aria-label={label}
			value={modelKey(value)}
			disabled={disabled}
			onChange={(event) => {
				const selected = models.find((entry) => modelKey(entry.model) === event.target.value);
				if (selected?.authenticated) onChange(selected.model);
			}}
		>
			{!value && <option value="">{locale === "en" ? "Choose a model" : "选择模型"}</option>}
			{value && !known && (
				<option value={modelKey(value)} disabled>
					{value.provider} / {value.id} · {locale === "en" ? "Unavailable" : "不可用"}
				</option>
			)}
			{models.map((entry) => (
				<option key={modelKey(entry.model)} value={modelKey(entry.model)} disabled={!entry.authenticated}>
					{entry.name} · {entry.model.provider}
					{!entry.authenticated ? (locale === "en" ? " · Unavailable" : " · 不可用") : ""}
				</option>
			))}
		</select>
	);
}

export function TeamModelDialog({
	team,
	models,
	busy,
	error,
	onClose,
	onSave,
}: {
	team: AgentTeam;
	models: ModelMetadata[];
	busy: boolean;
	error: string;
	onClose: () => void;
	onSave: (mode: "shared" | "manual", leaderModel: ModelRef, version: number) => Promise<boolean>;
}) {
	const { locale } = useLocale();
	const label = (zh: string, en: string) => (locale === "en" ? en : zh);
	const dialog = useRef<HTMLDialogElement>(null);
	const leader = team.members.find((member) => member.lead)!;
	const [mode, setMode] = useState<"shared" | "manual">(team.modelPolicy?.mode ?? "shared");
	const [model, setModel] = useState(leader.pendingModel ?? leader.model ?? team.modelPolicy?.sourceModel);
	const [version] = useState(team.modelPolicy?.version ?? 0);
	const setup = team.modelPolicy?.awaitingConfiguration;
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const available = models.some((entry) => entry.authenticated && modelKey(entry.model) === modelKey(model));
	return (
		<dialog
			ref={dialog}
			className="team-model-dialog"
			aria-labelledby="team-model-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (model && available) void onSave(mode, model, version);
				}}
			>
				<header>
					<span>
						<GitBranch size={20} /> TEAM SETUP
					</span>
					<button
						type="button"
						className="icon-button"
						aria-label={label("关闭模型设置", "Close model settings")}
						disabled={busy}
						onClick={onClose}
					>
						<X size={18} />
					</button>
				</header>
				<h2 id="team-model-title">
					{setup
						? label("团队准备好了，模型怎么分配？", "How should this team use models?")
						: label("团队模型分配", "Team model assignment")}
				</h2>
				<p>
					{label(
						"负责人将根据任务需要创建成员。请选择这些成员使用模型的方式。",
						"The Leader creates members as needed. Choose how their models are assigned."
					)}
				</p>
				<div className="team-leader-model">
					<span className="team-avatar">L</span>
					<div>
						<strong>{label("负责人 Leader", "Leader")}</strong>
						<small>{label("默认沿用开启 team 时的对话模型", "Inherits the conversation model at team launch")}</small>
					</div>
					<TeamModelPicker
						models={models}
						value={model}
						onChange={setModel}
						disabled={busy}
						label={label("Leader 模型", "Leader model")}
					/>
				</div>
				<fieldset className="team-model-options" disabled={busy}>
					<legend className="sr-only">{label("模型分配方式", "Model assignment mode")}</legend>
					<label className={mode === "shared" ? "selected" : ""}>
						<Link2 size={26} />
						<input
							type="radio"
							name="team-model-mode"
							value="shared"
							checked={mode === "shared"}
							onChange={() => setMode("shared")}
						/>
						<strong>{label("使用对话默认模型", "Use conversation default")}</strong>
						<span>{label("所有成员使用与 Leader 相同的模型。", "Every member uses the Leader’s model.")}</span>
						<small>{label("后续创建的成员自动开始工作。", "New members start automatically.")}</small>
					</label>
					<label className={mode === "manual" ? "selected" : ""}>
						<SlidersHorizontal size={26} />
						<input
							type="radio"
							name="team-model-mode"
							value="manual"
							checked={mode === "manual"}
							onChange={() => setMode("manual")}
						/>
						<strong>{label("自主选择", "Assign models yourself")}</strong>
						<span>{label("Leader 使用当前选定的模型。", "The Leader uses the selected model.")}</span>
						<small>
							{label("后续新成员由你分配模型，确认后开始工作。", "Choose each new member’s model before it starts.")}
						</small>
					</label>
				</fieldset>
				<p className="team-model-scope">
					{mode === "shared"
						? label(
								"应用到 Leader 和所有成员，包括待启动成员；正在执行的轮次结束后切换。",
								"Applies to the Leader and all members, including waiting members. Active turns finish before switching."
							)
						: label(
								"已有成员保留各自模型，后续新成员等待你分配。Leader 模型在下一轮生效。",
								"Existing members keep their models; new members wait for your choice. The Leader switches next turn."
							)}
				</p>
				{version !== (team.modelPolicy?.version ?? 0) && (
					<p role="alert">
						{label("配置已更新，请关闭后重新打开。", "Configuration changed. Close and reopen this dialog.")}
					</p>
				)}
				{error && (
					<p role="alert" className="persistent-team-error">
						{error}
					</p>
				)}
				<footer>
					<button type="button" disabled={busy} onClick={onClose}>
						{setup ? label("返回对话", "Back to chat") : label("取消", "Cancel")}
					</button>
					<button
						className="teams-primary"
						disabled={busy || !available || version !== (team.modelPolicy?.version ?? 0)}
					>
						{busy
							? label("正在保存…", "Saving…")
							: setup
								? label("进入团队", "Enter team")
								: label("保存分配", "Save assignment")}
						<ArrowRight size={16} />
					</button>
				</footer>
			</form>
		</dialog>
	);
}

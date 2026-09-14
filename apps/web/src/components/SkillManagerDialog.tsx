import { BookOpen, CircleAlert, Download, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, CommandResult, InstalledSkill, Skill } from "@wuming/protocol";
import { useFocusTrap } from "../use-focus-trap.js";

type SkillCommand = Extract<
	Command,
	{
		type: "skill.installed.list" | "skill.install" | "skill.preview" | "skill.set_enabled" | "skill.uninstall";
	}
>;
interface Props {
	workspaceId: string;
	onCommand: (command: SkillCommand) => Promise<CommandResult>;
	onClose: () => void;
}

export function SkillManagerDialog({ workspaceId, onCommand, onClose }: Props) {
	const dialog = useFocusTrap<HTMLDivElement>();
	const [skills, setSkills] = useState<InstalledSkill[]>([]);
	const [preview, setPreview] = useState<Skill>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [sourcePath, setSourcePath] = useState("");
	const [skillId, setSkillId] = useState("");
	const [removal, setRemoval] = useState<string>();
	const revision = useRef(0);
	const previewSection = useRef<HTMLElement>(null);
	useEffect(() => {
		if (preview) previewSection.current?.scrollIntoView({ block: "nearest" });
	}, [preview]);
	const refresh = useCallback(async () => {
		const result = await onCommand({ type: "skill.installed.list", workspaceId });
		if (result.type !== "skill.installed.list" || result.workspaceId !== workspaceId)
			throw new Error("技能列表响应不匹配");
		return result.skills;
	}, [onCommand, workspaceId]);
	useEffect(() => {
		const current = ++revision.current;
		setBusy(true);
		setError(undefined);
		void refresh()
			.then((items) => {
				if (revision.current === current) setSkills(items);
			})
			.catch((cause: unknown) => {
				if (revision.current === current) setError(String(cause instanceof Error ? cause.message : cause));
			})
			.finally(() => {
				if (revision.current === current) setBusy(false);
			});
		return () => {
			++revision.current;
		};
	}, [refresh]);
	const act = async (command?: SkillCommand) => {
		if (busy) return;
		const current = ++revision.current;
		const previousSkills = skills;
		if (command?.type === "skill.set_enabled")
			setSkills((items) =>
				items.map((item) => (item.id === command.skillId ? { ...item, enabled: command.enabled } : item))
			);
		setBusy(true);
		setError(undefined);
		try {
			if (command) {
				const result = await onCommand(command);
				if (revision.current !== current) return;
				if (command.type === "skill.preview") {
					if (
						result.type !== "skill.preview" ||
						result.skill.id !== command.skillId ||
						result.skill.workspaceId !== workspaceId
					)
						throw new Error("技能预览响应不匹配");
					setPreview(result.skill);
					return;
				}
				setPreview(undefined);
				setRemoval(undefined);
				if (command.type === "skill.install") {
					setSourcePath("");
					setSkillId("");
				}
			}
			const items = await refresh();
			if (revision.current === current) setSkills(items);
		} catch (cause) {
			if (revision.current === current) {
				if (command?.type === "skill.set_enabled") setSkills(previousSkills);
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		} finally {
			if (revision.current === current) setBusy(false);
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
				className="skill-manager-dialog"
				ref={dialog}
				role="dialog"
				aria-modal="true"
				aria-labelledby="skill-manager-title"
				tabIndex={-1}
			>
				<header className="skill-manager-header">
					<h2 id="skill-manager-title">管理技能</h2>
					<button
						className="icon-button"
						type="button"
						title="关闭技能管理"
						aria-label="关闭技能管理"
						disabled={busy}
						onClick={onClose}
					>
						<X size={18} />
					</button>
				</header>
				<form
					className="skill-install-form"
					onSubmit={(event) => {
						event.preventDefault();
						void act({
							type: "skill.install",
							workspaceId,
							sourcePath: sourcePath.trim(),
							...(skillId.trim() ? { skillId: skillId.trim() } : {}),
						});
					}}
				>
					<label>
						工作区内的技能目录
						<input
							value={sourcePath}
							onChange={(event) => setSourcePath(event.target.value)}
							placeholder="packages/my-skill"
							required
							disabled={busy}
						/>
					</label>
					<label>
						技能 ID（可选）
						<input
							value={skillId}
							onChange={(event) => setSkillId(event.target.value)}
							placeholder="my-skill"
							disabled={busy}
						/>
					</label>
					<button type="submit" disabled={busy || !sourcePath.trim()}>
						<Download size={15} />
						安装
					</button>
				</form>
				{error && (
					<div className="workbench-error" role="alert">
						<CircleAlert size={16} />
						{error}
					</div>
				)}
				<div className="skill-manager-toolbar">
					<span>{skills.length} 个技能</span>
					<button
						type="button"
						className="icon-button"
						title="刷新已安装技能"
						aria-label="刷新已安装技能"
						disabled={busy}
						onClick={() => void act()}
					>
						<RefreshCw size={16} />
					</button>
				</div>
				<div className="skill-manager-scroll" aria-busy={busy}>
					{skills.map((skill) => (
						<div className="skill-manager-row" key={skill.id} data-skill-id={skill.id}>
							<div className="skill-manager-identity">
								<strong>{skill.name}</strong>
								<small>
									{skill.id} · {skill.source === "builtin" ? "系统内置" : "用户安装"} · {skill.version}
									{skill.allowImplicitInvocation === false ? " · 手动调用" : ""}
								</small>
							</div>
							<div className="skill-manager-actions">
								<label>
									<input
										type="checkbox"
										checked={skill.enabled}
										aria-label={`启用 ${skill.id}`}
										disabled={busy}
										onChange={(event) =>
											void act({
												type: "skill.set_enabled",
												workspaceId,
												skillId: skill.id,
												enabled: event.target.checked,
											})
										}
									/>
									<span>{skill.enabled ? "已启用" : "已禁用"}</span>
								</label>
								<button
									className="icon-button"
									type="button"
									title={`查看 ${skill.id}`}
									aria-label={`查看 ${skill.id}`}
									disabled={busy}
									onClick={() => void act({ type: "skill.preview", workspaceId, skillId: skill.id })}
								>
									<BookOpen size={16} />
								</button>
								{skill.source === "user" && (
									<button
										className="icon-button"
										type="button"
										title={`卸载 ${skill.id}`}
										aria-label={`卸载 ${skill.id}`}
										disabled={busy}
										onClick={() => setRemoval(skill.id)}
									>
										<Trash2 size={16} />
									</button>
								)}
							</div>
							{removal === skill.id && (
								<div className="skill-remove-confirm">
									<span>卸载 {skill.name}？</span>
									<button
										type="button"
										disabled={busy}
										onClick={() => void act({ type: "skill.uninstall", workspaceId, skillId: skill.id })}
									>
										确认卸载
									</button>
									<button type="button" disabled={busy} onClick={() => setRemoval(undefined)}>
										取消
									</button>
								</div>
							)}
						</div>
					))}
					{skills.length === 0 && <div className="workbench-empty">{busy ? "正在加载" : "暂无技能"}</div>}
					{preview && (
						<section ref={previewSection} className="skill-manager-preview" aria-label="技能预览">
							<h3>{preview.name}</h3>
							{preview.truncated && <p role="alert">内容已截断，不能用于执行。</p>}
							<pre>{preview.content}</pre>
						</section>
					)}
				</div>
			</div>
		</div>
	);
}

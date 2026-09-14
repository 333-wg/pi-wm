import { Box, CornerDownLeft, FileText, Folder } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import type { SkillSummary, WorkspaceEntry } from "@wuming/protocol";
import { rankBy, type Trigger } from "../lib/suggest.js";

/** A command the composer can run locally or expand into the prompt. */
export interface ComposerCommand {
	/** Token typed after the slash, e.g. `new` for `/new`. */
	name: string;
	title: string;
	/** Extra text used for matching only, such as a Chinese alias. */
	hint?: string;
	/** `action` runs locally; `prompt` is sent to the runtime as text. */
	kind: "action" | "prompt";
	/** Placeholder shown when the command expects a trailing argument. */
	argumentHint?: string;
	icon?: ReactNode;
	run?: (argument: string) => void | Promise<void>;
}

export interface SuggestItem {
	group?: string;
	skillId?: string;
	id: string;
	/** Text inserted in place of the trigger token. */
	value: string;
	label: string;
	detail?: string;
	badge?: string;
	icon?: ReactNode;
	/** Set for commands that run instead of being sent to the model. */
	action?: (argument: string) => void | Promise<void>;
}

export function skillItems(skills: readonly SkillSummary[], query: string): SuggestItem[] {
	const named = rankBy(skills, query, (skill) => [skill.name, skill.id], 100);
	const ids = new Set(named.map((skill) => skill.id));
	const described = skills.filter(
		(skill) => !ids.has(skill.id) && skill.description.toLowerCase().includes(query.toLowerCase())
	);
	return [...named, ...described].slice(0, 100).map((skill) => ({
		id: `skill:${skill.id}`,
		skillId: skill.id,
		value: skill.id,
		label: skill.name,
		detail: skill.description || "暂无说明",
		group: "技能",
		icon: <Box size={16} />,
		badge: [
			skill.source === "builtin" ? "系统" : skill.source === "user" ? "工作区" : "技能",
			...(skill.allowImplicitInvocation === false ? ["手动"] : []),
		].join(" · "),
	}));
}

const kilobyte = 1024;

function formatSize(size: number | undefined): string | undefined {
	if (size === undefined) return undefined;
	if (size < kilobyte) return `${size} B`;
	if (size < kilobyte * kilobyte) return `${Math.round(size / kilobyte)} KB`;
	return `${(size / kilobyte / kilobyte).toFixed(1)} MB`;
}

function parentOf(path: string): string | undefined {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? undefined : path.slice(0, cut);
}

export function fileItems(entries: readonly WorkspaceEntry[]): SuggestItem[] {
	return entries.map((entry) => {
		const parent = parentOf(entry.path);
		const badge = entry.kind === "directory" ? "目录" : formatSize(entry.size);
		return {
			id: entry.path,
			value: entry.kind === "directory" ? `${entry.path}/` : entry.path,
			label: entry.name,
			...(parent ? { detail: parent } : {}),
			...(badge ? { badge } : {}),
			icon: entry.kind === "directory" ? <Folder size={14} /> : <FileText size={14} />,
		};
	});
}

export function commandItems(commands: readonly ComposerCommand[], query: string): SuggestItem[] {
	const ranked = rankBy(commands, query, (command) => [command.name, command.title, command.hint ?? ""], 14);
	return ranked.map((command) => {
		// Commands that need an argument are inserted, not fired, so the user can
		// finish typing; everything else runs the moment it is picked.
		const immediate = command.kind === "action" && command.run !== undefined && command.argumentHint === undefined;
		return {
			group: "命令",
			id: command.name,
			value: command.name,
			label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
			detail: command.title,
			badge: immediate ? "立即执行" : command.kind === "prompt" ? "发送给运行时" : "需要参数",
			...(command.icon ? { icon: command.icon } : {}),
			...(immediate && command.run ? { action: command.run } : {}),
		};
	});
}

/**
 * Floating list above the composer. Mouse down is prevented so picking an
 * option never steals focus from the textarea mid-edit.
 */
export function SuggestMenu({
	trigger,
	items,
	activeIndex,
	loading,
	error,
	onPick,
	onHover,
}: {
	trigger: Trigger;
	items: SuggestItem[];
	activeIndex: number;
	loading?: boolean;
	error?: string | undefined;
	onPick: (item: SuggestItem) => void;
	onHover: (index: number) => void;
}) {
	const label = trigger.kind === "file" ? "引用文件" : "快捷命令";
	const list = useRef<HTMLUListElement>(null);
	useEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);
	return (
		<div className="suggest-menu" role="listbox" aria-label={trigger.kind === "skill" ? "选择技能" : label}>
			<div className="suggest-head">
				<span>{trigger.kind === "skill" ? "技能" : trigger.kind === "command" ? "命令与技能" : label}</span>
				{trigger.query ? (
					<code>
						{trigger.kind === "file" ? "@" : trigger.kind === "skill" ? "$" : "/"}
						{trigger.query}
					</code>
				) : null}
				<span className="suggest-keys">
					<kbd>↑</kbd>
					<kbd>↓</kbd>
					<kbd>
						<CornerDownLeft size={10} />
					</kbd>
				</span>
			</div>
			{items.length === 0 ? (
				<div className="suggest-empty">
					{error ??
						(loading
							? "正在搜索..."
							: trigger.kind === "file"
								? "没有匹配的文件"
								: trigger.kind === "skill"
									? "没有匹配的技能"
									: "没有匹配的命令或技能")}
				</div>
			) : (
				<ul ref={list}>
					{items.map((item, index) => (
						<li key={item.id}>
							{item.group && item.group !== items[index - 1]?.group ? (
								<div className="suggest-group">{item.group}</div>
							) : null}
							<button
								type="button"
								role="option"
								aria-selected={index === activeIndex}
								className={`${index === activeIndex ? "active" : ""} ${item.skillId ? "suggest-skill" : ""}`}
								title={[item.label, item.detail, item.badge].filter(Boolean).join(" · ")}
								onMouseDown={(event) => event.preventDefault()}
								onMouseEnter={() => onHover(index)}
								onClick={() => onPick(item)}
							>
								{item.icon ? <span className="suggest-icon">{item.icon}</span> : null}
								<span className="suggest-label">{item.label}</span>
								{item.detail ? <span className="suggest-detail">{item.detail}</span> : null}
								{item.badge ? <span className="suggest-badge">{item.badge}</span> : null}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

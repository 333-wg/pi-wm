import { CornerDownLeft, FileText, Folder } from "lucide-react";
import { type ReactNode } from "react";
import type { WorkspaceEntry } from "@wuming/protocol";
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
	return (
		<div className="suggest-menu" role="listbox" aria-label={label}>
			<div className="suggest-head">
				<span>{label}</span>
				{trigger.query ? <code>{trigger.kind === "file" ? "@" : "/"}{trigger.query}</code> : null}
				<span className="suggest-keys">
					<kbd>↑</kbd>
					<kbd>↓</kbd>
					<kbd>
						<CornerDownLeft size={10} />
					</kbd>
				</span>
			</div>
			{items.length === 0 ? (
				<div className="suggest-empty">{error ?? (loading ? "正在搜索..." : trigger.kind === "file" ? "没有匹配的文件" : "没有匹配的命令")}</div>
			) : (
				<ul>
					{items.map((item, index) => (
						<li key={item.id}>
							<button
								type="button"
								role="option"
								aria-selected={index === activeIndex}
								className={index === activeIndex ? "active" : ""}
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

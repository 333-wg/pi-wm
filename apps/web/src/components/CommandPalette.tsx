import { ChevronRight, CircleAlert, Command, CornerDownLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cycleIndex, rankBy } from "../lib/suggest.js";

/**
 * One row of the palette. Optional fields accept `undefined` explicitly so
 * callers can forward possibly-missing values without conditional spreads.
 */
export interface PaletteEntry {
	id: string;
	/** Section heading; groups keep the order in which they first appear. */
	group: string;
	label: string;
	detail?: string | undefined;
	badge?: string | undefined;
	icon?: ReactNode;
	/** Extra match text, e.g. Chinese aliases or a session id. */
	keywords?: readonly string[];
	/** When set the row asks for an argument before running. */
	argumentHint?: string | undefined;
	run: (argument: string) => void | Promise<void>;
}

/** True when the platform labels the primary chord `⌘` instead of `Ctrl`. */
export function isAppleKeyboard(): boolean {
	return /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function modifierLabel(): string {
	return isAppleKeyboard() ? "⌘" : "Ctrl";
}

/**
 * Ctrl/Cmd+K launcher over the same command registry the composer uses, plus
 * sessions and shell toggles. Rows that need an argument switch the input into
 * an argument prompt instead of running straight away.
 */
export function CommandPalette({ entries, onClose }: { entries: readonly PaletteEntry[]; onClose: () => void }) {
	const [query, setQuery] = useState("");
	const [pending, setPending] = useState<PaletteEntry>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLUListElement>(null);

	// Groups stay contiguous — ranking only reorders rows inside a group, which
	// keeps the list readable while typing.
	const visible = useMemo(() => {
		if (pending) return [];
		const order = new Map<string, number>();
		for (const [index, entry] of entries.entries()) if (!order.has(entry.group)) order.set(entry.group, index);
		const ranked = rankBy(entries, query.trim(), (entry) => [entry.label, entry.detail ?? "", entry.group, ...(entry.keywords ?? [])], 60);
		return ranked.sort((left, right) => (order.get(left.group) ?? 0) - (order.get(right.group) ?? 0));
	}, [entries, pending, query]);

	const visibleKey = visible.map((entry) => entry.id).join(" ");
	useEffect(() => {
		setActiveIndex(0);
	}, [visibleKey]);
	useEffect(() => {
		input.current?.focus();
	}, [pending]);
	useEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, visibleKey]);

	const pick = (entry: PaletteEntry, argument: string) => {
		if (busy) return;
		if (entry.argumentHint !== undefined && argument === "" && !pending) {
			setPending(entry);
			setQuery("");
			setError(undefined);
			return;
		}
		setBusy(true);
		setError(undefined);
		void Promise.resolve(entry.run(argument))
			.then(() => onClose())
			.catch((cause: unknown) => {
				setError(cause instanceof Error ? cause.message : String(cause));
				setBusy(false);
			});
	};

	const leave = () => {
		setPending(undefined);
		setQuery("");
		setError(undefined);
	};

	let group: string | undefined;
	return (
		<div className="modal-backdrop palette-backdrop" role="presentation" onMouseDown={onClose}>
			<div className="palette" role="dialog" aria-modal="true" aria-label="命令面板" onMouseDown={(event) => event.stopPropagation()}>
				<div className="palette-input">
					{pending ? (
						<button type="button" className="palette-scope" title="返回命令列表" onClick={leave}>
							{pending.icon}
							<span>{pending.label}</span>
							<ChevronRight size={13} />
						</button>
					) : (
						<Command size={15} />
					)}
					<input
						ref={input}
						aria-label="命令面板"
						role="combobox"
						aria-expanded={visible.length > 0}
						aria-controls="palette-list"
						{...(visible[activeIndex] ? { "aria-activedescendant": `palette-option-${activeIndex}` } : {})}
						placeholder={pending ? pending.argumentHint : "搜索命令、会话与面板"}
						value={query}
						disabled={busy}
						onChange={(event) => {
							setQuery(event.target.value);
							setError(undefined);
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								if (pending) leave();
								else onClose();
								return;
							}
							if (event.key === "Backspace" && query === "" && pending) {
								event.preventDefault();
								leave();
								return;
							}
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								if (visible.length === 0) return;
								event.preventDefault();
								setActiveIndex((current) => cycleIndex(current, event.key === "ArrowDown" ? 1 : -1, visible.length));
								return;
							}
							if (event.key !== "Enter") return;
							event.preventDefault();
							if (pending) {
								pick(pending, query.trim());
								return;
							}
							const entry = visible[activeIndex] ?? visible[0];
							if (entry) pick(entry, "");
						}}
					/>
					<kbd>Esc</kbd>
				</div>
				{error && <div className="palette-error"><CircleAlert size={13} />{error}</div>}
				{pending ? (
					<div className="palette-hint">
						{pending.detail ? `${pending.detail} · ` : ""}输入参数后按 <CornerDownLeft size={11} /> 执行
					</div>
				) : (
					<ul className="palette-list" id="palette-list" role="listbox" aria-label="命令" ref={list}>
						{visible.length === 0 && <li className="palette-empty" role="presentation">没有匹配的命令</li>}
						{visible.map((entry, index) => {
							const heading = entry.group === group ? undefined : entry.group;
							group = entry.group;
							// The `li` only carries the group heading, so it stays out of the
							// listbox's accessibility tree and the button remains the option.
							return (
								<li key={entry.id} role="presentation">
									{heading && <div className="palette-group">{heading}</div>}
									<button
										type="button"
										role="option"
										id={`palette-option-${index}`}
										aria-selected={index === activeIndex}
										className={index === activeIndex ? "active" : ""}
										onMouseDown={(event) => event.preventDefault()}
										onMouseEnter={() => setActiveIndex(index)}
										onClick={() => pick(entry, "")}
									>
										{entry.icon ? <span className="palette-icon">{entry.icon}</span> : null}
										<span className="palette-label">{entry.label}</span>
										{entry.detail ? <span className="palette-detail">{entry.detail}</span> : null}
										{entry.badge ? <span className="palette-badge">{entry.badge}</span> : null}
									</button>
								</li>
							);
						})}
					</ul>
				)}
				<div className="palette-foot">
					{pending ? (
						<>
							<span><kbd>Esc</kbd>返回命令</span>
							<span><kbd><CornerDownLeft size={10} /></kbd>执行</span>
						</>
					) : (
						<>
							<span><kbd>↑</kbd><kbd>↓</kbd>选择</span>
							<span><kbd><CornerDownLeft size={10} /></kbd>执行</span>
							<span><kbd>{modifierLabel()}</kbd><kbd>/</kbd>快捷键</span>
						</>
					)}
					<span className="palette-count">{pending ? "等待参数" : `${visible.length} 项`}</span>
				</div>
			</div>
		</div>
	);
}

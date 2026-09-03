import { Check, Copy, GitBranch, Pencil } from "lucide-react";
import { type KeyboardEvent, useCallback, useState } from "react";

/**
 * The actions revealed on a transcript message. Every button is always in the
 * DOM — the row is only faded out, and comes back on hover *or* focus — so the
 * keyboard reaches them in reading order instead of them being hover-only.
 */
export function MessageActions({
	text,
	busy,
	branchDisabled,
	branchTitle,
	onFork,
	onEdit,
}: {
	/** What the copy button writes; the button is dropped when this is empty. */
	text: string;
	busy: boolean;
	branchDisabled: boolean;
	/** Why forking is unavailable, when it is — shown as the button's tooltip. */
	branchTitle: string;
	onFork?: () => void;
	onEdit?: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const copy = useCallback(() => {
		if (!navigator.clipboard) return;
		void navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1400);
			})
			.catch(() => undefined);
	}, [text]);

	return (
		<div className="message-actions">
			{text !== "" && (
				<button type="button" title={copied ? "已复制" : "复制消息"} aria-label="复制消息" onClick={copy}>
					{copied ? <Check size={13} /> : <Copy size={13} />}
				</button>
			)}
			{onEdit && (
				<button
					type="button"
					title={branchDisabled ? branchTitle : "编辑并重新发送"}
					aria-label="编辑并重新发送"
					disabled={branchDisabled || busy}
					onClick={onEdit}
				>
					<Pencil size={13} />
				</button>
			)}
			{onFork && (
				<button
					type="button"
					title={branchDisabled ? branchTitle : "从这里分叉出新会话"}
					aria-label="从这里分叉出新会话"
					disabled={branchDisabled || busy}
					onClick={onFork}
				>
					<GitBranch size={13} />
				</button>
			)}
		</div>
	);
}

/**
 * The in-place editor that replaces a user message's body. Keys match the
 * composer — Enter sends, Shift+Enter breaks the line — so the muscle memory
 * built one box down still works here; Escape backs out.
 */
export function MessageEditor({
	initial,
	busy,
	onCancel,
	onSubmit,
}: {
	initial: string;
	busy: boolean;
	onCancel: () => void;
	onSubmit: (text: string) => void;
}) {
	const [draft, setDraft] = useState(initial);
	const ready = draft.trim() !== "" && !busy;
	const submit = () => {
		if (ready) onSubmit(draft.trim());
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onCancel();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div className="message-editor">
			<textarea
				aria-label="编辑消息"
				autoFocus
				disabled={busy}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={onKeyDown}
				rows={Math.min(14, Math.max(3, draft.split("\n").length + 1))}
				value={draft}
			/>
			<div className="message-editor-foot">
				<span className="message-editor-hint">
					重新发送会从上一条消息分叉出新会话，原会话保持不动。
				</span>
				<button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
					取消
				</button>
				<button type="button" className="primary-button" disabled={!ready} onClick={submit}>
					{busy ? "正在发送..." : "重新发送"}
				</button>
			</div>
		</div>
	);
}

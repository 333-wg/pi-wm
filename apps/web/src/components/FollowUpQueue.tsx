import { useState } from "react";
import "./FollowUpQueue.css";
import { ArrowUp, Pencil, Trash2, Paperclip } from "lucide-react";
import type { QueuedFollowUp } from "@wuming/protocol";
import { useT } from "../lib/locale.js";

export function FollowUpQueue({ entries, disabled, onChange }: {
	entries: QueuedFollowUp[];
	disabled: boolean;
	onChange: (entry: QueuedFollowUp, text?: string, sendNow?: boolean) => Promise<void>;
}) {
	const t = useT();
	const [editing, setEditing] = useState<QueuedFollowUp>();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const change = async (entry: QueuedFollowUp, value?: string, sendNow = false) => {
		setBusy(true);
		setError(undefined);
		try {
			await onChange(entry, value, sendNow);
			setEditing(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally { setBusy(false); }
	};
	const latestEditing = editing && entries.find((entry) => entry.id === editing.id);
	const conflict = !!latestEditing && latestEditing.updatedAt !== editing?.updatedAt;
	if (!entries.length && !editing && !error) return null;
	return <section className="follow-up-queue" aria-label={t("followUpQueue")}>
		<header><strong>{t("queuedFollowUps")}</strong><span className="follow-up-count">{entries.length}</span><span className="follow-up-hint">{t("followUpAutoSend")}</span></header>
		<ol>
			{entries.map((entry, index) => <li key={entry.id}>
				<span className="follow-up-position">{index + 1}</span>
				<div className="follow-up-content">
					{editing?.id === entry.id ? <form onSubmit={(event) => { event.preventDefault(); if (!conflict) void change(editing, text); }}>
						<textarea aria-label={t("editQueuedFollowUp")} autoFocus value={text} disabled={busy || disabled} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && !busy) setEditing(undefined); }} rows={2} />
						{conflict && <div className="follow-up-conflict" role="status">
							<p>{t("queuedFollowUpConflict")}</p>
							<pre>{entry.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")}</pre>
							<button type="button" disabled={busy || disabled} onClick={() => { setEditing(entry); setError(undefined); }}>{t("confirmQueuedFollowUpOverwrite")}</button>
						</div>}
						<div className="follow-up-edit-actions"><button type="button" disabled={busy} onClick={() => setEditing(undefined)}>{t("cancelEdit")}</button><button type="submit" disabled={busy || disabled || conflict || (!text.trim() && !entry.content.some((part) => part.type === "artifact"))}>{t("saveQueuedFollowUp")}</button></div>
					</form> : <p title={entry.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")}>{entry.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")}</p>}
					{entry.content.filter((part) => part.type === "artifact").map((part) => <span className="follow-up-attachment" key={part.artifact.id}><Paperclip size={12} />{part.artifact.name}</span>)}
				</div>
				{editing?.id !== entry.id && <div className="follow-up-actions">
					<button type="button" className="icon-button" title={t("deleteQueuedFollowUp")} aria-label={t("deleteQueuedFollowUp")} disabled={disabled || busy || !!editing} onClick={() => void change(entry)}><Trash2 size={14} /></button>
					<button type="button" className="icon-button" title={t("editQueuedFollowUp")} aria-label={t("editQueuedFollowUp")} disabled={disabled || busy || !!editing} onClick={() => { setEditing(entry); setText(entry.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")); setError(undefined); }}><Pencil size={14} /></button>
					<button type="button" className="icon-button follow-up-send-now" title={t("sendQueuedFollowUpNow")} aria-label={t("sendQueuedFollowUpNow")} disabled={disabled || busy || !!editing} onClick={() => void change(entry, undefined, true)}><ArrowUp size={15} /></button>
				</div>}
			</li>)}
		</ol>
		{editing && !entries.some((entry) => entry.id === editing.id) && <div className="follow-up-stale" role="status"><p>{t("queuedFollowUpStarted")}</p><textarea aria-label={t("editQueuedFollowUp")} value={text} readOnly /><button type="button" onClick={() => setEditing(undefined)}>{t("cancelEdit")}</button></div>}
		{error && <div className="attachment-error" role="alert">{error}<button type="button" onClick={() => setError(undefined)}>{t("cancelEdit")}</button></div>}
	</section>;
}

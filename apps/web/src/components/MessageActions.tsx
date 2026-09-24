import { useT } from "../lib/locale.js";
import { Check, Copy, Pencil } from "lucide-react";
import { useCallback, useState } from "react";

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
	onEdit,
}: {
	/** What the copy button writes; the button is dropped when this is empty. */
	text: string;
	busy: boolean;
	branchDisabled: boolean;
	/** Why editing is unavailable, when it is — shown as the button's tooltip. */
	branchTitle: string;
	onEdit?: () => void;
}) {
	const t = useT();
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
				<button
					type="button"
					title={copied ? t("copied") : t("copyMessage")}
					aria-label={t("copyMessage")}
					onClick={copy}
				>
					{copied ? <Check size={13} /> : <Copy size={13} />}
				</button>
			)}
			{onEdit && (
				<button
					type="button"
					title={branchDisabled ? branchTitle : t("editAndResend")}
					aria-label={t("editAndResend")}
					disabled={branchDisabled || busy}
					onClick={onEdit}
				>
					<Pencil size={13} />
				</button>
			)}
		</div>
	);
}

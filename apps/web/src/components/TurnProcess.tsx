import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useT } from "../lib/locale.js";
import "./turn-process.css";

export function TurnProcess({
	durationMs,
	children,
	reveal,
}: {
	durationMs?: number | undefined;
	children: ReactNode | (() => ReactNode);
	reveal?: { messageId: string } | undefined;
}) {
	const t = useT();
	const [open, setOpen] = useState(Boolean(reveal));
	const [hasExpanded, setHasExpanded] = useState(Boolean(reveal));
	// A fresh target also represents another click on the same search hit.
	const [previousReveal, setPreviousReveal] = useState(reveal);
	if (previousReveal !== reveal) {
		setPreviousReveal(reveal);
		if (reveal) {
			setOpen(true);
			setHasExpanded(true);
		}
	}
	const id = useId();
	const expanded = open;
	const seconds = Math.round((durationMs ?? 0) / 1000);
	const duration =
		seconds < 60
			? t("seconds", { seconds })
			: t("minutesSeconds", {
					minutes: Math.floor(seconds / 60),
					seconds: seconds % 60,
				});
	return (
		<section className="turn-process">
			<button
				type="button"
				className="turn-process-summary"
				aria-expanded={expanded}
				aria-controls={id}
				onClick={() => {
					setHasExpanded(true);
					setOpen(!expanded);
				}}
				title={t(expanded ? "collapseProcess" : "expandProcess")}
			>
				<span>{durationMs === undefined ? t("executionProcess") : t("processDuration", { duration })}</span>
				<ChevronRight size={14} aria-hidden="true" />
			</button>
			<div id={id} className="turn-process-items" hidden={!expanded}>
				{/* Keep visited details mounted so nested tool state survives folding. */}
				{hasExpanded ? (typeof children === "function" ? children() : children) : null}
			</div>
		</section>
	);
}

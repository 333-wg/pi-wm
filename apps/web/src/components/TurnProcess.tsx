import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useT } from "../lib/locale.js";
import "./turn-process.css";

export function TurnProcess({
	durationMs,
	children,
	reveal = false,
}: {
	durationMs?: number | undefined;
	children: ReactNode;
	reveal?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(reveal);
	const [previousReveal, setPreviousReveal] = useState(reveal);
	if (previousReveal !== reveal) {
		setPreviousReveal(reveal);
		if (reveal) setOpen(true);
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
				onClick={() => setOpen(!expanded)}
				title={t(expanded ? "collapseProcess" : "expandProcess")}
			>
				<span>{durationMs === undefined ? t("executionProcess") : t("processDuration", { duration })}</span>
				<ChevronRight size={14} aria-hidden="true" />
			</button>
			<div id={id} className="turn-process-items" hidden={!expanded}>
				{children}
			</div>
		</section>
	);
}

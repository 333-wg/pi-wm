import { useT } from "../lib/locale.js";
import { Activity, ChevronRight, ListChecks } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import {
	isCompactTool,
	summarizeToolActivity,
	toolActivityCounts,
	toolActivityLabel,
	type GroupableTool,
} from "../lib/tool-groups.js";

export function ToolGroup({ tools, children }: { tools: GroupableTool[]; children: ReactNode }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const id = useId();
	if (tools.length === 0 || !tools.every(isCompactTool)) return children;
	const current =
		tools.findLast((tool) => tool.status === "running") ?? tools.findLast((tool) => tool.status === "pending");
	const counts = toolActivityCounts(tools);
	const summary = summarizeToolActivity(tools, t);
	const label = current
		? t(current.status === "running" ? "activityRunning" : "activityPending", {
				activity: toolActivityLabel(current, t),
			})
		: summary;
	return (
		<div className="tool-row tool-group">
			<div className={`tool-trace ${current?.status ?? "complete"}${open ? " open" : ""}`}>
				<button
					type="button"
					className="tool-trace-summary tool-group-summary"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					aria-controls={open ? id : undefined}
					title={summary}
				>
					<ChevronRight size={14} className="tool-caret" />
					<span className="tool-icon">{current ? <Activity size={15} /> : <ListChecks size={15} />}</span>
					<span className="tool-activity-label">{label}</span>
					<span className="tool-group-count">
						{current
							? t("activityProgress", { completed: counts.ended, total: tools.length })
							: t("activityEnded", { count: tools.length })}
					</span>
				</button>
				{open && (
					<div className="tool-group-items" id={id}>
						{children}
					</div>
				)}
			</div>
		</div>
	);
}

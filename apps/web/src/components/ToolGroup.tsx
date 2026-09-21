import { useT } from "../lib/locale.js";
import { Activity, ChevronRight, ListChecks } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { isCompactTool, summarizeToolActivity, toolActivityLabel, type GroupableTool } from "../lib/tool-groups.js";
import { StatusIndicator } from "./ToolCard.js";

export function ToolGroup({ tools, children }: { tools: GroupableTool[]; children: ReactNode }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const id = useId();
	if (tools.length === 0 || !tools.every(isCompactTool)) return children;
	const current =
		tools.findLast((tool) => tool.status === "running") ??
		tools.findLast((tool) => tool.status === "pending") ??
		tools[tools.length - 1]!;
	const completed = tools.filter((tool) => tool.status === "complete").length;
	const summary = summarizeToolActivity(tools, t);
	const label =
		current.status === "complete"
			? summary
			: t(current.status === "running" ? "activityRunning" : "activityPending", {
					activity: toolActivityLabel(current, t),
				});
	return (
		<div className="tool-row tool-group">
			<div className={`tool-trace ${current.status}${open ? " open" : ""}`}>
				<button
					type="button"
					className="tool-trace-summary tool-group-summary"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					aria-controls={open ? id : undefined}
				>
					<ChevronRight size={14} className="tool-caret" />
					<span className="tool-icon">
						{current.status === "running" ? <Activity size={15} /> : <ListChecks size={15} />}
					</span>
					<span className="tool-activity-label" title={summary}>
						{label}
					</span>
					{completed < tools.length && (
						<span className="tool-meta" aria-label={t("activityProgress", { completed, total: tools.length })}>
							{completed}/{tools.length}
						</span>
					)}
					<StatusIndicator status={current.status} />
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

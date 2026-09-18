import { useT } from "../lib/locale.js";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type { GroupableTool } from "../lib/tool-groups.js";
import { describeTool, StatusIndicator } from "./ToolCard.js";

export function ToolGroup({ tools, children }: { tools: GroupableTool[]; children: ReactNode }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const id = useId();
	if (tools.length < 2) return children;
	const current =
		tools.findLast((tool) => tool.status === "running") ??
		tools.findLast((tool) => tool.status === "pending") ??
		tools[tools.length - 1]!;
	const description = describeTool(current.toolName, current.input, t);
	const completed = tools.filter((tool) => tool.status === "complete").length;
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
					<span className="tool-icon">{description.icon}</span>
					<span className="tool-verb">{description.verb}</span>
					<span className="tool-group-count">{t("callCount", { count: tools.length })}</span>
					{description.target && (
						<span className="tool-target" title={description.title ?? description.target}>
							{description.target}
						</span>
					)}
					{completed < tools.length && (
						<span className="tool-meta">
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

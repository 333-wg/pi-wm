import { CircleAlert, Layers, X } from "lucide-react";

export function CompactionActivity({ status }: { status: "running" | "complete" | "failed" | "cancelled" }) {
	if (status === "complete") return null;
	const label = status === "running" ? "正在压缩上下文" : status === "failed" ? "上下文压缩未完成" : "上下文压缩已取消";
	const Icon = status === "running" ? Layers : status === "failed" ? CircleAlert : X;
	return (
		<div
			className={`activity-row compaction-activity compaction-${status}`}
			role="status"
			aria-live="polite"
			aria-label={label}
		>
			<Icon size={16} aria-hidden="true" />
			<span>{label}</span>
			{status === "running" && (
				<span className="compaction-motion" aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
			)}
		</div>
	);
}

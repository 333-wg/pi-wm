import { Check, CircleAlert, LoaderCircle, ShieldAlert, TerminalSquare, X } from "lucide-react";
import { useRef, useState } from "react";
import type { ApprovalRequest } from "@wuming/protocol";

export function ApprovalPanel({
	approval,
	onRespond,
}: {
	approval: ApprovalRequest;
	onRespond: (decision: "approve" | "deny") => Promise<void>;
}) {
	const [responding, setResponding] = useState<"approve" | "deny" | undefined>();
	const [error, setError] = useState<string>();
	const pending = useRef(false);
	const isCommand = approval.capabilities.some((capability) => capability.type === "process.exec");
	const summary = isCommand && approval.summary.startsWith("Run: ") ? approval.summary.slice(5) : approval.summary;
	const capabilities = [...new Set(approval.capabilities.map((capability) => capability.type))];
	const respond = async (decision: "approve" | "deny") => {
		if (pending.current) return;
		pending.current = true;
		setResponding(decision);
		setError(undefined);
		try {
			await onRespond(decision);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setResponding(undefined);
			pending.current = false;
		}
	};
	return (
		<section
			className={"approval-panel risk-" + approval.risk}
			aria-label="需要批准工具调用"
			aria-busy={responding !== undefined}
		>
			<header className="approval-heading">
				<span className="approval-icon">
					<ShieldAlert size={17} aria-hidden="true" />
				</span>
				<strong>工具调用待确认</strong>
				<span className="approval-risk">{{ low: "低风险", medium: "中风险", high: "高风险" }[approval.risk]}</span>
			</header>
			<div className="approval-detail">
				<div className="approval-detail-label">
					{isCommand ? <TerminalSquare size={14} aria-hidden="true" /> : <ShieldAlert size={14} aria-hidden="true" />}
					<span>{isCommand ? "待执行命令" : "操作内容"}</span>
				</div>
				{isCommand ? (
					<pre className="approval-command">
						<code>{summary}</code>
					</pre>
				) : (
					<p className="approval-summary">{summary}</p>
				)}
			</div>
			{error && (
				<div className="approval-error" role="alert">
					<CircleAlert size={14} />
					<span>{error}</span>
				</div>
			)}
			<footer className="approval-footer">
				<div className="approval-capabilities" aria-label="请求的权限">
					{capabilities.map((capability) => (
						<code key={capability}>{capability}</code>
					))}
				</div>
				<div className="approval-actions">
					<button
						type="button"
						className="approval-deny"
						disabled={responding !== undefined}
						onClick={() => void respond("deny")}
					>
						{responding === "deny" ? <LoaderCircle className="approval-spinner" size={15} /> : <X size={15} />}
						{responding === "deny" ? "拒绝中" : "拒绝"}
					</button>
					<button
						type="button"
						className="approval-allow"
						disabled={responding !== undefined}
						onClick={() => void respond("approve")}
					>
						{responding === "approve" ? <LoaderCircle className="approval-spinner" size={15} /> : <Check size={15} />}
						{responding === "approve" ? "允许中" : "允许"}
					</button>
				</div>
			</footer>
		</section>
	);
}

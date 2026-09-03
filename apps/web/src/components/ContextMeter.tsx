import { Gauge } from "lucide-react";
import { contextLevel, formatTokens, type ContextUsage } from "../lib/context-usage.js";

function describe(usage: ContextUsage): string {
	const percent = Math.round(usage.ratio * 100);
	const basis = usage.coarse ? "按最近一轮的总用量估算" : "按最近一次请求的用量估算";
	return `上下文约占 ${percent}%（${usage.tokens.toLocaleString("en-US")} / ${usage.contextWindow.toLocaleString("en-US")} token，${basis}）`;
}

/** Bar for the run rail: label, percentage, and the token pair underneath. */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
	const percent = Math.round(usage.ratio * 100);
	return (
		<div className={`context-meter level-${contextLevel(usage.ratio)}`} title={describe(usage)}>
			<div className="context-head">
				<span>上下文</span>
				<strong>{percent}%</strong>
			</div>
			<div className="context-bar" role="img" aria-label={describe(usage)}>
				<i style={{ width: `${Math.max(2, percent)}%` }} />
			</div>
			<div className="context-foot">
				<span>{formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}</span>
				{usage.ratio >= 0.75 && <span>建议 /compact</span>}
			</div>
		</div>
	);
}

/** Compact readout for the composer, where the rail may be hidden. */
export function ContextPill({ usage }: { usage: ContextUsage }) {
	const percent = Math.round(usage.ratio * 100);
	return (
		<span className={`context-pill level-${contextLevel(usage.ratio)}`} title={describe(usage)}>
			<Gauge size={13} />
			<span>上下文 {percent}%</span>
		</span>
	);
}

import { Gauge } from "lucide-react";
import { contextLevel, formatTokens, type ContextUsage } from "../lib/context-usage.js";

function describe(usage: ContextUsage): string {
	if (usage.tokens === null || usage.ratio === null)
		return `${usage.basis === "compaction" ? "已压缩，" : ""}上下文用量待更新（模型窗口 ${usage.contextWindow.toLocaleString("en-US")} token）`;
	const percent = Math.round(usage.ratio * 100);
	const basis = usage.basis === "compaction" ? "按压缩后保留内容估算" : "按最近一次模型请求的输入、缓存和输出估算";
	return `上下文约占 ${percent}%（${usage.tokens.toLocaleString("en-US")} / ${usage.contextWindow.toLocaleString("en-US")} token，${basis}）`;
}

/** Bar for the run rail: label, percentage, and the token pair underneath. */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
	const percent = usage.ratio === null ? null : Math.round(usage.ratio * 100);
	return (
		<div className={`context-meter level-${contextLevel(usage.ratio ?? 0)}`} title={describe(usage)}>
			<div className="context-head">
				<span>上下文</span>
				<strong>{percent === null ? "待更新" : `${percent}%`}</strong>
			</div>
			<div className="context-bar" role="img" aria-label={describe(usage)}>
				<i style={{ width: `${percent ?? 0}%` }} />
			</div>
			<div className="context-foot">
				<span>
					{usage.tokens === null ? "--" : formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}
				</span>
				{usage.ratio !== null && usage.ratio >= 0.75 ? (
					<span>建议 /compact</span>
				) : (
					usage.basis === "compaction" && <span>{usage.tokens === null ? "已压缩" : "压缩后估算"}</span>
				)}
			</div>
		</div>
	);
}

/** Compact readout for the composer, where the rail may be hidden. */
export function ContextPill({ usage }: { usage: ContextUsage }) {
	const percent = usage.ratio === null ? null : Math.round(usage.ratio * 100);
	return (
		<span className={`context-pill level-${contextLevel(usage.ratio ?? 0)}`} title={describe(usage)}>
			<Gauge size={13} />
			<span>上下文 {percent === null ? "待更新" : `${percent}%`}</span>
		</span>
	);
}

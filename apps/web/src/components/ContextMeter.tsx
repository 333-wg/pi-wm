import { Gauge } from "lucide-react";
import { contextLevel, formatTokens, type CacheUsage, type ContextUsage } from "../lib/context-usage.js";

function describeOccupancy(usage: ContextUsage): string {
	if (usage.tokens === null || usage.ratio === null)
		return `${usage.basis === "compaction" ? "已压缩，" : ""}上下文用量待更新（模型窗口 ${usage.contextWindow.toLocaleString("en-US")} token）`;
	const percent = Math.round(usage.ratio * 100);
	const basis = usage.basis === "compaction" ? "按压缩后保留内容估算" : "按最近一次模型请求的输入、缓存和输出估算";
	return `上下文约占 ${percent}%（${usage.tokens.toLocaleString("en-US")} / ${usage.contextWindow.toLocaleString("en-US")} token，${basis}）`;
}

function describeCache(label: string, cache: CacheUsage | undefined): string {
	if (!cache || cache.hitRatio === null) return `${label}：暂无输入用量`;
	const count = (value: number) => value.toLocaleString("en-US");
	return `${label}\n缓存命中率（输入 token）：${(cache.hitRatio * 100).toFixed(1)}%\n缓存读取：${count(cache.readTokens)} token · 缓存写入：${count(cache.writeTokens)} token\n输入总量：${count(cache.inputTokens)} token`;
}

function describe(usage: ContextUsage): string {
	return [
		describeOccupancy(usage),
		describeCache("最近一次模型请求", usage.cache?.latest),
		describeCache(`会话累计（${usage.cache?.requestCount ?? 0} 次已记录模型请求，含历史模型）`, usage.cache?.session),
		"命中率 = 缓存读取 /（未缓存输入 + 缓存读取 + 缓存写入），不含输出。",
		"按接口返回统计；未上报缓存的接口可能显示 0。压缩后需新请求才能确认缓存命中。",
	].join("\n\n");
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
		<span
			className={`context-pill level-${contextLevel(usage.ratio ?? 0)}`}
			title={describe(usage)}
			tabIndex={0}
			aria-label={describe(usage)}
		>
			<Gauge size={13} />
			<span>上下文 {percent === null ? "待更新" : `${percent}%`}</span>
		</span>
	);
}

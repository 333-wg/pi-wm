import { ChevronRight, Gauge, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { contextLevel, formatTokens, type CacheUsage, type ContextUsage } from "../lib/context-usage.js";
import "./context-meter.css";

function describeOccupancy(usage: ContextUsage): string {
	if (usage.tokens === null || usage.ratio === null)
		return (
			(usage.basis === "compaction" ? "已压缩，" : "") +
			"上下文用量待更新（模型窗口 " +
			usage.contextWindow.toLocaleString("en-US") +
			" token）"
		);
	const basis = usage.basis === "compaction" ? "按压缩后保留内容估算" : "按最近一次模型请求的输入、缓存和输出估算";
	return (
		"上下文约占 " +
		Math.round(usage.ratio * 100) +
		"%（" +
		usage.tokens.toLocaleString("en-US") +
		" / " +
		usage.contextWindow.toLocaleString("en-US") +
		" token，" +
		basis +
		"）"
	);
}

function hitRate(cache: CacheUsage | undefined): string {
	return cache?.hitRatio == null ? "暂无数据" : (cache.hitRatio * 100).toFixed(1) + "%";
}

export function ContextDetails({ usage }: { usage: ContextUsage }) {
	const percent = usage.ratio === null ? null : Math.round(usage.ratio * 100);
	const count = (value: number | undefined) => (value === undefined ? "--" : value.toLocaleString("en-US"));
	return (
		<>
			<div className="context-detail-occupancy">
				<strong>
					{percent === null ? (
						"待更新"
					) : (
						<>
							{percent}
							<small>%</small>
						</>
					)}
				</strong>
				<span>{usage.basis === "compaction" ? "压缩后估算" : "当前占用"}</span>
			</div>
			<div className="context-detail-track" role="img" aria-label={describeOccupancy(usage)}>
				<i style={{ width: (percent ?? 0) + "%" }} />
			</div>
			<div className="context-detail-tokens">
				{count(usage.tokens ?? undefined)} / {count(usage.contextWindow)} <span>tokens</span>
			</div>
			<div className="context-cache-heading">
				缓存命中率 <span>输入 tokens</span>
			</div>
			<div className="context-cache-summary">
				<div>
					<span>最近完成请求</span>
					<strong className={usage.cache?.awaitingRequest ? "context-cache-waiting" : undefined}>
						{usage.cache?.awaitingRequest ? "等待首个请求用量" : hitRate(usage.cache?.latest)}
					</strong>
				</div>
				<div>
					<span>会话累计 {!!usage.cache?.requestCount && <small>{usage.cache.requestCount} 次</small>}</span>
					<strong>{hitRate(usage.cache?.session)}</strong>
				</div>
			</div>
			<details className="context-detail-disclosure">
				<summary>
					<ChevronRight size={12} />
					用量明细
				</summary>
				<table>
					<caption>输入用量（tokens）</caption>
					<thead>
						<tr>
							<th scope="col">用量</th>
							<th scope="col">最近完成请求</th>
							<th scope="col">会话累计</th>
						</tr>
					</thead>
					<tbody>
						{(
							[
								["缓存读取", "readTokens"],
								["缓存写入", "writeTokens"],
								["输入总量", "inputTokens"],
							] as const
						).map(([label, key]) => (
							<tr key={key}>
								<th scope="row">{label}</th>
								<td>{count(usage.cache?.latest?.[key])}</td>
								<td>{count(usage.cache?.requestCount ? usage.cache.session[key] : undefined)}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p>命中率 = 缓存读取 / 输入总量，不含输出。会话累计包含历史模型。</p>
				<p>按接口上报统计，未上报缓存时可能显示 0。压缩后需新请求确认缓存命中。</p>
			</details>
		</>
	);
}

function ContextPopover({
	usage,
	className,
	children,
}: {
	usage: ContextUsage;
	className: string;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<CSSProperties>({});
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const pinned = useRef(false);
	const id = useId();
	const clearTimer = () => clearTimeout(timer.current);
	const close = (restoreFocus = false) => {
		clearTimer();
		pinned.current = false;
		setOpen(false);
		if (restoreFocus) trigger.current?.focus();
	};
	const leave = () => {
		clearTimer();
		if (!pinned.current) timer.current = setTimeout(() => setOpen(false), 180);
	};
	useEffect(() => () => clearTimeout(timer.current), []);
	useLayoutEffect(() => {
		if (!open) return;
		const place = () => {
			if (!trigger.current || !panel.current) return;
			const anchor = trigger.current.getBoundingClientRect();
			const viewport = window.visualViewport;
			const leftEdge = viewport?.offsetLeft ?? 0;
			const topEdge = viewport?.offsetTop ?? 0;
			const width = Math.min(304, (viewport?.width ?? window.innerWidth) - 24);
			const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight);
			const height = Math.min(panel.current.scrollHeight + 2, bottomEdge - topEdge - 24);
			const top = anchor.top - height - 8 >= topEdge + 12 ? anchor.top - height - 8 : anchor.bottom + 8;
			setPosition({
				width,
				left: Math.max(
					leftEdge + 12,
					Math.min(anchor.left, leftEdge + (viewport?.width ?? window.innerWidth) - width - 12)
				),
				top: Math.max(topEdge + 12, Math.min(top, bottomEdge - height - 12)),
				maxHeight: bottomEdge - topEdge - 24,
			});
		};
		place();
		const observer = new ResizeObserver(place);
		observer.observe(panel.current!);
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		window.visualViewport?.addEventListener("resize", place);
		window.visualViewport?.addEventListener("scroll", place);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
			window.visualViewport?.removeEventListener("resize", place);
			window.visualViewport?.removeEventListener("scroll", place);
		};
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const outside = (event: Event) => {
			if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				close(panel.current?.contains(document.activeElement));
			}
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		document.addEventListener("keydown", escape, true);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
			document.removeEventListener("keydown", escape, true);
		};
	}, [open]);
	return (
		<>
			<button
				type="button"
				ref={trigger}
				className={className}
				aria-label={describeOccupancy(usage)}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls={open ? id : undefined}
				onPointerEnter={(event) => {
					if (event.pointerType === "mouse") {
						clearTimer();
						timer.current = setTimeout(() => setOpen(true), 220);
					}
				}}
				onPointerLeave={leave}
				onClick={() => {
					clearTimer();
					if (open && pinned.current) close();
					else {
						pinned.current = true;
						setOpen(true);
					}
				}}
				onKeyDown={(event) => {
					if (event.key === "Tab" && !event.shiftKey && open) {
						event.preventDefault();
						panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
					}
				}}
			>
				{children}
			</button>
			{open &&
				createPortal(
					<div
						id={id}
						ref={panel}
						role="dialog"
						aria-label="上下文统计"
						className={"context-popover level-" + contextLevel(usage.ratio ?? 0)}
						style={position}
						onPointerEnter={clearTimer}
						onPointerLeave={leave}
						onFocus={() => {
							clearTimer();
							pinned.current = true;
						}}
						onKeyDown={(event) => {
							if (event.key === "Tab" && event.shiftKey && event.target === panel.current?.querySelector("button")) {
								event.preventDefault();
								trigger.current?.focus();
							}
						}}
					>
						<header>
							<span>
								<Gauge size={14} />
								上下文
							</span>
							<button type="button" aria-label="关闭上下文统计" title="关闭" onClick={() => close(true)}>
								<X size={14} />
							</button>
						</header>
						<ContextDetails usage={usage} />
					</div>,
					document.body
				)}
		</>
	);
}

/** Bar for the run rail. */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
	const percent = usage.ratio === null ? null : Math.round(usage.ratio * 100);
	return (
		<ContextPopover usage={usage} className={"context-meter level-" + contextLevel(usage.ratio ?? 0)}>
			<span className="context-head">
				<span>上下文</span>
				<strong>{percent === null ? "待更新" : percent + "%"}</strong>
			</span>
			<span className="context-bar" role="img" aria-label={describeOccupancy(usage)}>
				<i style={{ width: (percent ?? 0) + "%" }} />
			</span>
			<span className="context-foot">
				<span>
					{usage.tokens === null ? "--" : formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}
				</span>
				{usage.ratio !== null && usage.ratio >= 0.75 ? (
					<span>建议 /compact</span>
				) : (
					usage.basis === "compaction" && <span>{usage.tokens === null ? "已压缩" : "压缩后估算"}</span>
				)}
			</span>
		</ContextPopover>
	);
}

/** Compact readout for the composer, where the rail may be hidden. */
export function ContextPill({ usage }: { usage: ContextUsage }) {
	const percent = usage.ratio === null ? null : Math.round(usage.ratio * 100);
	return (
		<ContextPopover usage={usage} className={"context-pill level-" + contextLevel(usage.ratio ?? 0)}>
			<Gauge size={13} />
			<span>上下文 {percent === null ? "待更新" : percent + "%"}</span>
		</ContextPopover>
	);
}

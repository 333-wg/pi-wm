import { useT, type Translate } from "../lib/locale.js";
import { ChevronRight, Gauge, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { contextLevel, formatTokens, type CacheUsage, type ContextUsage } from "../lib/context-usage.js";
import "./context-meter.css";

function describeOccupancy(usage: ContextUsage, t: Translate): string {
	if (usage.tokens === null || usage.ratio === null)
		return t("contextAwaiting", {
			prefix: usage.basis === "compaction" ? t("compactedPrefix") : "",
			window: usage.contextWindow.toLocaleString("en-US"),
		});
	return t("contextOccupancy", {
		percent: Math.round(usage.ratio * 100),
		tokens: usage.tokens.toLocaleString("en-US"),
		window: usage.contextWindow.toLocaleString("en-US"),
		basis: t(usage.basis === "compaction" ? "contextCompactedBasis" : "contextRequestBasis"),
	});
}

function hitRate(cache: CacheUsage | undefined, t: Translate): string {
	return cache?.hitRatio == null ? t("noData") : (cache.hitRatio * 100).toFixed(1) + "%";
}

export function ContextDetails({ usage }: { usage: ContextUsage }) {
	const t = useT();
	const percent = usage.ratio === null ? null : Math.round(usage.ratio * 100);
	const count = (value: number | undefined) => (value === undefined ? "--" : value.toLocaleString("en-US"));
	return (
		<>
			<div className="context-detail-occupancy">
				<strong>
					{percent === null ? (
						t("awaitingUpdate")
					) : (
						<>
							{percent}
							<small>%</small>
						</>
					)}
				</strong>
				<span>{usage.basis === "compaction" ? t("compactedEstimate") : t("currentOccupancy")}</span>
			</div>
			<div className="context-detail-track" role="img" aria-label={describeOccupancy(usage, t)}>
				<i style={{ width: (percent ?? 0) + "%" }} />
			</div>
			<div className="context-detail-tokens">
				{count(usage.tokens ?? undefined)} / {count(usage.contextWindow)} <span>tokens</span>
			</div>
			<div className="context-cache-heading">
				{t("cacheHitRate")} <span>{t("inputTokens")}</span>
			</div>
			<div className="context-cache-summary">
				<div>
					<span>{t("latestRequest")}</span>
					<strong className={usage.cache?.awaitingRequest ? "context-cache-waiting" : undefined}>
						{usage.cache?.awaitingRequest ? t("awaitingFirstUsage") : hitRate(usage.cache?.latest, t)}
					</strong>
				</div>
				<div>
					<span>
						{t("sessionTotal")}{" "}
						{!!usage.cache?.requestCount && <small>{t("callCount", { count: usage.cache.requestCount })}</small>}
					</span>
					<strong>{hitRate(usage.cache?.session, t)}</strong>
				</div>
			</div>
			<details className="context-detail-disclosure">
				<summary>
					<ChevronRight size={12} />
					{t("usageDetails")}
				</summary>
				<table>
					<caption>{t("inputUsage")}</caption>
					<thead>
						<tr>
							<th scope="col">{t("usage")}</th>
							<th scope="col">{t("latestRequest")}</th>
							<th scope="col">{t("sessionTotal")}</th>
						</tr>
					</thead>
					<tbody>
						{(
							[
								[t("usageCacheRead"), "readTokens"],
								[t("usageCacheWrite"), "writeTokens"],
								[t("totalInput"), "inputTokens"],
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
				<p>{t("cacheRateHint")}</p>
				<p>{t("cacheReportedHint")}</p>
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
	const t = useT();
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
				aria-label={describeOccupancy(usage, t)}
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
						aria-label={t("contextStats")}
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
								{t("context")}
							</span>
							<button type="button" aria-label={t("closeContextStats")} title={t("close")} onClick={() => close(true)}>
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
	const t = useT();
	const percent = usage.ratio === null ? null : Math.round(usage.ratio * 100);
	return (
		<ContextPopover usage={usage} className={"context-meter level-" + contextLevel(usage.ratio ?? 0)}>
			<span className="context-head">
				<span>{t("context")}</span>
				<strong>{percent === null ? t("awaitingUpdate") : percent + "%"}</strong>
			</span>
			<span className="context-bar" role="img" aria-label={describeOccupancy(usage, t)}>
				<i style={{ width: (percent ?? 0) + "%" }} />
			</span>
			<span className="context-foot">
				<span>
					{usage.tokens === null ? "--" : formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}
				</span>
				{usage.ratio !== null && usage.ratio >= 0.75 ? (
					<span>{t("compactSuggestion")}</span>
				) : (
					usage.basis === "compaction" && <span>{usage.tokens === null ? t("compacted") : t("compactedEstimate")}</span>
				)}
			</span>
		</ContextPopover>
	);
}

/** Compact readout for the composer, where the rail may be hidden. */
export function ContextPill({ usage }: { usage: ContextUsage }) {
	const t = useT();
	const percent = usage.ratio === null ? null : Math.round(usage.ratio * 100);
	return (
		<ContextPopover usage={usage} className={"context-pill level-" + contextLevel(usage.ratio ?? 0)}>
			<Gauge size={13} />
			<span>
				{t("context")} {percent === null ? t("awaitingUpdate") : percent + "%"}
			</span>
		</ContextPopover>
	);
}

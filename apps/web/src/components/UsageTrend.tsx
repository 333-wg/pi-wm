import { useId, useState } from "react";
import type { UsageOverview } from "@wuming/protocol";
import { useLocale } from "../lib/locale.js";
import { formatTokens } from "../lib/context-usage.js";
import { usageTrendGeometry } from "../lib/usage-trend.js";
import "./usage-trend.css";

export function UsageTrend({ daily }: { daily: UsageOverview["daily"] }) {
	const { locale, t } = useLocale();
	const gradient = useId();
	const [selectedDate, setSelectedDate] = useState<string>();
	const geometry = usageTrendGeometry(daily.map((entry) => entry.usage.totalTokens));
	const activeIndex = Math.max(
		0,
		daily.findIndex((entry) => entry.date === selectedDate)
	);
	const index = selectedDate && daily.some((entry) => entry.date === selectedDate) ? activeIndex : daily.length - 1;
	const entry = daily[index];
	const point = geometry.points[index];
	const number = new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN");
	const dateLabel = (i: number) =>
		i === daily.length - 1 ? t("usageToday") : daily[i]!.date.slice(5).replace("-", "/");
	if (!entry || !point) return <div className="usage-settings-placeholder">{t("usageTrendEmpty")}</div>;
	return (
		<div className="usage-trend-card" role="group" aria-label={t("usageTrendAria", { days: daily.length })}>
			<div className="usage-trend-summary">
				<span className="usage-trend-legend">
					<i />
					Token
				</span>
				<div className="usage-trend-readout" role="status" aria-live="polite" aria-atomic="true">
					<span>
						{entry.date} · {dateLabel(index)}
					</span>
					<strong>
						{number.format(entry.usage.totalTokens)} <small>Token</small>
					</strong>
					<span>
						{new Intl.NumberFormat("en-US", {
							style: "currency",
							currency: "USD",
							minimumFractionDigits: 2,
							maximumFractionDigits: 4,
						}).format(entry.usage.costUsd)}{" "}
						· {t("usageRequestsTurns", { requests: entry.requestCount, turns: entry.turnCount })}
					</span>
				</div>
			</div>
			<div className="usage-trend-chart">
				<div className="usage-trend-y" aria-hidden="true">
					{[1, 0.5, 0].map((ratio) => (
						<span key={ratio}>{formatTokens(geometry.ceiling * ratio)}</span>
					))}
				</div>
				<div className="usage-trend-plot">
					<svg viewBox="0 0 640 160" preserveAspectRatio="none" aria-hidden="true">
						<defs>
							<linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor="currentColor" stopOpacity=".2" />
								<stop offset="100%" stopColor="currentColor" stopOpacity=".015" />
							</linearGradient>
						</defs>
						{[0, 80, 160].map((y) => (
							<line className="usage-trend-grid" key={y} x1="0" x2="640" y1={y} y2={y} />
						))}
						<path d={geometry.area} fill={`url(#${gradient})`} />
						<path className="usage-trend-line" d={geometry.line} />
						<line className="usage-trend-guide" x1={point.x} x2={point.x} y1="0" y2="160" />
					</svg>
					{geometry.points.map((p, i) => (
						<button
							key={daily[i]!.date}
							type="button"
							className={`usage-settings-day usage-trend-point${index === i ? " selected" : ""}`}
							style={{ left: `${(p.x / 640) * 100}%`, top: `${(p.y / 160) * 100}%` }}
							aria-label={`${daily[i]!.date}: ${number.format(daily[i]!.usage.totalTokens)} Token`}
							aria-pressed={index === i}
							onMouseEnter={() => setSelectedDate(daily[i]!.date)}
							onFocus={() => setSelectedDate(daily[i]!.date)}
							onClick={() => setSelectedDate(daily[i]!.date)}
						>
							<span />
						</button>
					))}
					<div className="usage-trend-x" aria-hidden="true">
						{daily.map((day, i) => {
							const step = daily.length <= 7 ? 1 : daily.length <= 14 ? 2 : 5;
							if (i !== 0 && i !== daily.length - 1 && (i % step !== 0 || daily.length - 1 - i < step)) return null;
							return (
								<span key={day.date} style={{ left: `${(geometry.points[i]!.x / 640) * 100}%` }}>
									{dateLabel(i)}
								</span>
							);
						})}
					</div>
				</div>
			</div>
			{daily.every((day) => day.usage.totalTokens === 0) && (
				<div className="usage-trend-empty">{t("usageTrendEmpty")}</div>
			)}
		</div>
	);
}

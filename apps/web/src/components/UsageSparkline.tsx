import { useId } from "react";
import type { UsageOverview } from "@wuming/protocol";
import { useLocale } from "../lib/locale.js";
import { usageTrendGeometry } from "../lib/usage-trend.js";

/** Compact companion to the full usage chart in Settings. */
export function UsageSparkline({ daily }: { daily: UsageOverview["daily"] }) {
	const { locale, t } = useLocale();
	const gradient = useId();
	const geometry = usageTrendGeometry(daily.map((entry) => entry.usage.totalTokens));
	const number = new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN");
	const money = new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 4,
	});
	return (
		<div className="usage-sparkline" role="group" aria-label={t("usageWeekAria")}>
			<div className="usage-sparkline-plot">
				<svg viewBox="0 0 640 160" preserveAspectRatio="none" aria-hidden="true">
					<defs>
						<linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="currentColor" stopOpacity=".22" />
							<stop offset="100%" stopColor="currentColor" stopOpacity=".02" />
						</linearGradient>
					</defs>
					<line className="usage-sparkline-baseline" x1="12" x2="628" y1="160" y2="160" />
					<path d={geometry.area} fill={`url(#${gradient})`} />
					<path className="usage-sparkline-line" d={geometry.line} />
				</svg>
				{daily.map((entry, index) => (
					<button
						key={entry.date}
						type="button"
						className="usage-sparkline-point"
						style={{
							left: `${(geometry.points[index]!.x / 640) * 100}%`,
							top: `${(geometry.points[index]!.y / 160) * 100}%`,
						}}
						aria-label={`${entry.date}: ${number.format(entry.usage.totalTokens)} Token`}
						title={`${entry.date} · ${number.format(entry.usage.totalTokens)} Token · ${money.format(entry.usage.costUsd)}`}
					>
						<span />
					</button>
				))}
			</div>
			<div className="usage-sparkline-dates" aria-hidden="true">
				{daily.map((entry, index) => (
					<span key={entry.date} style={{ left: `${(geometry.points[index]!.x / 640) * 100}%` }}>
						{index === daily.length - 1 ? t("usageToday") : entry.date.slice(5).replace("-", "/")}
					</span>
				))}
			</div>
		</div>
	);
}

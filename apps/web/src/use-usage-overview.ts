import { useEffect, useSyncExternalStore } from "react";
import { USAGE_FRESH_MS, type UsageOverviewCache } from "./lib/usage-overview-cache.js";

export function useUsageOverview(
	cache: UsageOverviewCache,
	workspaceId: string | undefined,
	days: number,
	active: boolean
) {
	useSyncExternalStore(cache.subscribe, cache.getVersion);
	const revision = cache.invalidationRevision;
	useEffect(() => {
		if (!active) return;
		const refresh = () => {
			if (document.visibilityState !== "hidden") void cache.load(workspaceId, days).catch(() => undefined);
		};
		// Coalesce bursts of usage/snapshot events while keeping the last result visible.
		const scheduled = window.setTimeout(refresh, cache.getState(workspaceId, days).data ? 150 : 0);
		const timer = window.setInterval(refresh, USAGE_FRESH_MS);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.clearTimeout(scheduled);
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [active, cache, workspaceId, days, revision]);
	return {
		...cache.getState(workspaceId, days),
		refresh: () => {
			void cache.load(workspaceId, days, true).catch(() => undefined);
		},
	};
}

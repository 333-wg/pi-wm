import { useCallback, useEffect, useRef, useState } from "react";
import type { GitDetails, GitStatus } from "@wuming/protocol";
import { workspaceApi } from "./workspace-api";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function useGitWorkspace(token: string, workspaceId: string) {
	const [status, setStatus] = useState<GitStatus>();
	const [details, setDetails] = useState<GitDetails>();
	const [statusError, setStatusError] = useState("");
	const [detailsError, setDetailsError] = useState("");
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [revision, setRevision] = useState(0);
	const mounted = useRef(false);
	const paused = useRef(false);
	const inFlight = useRef(false);
	const sequence = useRef(0);

	const refresh = useCallback(
		async (quiet = false): Promise<void> => {
			if (quiet && (paused.current || inFlight.current)) return;
			const request = ++sequence.current;
			inFlight.current = true;
			if (!quiet) setRefreshing(true);
			const [nextStatus, nextDetails] = await Promise.allSettled([
				workspaceApi.status(token, workspaceId),
				workspaceApi.gitDetails(token, workspaceId),
			]);
			// Late responses from a previous refresh or a pre-mutation snapshot must never replace current state.
			if (!mounted.current || sequence.current !== request) return;
			inFlight.current = false;
			setLoading(false);
			setRefreshing(false);
			if (nextStatus.status === "fulfilled") {
				setStatus(nextStatus.value);
				setStatusError("");
				setRevision((value) => value + 1);
			} else {
				setStatus(undefined);
				setStatusError(message(nextStatus.reason));
			}
			if (nextDetails.status === "fulfilled") {
				setDetails(nextDetails.value);
				setDetailsError("");
			} else {
				setDetails(undefined);
				setDetailsError(message(nextDetails.reason));
			}
		},
		[token, workspaceId]
	);

	const onBusyChange = useCallback((busy: boolean) => {
		paused.current = busy;
		if (busy) {
			sequence.current += 1;
			inFlight.current = false;
			setRefreshing(false);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		const refreshWhenVisible = () => {
			if (document.visibilityState === "visible") void refresh(true);
		};
		const timer = window.setInterval(refreshWhenVisible, 3000);
		window.addEventListener("focus", refreshWhenVisible);
		document.addEventListener("visibilitychange", refreshWhenVisible);
		return () => {
			mounted.current = false;
			sequence.current += 1;
			inFlight.current = false;
			window.clearInterval(timer);
			window.removeEventListener("focus", refreshWhenVisible);
			document.removeEventListener("visibilitychange", refreshWhenVisible);
		};
	}, [refresh]);

	return { status, details, statusError, detailsError, loading, refreshing, revision, refresh, onBusyChange };
}

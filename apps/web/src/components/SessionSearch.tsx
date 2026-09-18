import { useT } from "../lib/locale.js";
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { SessionSearchMatch } from "@wuming/protocol";
import "./task-observability.css";

export type SearchSessions = (
	workspaceId: string,
	query: string,
	archived: boolean
) => Promise<{
	matches: SessionSearchMatch[];
	truncated: boolean;
}>;

export function SessionSearch({
	workspaceId,
	archived,
	disabled,
	search,
	onOpen,
}: {
	workspaceId?: string;
	archived: boolean;
	disabled: boolean;
	search: SearchSessions;
	onOpen: (sessionId: string, messageId: string) => Promise<void>;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [matches, setMatches] = useState<SessionSearchMatch[]>([]);
	const [truncated, setTruncated] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const generation = useRef(0);
	useEffect(() => {
		const current = ++generation.current;
		setMatches([]);
		setError("");
		setTruncated(false);
		setBusy(Boolean(query.trim() && workspaceId && !disabled));
		if (!query.trim() || !workspaceId || disabled) return;
		const timer = setTimeout(() => {
			void search(workspaceId, query.trim(), archived)
				.then((result) => {
					if (generation.current !== current) return;
					setMatches(result.matches);
					setTruncated(result.truncated);
				})
				.catch((cause) => {
					if (generation.current === current) setError(cause instanceof Error ? cause.message : String(cause));
				})
				.finally(() => {
					if (generation.current === current) setBusy(false);
				});
		}, 250);
		return () => {
			clearTimeout(timer);
			generation.current++;
		};
	}, [workspaceId, query, archived, disabled, search]);
	return (
		<section className="session-search" aria-label={t("searchConversations")}>
			<div className="session-search-field">
				<Search size={13} aria-hidden="true" />
				<input
					aria-label={t("searchMessages")}
					placeholder={t("searchMessages")}
					value={query}
					maxLength={200}
					disabled={disabled}
					onChange={(event) => setQuery(event.target.value)}
				/>
				{query && (
					<button type="button" title={t("clearSearch")} aria-label={t("clearSearch")} onClick={() => setQuery("")}>
						<X size={13} />
					</button>
				)}
			</div>
			{query.trim() && (
				<div className="session-search-results" aria-busy={busy}>
					{busy ? (
						<div className="session-search-status" role="status">
							{t("searching")}
						</div>
					) : error ? (
						<div className="session-search-status" role="alert">
							{error}
						</div>
					) : matches.length === 0 ? (
						<div className="session-search-status" role="status">
							{t("noMatchingMessages")}
						</div>
					) : (
						matches.map((match) => (
							<button
								type="button"
								className="session-search-hit"
								key={`${match.sessionId}:${match.messageId}`}
								onClick={() => {
									void onOpen(match.sessionId, match.messageId).catch((cause) => setError(String(cause)));
								}}
							>
								<strong>{match.sessionName || t("unnamedChat")}</strong>
								<span>
									{match.snippet.slice(0, match.highlightStart)}
									<mark>{match.snippet.slice(match.highlightStart, match.highlightEnd)}</mark>
									{match.snippet.slice(match.highlightEnd)}
								</span>
								<small>
									{match.role === "user" ? t("you") : t("assistant")} · {new Date(match.createdAt).toLocaleDateString()}
								</small>
							</button>
						))
					)}
					{truncated && <div className="session-search-status">{t("searchTruncated")}</div>}
				</div>
			)}
		</section>
	);
}

import { useT } from "../lib/locale.js";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { sessionUsageRequests, type RunSummary, type SessionSnapshot } from "@wuming/protocol";
import { diagnoseRun, diagnosticReport } from "../lib/run-diagnostics";
import "./task-observability.css";

function elapsed(start?: number, end?: number) {
	return start === undefined || end === undefined ? "--" : `${(Math.max(0, end - start) / 1000).toFixed(1)}s`;
}

export function RunDiagnostics({ snapshot, runs }: { snapshot: SessionSnapshot; runs: RunSummary[] }) {
	const t = useT();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (snapshot.session.phase !== "turn") return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [snapshot.session.phase]);
	const diagnosis = diagnoseRun(snapshot, runs, t);
	const requests = sessionUsageRequests(snapshot).slice(-10).reverse();
	const pending = snapshot.session.phase === "turn" && requests[0]?.status === "pending" ? requests[0] : undefined;
	const download = () => {
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(diagnosticReport(snapshot, runs), null, 2)], { type: "application/json" })
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = "pi-wm-diagnostics.json";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
	return (
		<section className="rail-section run-diagnostics" aria-label={t("runDiagnostics")}>
			<div className="rail-section-heading">
				<h2>{t("runDiagnostics")}</h2>
				<button
					type="button"
					className="rail-icon-button"
					onClick={download}
					title={t("exportDiagnosticsHint")}
					aria-label={t("exportDiagnostics")}
				>
					<Download size={14} />
				</button>
			</div>
			<p className={diagnosis.attention ? "diagnosis-attention" : ""}>
				{diagnosis.label}
				{pending && ` · ${elapsed(pending.startedAt, now)}`}
			</p>
			{diagnosis.toolName && <code className="diagnosis-tool">{diagnosis.toolName}</code>}
			{requests.length > 0 && (
				<details className="request-history">
					<summary>{t("recentRequests")}</summary>
					<div className="request-table">
						<table>
							<thead>
								<tr>
									<th>{t("status")}</th>
									<th>{t("firstContent")}</th>
									<th>{t("totalDuration")}</th>
								</tr>
							</thead>
							<tbody>
								{requests.map((request) => (
									<tr key={request.requestId} title={`${request.model.provider}/${request.model.id}`}>
										<td>
											{request.status === "error"
												? t("statusFailed")
												: request.status === "aborted"
													? t("interrupted")
													: request.status === "complete"
														? t("complete")
														: request.status === "pending"
															? request === pending
																? t("inProgress")
																: t("unfinished")
															: t("unrecorded")}
										</td>
										<td>{elapsed(request.startedAt, request.firstContentAt)}</td>
										<td>{elapsed(request.startedAt, request === pending ? now : request.finishedAt)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</details>
			)}
		</section>
	);
}

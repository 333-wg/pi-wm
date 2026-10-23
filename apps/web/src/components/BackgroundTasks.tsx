import { useEffect, useState } from "react";
import { Check, CircleAlert, LoaderCircle, Square, X } from "lucide-react";
import type { BackgroundTask } from "@wuming/protocol";
import { useT } from "../lib/locale.js";
import "./background-tasks.css";

export function BackgroundTaskPanel({
	tasks,
	onCancel,
}: {
	tasks: BackgroundTask[];
	onCancel: (id: string) => Promise<void>;
}) {
	const t = useT();
	const labels = {
		running: t("backgroundRunning"),
		completed: t("backgroundCompleted"),
		failed: t("backgroundFailed"),
		cancelled: t("backgroundCancelled"),
		interrupted: t("backgroundInterrupted"),
	};
	const [now, setNow] = useState(Date.now);
	const [busy, setBusy] = useState<string[]>([]);
	const [error, setError] = useState("");
	const running = tasks.some((task) => task.status === "running");
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	// This is a live-progress panel above the composer, not a task-history list.
	// Keep terminal results in the runtime journal without pinning them here.
	const visible = tasks.filter((task) => task.status === "running");
	if (!visible.length) return null;
	return (
		<section className="background-tasks" aria-label={t("backgroundTasks")}>
			{visible.map((task) => {
				const seconds = Math.max(0, Math.floor(((task.finishedAt ?? now) - task.startedAt) / 1000));
				const Icon =
					task.status === "running"
						? LoaderCircle
						: task.status === "completed"
							? Check
							: task.status === "cancelled"
								? X
								: CircleAlert;
				return (
					<div className={`background-task background-task-${task.status}`} key={task.id}>
						<details>
							<summary>
								<Icon size={14} aria-hidden="true" />
								<span className="background-task-label">{task.label}</span>
								<span className="background-task-status">
									{labels[task.status]} · {seconds}s
								</span>
							</summary>
							<pre>{task.preview || task.toolName}</pre>
						</details>
						{task.status === "running" && (
							<button
								type="button"
								className="background-task-stop"
								aria-label={`${t("stopTask")} ${task.label}`}
								title={t("stopTask")}
								disabled={busy.includes(task.id)}
								onClick={() => {
									setBusy((value) => [...value, task.id]);
									setError("");
									void onCancel(task.id)
										.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
										.finally(() => setBusy((value) => value.filter((id) => id !== task.id)));
								}}
							>
								<Square size={13} />
							</button>
						)}
					</div>
				);
			})}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}

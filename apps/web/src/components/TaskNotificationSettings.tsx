import { useState } from "react";

export function TaskNotificationSettings() {
	const [enabled, setEnabled] = useState(() => localStorage.getItem("wuming.taskNotifications") !== "false");
	if (!window.wumingDesktop?.notifications) return null;
	return (
		<label className="task-notification-setting">
			<span>后台任务通知</span>
			<input
				type="checkbox"
				role="switch"
				checked={enabled}
				aria-label="后台任务通知"
				onChange={(event) => {
					setEnabled(event.target.checked);
					localStorage.setItem("wuming.taskNotifications", String(event.target.checked));
				}}
			/>
		</label>
	);
}

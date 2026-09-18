const messages = {
	completed: "任务已完成",
	failed: "任务执行失败",
	approval: "任务等待批准",
};

export function validTaskNotification(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => ["id", "sessionId", "workspaceId", "kind"].includes(key)) &&
		[value.id, value.sessionId, value.workspaceId].every(
			(id) => typeof id === "string" && id.length > 0 && id.length <= 200
		) &&
		Object.hasOwn(messages, value.kind)
	);
}

export class TaskNotifications {
	seen = new Set();
	active = new Map();
	constructor({ Notification, foreground, onOpen }) {
		this.Notification = Notification;
		this.foreground = foreground;
		this.onOpen = onOpen;
	}

	show(value) {
		if (!validTaskNotification(value)) throw new Error("Invalid task notification");
		if (this.seen.has(value.id)) return false;
		this.seen.add(value.id);
		if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
		if (this.foreground() || !this.Notification.isSupported()) return false;
		const key = `${value.sessionId}:${value.kind}`;
		this.active.get(key)?.close();
		if (this.active.size >= 20) return false;
		const notification = new this.Notification({ title: "Pi-Wm", body: messages[value.kind] });
		this.active.set(key, notification);
		const cleanup = () => {
			if (this.active.get(key) === notification) this.active.delete(key);
		};
		notification.on("click", () => {
			cleanup();
			this.onOpen({ sessionId: value.sessionId, workspaceId: value.workspaceId });
		});
		notification.on("close", cleanup);
		notification.on("failed", cleanup);
		notification.show();
		return true;
	}
}

/** A stop may wait briefly for reconnect, but must never be sent after expiry. */
export async function waitForStopConnection<T>(
	current: () => T | undefined,
	isCurrent: () => boolean,
	timeoutMs = 8_000
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (!isCurrent()) throw new Error("会话或登录状态已变化，请在目标会话中重新停止");
		if (Date.now() >= deadline) throw new Error("网关仍未连接，停止请求尚未送达，请重试");
		const connection = current();
		if (connection) return connection;
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
	}
}

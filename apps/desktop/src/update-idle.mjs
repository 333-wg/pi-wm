// Background polling can overlap the idle check without any user work running.
export async function waitForUpdateIdle(readStatus, wait = () => new Promise((resolve) => setTimeout(resolve, 100))) {
	for (let attempt = 0; ; attempt++) {
		const status = await readStatus();
		const persistent = ["shuttingDown", "recovering", "terminals", "running", "queued", "goals"].some(
			(key) => (status.activity?.[key] ?? 0) > 0
		);
		if (!status.busy || persistent || attempt === 15) return status;
		await wait();
	}
}

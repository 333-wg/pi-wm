// Confirmation is followed by an atomic service-side idle check and shutdown gate.
export async function installDesktopUpdate({ updates, host, confirm, install }) {
	if (updates.installPending || updates.state.status !== "ready") return updates.snapshot();
	updates.installPending = true;
	try {
		const status = await host.updateStatus();
		if (status.busy) {
			updates.patch({ busy: true, error: "busy" });
			return updates.snapshot();
		}
		if (!(await confirm())) return updates.snapshot();
		const prepared = await host.updateStatus(true);
		if (prepared.busy) {
			updates.patch({ busy: true, error: "busy" });
			return updates.snapshot();
		}
		updates.patch({ status: "installing", busy: false, error: undefined });
		await host.stop();
		// Windows hands off to the installer's visible progress page; other platforms are unchanged.
		await install(updates.state.platform !== "win32", true);
	} catch {
		const installing = updates.state.status === "installing";
		updates.patch({ status: installing ? "error" : "ready", error: installing ? "install" : "service" });
	} finally {
		updates.installPending = false;
	}
	return updates.snapshot();
}

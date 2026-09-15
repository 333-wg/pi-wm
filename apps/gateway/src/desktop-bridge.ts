import { randomUUID } from "node:crypto";
import type { LocalProjectSelection } from "./local-picker.js";

/** Only the private parent IPC channel can select paths or manage the host. */
export function createDesktopBridge() {
	if (process.env.WUMING_DESKTOP !== "true") return undefined;
	if (!process.send || !process.connected) throw new Error("Desktop host requires a parent IPC channel");
	let stopping = false;
	let shutdown: (() => void) | undefined;
	const pending = new Map<string, (selection?: LocalProjectSelection) => void>();
	const stop = () => {
		if (stopping) return;
		stopping = true;
		setTimeout(() => process.exit(1), 10_000).unref();
		for (const resolve of pending.values()) resolve();
		pending.clear();
		shutdown?.();
	};
	process.on("disconnect", stop);
	process.on("message", (value: unknown) => {
		if (!value || typeof value !== "object") return;
		const message = value as { type?: string; id?: string; selection?: LocalProjectSelection };
		if (message.type === "desktop.shutdown") stop();
		if (message.type === "desktop.pick.result" && typeof message.id === "string") {
			const selection = message.selection;
			pending.get(message.id)?.(
				selection && typeof selection.path === "string" && ["file", "directory"].includes(selection.kind)
					? selection
					: undefined
			);
		}
	});
	return {
		onShutdown(callback: () => void) {
			shutdown = callback;
			if (stopping) callback();
		},
		ready(port: number) {
			if (process.connected && !stopping) process.send?.({ type: "desktop.ready", port });
		},
		async pickProject(kind?: "file" | "directory"): Promise<LocalProjectSelection> {
			if (stopping || !process.connected) throw new Error("Desktop host disconnected");
			if (pending.size) throw Object.assign(new Error("A project picker is already open"), { httpStatus: 409 });
			const id = randomUUID();
			const result = await new Promise<LocalProjectSelection | undefined>((resolve) => {
				const timer = setTimeout(() => finish(), 5 * 60_000);
				const finish = (selection?: LocalProjectSelection) => {
					clearTimeout(timer);
					pending.delete(id);
					resolve(selection);
				};
				pending.set(id, finish);
				process.send?.({ type: "desktop.pick", id, kind }, (error) => {
					if (error) finish();
				});
			});
			if (!result) throw Object.assign(new Error("Project selection was cancelled"), { httpStatus: 400 });
			return result;
		},
	};
}

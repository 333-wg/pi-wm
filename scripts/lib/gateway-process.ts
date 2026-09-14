import type { ChildProcess } from "node:child_process";

export async function stopGateway(child: ChildProcess, graceMs = 5_000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	await new Promise<void>((resolveStop, reject) => {
		const cleanup = () => {
			clearTimeout(forceTimer);
			clearTimeout(deadline);
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
		};
		const onExit = () => {
			cleanup();
			resolveStop();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const forceTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
		const deadline = setTimeout(() => {
			cleanup();
			reject(new Error("Gateway termination could not be confirmed"));
		}, graceMs + 5_000);
		child.once("exit", onExit);
		child.once("error", onError);
		child.kill("SIGTERM");
	});
}

/** Failure owns child cleanup, including failures before the caller receives a handle. */
export async function waitForGatewayPort(child: ChildProcess, timeoutMs = 30_000): Promise<number> {
	try {
		return await new Promise<number>((resolvePort, reject) => {
			let pending = "";
			const cleanup = () => {
				clearTimeout(timer);
				child.stdout?.removeListener("data", onData);
				child.removeListener("exit", onExit);
				child.removeListener("error", onError);
			};
			const fail = (error: Error) => {
				cleanup();
				reject(error);
			};
			const onExit = () => fail(new Error("Gateway exited before readiness"));
			const onError = () => fail(new Error("Gateway process could not be started"));
			const onData = (chunk: Buffer | string) => {
				pending += String(chunk);
				let end: number;
				while ((end = pending.indexOf("\n")) >= 0) {
					const line = pending.slice(0, end).trim();
					pending = pending.slice(end + 1);
					const match = /^Wuming gateway listening on http:\/\/127\.0\.0\.1:(\d+)$/.exec(line);
					if (!match) continue;
					const port = Number(match[1]);
					if (port < 1 || port > 65535) {
						fail(new Error("Gateway reported an invalid port"));
						return;
					}
					cleanup();
					resolvePort(port);
					return;
				}
				// Never retain or print credentials accidentally logged at startup.
				pending = pending.slice(-4096);
			};
			const timer = setTimeout(() => fail(new Error("Gateway startup timed out")), timeoutMs);
			child.stdout?.on("data", onData);
			child.once("exit", onExit);
			child.once("error", onError);
			if (child.exitCode !== null || child.signalCode !== null) onExit();
		});
	} catch (error) {
		await stopGateway(child);
		throw error;
	}
}

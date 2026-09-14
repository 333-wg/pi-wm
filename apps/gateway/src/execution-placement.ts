export type DeploymentMode = "local_device" | "server";
export type ProcessMode = "local" | "docker" | "disabled";
export type TerminalMode = "host" | "docker" | "disabled";

export interface ExecutionPlacementOptions {
	host: string;
	deploymentMode?: string;
	processMode?: string;
	terminalMode?: string;
	previewEnabled?: boolean;
}

export interface ExecutionPlacement {
	deploymentMode: DeploymentMode;
	processMode: ProcessMode;
	terminalMode: TerminalMode;
	previewEnabled: boolean;
}

export function isLoopbackHost(host: string): boolean {
	const normalized = host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	return (
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "0:0:0:0:0:0:0:1" ||
		/^127(?:\.\d{1,3}){3}$/.test(normalized)
	);
}

function deploymentMode(value: string | undefined, host: string): DeploymentMode {
	if (value === undefined) return "server";
	if (value !== "local_device" && value !== "server")
		throw new Error("WUMING_DEPLOYMENT_MODE must be local_device or server");
	if (value === "local_device" && !isLoopbackHost(host)) {
		throw new Error("local_device mode must bind WUMING_HOST to loopback (127.0.0.1, localhost, or ::1)");
	}
	return value;
}

function processMode(value: string | undefined, mode: DeploymentMode): ProcessMode {
	if (value === undefined) return mode === "local_device" ? "local" : "disabled";
	if (value !== "local" && value !== "docker" && value !== "disabled")
		throw new Error("WUMING_PROCESS_MODE must be local, docker, or disabled");
	if (mode === "server" && value === "local") {
		throw new Error(
			"WUMING_PROCESS_MODE=local is forbidden in server mode because it would execute on the server, not the user device"
		);
	}
	return value;
}

function terminalMode(value: string | undefined, mode: DeploymentMode): TerminalMode {
	if (value === undefined) return mode === "local_device" ? "host" : "disabled";
	if (value !== "host" && value !== "docker" && value !== "disabled")
		throw new Error("WUMING_TERMINAL_MODE must be host, docker, or disabled");
	if (mode === "server" && value === "host") {
		throw new Error("WUMING_TERMINAL_MODE=host is forbidden in server mode because it would expose the server shell");
	}
	return value;
}

export function resolveExecutionPlacement(options: ExecutionPlacementOptions): ExecutionPlacement {
	const resolvedDeploymentMode = deploymentMode(options.deploymentMode, options.host);
	const resolvedPreviewEnabled = options.previewEnabled ?? resolvedDeploymentMode === "local_device";
	if (resolvedDeploymentMode === "server" && resolvedPreviewEnabled) {
		throw new Error("WUMING_PREVIEW_ENABLED=true is forbidden in server mode because previews run on the Gateway host");
	}
	return {
		deploymentMode: resolvedDeploymentMode,
		processMode: processMode(options.processMode, resolvedDeploymentMode),
		terminalMode: terminalMode(options.terminalMode, resolvedDeploymentMode),
		previewEnabled: resolvedPreviewEnabled,
	};
}

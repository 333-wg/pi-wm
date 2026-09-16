export interface DesktopConnection {
	token: string;
	websocketUrl: string;
}

export interface DesktopUpdateState {
	revision: number;
	status: "disabled" | "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "installing" | "error";
	disabledReason?: "development" | "platform" | "unconfigured";
	currentVersion: string;
	platform: string;
	arch: string;
	repository?: string;
	nextVersion?: string;
	releaseNotes?: string;
	releaseDate?: string;
	lastCheckedAt?: number;
	autoCheck: boolean;
	deferredUntil: number;
	progress: number;
	transferred?: number;
	total?: number;
	bytesPerSecond?: number;
	busy?: boolean;
	activityUnknown?: boolean;
	error?: "network" | "busy" | "service" | "install";
}

export type DesktopUpdateAction =
	"state" | "check" | "download" | "cancel" | "defer" | "auto-check" | "install" | "restart" | "activity";

declare global {
	interface Window {
		wumingDesktop?: {
			connect(): Promise<DesktopConnection>;
			windowChrome?: boolean;
			openMenu?(): Promise<void>;
			setWindowTheme?(theme: "light" | "dark"): Promise<void>;
			updates?: {
				invoke(action: DesktopUpdateAction, value?: boolean): Promise<DesktopUpdateState>;
				onState(callback: (state: DesktopUpdateState) => void): () => void;
				onOpen(callback: () => void): () => void;
			};
		};
	}
}

let connection: DesktopConnection | undefined;

export async function initializeDesktopConnection(): Promise<void> {
	if (!window.wumingDesktop) return;
	connection = await window.wumingDesktop.connect();
	localStorage.removeItem("wuming.token");
}

export function desktopConnection(): DesktopConnection | undefined {
	return connection;
}

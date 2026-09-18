export interface DesktopConnection {
	token: string;
	websocketUrl: string;
}

export interface BrowserTabState {
	id: string;
	url: string;
	title: string;
	loading: boolean;
	error?: string;
	canGoBack: boolean;
	canGoForward: boolean;
	zoom: number;
}

export interface BrowserState {
	workspaceId: string;
	sessionId: string;
	revision: number;
	activeId?: string;
	tabs: BrowserTabState[];
}

export interface BrowserRequest {
	workspaceId: string;
	sessionId: string;
	action:
		| "state"
		| "open"
		| "hide"
		| "activate"
		| "close"
		| "navigate"
		| "back"
		| "forward"
		| "reload"
		| "stop"
		| "zoom"
		| "devtools"
		| "external"
		| "bounds";
	tabId?: string | undefined;
	url?: string | undefined;
	zoom?: number;
	bounds?: { x: number; y: number; width: number; height: number };
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
	error?:
		| "network"
		| "timeout"
		| "no-release"
		| "metadata"
		| "integrity"
		| "disk"
		| "permission"
		| "rate-limit"
		| "access"
		| "busy"
		| "service"
		| "install";
	retryAction?: "check" | "download" | "restart";
}

export type DesktopUpdateAction =
	"state" | "check" | "download" | "cancel" | "defer" | "auto-check" | "install" | "restart" | "activity";

declare global {
	interface Window {
		wumingDesktop?: {
			browser?: {
				invoke(request: BrowserRequest): Promise<BrowserState>;
				onFocusAddress(callback: (owner: { workspaceId: string; sessionId: string }) => void): () => void;
				onState(callback: (state: BrowserState) => void): () => void;
			};
			connect(): Promise<DesktopConnection>;
			windowChrome?: boolean;
			openMenu?(): Promise<void>;
			setWindowTheme?(theme: "light" | "dark"): Promise<void>;
			notifications?: {
				show(value: {
					id: string;
					sessionId: string;
					workspaceId: string;
					kind: "completed" | "failed" | "approval";
				}): Promise<boolean>;
				onOpen(callback: (target: { sessionId: string; workspaceId: string }) => void): () => void;
			};
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

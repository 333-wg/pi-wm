export interface DesktopConnection {
	token: string;
	websocketUrl: string;
}

declare global {
	interface Window {
		wumingDesktop?: { connect(): Promise<DesktopConnection> };
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

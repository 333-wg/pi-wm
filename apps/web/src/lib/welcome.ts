export const DESKTOP_WELCOME_KEY = "wuming.desktop.welcome.complete";

// This first-use UI gate does not replace the desktop's random gateway token.
export function isDesktopWelcomePassword(value: string): boolean {
	return value === "wuming";
}

export function readDesktopWelcome(storage: Pick<Storage, "getItem"> | undefined): boolean {
	try {
		return storage?.getItem(DESKTOP_WELCOME_KEY) === "true";
	} catch {
		return false;
	}
}

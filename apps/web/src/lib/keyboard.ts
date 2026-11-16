/** The platform-specific label for the primary shortcut modifier. */
export function modifierLabel(): string {
	return /mac|iphone|ipad|ipod/i.test(navigator.userAgent) ? "⌘" : "Ctrl";
}

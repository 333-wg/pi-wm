export const OPEN_BROWSER_EVENT = "wuming:open-browser";

export function previewUrl(toolName: string, input: unknown): string | undefined {
	if (
		toolName !== "preview_start" ||
		!input ||
		typeof input !== "object" ||
		!("url" in input) ||
		typeof input.url !== "string"
	)
		return;
	try {
		const url = new URL(input.url);
		if (
			["http:", "https:"].includes(url.protocol) &&
			["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
			!url.username &&
			!url.password
		)
			return url.href;
	} catch {
		/* Invalid tool input is not a navigable preview. */
	}
}

export function openBrowserPreview(url: string): void {
	window.dispatchEvent(new CustomEvent(OPEN_BROWSER_EVENT, { detail: { url } }));
}

import type { CSSProperties } from "react";

export const CHAT_APPEARANCE_KEY = "wuming.chatAppearance";
export const CHAT_FONTS = ["system", "sans", "serif", "mono"] as const;
export const CHAT_WIDTHS = ["standard", "wide", "full"] as const;
export type ChatAppearance = {
	font: (typeof CHAT_FONTS)[number];
	fontSize: number;
	width: (typeof CHAT_WIDTHS)[number];
};
export const DEFAULT_CHAT_APPEARANCE: ChatAppearance = { font: "system", fontSize: 14, width: "standard" };
const fonts: Record<ChatAppearance["font"], string> = {
	system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
	sans: 'Arial, "Helvetica Neue", "Noto Sans SC", "Microsoft YaHei", sans-serif',
	serif: 'Georgia, "Noto Serif SC", "Songti SC", SimSun, serif',
	mono: 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace',
};

export function normalizeChatAppearance(value: unknown): ChatAppearance {
	const input = value && typeof value === "object" ? (value as Partial<ChatAppearance>) : {};
	return {
		font: CHAT_FONTS.includes(input.font!) ? input.font! : DEFAULT_CHAT_APPEARANCE.font,
		fontSize:
			typeof input.fontSize === "number" && Number.isFinite(input.fontSize)
				? Math.min(24, Math.max(12, Math.round(input.fontSize)))
				: DEFAULT_CHAT_APPEARANCE.fontSize,
		width: CHAT_WIDTHS.includes(input.width!) ? input.width! : DEFAULT_CHAT_APPEARANCE.width,
	};
}

export function readChatAppearance(storage?: Pick<Storage, "getItem">): ChatAppearance {
	try {
		return normalizeChatAppearance(JSON.parse(storage?.getItem(CHAT_APPEARANCE_KEY) ?? "null"));
	} catch {
		return { ...DEFAULT_CHAT_APPEARANCE };
	}
}

export function writeChatAppearance(storage: Pick<Storage, "setItem"> | undefined, value: ChatAppearance): boolean {
	try {
		if (!storage) return false;
		storage.setItem(CHAT_APPEARANCE_KEY, JSON.stringify(normalizeChatAppearance(value)));
		return true;
	} catch {
		return false;
	}
}

export function chatAppearanceStyle(value: ChatAppearance): CSSProperties {
	return {
		"--chat-font": fonts[value.font],
		"--chat-font-size": `${value.fontSize}px`,
		"--chat-width": { standard: "820px", wide: "1100px", full: "100%" }[value.width],
		"--chat-preview-width": { standard: "72%", wide: "90%", full: "100%" }[value.width],
	} as CSSProperties;
}

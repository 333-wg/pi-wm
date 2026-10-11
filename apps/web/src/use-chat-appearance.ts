import { useEffect, useState } from "react";
import {
	CHAT_APPEARANCE_KEY,
	normalizeChatAppearance,
	readChatAppearance,
	writeChatAppearance,
	type ChatAppearance,
} from "./lib/chat-appearance.js";

function localStorageSlot(): Storage | undefined {
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

export function useChatAppearance() {
	const [settings, setSettings] = useState(() => readChatAppearance(localStorageSlot()));
	const [saveFailed, setSaveFailed] = useState(false);
	useEffect(() => {
		const sync = (event: StorageEvent) => {
			if (event.storageArea !== localStorageSlot() || (event.key !== CHAT_APPEARANCE_KEY && event.key !== null)) return;
			setSettings(readChatAppearance(localStorageSlot()));
			setSaveFailed(false);
		};
		window.addEventListener("storage", sync);
		return () => window.removeEventListener("storage", sync);
	}, []);
	return {
		settings,
		saveFailed,
		update(value: ChatAppearance) {
			const next = normalizeChatAppearance(value);
			setSettings(next);
			setSaveFailed(!writeChatAppearance(localStorageSlot(), next));
		},
	};
}
export type ChatAppearanceState = ReturnType<typeof useChatAppearance>;

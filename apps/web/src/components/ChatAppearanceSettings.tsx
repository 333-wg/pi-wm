import { CHAT_FONTS, CHAT_WIDTHS, DEFAULT_CHAT_APPEARANCE, chatAppearanceStyle } from "../lib/chat-appearance.js";
import type { ChatAppearanceState } from "../use-chat-appearance.js";
import { Markdown } from "./Markdown.js";
import "./chat-appearance.css";

export function ChatAppearanceSettings({
	appearance,
	locale,
}: {
	appearance: ChatAppearanceState;
	locale: "zh" | "en";
}) {
	const zh = locale === "zh";
	const { settings, update } = appearance;
	const fontLabels = zh ? ["跟随系统", "无衬线", "衬线", "等宽"] : ["System", "Sans serif", "Serif", "Monospace"];
	const widthLabels = zh ? ["标准", "宽", "铺满"] : ["Standard", "Wide", "Full"];
	return (
		<section className="chat-appearance-settings" aria-label={zh ? "聊天外观" : "Chat appearance"}>
			<div className="chat-appearance-heading">
				<span className="settings-section-title">{zh ? "聊天外观" : "Chat appearance"}</span>
				<button type="button" onClick={() => update(DEFAULT_CHAT_APPEARANCE)}>
					{zh ? "恢复默认" : "Reset defaults"}
				</button>
			</div>
			<p className="settings-hint">
				{zh
					? "仅调整聊天正文与输入框，不改变界面缩放。自动保存在此设备的当前浏览器或桌面端，不跨设备同步。"
					: "Applies to chat text and input, independently of interface zoom. Saved in this device’s current browser or desktop app; not synced across devices."}
			</p>
			<label className="chat-appearance-control">
				<span>{zh ? "聊天字体" : "Chat font"}</span>
				<select
					value={settings.font}
					onChange={(event) => update({ ...settings, font: event.target.value as typeof settings.font })}
				>
					{CHAT_FONTS.map((font, index) => (
						<option key={font} value={font}>
							{fontLabels[index]}
						</option>
					))}
				</select>
			</label>
			<label className="chat-appearance-control">
				<span>
					{zh ? "字号" : "Font size"} <output>{settings.fontSize}px</output>
				</span>
				<input
					aria-label={zh ? "聊天字号" : "Chat font size"}
					type="range"
					min="12"
					max="24"
					step="1"
					value={settings.fontSize}
					onChange={(event) => update({ ...settings, fontSize: Number(event.target.value) })}
				/>
			</label>
			<div className="chat-appearance-control">
				<span>{zh ? "对话宽度" : "Conversation width"}</span>
				<div className="segmented" role="group" aria-label={zh ? "对话宽度" : "Conversation width"}>
					{CHAT_WIDTHS.map((width, index) => (
						<button
							key={width}
							type="button"
							className={settings.width === width ? "active" : ""}
							aria-pressed={settings.width === width}
							onClick={() => update({ ...settings, width })}
						>
							{widthLabels[index]}
						</button>
					))}
				</div>
			</div>
			<div className="chat-appearance-preview" style={chatAppearanceStyle(settings)}>
				<span className="settings-hint">{zh ? "即时预览 · 宽度为比例示意" : "Live preview · proportional width"}</span>
				<div className="chat-preview-content">
					<div className="user-message-bubble">
						<Markdown text={zh ? "你好，帮我整理一下今天的想法。" : "Hello, help me organize today’s ideas."} />
					</div>
					<Markdown
						text={
							zh
								? "### 让阅读更舒适\n选择适合你的**字体、字号与宽度**。中文与 English 都能即时预览，代码 `const hello = 1` 保持等宽。"
								: "### Make reading comfortable\nChoose your **font, size and width**. Preview English and 中文 instantly; code `const hello = 1` stays monospace."
						}
					/>
				</div>
			</div>
			{appearance.saveFailed && (
				<p role="alert">
					{zh
						? "本地保存失败，本次调整仍有效，刷新后可能恢复默认。"
						: "Could not save locally. Changes apply now but may be lost on reload."}
				</p>
			)}
		</section>
	);
}

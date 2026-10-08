import type { ContentPart, TranscriptItem } from "@wuming/protocol";
import { useState } from "react";
import { Markdown } from "./Markdown.js";

export function PhoneMessageContent({ parts, thinking }: { parts: ContentPart[]; thinking: boolean }) {
	return (
		<>
			{parts.map((part, i) => {
				if (part.type === "text") return <Markdown key={i} text={part.text} className="phone-message-text prose" />;
				if (part.type === "artifact") {
					const url = `/api/artifacts/${encodeURIComponent(part.artifact.id)}`;
					return (
						<div className="phone-artifact" key={i}>
							{/^image\/(png|jpeg|gif|webp)$/.test(part.artifact.mimeType) && (
								<img src={url} alt={part.artifact.name} loading="lazy" />
							)}
							<a href={url} download={part.artifact.name}>
								{part.artifact.name} · 下载
							</a>
						</div>
					);
				}
				if (part.type === "thinking")
					return thinking ? (
						<details key={i}>
							<summary>思考过程</summary>
							<Markdown text={part.text} />
						</details>
					) : null;
				return (
					<details key={i}>
						<summary>工具 · {part.toolName}</summary>
						<pre>{JSON.stringify(part.input, null, 2)}</pre>
					</details>
				);
			})}
		</>
	);
}
export function PhoneMessage({ item, thinking, tools }: { item: TranscriptItem; thinking: boolean; tools: boolean }) {
	const [copyState, setCopyState] = useState("复制消息");
	if (item.type === "tool" && !tools) return null;
	const text = item.content
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n");
	return (
		<article className={`phone-message ${item.type}`}>
			<strong>
				{item.type === "user"
					? "你"
					: item.type === "tool"
						? `${item.toolName} · ${item.isError ? "失败" : item.status === "complete" ? "完成" : item.status === "running" ? "执行中" : item.status}`
						: "Pi-Wm"}
			</strong>
			{item.type === "tool" ? (
				<details>
					<summary>查看工具结果{text ? ` · ${text.slice(0, 100)}` : ""}</summary>
					<pre>{JSON.stringify(item.input, null, 2)}</pre>
					<PhoneMessageContent parts={item.content} thinking={thinking} />
				</details>
			) : (
				<PhoneMessageContent parts={item.content} thinking={thinking} />
			)}
			{item.type === "assistant" && item.error && <p role="alert">{item.error}</p>}
			{item.type !== "tool" && text && (
				<button
					className="phone-copy"
					type="button"
					onClick={() => {
						void navigator.clipboard
							.writeText(text)
							.then(() => setCopyState("已复制"))
							.catch(() => setCopyState("复制失败，请长按文本"));
					}}
				>
					{copyState}
				</button>
			)}
		</article>
	);
}

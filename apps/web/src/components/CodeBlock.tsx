import { Check, Copy } from "lucide-react";
import { Fragment, memo, useCallback, useMemo, useState } from "react";
import { highlight, resolveLanguage } from "../lib/highlight";

const fileFontSizes = [10, 12, 12.5, 14, 16, 18, 20, 24];
const fileFontSizeKey = "wuming.filePreview.fontSize";
const defaultFileFontSize = 12.5;

function readFileFontSize(): number {
	try {
		const saved = Number(localStorage.getItem(fileFontSizeKey));
		return fileFontSizes.includes(saved) ? saved : defaultFileFontSize;
	} catch {
		return defaultFileFontSize;
	}
}

/**
 * A highlighted code block, memoised on the code it shows.
 *
 * This is the heaviest leaf in the transcript: one element per token, so a
 * hundred-line block is well over a thousand elements. It is also the leaf most
 * often asked to re-render for nothing — the block a model has already finished
 * keeps the same text while the message below it is still streaming, and every
 * tool card re-renders with its row. Both of the props that decide the output
 * are strings, so the default shallow comparison holds whenever the code does.
 */
export const CodeBlock = memo(function CodeBlock({
	code,
	lang = "",
	streaming = false,
	variant = "transcript",
}: {
	code: string;
	lang?: string;
	streaming?: boolean;
	variant?: "transcript" | "file";
}) {
	const [copied, setCopied] = useState(false);
	const [fileFontSize, setFileFontSize] = useState(() =>
		variant === "file" ? readFileFontSize() : defaultFileFontSize
	);
	const [fontSizeSaveFailed, setFontSizeSaveFailed] = useState(false);
	const lines = useMemo(() => highlight(code, lang), [code, lang]);
	const copy = useCallback(() => {
		if (!navigator.clipboard) return;
		void navigator.clipboard
			.writeText(code)
			.then(() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1400);
			})
			.catch(() => undefined);
	}, [code]);
	return (
		<div
			className={`code-block${streaming ? " streaming" : ""}${variant === "file" ? " code-block-file" : ""}`}
			data-language={resolveLanguage(lang) || "text"}
		>
			<div className="code-block-bar">
				<span className="code-language">
					{lang || "文本"}
					{variant === "file" && <span className="code-file-meta"> · 只读</span>}
				</span>
				{variant === "file" && (
					<label className="code-font-size">
						字号
						<select
							aria-label="文件预览字号"
							value={fileFontSize}
							onChange={(event) => {
								const size = Number(event.target.value);
								setFileFontSize(size);
								try {
									localStorage.setItem(fileFontSizeKey, String(size));
									setFontSizeSaveFailed(false);
								} catch {
									setFontSizeSaveFailed(true);
								}
							}}
						>
							{fileFontSizes.map((size) => (
								<option key={size} value={size}>
									{size} px{size === defaultFileFontSize ? "（默认）" : ""}
								</option>
							))}
						</select>
					</label>
				)}
				<button type="button" className="code-copy" onClick={copy} aria-label="复制代码">
					{copied ? <Check size={13} /> : <Copy size={13} />}
					<span>{copied ? "已复制" : "复制"}</span>
				</button>
			</div>
			{variant === "file" && fontSizeSaveFailed && (
				<div className="code-font-size-notice" role="status">
					字号已调整，但无法保存；重新打开文件后可能恢复默认。
				</div>
			)}
			<pre tabIndex={variant === "file" ? 0 : undefined} aria-label={variant === "file" ? "文件内容" : undefined}>
				<code style={variant === "file" ? { fontSize: fileFontSize } : undefined}>
					{lines.map((tokens, index) => (
						<span className="code-line" key={index}>
							{variant === "file" && <span className="code-line-number" aria-hidden="true" data-line={index + 1} />}
							{tokens.map((token, position) =>
								token.kind === "plain" ? (
									<Fragment key={position}>{token.value}</Fragment>
								) : (
									<span className={`tok tok-${token.kind}`} key={position}>
										{token.value}
									</span>
								)
							)}
							{index < lines.length - 1 ? "\n" : ""}
						</span>
					))}
				</code>
			</pre>
		</div>
	);
});

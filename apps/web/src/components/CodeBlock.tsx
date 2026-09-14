import { Check, Copy } from "lucide-react";
import { Fragment, memo, useCallback, useMemo, useState } from "react";
import { highlight, resolveLanguage } from "../lib/highlight";

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
}: {
	code: string;
	lang?: string;
	streaming?: boolean;
}) {
	const [copied, setCopied] = useState(false);
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
		<div className={`code-block${streaming ? " streaming" : ""}`} data-language={resolveLanguage(lang) || "text"}>
			<div className="code-block-bar">
				<span className="code-language">{lang || "文本"}</span>
				<button type="button" className="code-copy" onClick={copy} aria-label="复制代码">
					{copied ? <Check size={13} /> : <Copy size={13} />}
					<span>{copied ? "已复制" : "复制"}</span>
				</button>
			</div>
			<pre>
				<code>
					{lines.map((tokens, index) => (
						<span className="code-line" key={index}>
							{tokens.map((token, position) =>
								token.kind === "plain" ? (
									<Fragment key={position}>{token.value}</Fragment>
								) : (
									<span className={`tok tok-${token.kind}`} key={position}>
										{token.value}
									</span>
								)
							)}
							{"\n"}
						</span>
					))}
				</code>
			</pre>
		</div>
	);
});

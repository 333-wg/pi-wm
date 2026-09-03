import { Fragment, type ReactNode, useMemo } from "react";
import { type BlockNode, type InlineNode, parseMarkdown } from "../lib/markdown";
import { CodeBlock } from "./CodeBlock";

function renderInline(nodes: InlineNode[]): ReactNode {
	return nodes.map((node, index) => {
		switch (node.type) {
			case "text":
				return <Fragment key={index}>{node.value}</Fragment>;
			case "code":
				return (
					<code className="md-code" key={index}>
						{node.value}
					</code>
				);
			case "strong":
				return <strong key={index}>{renderInline(node.children)}</strong>;
			case "em":
				return <em key={index}>{renderInline(node.children)}</em>;
			case "del":
				return <del key={index}>{renderInline(node.children)}</del>;
			case "link":
				return (
					<a href={node.href} target="_blank" rel="noreferrer noopener" key={index}>
						{renderInline(node.children)}
					</a>
				);
			case "break":
				return <br key={index} />;
			default:
				return null;
		}
	});
}

function ListItem({ blocks, tight }: { blocks: BlockNode[]; tight: boolean }) {
	if (tight && blocks.length === 1 && blocks[0]?.type === "paragraph") {
		return <li>{renderInline(blocks[0].children)}</li>;
	}
	return (
		<li>
			<Blocks nodes={blocks} />
		</li>
	);
}

function Block({ node }: { node: BlockNode }) {
	switch (node.type) {
		case "heading": {
			const Tag = `h${Math.min(node.level + 1, 6)}` as "h2";
			return <Tag className={`md-h md-h${node.level}`}>{renderInline(node.children)}</Tag>;
		}
		case "paragraph":
			return <p>{renderInline(node.children)}</p>;
		case "code":
			return <CodeBlock code={node.text} lang={node.lang} streaming={node.open} />;
		case "hr":
			return <hr />;
		case "quote":
			return (
				<blockquote>
					<Blocks nodes={node.children} />
				</blockquote>
			);
		case "list":
			return node.ordered ? (
				<ol start={node.start} className={node.tight ? "tight" : ""}>
					{node.items.map((item, index) => (
						<ListItem blocks={item} tight={node.tight} key={index} />
					))}
				</ol>
			) : (
				<ul className={node.tight ? "tight" : ""}>
					{node.items.map((item, index) => (
						<ListItem blocks={item} tight={node.tight} key={index} />
					))}
				</ul>
			);
		case "table":
			return (
				<div className="md-table-scroll">
					<table>
						<thead>
							<tr>
								{node.head.map((cell, index) => (
									<th key={index} style={{ textAlign: node.align[index] ?? undefined }}>
										{renderInline(cell)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{node.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, index) => (
										<td key={index} style={{ textAlign: node.align[index] ?? undefined }}>
											{renderInline(cell)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		default:
			return null;
	}
}

function Blocks({ nodes }: { nodes: BlockNode[] }) {
	return (
		<>
			{nodes.map((node, index) => (
				<Block node={node} key={index} />
			))}
		</>
	);
}

export function Markdown({ text, className = "prose" }: { text: string; className?: string }) {
	const blocks = useMemo(() => parseMarkdown(text), [text]);
	return (
		<div className={className}>
			<Blocks nodes={blocks} />
		</div>
	);
}

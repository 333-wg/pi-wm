import { useMemo } from "react";
import {
	collapseContext,
	countChanges,
	diffLines,
	type DiffRow,
	parseUnifiedDiff,
} from "../lib/diff";

function DiffRows({ rows, numbered = true }: { rows: DiffRow[]; numbered?: boolean }) {
	return (
		<div className={`diff-rows${numbered ? "" : " plain"}`}>
			{rows.map((row, index) =>
				row.kind === "gap" ? (
					<div className="diff-row gap" key={index}>
						{numbered ? <span className="diff-gutter" /> : null}
						{numbered ? <span className="diff-gutter" /> : null}
						<span className="diff-marker" />
						<span className="diff-text">省略 {row.hidden} 行未更改内容</span>
					</div>
				) : (
					<div className={`diff-row ${row.kind}`} key={index}>
						{numbered ? <span className="diff-gutter">{row.oldNumber ?? ""}</span> : null}
						{numbered ? <span className="diff-gutter">{row.newNumber ?? ""}</span> : null}
						<span className="diff-marker">{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}</span>
						<span className="diff-text">{row.text || " "}</span>
					</div>
				),
			)}
		</div>
	);
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
	if (added === 0 && removed === 0) return <span className="diff-stat">无变化</span>;
	return (
		<span className="diff-stat">
			{added > 0 && <span className="diff-stat-add">+{added}</span>}
			{removed > 0 && <span className="diff-stat-del">-{removed}</span>}
		</span>
	);
}

export function EditDiff({
	before,
	after,
	context = 3,
	numbered = true,
}: {
	before: string;
	after: string;
	context?: number;
	numbered?: boolean;
}) {
	const rows = useMemo(() => collapseContext(diffLines(before, after), context), [before, after, context]);
	return <DiffRows rows={rows} numbered={numbered} />;
}

export function editDiffStat(before: string, after: string): { added: number; removed: number } {
	return countChanges(diffLines(before, after));
}

export function UnifiedDiff({ patch }: { patch: string }) {
	const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
	if (parsed.binary) return <p className="empty-hint">二进制文件差异无法显示。</p>;
	if (parsed.hunks.length === 0) return <p className="empty-hint">没有可显示的差异。</p>;
	return (
		<div className="unified-diff">
			{parsed.hunks.map((hunk, index) => (
				<div className="diff-hunk" key={index}>
					<div className="diff-hunk-header">{hunk.header}</div>
					<DiffRows rows={hunk.lines} />
				</div>
			))}
		</div>
	);
}

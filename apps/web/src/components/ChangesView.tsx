import { useEffect, useMemo, useState } from "react";
import {
	ArrowDown,
	ArrowUp,
	Check,
	Columns2,
	GitBranch,
	GitCompareArrows,
	List,
	RefreshCw,
	Search,
	WrapText,
} from "lucide-react";
import type { GitDiff } from "@wuming/protocol";
import { workspaceApi } from "../workspace-api";
import { countChanges, parseUnifiedDiff } from "../lib/diff";
import { DiffStat, UnifiedDiff } from "./DiffView";
import { GitControls } from "./GitControls";
import { useGitWorkspace } from "../use-git-workspace";

export function ChangesView(props: { token: string; workspaceId: string }) {
	return <ReviewPanel key={props.workspaceId + props.token} {...props} />;
}

function ReviewPanel({ token, workspaceId }: { token: string; workspaceId: string }) {
	const {
		status,
		details,
		statusError,
		detailsError,
		loading: statusLoading,
		refreshing,
		revision,
		refresh: refreshStatus,
		onBusyChange,
	} = useGitWorkspace(token, workspaceId);
	const [path, setPath] = useState("");
	const [staged, setStaged] = useState(false);
	const [query, setQuery] = useState("");
	const [split, setSplit] = useState(false);
	const [wrap, setWrap] = useState(false);
	const [result, setResult] = useState<{ key: string; diff: GitDiff }>();
	const [diffError, setDiffError] = useState<{ key: string; message: string }>();
	const [reviewed, setReviewed] = useState<Record<string, string>>({});
	const entries = useMemo(
		() =>
			(status?.entries ?? []).filter(
				(entry) =>
					(staged ? entry.indexStatus !== " " && entry.indexStatus !== "?" : entry.worktreeStatus !== " ") &&
					entry.path.toLowerCase().includes(query.toLowerCase())
			),
		[status, staged, query]
	);
	const selected = entries.find((entry) => entry.path === path) ?? entries[0];
	const selectedPath = selected?.path;
	const statusKey = JSON.stringify(status ?? null);
	const key = JSON.stringify([staged, selectedPath, statusKey]);
	useEffect(() => {
		let active = true;
		if (selectedPath)
			workspaceApi
				.diff(token, workspaceId, selectedPath, staged)
				.then((diff) => {
					if (active) {
						setResult({ key, diff });
						setDiffError(undefined);
					}
				})
				.catch((cause) => {
					if (active) setDiffError({ key, message: String(cause) });
				});
		return () => {
			active = false;
		};
	}, [token, workspaceId, selectedPath, staged, key, revision]);
	const diff = result?.key === key ? result.diff : undefined;
	const error = statusError || (diffError?.key === key ? diffError.message : "");
	const loading = statusLoading || Boolean(selectedPath && !diff && !error);
	const stats = useMemo(
		() => countChanges(parseUnifiedDiff(diff?.content ?? "").hunks.flatMap((hunk) => hunk.lines)),
		[diff]
	);
	const reviewKey = JSON.stringify([staged, selectedPath]);
	const viewed = Boolean(diff && !diff.truncated && reviewed[reviewKey] === diff.content);
	const index = entries.findIndex((entry) => entry.path === selectedPath);
	const workingCount = status?.entries.filter((entry) => entry.worktreeStatus !== " ").length ?? 0;
	const stagedCount =
		status?.entries.filter((entry) => entry.indexStatus !== " " && entry.indexStatus !== "?").length ?? 0;
	return (
		<section className="code-workbench review-workbench" aria-label="Git 更改">
			<aside className="workbench-sidebar">
				<div className="workbench-heading">
					<div>
						<strong>
							更改 <small>{status?.entries.length ?? 0}</small>
						</strong>
						<span>
							<GitBranch size={11} /> {status?.branch ?? "Git"}
						</span>
					</div>
					<button className="icon-button" title="刷新更改" disabled={refreshing} onClick={() => void refreshStatus()}>
						<RefreshCw size={15} />
					</button>
				</div>
				<div className="review-scope segmented" aria-label="差异范围">
					<button aria-pressed={!staged} className={!staged ? "active" : ""} onClick={() => setStaged(false)}>
						未暂存 {workingCount}
					</button>
					<button aria-pressed={staged} className={staged ? "active" : ""} onClick={() => setStaged(true)}>
						已暂存 {stagedCount}
					</button>
				</div>
				<label className="review-search">
					<Search size={14} />
					<input
						aria-label="筛选更改文件"
						placeholder="筛选文件"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>
				<div className="changes-list">
					{entries.map((entry) => (
						<button
							key={entry.path}
							title={entry.originalPath ? entry.originalPath + " → " + entry.path : entry.path}
							className={selectedPath === entry.path ? "selected" : ""}
							aria-current={selectedPath === entry.path ? "true" : undefined}
							onClick={() => setPath(entry.path)}
						>
							<span
								className={"status-code status-" + (staged ? entry.indexStatus : entry.worktreeStatus).toLowerCase()}
							>
								{entry.indexStatus === "?" ? "U" : staged ? entry.indexStatus : entry.worktreeStatus}
							</span>
							<span>{entry.path}</span>
						</button>
					))}
				</div>
				<div className="workbench-notice">
					{statusError
						? "Git 状态读取失败"
						: status && !status.isRepository
							? "当前工作区不是 Git 仓库"
							: statusLoading
								? "正在读取 Git 更改..."
								: refreshing
									? "正在刷新更改..."
									: entries.length
										? entries.length + " 个文件"
										: query
											? "没有匹配的文件"
											: staged
												? "没有已暂存更改"
												: "没有未暂存更改"}
				</div>
				{status?.truncated && <div className="workbench-notice">状态列表已截断</div>}
			</aside>
			<div className="workbench-content">
				<GitControls
					token={token}
					workspaceId={workspaceId}
					status={status}
					statusError={statusError}
					details={details}
					detailsError={detailsError}
					selected={selected}
					staged={staged}
					refresh={refreshStatus}
					onBusyChange={onBusyChange}
				/>
				<div className="editor-heading review-heading">
					<GitCompareArrows size={15} />
					<strong title={selectedPath}>{selectedPath ?? "更改"}</strong>
					{diff && <DiffStat {...stats} />}
				</div>
				<div className="review-toolbar">
					<div className="segmented" aria-label="差异布局">
						<button
							title="统一视图"
							aria-label="统一视图"
							aria-pressed={!split}
							className={!split ? "active" : ""}
							onClick={() => setSplit(false)}
						>
							<List size={15} />
						</button>
						<button
							title="并排视图"
							aria-label="并排视图"
							aria-pressed={split}
							className={split ? "active" : ""}
							onClick={() => setSplit(true)}
						>
							<Columns2 size={15} />
						</button>
					</div>
					<button
						className="icon-button"
						title="自动换行"
						aria-label="自动换行"
						aria-pressed={wrap}
						onClick={() => setWrap((value) => !value)}
					>
						<WrapText size={15} />
					</button>
					<label className="review-viewed">
						<input
							type="checkbox"
							checked={viewed}
							disabled={!diff || diff.truncated}
							onChange={() =>
								setReviewed((value) => {
									const next = { ...value };
									if (viewed) delete next[reviewKey];
									else if (diff) next[reviewKey] = diff.content;
									return next;
								})
							}
						/>
						已查看
					</label>
					<span className="review-position">
						{index < 0 ? 0 : index + 1} / {entries.length}
					</span>
					<button
						className="icon-button"
						title="上一个文件"
						disabled={index <= 0}
						onClick={() => setPath(entries[index - 1]!.path)}
					>
						<ArrowUp size={15} />
					</button>
					<button
						className="icon-button"
						title="下一个文件"
						disabled={index < 0 || index >= entries.length - 1}
						onClick={() => setPath(entries[index + 1]!.path)}
					>
						<ArrowDown size={15} />
					</button>
				</div>
				{error && (
					<div className="workbench-error review-error" role="alert">
						{error}
					</div>
				)}
				{loading && (
					<div className="workbench-empty" role="status">
						正在加载差异...
					</div>
				)}
				{!loading && !diff && !error && (
					<div className="workbench-empty changes-empty">
						<span className="changes-empty-icon">
							<Check size={22} />
						</span>
						<strong>
							{status?.isRepository === false
								? "当前工作区不是 Git 仓库"
								: query
									? "没有可显示的更改"
									: staged
										? "没有已暂存更改"
										: stagedCount
											? "更改已暂存"
											: "工作区干净"}
						</strong>
						<span>
							{status?.isRepository === false
								? "此目录尚未初始化 Git。"
								: query
									? "没有文件匹配当前筛选条件。"
									: staged
										? "暂存文件后，差异会显示在这里。"
										: "修改或新增文件后，差异会显示在这里。"}
						</span>
					</div>
				)}
				{diff && (
					<div key={key} className={"diff-scroll review-diff" + (wrap ? " review-wrap" : "")}>
						<UnifiedDiff patch={diff.content} split={split} />
						{diff.truncated && <div className="preview-truncated">差异内容已截断，无法标记为已查看</div>}
					</div>
				)}
			</div>
		</section>
	);
}

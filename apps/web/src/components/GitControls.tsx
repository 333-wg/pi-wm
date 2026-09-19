import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
	ArrowDownToLine,
	ArrowUpFromLine,
	CloudDownload,
	FolderGit2,
	GitCommitHorizontal,
	LoaderCircle,
	Minus,
	MinusSquare,
	Plus,
	PlusSquare,
	Settings2,
	ShieldCheck,
	Trash2,
	X,
} from "lucide-react";
import type { GitAction, GitDetails, GitStatus, GitStatusEntry } from "@wuming/protocol";
import { workspaceApi } from "../workspace-api";
import { useFocusTrap } from "../use-focus-trap";

function Dialog({
	title,
	busy,
	close,
	children,
}: {
	title: string;
	busy: boolean;
	close: () => void;
	children: ReactNode;
}) {
	const ref = useFocusTrap<HTMLDivElement>();
	return createPortal(
		<div
			className="git-dialog-backdrop"
			onClick={(event) => {
				if (event.target === event.currentTarget && !busy) close();
			}}
		>
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className="git-dialog"
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						if (!busy) close();
					}
				}}
			>
				<header>
					<h2>{title}</h2>
					<button className="icon-button" title="关闭" aria-label="关闭" disabled={busy} onClick={close}>
						<X size={18} />
					</button>
				</header>
				{children}
			</div>
		</div>,
		document.body
	);
}

export function GitControls({
	token,
	workspaceId,
	status,
	statusError,
	details,
	detailsError,
	selected,
	staged,
	refresh,
	onBusyChange,
}: {
	token: string;
	workspaceId: string;
	status: GitStatus | undefined;
	statusError: string;
	details: GitDetails | undefined;
	detailsError: string;
	selected: GitStatusEntry | undefined;
	staged: boolean;
	refresh: () => Promise<void>;
	onBusyChange: (busy: boolean) => void;
}) {
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const mounted = useRef(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [dialog, setDialog] = useState<"commit" | "remotes" | "push" | "pull" | "trust">();
	const [trustPath, setTrustPath] = useState("");
	const [message, setMessage] = useState("");
	const [remote, setRemote] = useState("");
	const [branch, setBranch] = useState("");
	const [remoteName, setRemoteName] = useState("origin");
	const [remoteUrl, setRemoteUrl] = useState("");
	const selectedRemote = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!details) {
			setRemote("");
			return;
		}
		setRemote((current) =>
			selectedRemote.current === current && details.remotes.some((item) => item.name === current)
				? current
				: details.upstreamRemote && details.remotes.some((item) => item.name === details.upstreamRemote)
					? details.upstreamRemote
					: (details.remotes.find((item) => item.name === "origin")?.name ?? details.remotes[0]?.name ?? "")
		);
	}, [details]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const execute = async (action: GitAction, after?: () => void) => {
		if (busyRef.current) return;
		busyRef.current = true;
		onBusyChange(true);
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const result = await workspaceApi.gitAction(token, workspaceId, action);
			if (!mounted.current) return;
			setNotice(result.message);
			after?.();
		} catch (cause) {
			if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (mounted.current) {
				await refresh();
				if (mounted.current) setBusy(false);
				onBusyChange(false);
			}
			busyRef.current = false;
		}
	};
	const canWrite = Boolean(details?.writable && details.isRepository && status?.isRepository);
	const stagedCount =
		status?.entries.filter((entry) => entry.indexStatus !== " " && entry.indexStatus !== "?").length ?? 0;
	const pending =
		status?.entries.filter((entry) =>
			staged ? entry.indexStatus !== " " && entry.indexStatus !== "?" : entry.worktreeStatus !== " "
		) ?? [];
	const paths = (entries: GitStatusEntry[]) => [
		...new Set(entries.flatMap((entry) => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])])),
	];
	const target = details?.remotes.find((item) => item.name === remote);
	const tracksSelected = Boolean(details?.upstream && details.upstreamRemote === remote);
	const openSync = (type: "push" | "pull") => {
		setBranch(
			details?.upstreamRemote === remote
				? (details.upstreamBranch ?? details.branch ?? "main")
				: (details?.branch ?? "main")
		);
		setError("");
		setDialog(type);
	};
	const close = () => setDialog(undefined);
	const feedback = (
		<>
			{error && (
				<div className="git-feedback git-failure" role="alert">
					{error}
				</div>
			)}
			{notice && (
				<div className="git-feedback" role="status">
					{notice}
				</div>
			)}
		</>
	);
	return (
		<>
			{details?.workspaceRoot && (
				<div className="git-repository-context" aria-label="仓库位置">
					<FolderGit2 size={14} aria-hidden="true" />
					<code title={details.workspaceRoot}>{details.workspaceRoot}</code>
					{details.repositoryRoot && details.repositoryRoot !== details.workspaceRoot && (
						<code title={details.repositoryRoot}>仓库：{details.repositoryRoot}</code>
					)}
				</div>
			)}
			<div className="git-commandbar" aria-label="Git 操作" aria-busy={busy}>
				<div className="git-command-group">
					{details?.trustRequired ? (
						<button
							className="git-command"
							disabled={busy}
							onClick={() => {
								setTrustPath(details.trustRequired!.path);
								setDialog("trust");
							}}
						>
							<ShieldCheck size={15} />
							信任此仓库
						</button>
					) : details?.writable && details.isRepository === false && status?.isRepository === false ? (
						<button className="git-command" disabled={busy} onClick={() => void execute({ type: "init" })}>
							<Plus size={15} />
							初始化仓库
						</button>
					) : (
						<>
							<button
								className="icon-button"
								title={staged ? "取消暂存当前文件" : "暂存当前文件"}
								aria-label={staged ? "取消暂存当前文件" : "暂存当前文件"}
								disabled={!canWrite || busy || !selected || status?.truncated}
								onClick={() =>
									selected && void execute({ type: staged ? "unstage" : "stage", paths: paths([selected]) })
								}
							>
								{staged ? <Minus size={16} /> : <Plus size={16} />}
							</button>
							<button
								className="icon-button"
								title={staged ? "取消全部暂存" : "暂存全部更改"}
								aria-label={staged ? "取消全部暂存" : "暂存全部更改"}
								disabled={!canWrite || busy || !pending.length || status?.truncated}
								onClick={() => void execute({ type: staged ? "unstage" : "stage", paths: paths(pending) })}
							>
								{staged ? <MinusSquare size={16} /> : <PlusSquare size={16} />}
							</button>
							<button
								className="git-command"
								aria-label="提交更改"
								disabled={!canWrite || busy || !stagedCount || Boolean(details?.conflicts)}
								onClick={() => {
									setError("");
									setDialog("commit");
								}}
							>
								<GitCommitHorizontal size={16} />
								提交<span>{stagedCount}</span>
							</button>
						</>
					)}
					{busy && <LoaderCircle size={15} className="git-spinner" aria-label="Git 操作进行中" />}
				</div>
				<div className="git-command-group git-remote-group">
					<select
						aria-label="远程仓库"
						value={remote}
						disabled={busy || !details?.remotes.length}
						onChange={(event) => {
							selectedRemote.current = event.target.value;
							setRemote(event.target.value);
						}}
					>
						<option value="" disabled>
							{details?.trustRequired ? "未信任" : details ? "未配置远程" : detailsError ? "读取失败" : "正在读取"}
						</option>
						{details?.remotes.map((item) => (
							<option key={item.name} value={item.name}>
								{item.name}
							</option>
						))}
					</select>
					<span
						className="git-tracking"
						title={
							tracksSelected
								? details?.upstream + "（基于最近获取）"
								: details
									? "尚未关联上游分支"
									: "尚未读取上游分支"
						}
					>
						{tracksSelected
							? "↑" + details!.ahead + " ↓" + details!.behind
							: details?.trustRequired
								? "--"
								: details
									? "未关联"
									: "--"}
					</span>
					<button
						className="icon-button"
						title="获取远程更新"
						aria-label="获取远程更新"
						disabled={!canWrite || !remote || busy}
						onClick={() => void execute({ type: "fetch", remote, branch: details?.branch ?? "main" })}
					>
						<CloudDownload size={16} />
					</button>
					<button
						className="icon-button"
						title="拉取"
						aria-label="拉取"
						disabled={!canWrite || !remote || busy || !details?.branch || !details.hasCommits}
						onClick={() => openSync("pull")}
					>
						<ArrowDownToLine size={16} />
					</button>
					<button
						className="icon-button"
						title="推送"
						aria-label="推送"
						disabled={
							!canWrite || !remote || busy || !details?.branch || !details.hasCommits || Boolean(details.conflicts)
						}
						onClick={() => openSync("push")}
					>
						<ArrowUpFromLine size={16} />
					</button>
					<button
						className="icon-button"
						title="管理远程仓库"
						aria-label="管理远程仓库"
						disabled={!canWrite || busy}
						onClick={() => {
							setError("");
							setDialog("remotes");
						}}
					>
						<Settings2 size={16} />
					</button>
				</div>
			</div>
			{target && (
				<div className="git-repository-context" aria-label="当前远程地址">
					<span>{target.name}</span>
					<code title={target.url}>{target.url}</code>
					{target.pushUrl !== target.url && <code title={target.pushUrl}>推送：{target.pushUrl}</code>}
				</div>
			)}
			{detailsError && detailsError !== statusError && (
				<div className="git-feedback git-failure" role="alert">
					{detailsError}
				</div>
			)}
			{details?.blockedReason && !details.trustRequired && <div className="git-feedback">{details.blockedReason}</div>}
			{Boolean(details?.conflicts) && (
				<div className="git-feedback git-failure" role="alert">
					{details?.conflicts} 个文件存在未解决冲突
				</div>
			)}
			{!dialog && feedback}
			{dialog && (
				<Dialog
					title={
						dialog === "commit"
							? "提交更改"
							: dialog === "remotes"
								? "远程仓库"
								: dialog === "push"
									? "推送提交"
									: dialog === "trust"
										? "信任此仓库"
										: "拉取更新"
					}
					busy={busy}
					close={close}
				>
					{dialog === "trust" && (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void execute({ type: "trust", path: trustPath }, close);
							}}
						>
							<div className="git-summary">
								<span>本地目录</span>
								<code>{trustPath}</code>
							</div>
							<p className="git-trust-warning">
								此目录属于其他系统账号。信任后，Git 将允许读取该仓库的配置，并在相关操作中执行 Git
								hooks。仅在确认仓库来源可信时继续。
							</p>
							<p className="git-trust-warning">
								仅将此目录加入当前系统用户的 Git 信任列表，不信任其他目录，也不上传或下载代码。
							</p>
							{feedback}
							<footer>
								<button type="button" className="git-command" disabled={busy} onClick={close}>
									取消
								</button>
								<button
									className="git-command git-primary"
									disabled={busy || trustPath !== details?.trustRequired?.path}
								>
									<ShieldCheck size={16} />
									{busy ? "处理中…" : "确认信任此目录"}
								</button>
							</footer>
						</form>
					)}
					{dialog === "commit" && (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void execute({ type: "commit", message }, () => {
									setMessage("");
									close();
								});
							}}
						>
							<div className="git-summary">
								<span>本地分支</span>
								<strong>{details?.branch ?? "分离 HEAD"}</strong>
								<span>已暂存</span>
								<strong>{stagedCount} 个文件</strong>
							</div>
							<label>
								提交说明
								<textarea
									aria-label="提交说明"
									value={message}
									maxLength={10000}
									rows={5}
									disabled={busy}
									onChange={(event) => setMessage(event.target.value)}
								/>
							</label>
							{feedback}
							<footer>
								<button type="button" className="git-command" disabled={busy} onClick={close}>
									取消
								</button>
								<button className="git-command git-primary" disabled={busy || !message.trim() || !stagedCount}>
									<GitCommitHorizontal size={16} />
									{busy ? "提交中…" : "提交到本地"}
								</button>
							</footer>
						</form>
					)}
					{(dialog === "push" || dialog === "pull") && (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void execute({ type: dialog, remote, branch }, close);
							}}
						>
							<div className="git-summary">
								<span>本地分支</span>
								<strong>{details?.branch}</strong>
								<span>远程仓库</span>
								<strong>{remote}</strong>
								<span>目标地址</span>
								<code>{dialog === "push" ? target?.pushUrl : target?.url}</code>
								<span>同步方式</span>
								<strong>{dialog === "push" ? "常规推送（不强制覆盖）" : "仅快进"}</strong>
							</div>
							<label>
								远程分支
								<input
									aria-label="远程分支"
									value={branch}
									maxLength={1000}
									disabled={busy}
									onChange={(event) => setBranch(event.target.value)}
								/>
							</label>
							{feedback}
							<footer>
								<button type="button" className="git-command" disabled={busy} onClick={close}>
									取消
								</button>
								<button className="git-command git-primary" disabled={busy || !branch.trim()}>
									{dialog === "push" ? <ArrowUpFromLine size={16} /> : <ArrowDownToLine size={16} />}
									{busy ? "同步中…" : dialog === "push" ? "确认推送" : "确认拉取"}
								</button>
							</footer>
						</form>
					)}
					{dialog === "remotes" && (
						<>
							<div className="git-remotes">
								{details?.remotes.map((item) => (
									<div className="git-remote-row" key={item.name}>
										<button
											disabled={busy}
											onClick={() => {
												setRemoteName(item.name);
												setRemoteUrl(item.url);
											}}
										>
											<strong>{item.name}</strong>
											<code>{item.url}</code>
											{item.pushUrl !== item.url && <code>推送：{item.pushUrl}</code>}
										</button>
										<button
											className="icon-button"
											title={"移除远程 " + item.name}
											aria-label={"移除远程 " + item.name}
											disabled={busy}
											onClick={() => {
												if (window.confirm("移除远程配置 " + item.name + "？平台仓库不会被删除。"))
													void execute({ type: "remote.remove", name: item.name });
											}}
										>
											<Trash2 size={16} />
										</button>
									</div>
								))}
							</div>
							<form
								onSubmit={(event) => {
									event.preventDefault();
									void execute({ type: "remote.save", name: remoteName.trim(), url: remoteUrl.trim() }, () => {
										selectedRemote.current = remoteName.trim();
										setRemote(remoteName.trim());
										setRemoteUrl("");
									});
								}}
							>
								<label>
									远程名称
									<input
										aria-label="远程名称"
										value={remoteName}
										maxLength={100}
										disabled={busy}
										onChange={(event) => setRemoteName(event.target.value)}
									/>
								</label>
								<label>
									仓库地址
									<input
										aria-label="仓库地址"
										placeholder="https://git.example.com/team/project.git"
										value={remoteUrl}
										maxLength={2000}
										disabled={busy}
										autoComplete="off"
										spellCheck={false}
										onChange={(event) => setRemoteUrl(event.target.value)}
									/>
								</label>
								{feedback}
								<footer>
									<button
										className="git-command git-primary"
										disabled={busy || !remoteName.trim() || !remoteUrl.trim()}
									>
										<Plus size={16} />
										{busy ? "保存中…" : "保存远程配置"}
									</button>
								</footer>
							</form>
						</>
					)}
				</Dialog>
			)}
		</>
	);
}

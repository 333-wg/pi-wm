import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, GitBranch, LoaderCircle, Plus, Search, X } from "lucide-react";
import { useGitWorkspace } from "../use-git-workspace";
import { workspaceApi } from "../workspace-api";
import { useFocusTrap } from "../use-focus-trap";
import { useLocale } from "../lib/locale";
import "./branch-picker.css";

export function BranchPicker({
	token,
	workspaceId,
	disabled,
	onBusyChange,
}: {
	token: string;
	workspaceId: string;
	disabled: boolean;
	onBusyChange: (busy: boolean) => void;
}) {
	const { locale } = useLocale();
	const en = locale === "en";
	const git = useGitWorkspace(token, workspaceId);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const anchor = useRef<HTMLButtonElement>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			onBusyChange(false);
		};
	}, [onBusyChange]);
	const branch = git.details?.branch ?? git.status?.branch;
	const label = branch ?? (git.details?.isRepository ? (en ? "Detached HEAD" : "分离 HEAD") : en ? "Branch" : "分支");
	const unavailable = !git.loading && !git.detailsError && !git.statusError && !git.details?.isRepository;
	if (unavailable) return null;
	return (
		<div className="branch-picker">
			<button
				ref={anchor}
				type="button"
				className="branch-picker-trigger"
				aria-label={en ? `Switch branch: ${label}` : `切换分支：${label}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={disabled || busy}
				title={label}
				onClick={() => {
					setNotice("");
					setOpen(true);
					void git.refresh();
				}}
			>
				{busy ? <LoaderCircle size={14} className="spin" /> : <GitBranch size={14} />}
				<span>{label}</span>
				<ChevronDown size={12} />
			</button>
			{notice && (
				<span className="visually-hidden" role="status">
					{notice}
				</span>
			)}
			{open && (
				<BranchMenu
					anchor={anchor.current}
					en={en}
					git={git}
					disabled={disabled}
					busy={busy}
					close={() => setOpen(false)}
					execute={async (branch, create) => {
						setBusy(true);
						onBusyChange(true);
						git.onBusyChange(true);
						let succeeded = false;
						try {
							const result = await workspaceApi.gitAction(token, workspaceId, {
								type: create ? "branch.create" : "branch.switch",
								branch,
							});
							succeeded = true;
							if (mounted.current) {
								setNotice(result.message);
								setOpen(false);
							}
						} finally {
							if (mounted.current) {
								await git.refresh();
								git.onBusyChange(false);
								setBusy(false);
								onBusyChange(false);
								if (succeeded)
									requestAnimationFrame(() => {
										if (mounted.current) anchor.current?.focus();
									});
							}
						}
					}}
				/>
			)}
		</div>
	);
}

function BranchMenu({
	anchor,
	en,
	git,
	disabled,
	busy,
	close,
	execute,
}: {
	anchor: HTMLButtonElement | null;
	en: boolean;
	git: ReturnType<typeof useGitWorkspace>;
	disabled: boolean;
	busy: boolean;
	close: () => void;
	execute: (branch: string, create: boolean) => Promise<void>;
}) {
	const ref = useFocusTrap<HTMLDivElement>();
	const [position, setPosition] = useState({ left: 12, top: 12 });
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState("");
	const running = useRef(false);
	const details = git.details;
	const branch = details?.branch ?? git.status?.branch;
	const branches = details?.branches ?? (branch ? [branch] : []);
	const matches = branches.filter((name) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
	const blocked =
		disabled ||
		busy ||
		git.loading ||
		git.refreshing ||
		!details?.writable ||
		!details?.hasCommits ||
		!!details.conflicts;
	const reason = disabled
		? en
			? "Stop the active task before changing branches."
			: "请先停止当前任务，再操作分支。"
		: (details?.blockedReason ??
			(details && !details.hasCommits
				? en
					? "Create the first commit before changing branches."
					: "请先创建首次提交，再创建或切换分支。"
				: details?.conflicts
					? en
						? "Resolve conflicts before changing branches."
						: "请先解决冲突，再操作分支。"
					: ""));
	useLayoutEffect(() => {
		const position = () => {
			if (!anchor || !ref.current) return;
			const rect = anchor.getBoundingClientRect();
			const menu = ref.current.getBoundingClientRect();
			setPosition({
				left: Math.max(12, Math.min(rect.left, window.innerWidth - menu.width - 12)),
				top: Math.max(12, Math.min(rect.top - menu.height - 8, window.innerHeight - menu.height - 12)),
			});
		};
		position();
		window.addEventListener("resize", position);
		window.addEventListener("scroll", position, true);
		return () => {
			window.removeEventListener("resize", position);
			window.removeEventListener("scroll", position, true);
		};
	}, [anchor, ref, creating, error, reason, git.detailsError, git.statusError, branches.length]);
	const run = async (target: string, create: boolean) => {
		if (blocked || running.current) return;
		running.current = true;
		setError("");
		try {
			await execute(target, create);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			ref.current?.focus();
		} finally {
			running.current = false;
		}
	};
	return createPortal(
		<div
			className="branch-picker-overlay"
			onClick={(event) => {
				if (event.target === event.currentTarget && !busy) close();
			}}
		>
			<div
				ref={ref}
				className="branch-picker-menu"
				style={position}
				role="dialog"
				tabIndex={-1}
				aria-modal="true"
				aria-label={en ? "Branches" : "分支"}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						if (!busy) close();
					}
				}}
			>
				<header>
					<strong>{creating ? (en ? "Create a branch" : "创建新分支") : en ? "Branches" : "分支"}</strong>
					<button
						type="button"
						className="icon-button"
						disabled={busy}
						aria-label={en ? "Close branches" : "关闭分支选择"}
						onClick={close}
					>
						<X size={16} />
					</button>
				</header>
				{creating ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							event.stopPropagation();
							void run(name.trim(), true);
						}}
					>
						<label htmlFor="new-git-branch">{en ? "Branch name" : "分支名称"}</label>
						<input
							id="new-git-branch"
							value={name}
							maxLength={1000}
							disabled={busy}
							placeholder="feature/my-task"
							onChange={(event) => setName(event.target.value)}
						/>
						<p>
							{en
								? "Create from the current HEAD and keep uncommitted changes. This changes the branch for all conversations in this workspace."
								: "从当前 HEAD 创建，保留未提交改动。此操作会更改该工作区所有对话使用的分支。"}
						</p>
						<div className="branch-picker-form-actions">
							<button
								type="button"
								disabled={busy}
								onClick={() => {
									setCreating(false);
									setError("");
								}}
							>
								{en ? "Back" : "返回"}
							</button>
							<button type="submit" disabled={blocked || !name.trim()}>
								{busy ? (en ? "Creating…" : "创建中…") : en ? "Create and switch" : "创建并切换"}
							</button>
						</div>
					</form>
				) : (
					<>
						<label className="branch-picker-search">
							<Search size={16} />
							<input
								aria-label={en ? "Search branches" : "搜索分支"}
								placeholder={en ? "Search branches" : "搜索分支"}
								value={query}
								onChange={(event) => setQuery(event.target.value)}
							/>
						</label>
						<div className="branch-picker-list" aria-label={en ? "Local branches" : "本地分支"}>
							{git.loading ? (
								<p role="status">{en ? "Loading…" : "加载中…"}</p>
							) : (
								matches.map((name) => (
									<button
										type="button"
										key={name}
										disabled={blocked || name === branch}
										aria-label={en ? `Switch to ${name}` : `切换到 ${name}`}
										aria-current={name === branch ? "true" : undefined}
										onClick={() => void run(name, false)}
									>
										<GitBranch size={16} />
										<span title={name}>{name}</span>
										{name === branch && <Check size={16} />}
									</button>
								))
							)}
							{!git.loading && matches.length === 0 && <p>{en ? "No matching branches" : "没有匹配的分支"}</p>}
						</div>
						<button
							type="button"
							className="branch-picker-create"
							disabled={blocked}
							onClick={() => {
								setCreating(true);
								setName(query);
								setError("");
							}}
						>
							<Plus size={17} />
							{en ? "Create and switch to a new branch…" : "创建并切换新分支…"}
						</button>
						<p className="branch-picker-hint">
							{en
								? "Switching affects all conversations in this workspace. Uncommitted changes block switching."
								: "切换影响此工作区的所有对话；有未提交改动时将阻止切换。"}
						</p>
					</>
				)}
				{reason && <p className="branch-picker-hint">{reason}</p>}
				{(error || git.detailsError || git.statusError) && (
					<div className="branch-picker-error" role="alert">
						{error || git.detailsError || git.statusError}
					</div>
				)}
				{(git.detailsError || git.statusError) && (
					<button type="button" disabled={busy || git.refreshing} onClick={() => void git.refresh()}>
						{en ? "Retry" : "重试"}
					</button>
				)}
			</div>
		</div>,
		document.body
	);
}

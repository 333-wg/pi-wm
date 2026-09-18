import { ArrowUpCircle, Check, Download, ExternalLink, LoaderCircle, RefreshCw, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DesktopUpdateAction, DesktopUpdateState } from "../lib/desktop.js";
import { useLocale } from "../lib/locale.js";
import clover from "../assets/wuming-clover.png";
import { Markdown } from "./Markdown.js";
import "./desktop-updates.css";

const zh = {
	title: "关于与更新",
	version: "当前版本",
	check: "检查更新",
	checking: "正在检查更新",
	idle: "检查 Pi-Wm 更新",
	latest: "已是最新版本",
	available: "发现新版本",
	downloading: "正在下载更新",
	ready: "更新已准备就绪",
	installing: "正在退出并安装",
	error: "更新暂时失败",
	download: "下载更新",
	install: "重启并安装",
	restart: "重新启动 Pi-Wm",
	retry: "重试",
	later: "稍后提醒",
	laterInstall: "稍后安装",
	cancel: "取消下载",
	auto: "自动检查更新",
	notes: "更新内容",
	noNotes: "此版本未提供更新说明。",
	lastCheck: "上次检查",
	published: "发布于",
	releases: "GitHub 发布页",
	disabled: "尚未配置更新源",
	development: "开发模式下不检查或安装更新。",
	platform: "当前平台暂不支持应用内更新。",
	unconfigured: "此安装包尚未配置更新发布仓库。",
	continue: "下载期间可以继续使用。",
	restartHint: "安装需要关闭并重新启动 Pi-Wm。",
	busy: "有任务正在运行或终端仍打开，请结束任务并关闭终端后再安装。",
	unknown: "暂时无法确认任务状态，已暂停安装。",
	network: "检查或下载失败，请确认网络后重试。",
	service: "无法确认本地服务状态，请稍后重试。",
	failedInstall: "安装未能完成，请重新启动 Pi-Wm 后重试。",
	actionError: "操作失败，请稍后重试。",
	deferred: "已暂缓提醒 24 小时，仍可在此页面更新。",
	loading: "正在读取版本信息",
	refresh: "重新读取",
	stable: "稳定版",
};
const en: Record<keyof typeof zh, string> = {
	title: "About & updates",
	version: "Current version",
	check: "Check for updates",
	checking: "Checking for updates",
	idle: "Check for Pi-Wm updates",
	latest: "You're up to date",
	available: "Update available",
	downloading: "Downloading update",
	ready: "Update ready to install",
	installing: "Closing and installing",
	error: "Update failed",
	download: "Download update",
	install: "Restart & install",
	restart: "Restart Pi-Wm",
	retry: "Retry",
	later: "Remind me later",
	laterInstall: "Install later",
	cancel: "Cancel download",
	auto: "Automatically check for updates",
	notes: "Release notes",
	noNotes: "No release notes were provided.",
	lastCheck: "Last checked",
	published: "Released",
	releases: "GitHub releases",
	disabled: "Update source not configured",
	development: "Updates are disabled in development mode.",
	platform: "In-app updates are not supported on this platform.",
	unconfigured: "This build has no update repository configured.",
	continue: "You can keep working during the download.",
	restartHint: "Installation closes and restarts Pi-Wm.",
	busy: "Tasks are running or terminals are open. Finish tasks and close terminals before installing.",
	unknown: "Unable to confirm task activity. Installation is paused.",
	network: "Check or download failed. Check your connection and try again.",
	service: "Unable to confirm local service status. Please try again later.",
	failedInstall: "Installation failed. Restart Pi-Wm and try again.",
	actionError: "The action failed. Please try again.",
	deferred: "Reminders paused for 24 hours. You can still update here.",
	loading: "Reading version information",
	refresh: "Reload",
	stable: "Stable",
};
function useCopy() {
	return useLocale().locale === "en" ? en : zh;
}

export function useDesktopUpdates(onOpen: () => void) {
	const api = window.wumingDesktop?.updates;
	const [state, setState] = useState<DesktopUpdateState>();
	const [pending, setPending] = useState<DesktopUpdateAction>();
	const [failed, setFailed] = useState(false);
	const accept = useCallback((next: DesktopUpdateState) => {
		setState((current) => (!current || next.revision >= current.revision ? next : current));
	}, []);
	const invoke = useCallback(
		async (action: DesktopUpdateAction, value?: boolean) => {
			if (!api) return;
			if (action !== "activity") {
				setPending(action);
				setFailed(false);
			}
			try {
				accept(await api.invoke(action, value));
			} catch {
				if (action !== "activity") setFailed(true);
			} finally {
				setPending((current) => (current === action ? undefined : current));
			}
		},
		[api, accept]
	);
	useEffect(() => {
		if (!api) return;
		const dispose = api.onState(accept);
		const close = api.onOpen(onOpen);
		void invoke("state");
		return () => {
			dispose();
			close();
		};
	}, [api, accept, invoke, onOpen]);
	useEffect(() => {
		if (state?.status !== "ready") return;
		void invoke("activity");
		const timer = setInterval(() => void invoke("activity"), 5_000);
		return () => clearInterval(timer);
	}, [state?.status, invoke]);
	return { enabled: Boolean(api), state, pending, failed, invoke };
}

type UpdateModel = ReturnType<typeof useDesktopUpdates>;

export function DesktopUpdateNotice({ model, onOpen }: { model: UpdateModel; onOpen: () => void }) {
	const copy = useCopy();
	const state = model.state;
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!state?.deferredUntil) return;
		const timer = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, [state?.deferredUntil]);
	if (!state || !["available", "downloading", "ready"].includes(state.status)) return null;
	if (state.status !== "downloading" && state.deferredUntil > now) return null;
	return (
		<button className="desktop-update-notice" onClick={onOpen}>
			{state.status === "ready" ? <RotateCw size={16} /> : <ArrowUpCircle size={16} />}
			<span>
				{state.status === "ready" ? copy.install : state.status === "downloading" ? copy.downloading : copy.available}
				<small>{state.status === "downloading" ? Math.floor(state.progress) + "%" : "v" + state.nextVersion}</small>
			</span>
		</button>
	);
}

export function DesktopUpdateSettings({ model }: { model: UpdateModel }) {
	const copy = useCopy();
	const { locale } = useLocale();
	const { state, pending, failed, invoke } = model;
	if (!state)
		return (
			<div className="desktop-update-settings">
				<h3>{copy.title}</h3>
				<p role="status">{failed ? copy.actionError : copy.loading}</p>
				{failed && (
					<button className="secondary-button" onClick={() => void invoke("state")}>
						<RefreshCw size={15} />
						{copy.refresh}
					</button>
				)}
			</div>
		);
	const status = state.status;
	const busy = status === "checking" || status === "downloading" || status === "installing";
	const canDownload = status === "available" || (status === "error" && Boolean(state.nextVersion));
	const action =
		state.error === "install" ? "restart" : status === "ready" ? "install" : canDownload ? "download" : "check";
	const formatDate = (value: string | number) => {
		const date = new Date(value);
		return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
	};
	const description =
		status === "disabled"
			? copy[state.disabledReason ?? "unconfigured"]
			: status === "ready"
				? copy.restartHint
				: status === "downloading"
					? copy.continue
					: copy.stable;
	const error = failed
		? copy.actionError
		: state.error === "network"
			? copy.network
			: state.error === "service"
				? copy.service
				: state.error === "install"
					? copy.failedInstall
					: undefined;
	return (
		<div className="desktop-update-settings">
			<div className="settings-page-header">
				<h3>{copy.title}</h3>
			</div>
			<div className="desktop-update-product">
				<img src={clover} alt="" width={40} height={40} />
				<div>
					<strong>Pi-Wm</strong>
					<p>
						{copy.version} {state.currentVersion} · {state.platform === "win32" ? "Windows" : state.platform}{" "}
						{state.arch}
					</p>
				</div>
			</div>
			<section className="desktop-update-status" aria-label={copy.title}>
				<div className="desktop-update-heading" role="status">
					{status === "latest" ? (
						<Check size={18} />
					) : busy ? (
						<LoaderCircle className="desktop-update-spin" size={18} />
					) : (
						<ArrowUpCircle size={18} />
					)}
					<strong>
						{copy[status]}
						{status === "available" ? " " + state.nextVersion : ""}
					</strong>
				</div>
				<p>{description}</p>
				{status === "downloading" && (
					<div className="desktop-update-download">
						<progress max={100} value={state.progress} aria-label={copy.downloading} />
						<span>
							{Math.floor(state.progress)}%
							{state.total
								? " · " +
									Math.round((state.transferred ?? 0) / 1048576) +
									" / " +
									Math.round(state.total / 1048576) +
									" MB"
								: ""}
						</span>
					</div>
				)}
				<div className="desktop-update-actions">
					<button
						className="primary-button"
						disabled={status === "disabled" || busy || Boolean(pending) || (status === "ready" && state.busy !== false)}
						onClick={() => void invoke(action)}
					>
						{action === "install" ? (
							<RotateCw size={15} />
						) : action === "download" ? (
							<Download size={15} />
						) : (
							<RefreshCw size={15} />
						)}
						{busy ? copy[status] : action === "restart" ? copy.restart : status === "error" ? copy.retry : copy[action]}
					</button>
					{status === "downloading" ? (
						<button className="secondary-button" disabled={pending === "cancel"} onClick={() => void invoke("cancel")}>
							<X size={15} />
							{copy.cancel}
						</button>
					) : (
						["available", "ready"].includes(status) && (
							<button className="secondary-button" disabled={Boolean(pending)} onClick={() => void invoke("defer")}>
								{status === "ready" ? copy.laterInstall : copy.later}
							</button>
						)
					)}
				</div>
				{status === "ready" && state.busy !== false && (
					<p className="desktop-update-warning" role="status">
						{state.activityUnknown || state.busy === undefined ? copy.unknown : copy.busy}
					</p>
				)}
				{error && (
					<p className="desktop-update-error" role="alert">
						{error}
					</p>
				)}
				{state.deferredUntil > Date.now() && <p role="status">{copy.deferred}</p>}
				{state.lastCheckedAt && (
					<p className="desktop-update-last-check">
						{copy.lastCheck} {formatDate(state.lastCheckedAt)}
					</p>
				)}
			</section>
			<label className="desktop-update-preference">
				<span>{copy.auto}</span>
				<input
					type="checkbox"
					checked={state.autoCheck}
					disabled={status === "disabled" || pending === "auto-check"}
					onChange={(event) => void invoke("auto-check", event.target.checked)}
				/>
			</label>
			{state.nextVersion && (
				<details className="desktop-update-notes" open>
					<summary>
						{state.nextVersion} · {copy.notes}
					</summary>
					{state.releaseDate && (
						<p>
							{copy.published} {formatDate(state.releaseDate)}
						</p>
					)}
					{state.releaseNotes ? <Markdown text={state.releaseNotes} /> : <p>{copy.noNotes}</p>}
				</details>
			)}
			{state.repository && (
				<a
					className="desktop-update-release-link"
					href={"https://github.com/" + state.repository + "/releases"}
					target="_blank"
					rel="noreferrer"
				>
					<ExternalLink size={14} />
					{copy.releases}
				</a>
			)}
		</div>
	);
}

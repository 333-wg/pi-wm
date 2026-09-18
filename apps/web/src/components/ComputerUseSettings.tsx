import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Circle, Loader2, Monitor, RefreshCw, ShieldAlert, Square } from "lucide-react";
import { createPortal } from "react-dom";
import type { ComputerUseStatus } from "@wuming/protocol";
import { useLocale } from "../lib/locale.js";
import { useFocusTrap } from "../use-focus-trap.js";
import "./computer-use.css";

export function useComputerUse(token: string, connected: boolean, local: boolean) {
	const [state, setState] = useState<ComputerUseStatus>();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const revision = useRef(0);
	const writing = useRef(false);
	const request = useCallback(
		async (action = "", value?: boolean) => {
			const current = ++revision.current;
			const response = await fetch(`/api/computer-use${action}`, {
				method: action.startsWith("/") ? "POST" : "GET",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				...(value === undefined ? {} : { body: JSON.stringify({ enabled: value }) }),
			});
			const next = (await response.json()) as ComputerUseStatus & { error?: string };
			if (!response.ok) throw new Error(next.error ?? `Computer Use: HTTP ${response.status}`);
			if (current === revision.current) {
				setState(next);
				setError("");
			}
		},
		[token]
	);
	useEffect(() => {
		setState(undefined);
		setError("");
		if (!connected || !local) return;
		let active = true;
		const poll = async () => {
			if (writing.current) return;
			try {
				await request();
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			}
		};
		void poll();
		const timer = setInterval(() => {
			if (!document.hidden) void poll();
		}, 3000);
		return () => {
			active = false;
			revision.current++;
			clearInterval(timer);
		};
	}, [connected, local, request]);
	const invoke = useCallback(
		async (action: string, value?: boolean) => {
			writing.current = true;
			setPending(true);
			setError("");
			try {
				await request(action, value);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				writing.current = false;
				setPending(false);
			}
		},
		[request]
	);
	return { state, pending, error, invoke, connected, local };
}

type Model = ReturnType<typeof useComputerUse>;

function EnableDialog({
	en,
	settingsAuthorization,
	onClose,
	onConfirm,
}: {
	en: boolean;
	settingsAuthorization: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const ref = useFocusTrap<HTMLDialogElement>();
	useEffect(() => {
		const dialog = ref.current;
		dialog?.showModal();
		return () => dialog?.close();
	}, [ref]);
	return createPortal(
		<dialog
			ref={ref}
			className="computer-use-dialog"
			aria-labelledby="computer-consent-title"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
		>
			<ShieldAlert size={24} aria-hidden="true" />
			<h3 id="computer-consent-title">{en ? "Enable desktop control?" : "允许 Agent 控制电脑？"}</h3>
			<ul>
				<li>
					{en
						? "Window names, control content and requested screenshots will be sent to your selected model. Visible windows may contain private information."
						: "窗口名称、控件内容及请求的截图会发送给当前模型，可能包含隐私信息。"}
				</li>
				<li>
					{settingsAuthorization
						? en
							? "Full-access sessions can operate the desktop directly without extra approval. Other session modes retain their approval policy. Applications may activate their own windows."
							: "完全访问会话可直接操作桌面，不再额外申请控制审批；其他会话遵循所选审批模式。应用自身可能激活窗口。"
						: en
							? "This shared deployment still requires approval for each desktop operation."
							: "当前为共享部署，桌面操作仍需逐次审批。"}
				</li>
				<li>
					{en
						? "Missing dependencies will be downloaded from PyPI into an isolated environment. Python 3 must already be installed."
						: "缺少依赖时会从 PyPI 自动下载至隔离环境；本机需要已安装 Python 3。"}
				</li>
				<li>
					{en
						? "The setting is remembered after restart. Turning it off or using emergency stop revokes access immediately."
						: "开启状态会在重启后保留。关闭开关或紧急停止会立即撤销权限。"}
				</li>
			</ul>
			<div className="computer-use-actions">
				<button type="button" onClick={onClose}>
					{en ? "Cancel" : "取消"}
				</button>
				<button type="button" className="computer-use-confirm" onClick={onConfirm}>
					<Check size={16} />
					{en ? "Allow and enable" : "同意并开启"}
				</button>
			</div>
		</dialog>,
		document.body
	);
}

export function ComputerUseSettings({ model }: { model: Model }) {
	const en = useLocale().locale === "en";
	const { state, pending, error, invoke } = model;
	const [confirming, setConfirming] = useState(false);
	const supported = model.local && state?.supported;
	const enabled = state?.enabled ?? false;
	const starting = Boolean(state?.requestedEnabled && state.installing);
	const stages = ["checking", "creating_environment", "installing_packages"] as const;
	const stageLabels = en
		? ["Check environment", "Create isolated environment", "Install dependencies"]
		: ["检测运行环境", "创建隔离环境", "安装依赖"];
	const stageIndex = stages.indexOf(state?.setupStage ?? "checking");
	const status = !model.local
		? en
			? "Local device only"
			: "仅限本地设备"
		: !state
			? en
				? "Connecting"
				: "连接中"
			: !supported
				? en
					? "Unavailable on this platform"
					: "当前平台不可用"
				: state.installing
					? stageLabels[stageIndex]
					: enabled
						? en
							? "Enabled"
							: "已开启"
						: state.error
							? en
								? "Environment needs attention"
								: "运行环境异常"
							: en
								? "Disabled"
								: "未开启";
	return (
		<div className="computer-use-settings">
			<div className="settings-page-header">
				<h3>Computer Use</h3>
			</div>
			<div className="computer-use-setting-row">
				<div className="computer-use-heading">
					<Monitor size={22} aria-hidden="true" />
					<div>
						<label htmlFor="computer-use-enabled">{en ? "Desktop control" : "桌面控制"}</label>
						<span className="computer-use-state" role="status">
							{status}
						</span>
					</div>
				</div>
				<input
					id="computer-use-enabled"
					type="checkbox"
					role="switch"
					checked={enabled || starting}
					disabled={!model.connected || pending || !supported || Boolean(state?.installing && !starting)}
					onChange={(event) => {
						const next = event.target.checked;
						if (next) setConfirming(true);
						else void invoke("/stop");
					}}
				/>
			</div>
			{state?.installing && (
				<ol className="computer-use-progress" aria-label={en ? "Setup progress" : "安装进度"}>
					{stages.map((stage, index) => (
						<li key={stage} aria-current={index === stageIndex ? "step" : undefined}>
							{index < stageIndex ? (
								<Check size={16} />
							) : index === stageIndex ? (
								<Loader2 size={16} className="computer-use-spinner" />
							) : (
								<Circle size={16} />
							)}
							{stageLabels[index]}
						</li>
					))}
				</ol>
			)}
			<dl className="computer-use-status">
				<div>
					<dt>{en ? "Built-in skill" : "内置技能"}</dt>
					<dd>
						<code>computer-use</code>
					</dd>
				</div>
				<div>
					<dt>{en ? "Control access" : "控件授权"}</dt>
					<dd>
						{state?.authorization === "settings"
							? en
								? "Settings authorization"
								: "设置统一授权"
							: en
								? "Confirm each operation"
								: "逐次确认"}
					</dd>
				</div>
				<div>
					<dt>{en ? "Foreground input" : "前台输入"}</dt>
					<dd>
						{state?.authorization === "settings"
							? en
								? "Direct in full-access mode"
								: "完全访问直接执行"
							: en
								? "Confirm each action"
								: "单次确认"}
					</dd>
				</div>
				{state?.activity && (
					<div>
						<dt>{en ? "Active mode" : "当前模式"}</dt>
						<dd>{state.activity === "semantic" ? "UI Automation" : en ? "Real mouse and keyboard" : "真实鼠标键盘"}</dd>
					</div>
				)}
				{state?.ownerSessionId && (
					<div>
						<dt>{en ? "Active session" : "控制会话"}</dt>
						<dd>
							<code>{state.ownerSessionId}</code>
						</dd>
					</div>
				)}
			</dl>
			<details className="computer-use-environment">
				<summary>{en ? "Runtime environment" : "运行环境"}</summary>
				<dl className="computer-use-status">
					<div>
						<dt>{en ? "Platform" : "平台"}</dt>
						<dd>{state?.platform === "win32" ? "Windows" : (state?.platform ?? "-")}</dd>
					</div>
					<div>
						<dt>{en ? "Dependencies" : "依赖状态"}</dt>
						<dd>{state?.ready ? (en ? "Ready" : "已就绪") : en ? "Pending" : "待准备"}</dd>
					</div>
					<div>
						<dt>Python</dt>
						<dd>
							<code>{state?.python ?? "-"}</code>
						</dd>
					</div>
				</dl>
			</details>
			{(error || state?.error) && (
				<p className="computer-use-error" role="alert">
					{error || state?.error}
				</p>
			)}
			<div className="computer-use-actions">
				<button
					type="button"
					disabled={!supported || pending || state?.installing}
					onClick={() => void invoke("?refresh=1")}
				>
					<RefreshCw size={15} />
					{en ? "Check again" : "重新检测"}
				</button>
				<button
					type="button"
					className="computer-use-stop"
					disabled={!enabled && !state?.requestedEnabled}
					onClick={() => void invoke("/stop")}
				>
					<Square size={15} />
					{en ? "Emergency stop" : "紧急停止"}
				</button>
			</div>
			{confirming && (
				<EnableDialog
					en={en}
					settingsAuthorization={state?.authorization === "settings"}
					onClose={() => setConfirming(false)}
					onConfirm={() => {
						setConfirming(false);
						void invoke("/enable", true);
					}}
				/>
			)}
		</div>
	);
}

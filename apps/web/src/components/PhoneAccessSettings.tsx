import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { LoaderCircle, QrCode, CircleAlert } from "lucide-react";
import { PhoneAccessGuide } from "./PhoneAccessGuide.js";
import "../phone.css";

type Status = {
	configuration?: { mode: string; origin: string; port: number; executable: string };
	enabled: boolean;
	port: number | null;
	url: string | null;
	tunnel: { state: string; error?: string; stage?: string; attempt?: number; nextRetryAt?: number };
	pending: { id: string; name: string }[];
	devices: { id: string; name: string; expiresAt: number; origin: string; workbench?: boolean }[];
};
export function PhoneAccessSettings({ token }: { token: string }) {
	const [status, setStatus] = useState<Status>();
	const [mode, setMode] = useState("cloudflare");
	const [origin, setOrigin] = useState("");
	const [port, setPort] = useState("5188");
	const [executable, setExecutable] = useState("");
	const [consent, setConsent] = useState(false);
	const [workbenchGrants, setWorkbenchGrants] = useState<Record<string, boolean>>({});
	const initialized = useRef(false);
	const [busy, setBusy] = useState(false);
	const [generatingPair, setGeneratingPair] = useState(false);
	const [error, setError] = useState("");
	const [pair, setPair] = useState<{ url: string; expiresAt: number; image: string }>();
	async function api(action: string, body?: unknown) {
		const response = await fetch(`/api/phone-access/${action}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const value = await response.json();
		if (!response.ok) throw new Error(value.error ?? "手机访问请求失败");
		return value;
	}
	useEffect(() => {
		let active = true;
		const refresh = () => {
			void api("status")
				.then((value) => {
					if (active) {
						setStatus(value);
						if (!initialized.current) {
							initialized.current = true;
							if (value.configuration) {
								setMode(value.configuration.mode);
								setOrigin(value.configuration.origin);
								setPort(String(value.configuration.port || 5188));
								setExecutable(value.configuration.executable);
							}
						}
					}
				})
				.catch((e) => {
					if (active) setError(String(e.message));
				});
		};
		refresh();
		const timer = setInterval(refresh, 3000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [token]);
	async function act(action: string, input: unknown = {}) {
		setBusy(true);
		setError("");
		if (action === "pairing") {
			setGeneratingPair(true);
			setPair(undefined);
		}
		try {
			const value = await api(action, input);
			if (action === "pairing")
				setPair({ ...value, image: await QRCode.toDataURL(value.url, { width: 240, margin: 2 }) });
			else {
				setStatus(value);
				if (action === "disable" || action === "enable") setPair(undefined);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
			setGeneratingPair(false);
		}
	}
	const waitingForTunnel =
		!status?.url && (status?.tunnel.state === "connecting" || Boolean(status?.tunnel.nextRetryAt));
	const pairingHint = generatingPair
		? "正在生成一次性二维码，请稍候…"
		: !status?.url
			? waitingForTunnel
				? "隧道尚未就绪，连接成功后才能生成二维码。"
				: "隧道未连接，请检查上方错误提示后重新开启。"
			: "点击生成一次性二维码，再用手机常用浏览器扫码。";
	return (
		<div className="phone-settings">
			<div className="settings-page-header">
				<h3>手机访问</h3>
				<p>在外面继续电脑上的同一段会话。默认关闭，不会自动恢复公网连接。</p>
			</div>
			<PhoneAccessGuide />
			<div className="phone-notice">
				电脑需要开机、联网且未休眠。Windows 关闭窗口后托盘继续运行；退出 Pi-Wm
				会停止手机访问。手机可发指令和审批，任务沿用原会话的工具权限。
			</div>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			{status?.enabled ? (
				<>
					<p role="status">
						{status.url ? "手机入口已配置" : (status.tunnel.stage ?? "正在建立隧道…")} · 本机上游端口 {status.port}
					</p>
					{Boolean(status.tunnel.attempt) && (
						<small>
							本次启动已尝试 {status.tunnel.attempt} 次
							{status.tunnel.nextRetryAt
								? ` · 约 ${Math.max(0, Math.ceil((status.tunnel.nextRetryAt - Date.now()) / 1000))} 秒后重试`
								: ""}
							。连续失败最多自动重试 3 次。
						</small>
					)}
					{status.tunnel.error && <p role="alert">{status.tunnel.error}</p>}
					{status.url && (
						<>
							<p className="phone-url">{status.url}</p>
							<p className="settings-hint">
								固定域名需自行配置 HTTPS 反代，保留 Host、支持 WebSocket。显示地址不代表外网可达，请用手机蜂窝网络验证。
							</p>
						</>
					)}
					<div className="phone-actions">
						<button
							type="button"
							className={`phone-pair-trigger${status.url && !busy ? " is-ready" : ""}`}
							disabled={busy || !status.url}
							aria-busy={generatingPair}
							aria-describedby="phone-pair-hint"
							onClick={() => void act("pairing")}
						>
							{generatingPair || waitingForTunnel ? (
								<LoaderCircle className="phone-pair-spinner" size={18} aria-hidden="true" />
							) : !status.url ? (
								<CircleAlert size={18} aria-hidden="true" />
							) : (
								<QrCode size={18} aria-hidden="true" />
							)}
							<span>
								{generatingPair
									? "正在生成二维码…"
									: !status.url
										? waitingForTunnel
											? "等待隧道连接…"
											: "隧道未连接"
										: "生成配对二维码"}
							</span>
						</button>
						<button disabled={busy} onClick={() => void act("disable")}>
							关闭手机访问
						</button>
					</div>
					<p id="phone-pair-hint" className="settings-hint" role="status">
						{pairingHint}
					</p>
					{pair && pair.expiresAt > Date.now() && pair.url.startsWith(`${status.url}#`) && (
						<div className="phone-pair" key={pair.expiresAt}>
							<div className="phone-pair-frame">
								<img src={pair.image} width="240" height="240" alt="手机访问一次性配对二维码" />
							</div>
							<p>5 分钟有效，仅可使用一次。扫码后请在此确认设备。</p>
							<button
								onClick={() =>
									void navigator.clipboard.writeText(pair.url).catch(() => setError("复制失败，请扫描二维码"))
								}
							>
								复制配对链接
							</button>
							<p className="settings-hint">链接是短期凭据，请勿分享或截图公开。</p>
						</div>
					)}
				</>
			) : (
				<>
					<label>
						连接方式
						<select value={mode} onChange={(e) => setMode(e.target.value)}>
							<option value="cloudflare">Cloudflare 临时 HTTPS 隧道</option>
							<option value="proxy">已有固定 HTTPS 反向代理</option>
						</select>
					</label>
					{mode === "cloudflare" ? (
						<>
							<label>
								已安装的 cloudflared 绝对路径
								<input
									value={executable}
									onChange={(e) => setExecutable(e.target.value)}
									placeholder="C:/Tools/cloudflared.exe"
								/>
							</label>
							<p className="settings-hint">
								不会自动下载。临时域名可能随重启变化，变化后需重新配对。隧道服务商可能接触传输内容，这不是中转不可读的端到端加密。
							</p>
						</>
					) : (
						<>
							<label>
								公网 HTTPS 域名
								<input
									value={origin}
									onChange={(e) => setOrigin(e.target.value)}
									placeholder="https://phone.example.com"
								/>
							</label>
							<label>
								本机回环端口
								<input type="number" min="1024" max="65535" value={port} onChange={(e) => setPort(e.target.value)} />
							</label>
							<p className="settings-hint">
								仅填写域名不会建立网络通道。反向代理或反向隧道必须能访问本机 127.0.0.1 的此端口。
							</p>
						</>
					)}
					<label className="phone-consent">
						<input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
						我理解已配对手机可驱动电脑 Agent 执行任务，传输可能经过所选服务商。
					</label>
					<button
						disabled={busy || !consent || !status}
						onClick={() =>
							void act("enable", {
								mode,
								...(mode === "cloudflare" ? { executable, port: 0 } : { origin, port: Number(port) }),
							})
						}
					>
						{busy ? "处理中…" : "同意并开启手机访问"}
					</button>
				</>
			)}
			<h4>待确认设备</h4>
			{!status?.pending.length && <p className="settings-hint">暂无配对请求</p>}
			{status?.pending.map((p) => (
				<div className="phone-device" key={p.id}>
					<span>{p.name}</span>
					<label className="phone-consent">
						<input
							type="checkbox"
							checked={workbenchGrants[p.id] ?? false}
							onChange={(e) => setWorkbenchGrants((old) => ({ ...old, [p.id]: e.target.checked }))}
						/>
						允许完整对话能力（新建、重命名、归档、选择模型/技能及上传附件）
					</label>
					<button
						disabled={busy}
						onClick={() => void act("approve", { id: p.id, workbench: workbenchGrants[p.id] === true })}
					>
						确认配对
					</button>
					<button disabled={busy} onClick={() => void act("reject", { id: p.id })}>
						拒绝
					</button>
				</div>
			))}
			<h4>已配对设备</h4>
			<p className="settings-hint">
				授权默认 30
				天，只包含配对时已有项目。旧设备不会自动扩大权限；需要完整对话能力时请重新配对并勾选授权。新会话固定使用工作区写入、风险审批。新增项目、清除浏览器数据或域名变化后需重新配对。
			</p>
			{status?.devices.map((d) => (
				<div className="phone-device" key={d.id}>
					<span>
						{d.name}
						<small>
							{d.origin} · {d.workbench ? "完整对话" : "基础接续"} · {new Date(d.expiresAt).toLocaleDateString()} 到期
						</small>
					</span>
					<button disabled={busy} onClick={() => void act("revoke", { id: d.id })}>
						撤销设备
					</button>
				</div>
			))}
		</div>
	);
}

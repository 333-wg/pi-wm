import { useState, type ReactNode } from "react";
import { Laptop, Smartphone, ShieldCheck, RefreshCw, Link, ArrowRight } from "lucide-react";

export function PhoneWelcome({
	checking,
	pairing,
	hasPairLink,
	retry,
	children,
}: {
	checking: boolean;
	pairing: boolean;
	hasPairLink: boolean;
	retry: () => void;
	children: ReactNode;
}) {
	const [copyStatus, setCopyStatus] = useState("");
	return (
		<main className="phone-welcome">
			<section className="phone-welcome-intro">
				<span className="phone-eyebrow">PI-WM / 随身工作台</span>
				<div className="phone-device-art" aria-hidden="true">
					<Laptop size={52} />
					<span />
					<Smartphone size={34} />
				</div>
				<h1>把工作台带在身边</h1>
				<p>
					灵感不用等回到电脑前。
					<br />
					查看进展、继续对话，让手上的事接着发生。
				</p>
				<div className="phone-benefits">
					<span>实时接续</span>
					<span>随时审批</span>
					<span>电脑执行</span>
				</div>
			</section>
			<section className="phone-entry-card" aria-busy={checking || pairing}>
				<span className="phone-eyebrow">
					{checking ? "正在恢复连接" : pairing ? "只差最后一步" : hasPairLink ? "连接你的电脑" : "欢迎回来"}
				</span>
				<h2>
					{checking
						? "检查这部手机的授权…"
						: pairing
							? "请在电脑上确认"
							: hasPairLink
								? "配对这部手机"
								: "继续，从这里开始"}
				</h2>
				<p className="phone-entry-description">
					{checking
						? "已配对的浏览器会自动进入，无需再次扫码。"
						: pairing
							? "在电脑「设置 → 手机访问」中确认请求，随后将自动进入。"
							: hasPairLink
								? "给设备起个名字，方便在电脑端识别。"
								: "同一浏览器、同一地址且授权有效时，会自动恢复。若未进入，请先重新检查。"}
				</p>
				{hasPairLink && !checking ? (
					children
				) : (
					<button className="phone-primary phone-entry-action" disabled={checking} onClick={retry}>
						<RefreshCw size={17} />
						{checking ? "正在检查…" : "重新检查授权"}
						<ArrowRight size={17} />
					</button>
				)}
			</section>
			<section className="phone-entry-help">
				<h2>下次，直接回来</h2>
				<p>配对后，在同一个浏览器收藏此入口即可。请勿收藏一次性二维码链接。</p>
				<button
					className="phone-entry-action"
					onClick={() => {
						void navigator.clipboard
							.writeText(`${location.origin}/phone`)
							.then(() => setCopyStatus("已复制入口（不含配对凭据）"))
							.catch(() => setCopyStatus("复制失败，请在浏览器中收藏当前页面"));
					}}
				>
					<Link size={16} />
					{copyStatus || "复制入口地址"}
				</button>
				<details>
					<summary>之前配对过，为什么还停在这里？</summary>
					<ul>
						<li>扫码工具、聊天软件和系统浏览器可能不共享授权。请用最初配对的浏览器打开；换浏览器需用新二维码配对。</li>
						<li>无痕模式、清除 Cookie、授权过期或主动退出授权，都需要重新配对。</li>
						<li>Cloudflare 临时域名重建后可能变化。旧收藏无法跳到新入口，请从电脑获取新二维码。</li>
					</ul>
				</details>
				<details>
					<summary>第一次使用？两步连接电脑</summary>
					<ol>
						<li>电脑打开「设置 → 手机访问」，开启入口并生成二维码。</li>
						<li>用常用手机浏览器扫码请求配对，再在电脑确认。</li>
					</ol>
				</details>
			</section>
			<footer className="phone-entry-security">
				<ShieldCheck size={16} />
				<span>
					授权保存在安全 Cookie 中，不会获取模型密钥。
					<br />
					电脑需保持在线；手机锁屏不会停止电脑任务。
				</span>
			</footer>
		</main>
	);
}

import { useState } from "react";
import { Check, Copy, Smartphone } from "lucide-react";

const setupPrompt = `请帮我在运行 Pi-Wm 的这台电脑上准备手机访问所需的 cloudflared。请实际检查和安装，不要只给命令让我执行。

1. 先确认操作系统、CPU 架构和工具权限，检查是否已安装官方 cloudflared；已安装且可用就复用。
2. 如果没有，请从 Cloudflare 官方文档指向的下载渠道获取匹配版本，优先安装到当前用户可写的专用工具目录，不覆盖已有文件；校验官方提供的校验信息（若可用）。不要从第三方镜像下载，也不要绕过网络或权限限制。如果需要管理员权限或无法安装，请说明原因并停下。
3. 确保最终程序名为 cloudflared.exe（Windows）或 cloudflared（macOS/Linux），运行 --version 验证能够执行。
4. 最后单独输出可直接粘贴到 Pi-Wm「设置 → 手机访问 → 已安装的 cloudflared 绝对路径」里的完整路径，不要带引号；再用简短步骤告诉我如何手动开启、生成二维码并在电脑确认手机配对。

仅准备本地工具，不要启动隧道、开启公网访问、代替我勾选授权或确认配对。不要修改系统代理、DNS、防火墙、关闭 TLS 校验、读取模型密钥或配置 Cloudflare 账号。临时隧道不需要 Cloudflare 账号或自有域名；路径不会自动填入 Pi-Wm，请提醒我复制回来。`;

export function PhoneAccessGuide() {
	const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
	const [expanded, setExpanded] = useState(false);
	async function copyPrompt() {
		setCopyState("copying");
		try {
			await navigator.clipboard.writeText(setupPrompt);
			setCopyState("copied");
		} catch {
			setCopyState("failed");
			setExpanded(true);
		}
	}
	return (
		<section className="phone-setup-guide" aria-labelledby="phone-guide-title">
			<div className="phone-guide-heading">
				<span className="phone-guide-icon">
					<Smartphone size={20} aria-hidden="true" />
				</span>
				<div>
					<h4 id="phone-guide-title">第一次使用？让 AI 帮你准备</h4>
					<p>适用于 Cloudflare 临时隧道，无需账号或自有域名。</p>
				</div>
			</div>
			<ol className="phone-guide-steps">
				<li>
					<span className="phone-step-number" aria-hidden="true">
						1
					</span>
					<div>
						<strong>把提示词发给 AI</strong>
						<p>在这台电脑的 Pi-Wm 对话中发送，让 AI 检查并安装 cloudflared。</p>
					</div>
				</li>
				<li>
					<span className="phone-step-number" aria-hidden="true">
						2
					</span>
					<div>
						<strong>粘贴路径，手动开启</strong>
						<p>将 AI 返回的完整路径填到下方，阅读授权说明后开启。</p>
					</div>
				</li>
				<li>
					<span className="phone-step-number" aria-hidden="true">
						3
					</span>
					<div>
						<strong>手机扫码，电脑确认</strong>
						<p>隧道连接后生成二维码，用手机常用浏览器配对。</p>
					</div>
				</li>
			</ol>
			<div className="phone-guide-copy-row">
				<button
					type="button"
					className="phone-guide-copy"
					disabled={copyState === "copying"}
					onClick={() => void copyPrompt()}
				>
					{copyState === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
					{copyState === "copied" ? "已复制安装提示词" : copyState === "copying" ? "正在复制…" : "复制安装提示词"}
				</button>
				<p>只复制文本，不会发送消息或自动开启公网访问。</p>
			</div>
			<p className="phone-guide-feedback" role="status">
				{copyState === "copied"
					? "已复制，回到电脑上的 AI 对话粘贴发送即可。"
					: copyState === "failed"
						? "复制失败，请在下方文本框全选并手动复制。"
						: ""}
			</p>
			<details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
				<summary>查看 / 手动复制提示词</summary>
				<label className="phone-guide-prompt-label">
					安装提示词
					<textarea readOnly value={setupPrompt} rows={9} onFocus={(event) => event.currentTarget.select()} />
				</label>
			</details>
			<p className="phone-guide-footnote">
				已安装？直接填写下方路径即可。应用重启后需手动开启；临时地址变化后需重新配对。网络受限时，安装成功也不代表隧道能连通。
			</p>
		</section>
	);
}

import type { OfficialProvider } from "@wuming/protocol";
import { useLocale } from "../lib/locale.js";
import { useFocusTrap } from "../use-focus-trap.js";

export type RiskProvider = Extract<
	OfficialProvider,
	"official-claude" | "official-chatgpt" | "official-grok" | "official-deepseek"
>;

export function requiresLoginRiskConfirmation(provider: OfficialProvider): provider is RiskProvider {
	return (
		provider === "official-claude" ||
		provider === "official-chatgpt" ||
		provider === "official-grok" ||
		provider === "official-deepseek"
	);
}

const risks = {
	"official-deepseek": {
		name: "DeepSeek",
		zh: "账号余额计费：此授权使用 DeepSeek 开放平台账号余额，不是免费网页版聊天。第三方接入不保证持续可用，服务商可能限制或撤销授权。",
		en: "Platform balance billing: this authorization uses your DeepSeek platform balance, not free web chat. Third-party access may be restricted or revoked and is not guaranteed to remain available.",
	},
	"official-claude": {
		name: "Claude",
		zh: "较高风险：在第三方应用中使用 Claude 订阅账号授权，可能触发 Anthropic 的风控，导致授权撤销、账号限制或封禁。请谨慎使用重要账号。",
		en: "Higher risk: using a Claude subscription account in a third-party app may trigger Anthropic's risk controls, resulting in revoked authorization, account restrictions or suspension. Use important accounts with caution.",
	},
	"official-chatgpt": {
		name: "ChatGPT",
		zh: "相对较低风险，但并非无风险：通过 ChatGPT / Codex 授权在第三方应用中使用订阅，仍可能因 OpenAI 的政策或风控而被限流、撤销授权、限制或封禁账号。",
		en: "Relatively lower risk, but not risk-free: using a subscription in a third-party app through ChatGPT / Codex authorization may still lead to rate limits, revoked authorization, account restrictions or suspension under OpenAI's policies or risk controls.",
	},
	"official-grok": {
		name: "Grok",
		zh: "中等风险：通过 xAI 授权在第三方应用中使用 Grok 账号，可能触发服务商的风控，导致授权失效、账号限制或封禁；订阅权益不保证可在第三方应用中使用。",
		en: "Moderate risk: using a Grok account in a third-party app through xAI authorization may trigger provider risk controls, resulting in invalidated authorization, account restrictions or suspension. Subscription benefits are not guaranteed in third-party apps.",
	},
} satisfies Record<RiskProvider, { name: string; zh: string; en: string }>;

export function OfficialLoginRiskDialog({
	provider,
	onCancel,
	onConfirm,
}: {
	provider: RiskProvider;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const { locale } = useLocale();
	const en = locale === "en";
	const risk = risks[provider];
	const dialog = useFocusTrap<HTMLDivElement>();
	return (
		<div
			className="official-login-risk-overlay"
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					onCancel();
				}
			}}
		>
			<div
				className="official-login-risk-dialog"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="official-login-risk-title"
				aria-describedby="official-login-risk-description"
				ref={dialog}
			>
				<h2 id="official-login-risk-title">
					{en ? `${risk.name} sign-in risk confirmation` : `${risk.name} 登录风险确认`}
				</h2>
				<div id="official-login-risk-description">
					<p>
						{en
							? "Pi-Wm is a third-party app, not an official client of this provider. Signing in on the provider's website does not mean it endorses or guarantees use in Pi-Wm."
							: "Pi-Wm 是第三方应用，并非该服务商的官方客户端。在服务商官网完成登录，不代表服务商认可或保障在 Pi-Wm 中的使用。"}
					</p>
					<p className="official-login-risk-provider">{en ? risk.en : risk.zh}</p>
					<p>
						{provider === "official-deepseek"
							? en
								? "Review DeepSeek's terms and billing before continuing. You can remove the local credential by signing out."
								: "请确认 DeepSeek 的服务条款与计费规则后继续。退出登录会移除本机凭据。"
							: en
								? "These qualitative risk levels follow cc-haha #1526 as a reference, not an official rating or a measured probability. Provider terms and enforcement can change; Pi-Wm cannot guarantee account safety. Review the provider's terms and decide whether to continue."
								: "以上风险等级参考 cc-haha #1526，仅为定性提示，并非官方评级或封禁概率。服务条款与风控策略可能变化，Pi-Wm 无法保证账号安全。请阅读服务商条款，自行决定是否继续。"}
					</p>
				</div>
				<footer>
					<button type="button" className="secondary-button" onClick={onCancel}>
						{en ? "Cancel" : "取消"}
					</button>
					<button type="button" className="primary-button" onClick={onConfirm}>
						{en ? "I understand the risks, continue" : "我已了解风险，继续登录"}
					</button>
				</footer>
			</div>
		</div>
	);
}

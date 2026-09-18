import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, LogIn, LogOut, X } from "lucide-react";
import type { Command, OfficialAccount, OfficialProvider } from "@wuming/protocol";
import { useLocale } from "../lib/locale.js";
import "./official-accounts.css";

type AccountCommand = Extract<Command, { type: `model.official.${string}` }>;
export function OfficialAccountSettings({
	request,
	onModelsChanged,
}: {
	request: (command?: AccountCommand) => Promise<OfficialAccount[]>;
	onModelsChanged: () => Promise<unknown>;
}) {
	const { locale } = useLocale();
	const en = locale === "en";
	const [accounts, setAccounts] = useState<OfficialAccount[]>([]);
	const [error, setError] = useState("");
	const [pollError, setPollError] = useState("");
	const [busy, setBusy] = useState<OfficialProvider>();
	const [codes, setCodes] = useState<Partial<Record<OfficialProvider, string>>>({});
	const [method, setMethod] = useState<"browser" | "device_code">("browser");
	const [copied, setCopied] = useState("");
	const revision = useRef(0);
	const signature = useRef<string | undefined>(undefined);
	const opening = useRef<OfficialProvider | undefined>(undefined);
	const writing = useRef(false);
	const mounted = useRef(false);
	const apply = useCallback(
		async (next: OfficialAccount[]) => {
			if (!mounted.current) return;
			setAccounts(next);
			setPollError("");
			const value = next.map((account) => `${account.provider}:${account.loggedIn}:${account.modelCount}`).join("|");
			if (signature.current !== value) {
				await onModelsChanged();
				signature.current = value;
			}
			const pending = next.find((account) => account.provider === opening.current);
			if (pending?.login?.authorizeUrl) {
				opening.current = undefined;
				window.open(pending.login.authorizeUrl, "_blank", "noopener,noreferrer");
			}
		},
		[onModelsChanged]
	);
	useEffect(() => {
		mounted.current = true;
		let polling = false;
		const poll = async () => {
			if (polling || writing.current) return;
			polling = true;
			const current = revision.current;
			try {
				const next = await request();
				if (mounted.current && current === revision.current) await apply(next);
			} catch (cause) {
				if (mounted.current && current === revision.current)
					setPollError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				polling = false;
			}
		};
		void poll();
		const timer = setInterval(() => {
			if (!document.hidden) void poll();
		}, 2000);
		return () => {
			mounted.current = false;
			revision.current++;
			clearInterval(timer);
		};
	}, [request, apply]);
	const invoke = async (command: AccountCommand & { provider: OfficialProvider }) => {
		writing.current = true;
		revision.current++;
		setBusy(command.provider);
		setError("");
		if (command.type === "model.official.start") opening.current = command.provider;
		else opening.current = undefined;
		try {
			await apply(await request(command));
			setCodes((current) => ({ ...current, [command.provider]: "" }));
		} catch (cause) {
			if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			writing.current = false;
			if (mounted.current) setBusy(undefined);
		}
	};
	return (
		<section className="official-accounts" aria-label={en ? "Official accounts" : "官方账号"}>
			{(error || pollError) && (
				<p className="official-account-error" role="alert">
					{error || pollError}
				</p>
			)}
			{accounts.length === 0 && !error && !pollError && (
				<Loader2 size={18} className="spinning" aria-label={en ? "Loading" : "加载中"} />
			)}
			{accounts.map((account) => {
				const pending = account.login?.status === "pending";
				const loading = busy === account.provider;
				return (
					<div className="official-account" key={account.provider} data-provider={account.provider}>
						<div className="official-account-row">
							<div className="official-account-identity">
								<strong>{account.name}</strong>
								<span className={account.loggedIn ? "official-account-connected" : ""}>
									{account.loggedIn ? (
										<>
											<Check size={13} />
											{en ? `Connected · ${account.modelCount} models` : `已登录 · ${account.modelCount} 个模型`}
										</>
									) : pending ? (
										en ? (
											"Awaiting authorization"
										) : (
											"等待授权"
										)
									) : en ? (
										"Not connected"
									) : (
										"未登录"
									)}
								</span>
							</div>
							<div className="official-account-actions">
								{account.provider === "official-chatgpt" && !pending && !account.loggedIn && (
									<select
										aria-label={en ? "ChatGPT login method" : "ChatGPT 登录方式"}
										value={method}
										onChange={(event) => setMethod(event.target.value as typeof method)}
									>
										<option value="browser">{en ? "Browser" : "浏览器授权"}</option>
										<option value="device_code">{en ? "Device code" : "设备码授权"}</option>
									</select>
								)}
								{pending ? (
									<button
										type="button"
										className="secondary-button"
										disabled={!!busy}
										onClick={() =>
											void invoke({
												type: "model.official.cancel",
												provider: account.provider,
												loginId: account.login!.id,
											})
										}
									>
										<X size={14} />
										{en ? "Cancel" : "取消"}
									</button>
								) : (
									<button
										type="button"
										className="secondary-button"
										disabled={!!busy}
										onClick={() =>
											void invoke(
												account.loggedIn
													? { type: "model.official.logout", provider: account.provider }
													: {
															type: "model.official.start",
															provider: account.provider,
															method: account.provider === "official-chatgpt" ? method : "browser",
														}
											)
										}
									>
										{loading ? (
											<Loader2 size={14} className="spinning" />
										) : account.loggedIn ? (
											<LogOut size={14} />
										) : (
											<LogIn size={14} />
										)}
										{account.loggedIn ? (en ? "Sign out" : "退出登录") : en ? "Sign in" : "登录"}
									</button>
								)}
							</div>
						</div>
						{pending && (
							<div className="official-account-authorization">
								{account.login?.authorizeUrl ? (
									<a href={account.login.authorizeUrl} target="_blank" rel="noreferrer noopener">
										<ExternalLink size={14} />
										{en ? "Open authorization page" : "打开授权页面"}
									</a>
								) : (
									<span>
										<Loader2 size={14} className="spinning" />
										{en ? "Preparing authorization" : "正在准备授权"}
									</span>
								)}
								{account.login?.userCode && (
									<div className="official-account-device-code">
										<code>{account.login.userCode}</code>
										<button
											type="button"
											className="icon-button"
											title={en ? "Copy device code" : "复制设备码"}
											aria-label={en ? "Copy device code" : "复制设备码"}
											onClick={() => {
												void navigator.clipboard
													.writeText(account.login!.userCode!)
													.then(() => setCopied(account.login!.id))
													.catch(() => setError(en ? "Clipboard unavailable" : "无法访问剪贴板"));
											}}
										>
											{copied === account.login.id ? <Check size={16} /> : <Copy size={16} />}
										</button>
									</div>
								)}
								{account.login?.manualCode && (
									<details>
										<summary>{en ? "Manual callback" : "手动回填"}</summary>
										<form
											onSubmit={(event) => {
												event.preventDefault();
												void invoke({
													type: "model.official.submit",
													provider: account.provider,
													loginId: account.login!.id,
													code: codes[account.provider] ?? "",
												});
											}}
										>
											<input
												type="password"
												autoComplete="off"
												aria-label={en ? "Complete callback URL" : "完整回调地址"}
												placeholder={en ? "Complete callback URL" : "完整回调地址"}
												value={codes[account.provider] ?? ""}
												onChange={(event) =>
													setCodes((current) => ({ ...current, [account.provider]: event.target.value }))
												}
											/>
											<button
												type="submit"
												className="secondary-button"
												disabled={!!busy || !codes[account.provider]?.trim()}
											>
												<Check size={14} />
												{en ? "Submit" : "提交"}
											</button>
										</form>
									</details>
								)}
							</div>
						)}
						{account.login?.status === "error" && (
							<p className="official-account-error" role="alert">
								{en
									? account.login.error
									: account.login.error?.includes("timed out")
										? "授权已超时，请重新登录。"
										: "授权失败，请检查网络、账号权限和本机回调端口后重试。"}
							</p>
						)}
					</div>
				);
			})}
		</section>
	);
}

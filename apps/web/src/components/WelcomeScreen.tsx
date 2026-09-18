import { ArrowRight, Check, Eye, EyeOff, KeyRound, Leaf, LoaderCircle, LockKeyhole, Sprout } from "lucide-react";
import { useState, type FormEvent } from "react";
import clover from "../assets/wuming-clover.png";
import "./welcome-screen.css";

export function WelcomeScreen({
	busy,
	error,
	onSubmit,
	onEdit,
}: {
	busy: boolean;
	error: string | undefined;
	onSubmit: (password: string) => void;
	onEdit: () => void;
}) {
	const [password, setPassword] = useState("");
	const [visible, setVisible] = useState(false);
	const [hintOpen, setHintOpen] = useState(false);
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (password && !busy) onSubmit(password);
	}
	return (
		<div className="welcome-screen">
			<header className="welcome-header">
				<div className="welcome-header-inner">
					<div className="welcome-brand">
						<img src={clover} alt="" />
						<span>
							Pi-Wm<span className="welcome-brand-chinese">无铭</span>
						</span>
					</div>
					<div className="welcome-header-note">
						<Sprout size={17} />
						<span>让灵感生根，让想法发生</span>
					</div>
					<span className="welcome-private">
						<LockKeyhole size={14} />
						个人工作空间
					</span>
				</div>
			</header>
			<main className="welcome-main">
				<div className="welcome-intro">
					<p className="welcome-eyebrow">一片新天地，一次新开始</p>
					<h1>
						<img src={clover} alt="" />
						欢迎来到 Pi-Wm
					</h1>
					<p className="welcome-description">把灵感带来，把值得做的事，一件件变成现实。</p>
				</div>
				<section className="welcome-panel" aria-label="开启工作空间">
					<div className="welcome-story">
						<span className="welcome-section-label">
							<Leaf size={17} />
							为你留的一方天地
						</span>
						<h2>
							让想法，
							<br />
							在这里生长。
						</h2>
						<p className="welcome-story-copy">
							不必等一切准备妥当。
							<br />
							一个念头，就是一个很好的开始。
						</p>
						<div className="welcome-signature">
							<img src={clover} alt="五叶草" />
							<div>
								<strong>一点灵感，无限可能</strong>
								<span>MAKE SOMETHING MEANINGFUL</span>
							</div>
						</div>
					</div>
					<form className="welcome-form" onSubmit={submit} aria-labelledby="welcome-form-title">
						<div className="welcome-form-heading">
							<span className="welcome-step">01 / 开启</span>
							<h2 id="welcome-form-title">进入你的工作空间</h2>
							<p>很高兴见到你，今天想做点什么？</p>
						</div>
						<div className="welcome-password-heading">
							<label className="welcome-password-label" htmlFor="welcome-password">
								访问密码
							</label>
							<div
								className="welcome-hint"
								onPointerEnter={(event) => {
									if (event.pointerType === "mouse") setHintOpen(true);
								}}
								onPointerLeave={(event) => {
									if (!event.currentTarget.contains(document.activeElement)) setHintOpen(false);
								}}
								onBlur={(event) => {
									if (!event.currentTarget.contains(event.relatedTarget)) setHintOpen(false);
								}}
								onKeyDown={(event) => {
									if (event.key === "Escape") setHintOpen(false);
								}}
							>
								<button
									className="welcome-hint-trigger"
									type="button"
									aria-label="查看初始密码"
									aria-describedby={hintOpen ? "welcome-password-hint" : undefined}
									onFocus={() => setHintOpen(true)}
									onClick={(event) => {
										event.currentTarget.focus();
										setHintOpen(true);
									}}
								>
									<KeyRound size={14} aria-hidden="true" />
									<span>初次来访？</span>
								</button>
								<div className="welcome-hint-popover" id="welcome-password-hint" role="tooltip" hidden={!hintOpen}>
									<span className="welcome-hint-caption">
										<Sprout size={14} />
										给你一枚通行口令
									</span>
									<code>wuming</code>
									<span className="welcome-hint-note">初始密码，全部小写</span>
								</div>
							</div>
						</div>
						<div className={"welcome-password" + (error ? " has-error" : "")}>
							<LockKeyhole size={18} aria-hidden="true" />
							<input
								id="welcome-password"
								name="password"
								type={visible ? "text" : "password"}
								autoComplete="current-password"
								autoCapitalize="none"
								spellCheck={false}
								required
								placeholder="输入你的访问密码"
								value={password}
								aria-invalid={Boolean(error)}
								aria-describedby="welcome-password-message"
								onChange={(event) => {
									setPassword(event.target.value);
									onEdit();
								}}
							/>
							<button
								className="welcome-visibility"
								type="button"
								aria-label={visible ? "隐藏密码" : "显示密码"}
								title={visible ? "隐藏密码" : "显示密码"}
								onClick={() => setVisible(!visible)}
							>
								{visible ? <EyeOff size={18} /> : <Eye size={18} />}
							</button>
						</div>
						<div className="welcome-password-message" id="welcome-password-message" aria-live="polite">
							{error ? (
								<span role="alert">{error}</span>
							) : (
								<span>
									<Check size={14} />
									首次验证后，在这台设备上记住你
								</span>
							)}
						</div>
						<button className="welcome-submit" type="submit" disabled={!password || busy}>
							{busy ? (
								<>
									<LoaderCircle className="welcome-spinner" size={18} />
									正在连接...
								</>
							) : (
								<>
									开启工作空间
									<ArrowRight size={18} />
								</>
							)}
						</button>
						<p className="welcome-form-footer">
							<Sprout size={16} />
							准备好了，就从这里出发。
						</p>
					</form>
				</section>
				<footer className="welcome-footer">
					<span>
						<Check size={16} />
						专注当下的想法，慢慢做成喜欢的模样
					</span>
					<span>
						由你开始，与你一起。
						<ArrowRight size={15} />
					</span>
				</footer>
			</main>
			<div className="welcome-bottom">
				Pi-Wm <span>·</span>一方天地，无限可能
			</div>
		</div>
	);
}

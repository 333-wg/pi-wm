import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
	ArrowLeft,
	ArrowRight,
	Code2,
	ExternalLink,
	Globe,
	Loader2,
	Monitor,
	Plus,
	RefreshCw,
	Smartphone,
	Square,
	X,
} from "lucide-react";
import type { BrowserRequest, BrowserState } from "../lib/desktop.js";
import { useLocale } from "../lib/locale.js";
import "./browser-panel.css";

export function BrowserPanel({
	workspaceId,
	sessionId,
	initialUrl,
	onClose,
}: {
	workspaceId: string;
	sessionId: string;
	initialUrl?: { url: string; sequence: number } | undefined;
	onClose: () => void;
}) {
	const { locale } = useLocale();
	const label = (zh: string, en: string) => (locale === "en" ? en : zh);
	const api = window.wumingDesktop?.browser;
	const [state, setState] = useState<BrowserState>();
	const [address, setAddress] = useState("");
	const [error, setError] = useState("");
	const [phone, setPhone] = useState(false);
	const [dragging, setDragging] = useState(false);
	const stage = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLElement>(null);
	const addressInput = useRef<HTMLInputElement>(null);
	const requestedUrl = useRef(initialUrl);
	requestedUrl.current = initialUrl;
	const active = state?.tabs.find((tab) => tab.id === state.activeId);
	const accept = useCallback(
		(next: BrowserState) => {
			if (next.workspaceId === workspaceId && next.sessionId === sessionId)
				setState((previous) => (!previous || next.revision > previous.revision ? next : previous));
		},
		[workspaceId, sessionId]
	);
	const invoke = useCallback(
		async (action: BrowserRequest["action"], fields: Partial<BrowserRequest> = {}) => {
			if (!api) return;
			try {
				const next = await api.invoke({ ...fields, workspaceId, sessionId, action });
				accept(next);
				setError("");
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[api, workspaceId, sessionId, accept]
	);
	useEffect(() => {
		if (!api) return;
		let cancelled = false;
		const unsubscribe = api.onState(accept);
		void api
			.invoke({ workspaceId, sessionId, action: "state" })
			.then((next) => {
				if (cancelled) return;
				accept(next);
				if (!next.tabs.length && !requestedUrl.current) void invoke("open");
			})
			.catch((cause: Error) => {
				if (!cancelled) setError(cause.message);
			});
		return () => {
			cancelled = true;
			unsubscribe();
			void api.invoke({ workspaceId, sessionId, action: "hide" }).catch(() => {});
		};
	}, [api, workspaceId, sessionId, accept, invoke]);
	useEffect(() => {
		if (initialUrl) void invoke("open", { url: initialUrl.url });
	}, [initialUrl, invoke]);
	useEffect(() => {
		setAddress(active?.url === "about:blank" ? "" : (active?.url ?? ""));
	}, [active?.id, active?.url]);
	useEffect(() => {
		if (!api) return;
		const focus = () => {
			addressInput.current?.focus();
			addressInput.current?.select();
		};
		const unsubscribe = api.onFocusAddress((owner) => {
			if (owner.workspaceId === workspaceId && owner.sessionId === sessionId) focus();
		});
		const shortcut = (event: KeyboardEvent) => {
			if (
				(event.ctrlKey || event.metaKey) &&
				event.key.toLowerCase() === "l" &&
				!document.querySelector('[aria-modal="true"], dialog[open]')
			) {
				event.preventDefault();
				focus();
			}
		};
		document.addEventListener("keydown", shortcut);
		return () => {
			unsubscribe();
			document.removeEventListener("keydown", shortcut);
		};
	}, [api, workspaceId, sessionId]);

	// Native child views sit above HTML. Hide them whenever an app dialog covers the panel.
	useLayoutEffect(() => {
		if (!api) return;
		let frame = 0;
		let last = "";
		const update = () => {
			frame = 0;
			const rect = stage.current?.getBoundingClientRect();
			const blocked = [...document.querySelectorAll('[aria-modal="true"], dialog[open], .mobile-scrim')].some(
				(element) => element.getClientRects().length > 0
			);
			const hidden =
				!active?.url || Boolean(active.error) || dragging || blocked || document.hidden || !rect?.width || !rect.height;
			const request: BrowserRequest = hidden
				? { workspaceId, sessionId, action: "hide" }
				: {
						workspaceId,
						sessionId,
						action: "bounds",
						tabId: active?.id,
						bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
					};
			const key = JSON.stringify(request);
			if (key === last) return;
			last = key;
			void api.invoke(request).catch((cause: Error) => setError(cause.message));
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		const resize = () => {
			last = "";
			schedule();
		};
		const observer = new ResizeObserver(schedule);
		if (stage.current) observer.observe(stage.current);
		const mutations = new MutationObserver(schedule);
		mutations.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class", "open", "aria-modal", "hidden"],
		});
		window.addEventListener("resize", resize);
		window.addEventListener("scroll", schedule, true);
		document.addEventListener("visibilitychange", schedule);
		schedule();
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			mutations.disconnect();
			window.removeEventListener("resize", resize);
			window.removeEventListener("scroll", schedule, true);
			document.removeEventListener("visibilitychange", schedule);
			void api.invoke({ workspaceId, sessionId, action: "hide" }).catch(() => {});
		};
	}, [api, workspaceId, sessionId, active?.id, active?.url, active?.error, phone, dragging]);
	const command = (action: BrowserRequest["action"], fields: Partial<BrowserRequest> = {}) =>
		void invoke(action, { tabId: active?.id, ...fields });
	function navigate(event: FormEvent) {
		event.preventDefault();
		if (address.trim()) command(active ? "navigate" : "open", { url: address.trim() });
	}
	return (
		<aside className="browser-panel" ref={panel} aria-label={label("浏览器预览", "Browser preview")}>
			<div
				className="browser-resizer"
				role="separator"
				aria-label={label("调整浏览器宽度", "Resize browser")}
				aria-orientation="vertical"
				tabIndex={0}
				onKeyDown={(event) => {
					if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
					event.preventDefault();
					panel.current?.parentElement?.style.setProperty(
						"--browser-width",
						Math.max(
							360,
							Math.min(innerWidth * 0.7, (panel.current?.offsetWidth ?? 560) + (event.key === "ArrowLeft" ? 32 : -32))
						) + "px"
					);
				}}
				onPointerDown={(event) => {
					event.currentTarget.setPointerCapture(event.pointerId);
					setDragging(true);
				}}
				onPointerMove={(event) => {
					if (event.currentTarget.hasPointerCapture(event.pointerId))
						panel.current?.parentElement?.style.setProperty(
							"--browser-width",
							Math.max(360, Math.min(innerWidth * 0.7, innerWidth - event.clientX)) + "px"
						);
				}}
				onPointerUp={(event) => {
					event.currentTarget.releasePointerCapture(event.pointerId);
					setDragging(false);
				}}
				onLostPointerCapture={() => setDragging(false)}
			/>
			<header className="browser-panel-header">
				<Globe size={16} />
				<strong>{label("浏览器", "Browser")}</strong>
				<button className="icon-button" title={label("关闭浏览器面板", "Close browser panel")} onClick={onClose}>
					<X size={16} />
				</button>
			</header>
			<div className="browser-tabs" role="tablist" aria-label={label("浏览器标签页", "Browser tabs")}>
				{state?.tabs.map((tab) => (
					<div className={"browser-tab" + (tab.id === state.activeId ? " active" : "")} key={tab.id}>
						<button
							role="tab"
							aria-selected={tab.id === state.activeId}
							title={tab.url || label("新标签页", "New tab")}
							onClick={() => command("activate", { tabId: tab.id })}
						>
							{tab.loading ? <Loader2 size={13} className="browser-spinner" /> : <Globe size={13} />}
							<span>{tab.title || tab.url || label("新标签页", "New tab")}</span>
						</button>
						<button
							className="icon-button"
							title={label("关闭标签页", "Close tab")}
							onClick={() => command("close", { tabId: tab.id })}
						>
							<X size={12} />
						</button>
					</div>
				))}
				<button
					className="icon-button"
					disabled={!api}
					title={label("新建标签页", "New tab")}
					onClick={() => command("open")}
				>
					<Plus size={16} />
				</button>
			</div>
			<form className="browser-toolbar" onSubmit={navigate}>
				<button
					type="button"
					className="icon-button"
					title={label("后退", "Back")}
					disabled={!active?.canGoBack}
					onClick={() => command("back")}
				>
					<ArrowLeft size={16} />
				</button>
				<button
					type="button"
					className="icon-button"
					title={label("前进", "Forward")}
					disabled={!active?.canGoForward}
					onClick={() => command("forward")}
				>
					<ArrowRight size={16} />
				</button>
				<button
					type="button"
					className="icon-button"
					title={active?.loading ? label("停止加载", "Stop loading") : label("刷新页面", "Reload page")}
					disabled={!active?.url}
					onClick={() => command(active?.loading ? "stop" : "reload")}
				>
					{active?.loading ? <Square size={14} /> : <RefreshCw size={15} />}
				</button>
				<input
					ref={addressInput}
					aria-label={label("浏览器地址", "Browser address")}
					placeholder="localhost:3000"
					value={address}
					disabled={!api}
					onChange={(event) => setAddress(event.target.value)}
					onFocus={(event) => event.target.select()}
					spellCheck={false}
				/>
				<button className="icon-button" disabled={!api || !address.trim()} title={label("打开地址", "Go")}>
					<ArrowRight size={16} />
				</button>
			</form>
			<div className="browser-tools">
				<div className="browser-device" role="group" aria-label={label("预览尺寸", "Viewport")}>
					<button
						className="icon-button"
						title={label("自适应宽度", "Responsive width")}
						aria-pressed={!phone}
						onClick={() => setPhone(false)}
					>
						<Monitor size={15} />
					</button>
					<button
						className="icon-button"
						title={label("手机宽度 390px", "Phone width 390px")}
						aria-pressed={phone}
						onClick={() => setPhone(true)}
					>
						<Smartphone size={15} />
					</button>
				</div>
				<select
					aria-label={label("页面缩放", "Page zoom")}
					disabled={!active}
					value={active?.zoom ?? 1}
					onChange={(event) => command("zoom", { zoom: Number(event.target.value) })}
				>
					{[0.5, 0.75, 1, 1.25, 1.5, 2].map((zoom) => (
						<option key={zoom} value={zoom}>
							{zoom * 100}%
						</option>
					))}
				</select>
				<span className="browser-tools-space" />
				<button
					className="icon-button"
					title={label("开发者工具", "Developer tools")}
					disabled={!active?.url}
					onClick={() => command("devtools")}
				>
					<Code2 size={16} />
				</button>
				<button
					className="icon-button"
					title={label("在外部浏览器打开", "Open externally")}
					disabled={!active?.url}
					onClick={() => command("external")}
				>
					<ExternalLink size={15} />
				</button>
			</div>
			{error && (
				<div className="browser-error" role="alert">
					{error}
					<button className="icon-button" title={label("关闭错误", "Dismiss error")} onClick={() => setError("")}>
						<X size={14} />
					</button>
				</div>
			)}
			<div className={"browser-stage-wrap" + (phone ? " phone" : "")}>
				<div className="browser-stage" ref={stage}>
					{!api ? (
						<div className="browser-empty">
							<Globe size={28} />
							<strong>{label("请在桌面端打开浏览器预览", "Browser preview requires the desktop app")}</strong>
						</div>
					) : active?.error ? (
						<div className="browser-empty" role="alert">
							<Globe size={28} />
							<strong>{label("无法加载此页面", "Could not load this page")}</strong>
							<p>{active.error}</p>
							<button onClick={() => command("reload")}>
								<RefreshCw size={14} />
								{label("重试", "Retry")}
							</button>
						</div>
					) : !active?.url ? (
						<div className="browser-empty">
							<Globe size={32} />
							<strong>{label("新标签页", "New tab")}</strong>
						</div>
					) : null}
				</div>
			</div>
		</aside>
	);
}

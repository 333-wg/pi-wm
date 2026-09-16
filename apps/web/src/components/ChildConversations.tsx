import { ArrowLeft, Check, CircleAlert, LoaderCircle, MessagesSquare, RefreshCw, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSummary, SubagentSummary } from "@wuming/protocol";

const activeStatuses = new Set(["queued", "running", "awaiting_approval", "cancelling"]);
const labels: Record<SubagentSummary["status"], string> = {
	queued: "排队中",
	running: "进行中",
	awaiting_approval: "等待批准",
	cancelling: "正在停止",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

export function ChildConversationMenu({
	session,
	children,
	open,
	onOpenChange,
	disabled,
	load,
	onSelect,
	onCancel,
}: {
	session: SessionSummary;
	children: SubagentSummary[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	disabled: boolean;
	load: (parentId: string) => Promise<SubagentSummary[]>;
	onSelect: (sessionId: string) => Promise<boolean>;
	onCancel: (id: string, parentId: string) => Promise<SubagentSummary>;
}) {
	const container = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const [siblings, setSiblings] = useState<SubagentSummary[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const [busyId, setBusyId] = useState<string>();
	const [retry, setRetry] = useState(0);
	const items = session.parentSessionId ? siblings : children;
	const running = items.filter((child) => activeStatuses.has(child.status)).length;

	useEffect(() => {
		setSiblings([]);
		setError(undefined);
	}, [session.id]);
	useEffect(() => {
		if (!open) return;
		closeButton.current?.focus();
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !container.current?.contains(event.target)) onOpenChange(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onOpenChange(false);
			trigger.current?.focus();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escape);
		};
	}, [open, onOpenChange]);
	useEffect(() => {
		if (!open || disabled) return;
		let disposed = false;
		let pending = false;
		const parentId = session.parentSessionId ?? session.id;
		setLoading(true);
		const refresh = async () => {
			if (pending) return;
			pending = true;
			try {
				const result = await load(parentId);
				if (!disposed) {
					if (session.parentSessionId) setSiblings(result);
					setError(undefined);
				}
			} catch (cause) {
				if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				pending = false;
				if (!disposed) setLoading(false);
			}
		};
		void refresh();
		const timer = session.parentSessionId ? setInterval(() => void refresh(), 1500) : undefined;
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	}, [disabled, load, open, retry, session.id, session.parentSessionId]);

	const select = async (id: string) => {
		if (busyId) return;
		if (id === session.id) {
			onOpenChange(false);
			trigger.current?.focus();
			return;
		}
		setBusyId(id);
		try {
			if (await onSelect(id)) onOpenChange(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusyId(undefined);
		}
	};
	const renderItems = (entries: SubagentSummary[]) =>
		entries.map((child) => (
			<div className={"child-conversation-row " + (session.id === child.sessionId ? "selected" : "")} key={child.id}>
				<button
					className="child-conversation-open"
					type="button"
					disabled={disabled || busyId !== undefined}
					aria-current={session.id === child.sessionId ? "page" : undefined}
					title={child.name + "\n" + child.task}
					onClick={() => void select(child.sessionId)}
				>
					<span className={"child-conversation-status status-" + child.status}>
						{child.status === "completed" ? (
							<Check size={15} />
						) : child.status === "failed" || child.status === "awaiting_approval" ? (
							<CircleAlert size={15} />
						) : activeStatuses.has(child.status) ? (
							<LoaderCircle size={15} className="spin" />
						) : (
							<Square size={13} />
						)}
					</span>
					<span className="child-conversation-copy">
						<span className="child-conversation-name">{child.name}</span>
						<span className="child-conversation-task">{child.task}</span>
					</span>
					<span className="child-conversation-state">
						{session.id === child.sessionId ? "当前 · " : ""}
						{labels[child.status]}
					</span>
				</button>
				{activeStatuses.has(child.status) && (
					<button
						type="button"
						className="child-conversation-stop"
						title={"停止子对话：" + child.name}
						disabled={
							disabled || session.archivedAt !== undefined || busyId !== undefined || child.status === "cancelling"
						}
						onClick={() => {
							setBusyId(child.id);
							setError(undefined);
							void onCancel(child.id, child.parentSessionId)
								.then((updated) =>
									setSiblings((current) => current.map((item) => (item.id === updated.id ? updated : item)))
								)
								.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
								.finally(() => setBusyId(undefined));
						}}
					>
						<Square size={12} />
					</button>
				)}
			</div>
		));
	return (
		<div className="child-conversation-menu" ref={container}>
			<button
				ref={trigger}
				className={"icon-button child-conversation-trigger " + (open ? "pressed" : "")}
				type="button"
				title={"子对话" + (running ? " · " + running + " 个进行中" : "")}
				aria-label="子对话"
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls="child-conversation-menu"
				onClick={() => onOpenChange(!open)}
			>
				<MessagesSquare size={18} />
				{items.length > 0 && (
					<span className={"child-conversation-count " + (running ? "running" : "")}>
						{items.length > 99 ? "99+" : items.length}
					</span>
				)}
			</button>
			{open && (
				<section id="child-conversation-menu" className="child-conversation-popover" role="dialog" aria-label="子对话">
					<header>
						<div>
							<strong>子对话</strong>
							<span>{items.length ? items.length + " 个" + (running ? " · " + running + " 个进行中" : "") : ""}</span>
						</div>
						<button
							ref={closeButton}
							className="icon-button"
							type="button"
							title="关闭子对话"
							onClick={() => {
								onOpenChange(false);
								trigger.current?.focus();
							}}
						>
							<X size={16} />
						</button>
					</header>
					<div className="child-conversation-scroll">
						{session.parentSessionId && (
							<button
								className="child-conversation-parent"
								type="button"
								disabled={disabled || busyId !== undefined}
								onClick={() => void select(session.parentSessionId!)}
							>
								<ArrowLeft size={15} />
								<span>返回上级对话</span>
							</button>
						)}
						{session.parentSessionId && items.length > 0 && (
							<div className="child-conversation-section-title">同级子对话</div>
						)}
						{renderItems(items)}
						{!items.length && !loading && !error && (
							<div className="child-conversation-empty">
								<MessagesSquare size={24} />
								<span>暂无子对话</span>
							</div>
						)}
						{loading && !items.length && (
							<div className="child-conversation-empty" role="status">
								<LoaderCircle size={18} className="spin" />
								<span>正在加载...</span>
							</div>
						)}
						{session.parentSessionId && children.length > 0 && (
							<>
								<div className="child-conversation-section-title">当前对话的子对话</div>
								{renderItems(children)}
							</>
						)}
						{error && (
							<div className="child-conversation-error" role="alert">
								<span>{error}</span>
								<button
									className="icon-button"
									type="button"
									title="重试加载子对话"
									onClick={() => setRetry((value) => value + 1)}
								>
									<RefreshCw size={15} />
								</button>
							</div>
						)}
						{disabled && (
							<div className="child-conversation-error" role="status">
								连接已断开
							</div>
						)}
					</div>
				</section>
			)}
		</div>
	);
}

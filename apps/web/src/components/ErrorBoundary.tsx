import { AlertTriangle, ClipboardCopy, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Describes a thrown value that is not an `Error`, which is legal in JavaScript
 * and does happen — a rejected string, a DOM exception, `undefined` from a
 * bundling accident. The formatter runs while the app is already broken, so it
 * must not become the second crash: every branch returns a string, and
 * `JSON.stringify` is guarded because it throws on cycles and on objects whose
 * getters throw, and returns `undefined` for a `toJSON` that does.
 */
function describeThrown(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null) {
		try {
			const json = JSON.stringify(value);
			if (typeof json === "string") return json;
		} catch {
			// Fall through to the tag below.
		}
		return Object.prototype.toString.call(value);
	}
	return String(value);
}

/** The one line of the failure worth putting in front of the reader. */
export function crashSummary(error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.trim();
		if (message) return `${error.name}: ${message}`;
		return error.name;
	}
	const described = describeThrown(error).trim();
	return described || "未知错误";
}

/**
 * The whole diagnostic, as one block of text to hand back to a developer.
 *
 * React's component stack is the part a JavaScript stack cannot supply — it
 * names the component that threw — so it is kept even when the error carries a
 * stack of its own.
 */
export function crashReport(error: unknown, componentStack?: string | null): string {
	const sections = [error instanceof Error && error.stack?.trim() ? error.stack.trim() : crashSummary(error)];
	// React opens the component stack with a blank line, which has to go, but the
	// indentation on the first frame is what lines it up with the rest, so a plain
	// `trim()` would leave the pasted report ragged.
	const stack = componentStack?.replace(/^\s*\n/, "").trimEnd();
	if (stack) sections.push(`组件栈:\n${stack}`);
	return sections.join("\n\n");
}

type BoundaryProps = { children: ReactNode };
type BoundaryState = {
	crashed: boolean;
	error: unknown;
	componentStack: string;
	copy: "idle" | "done" | "failed";
};

/**
 * Catches a render error anywhere below it.
 *
 * Without this, a single bad value in a transcript unmounts the entire
 * interface: React clears the root, the page goes white, and the only trace is
 * in a console the reader is unlikely to have open. The session itself is
 * safe — every turn is already persisted server-side — so the honest fallback
 * says so, offers to re-render or reload, and keeps the diagnostic reachable
 * without asking anyone to reproduce the crash.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
	state: BoundaryState = { crashed: false, error: null, componentStack: "", copy: "idle" };

	static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
		return { crashed: true, error, copy: "idle" };
	}

	componentDidCatch(error: unknown, info: ErrorInfo): void {
		// A production build reports nowhere else, and the component stack only
		// exists here.
		console.error("Wuming interface crashed", error, info.componentStack);
		this.setState({ componentStack: info.componentStack ?? "" });
	}

	private retry = (): void => {
		this.setState({ crashed: false, error: null, componentStack: "", copy: "idle" });
	};

	private reload = (): void => {
		window.location.reload();
	};

	private copy = (): void => {
		const report = crashReport(this.state.error, this.state.componentStack);
		if (!navigator.clipboard) {
			this.setState({ copy: "failed" });
			return;
		}
		void navigator.clipboard
			.writeText(report)
			.then(() => this.setState({ copy: "done" }))
			.catch(() => this.setState({ copy: "failed" }));
	};

	render(): ReactNode {
		if (!this.state.crashed) return this.props.children;
		return (
			<div className="empty-state" role="alert">
				<div className="empty-icon">
					<AlertTriangle size={24} />
				</div>
				<h2>界面渲染出错了</h2>
				<p>会话内容已经保存在服务端，重新渲染或刷新页面都不会丢失记录。</p>
				<p>{crashSummary(this.state.error)}</p>
				<div className="failure-actions">
					<button type="button" onClick={this.retry}>
						<RotateCcw size={13} />
						<span>重新渲染</span>
					</button>
					<button type="button" onClick={this.reload}>
						<span>刷新页面</span>
					</button>
					<button type="button" onClick={this.copy}>
						<ClipboardCopy size={13} />
						<span>
							{this.state.copy === "done" ? "已复制" : this.state.copy === "failed" ? "复制失败" : "复制错误详情"}
						</span>
					</button>
				</div>
			</div>
		);
	}
}

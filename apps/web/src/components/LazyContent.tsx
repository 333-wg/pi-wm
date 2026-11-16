import { Component, Suspense, type ReactNode } from "react";
import { useT } from "../lib/locale.js";
import { useFocusTrap } from "../use-focus-trap.js";

class PanelBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function LoadingDialog({ onClose, failed = false }: { onClose: () => void; failed?: boolean }) {
	const t = useT();
	const dialog = useFocusTrap<HTMLDivElement>();
	return (
		<div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
			<div
				className="shortcuts-dialog"
				role="dialog"
				aria-modal="true"
				aria-label={t(failed ? "loadingPanelFailed" : "loadingPanel")}
				ref={dialog}
				onMouseDown={(event) => event.stopPropagation()}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onClose();
					}
				}}
			>
				<div className="dialog-header">
					<span role={failed ? "alert" : "status"}>{t(failed ? "loadingPanelFailed" : "loadingPanel")}</span>
					<button type="button" onClick={onClose}>
						{t("close")}
					</button>
				</div>
			</div>
		</div>
	);
}

export function LazyContent({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
	const t = useT();
	return (
		<PanelBoundary
			fallback={
				onClose ? (
					<LoadingDialog onClose={onClose} failed />
				) : (
					<div className="workbench-empty" role="alert">
						{t("loadingPanelFailed")}
					</div>
				)
			}
		>
			<Suspense
				fallback={
					onClose ? (
						<LoadingDialog onClose={onClose} />
					) : (
						<div className="workbench-empty" role="status">
							{t("loadingPanel")}
						</div>
					)
				}
			>
				{children}
			</Suspense>
		</PanelBoundary>
	);
}

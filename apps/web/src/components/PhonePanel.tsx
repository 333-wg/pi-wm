import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import clover from "../assets/wuming-clover.png";

/** Local UI history only: Back dismisses a panel without leaving the conversation. */
export function PhonePanel({
	open,
	title,
	onClose,
	children,
	drawer = false,
	error,
}: {
	open: boolean;
	title: string;
	onClose: () => void;
	children: ReactNode;
	drawer?: boolean;
	error?: string;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		if (!open) return;
		const element = dialog.current!;
		const previous = document.activeElement as HTMLElement | null;
		const token = crypto.randomUUID();
		history.pushState({ ...history.state, phonePanel: token }, "", location.href);
		const pop = () => {
			if (history.state?.phonePanel !== token) close.current();
		};
		window.addEventListener("popstate", pop);
		element.showModal();
		return () => {
			window.removeEventListener("popstate", pop);
			element.close();
			if (history.state?.phonePanel === token) history.back();
			if (previous?.isConnected) previous.focus({ preventScroll: true });
		};
	}, [open]);
	return (
		<dialog
			ref={dialog}
			className={`phone-panel ${drawer ? "phone-drawer" : "phone-sheet"}`}
			aria-labelledby={drawer ? undefined : titleId}
			aria-label={drawer ? title : undefined}
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
			onClick={(e) => {
				if (e.target === e.currentTarget) {
					const r = e.currentTarget.getBoundingClientRect();
					if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
				}
			}}
		>
			<div className="phone-panel-heading">
				<h2 id={titleId}>
					{drawer ? (
						<>
							<img src={clover} alt="" />
							Pi-Wm
						</>
					) : (
						title
					)}
				</h2>
				<button type="button" className="phone-icon" aria-label={`关闭${title}`} onClick={onClose}>
					<X size={20} />
				</button>
			</div>
			<div className="phone-panel-body">
				{open && (
					<>
						{error && (
							<p role="alert" className="phone-error">
								{error}
							</p>
						)}
						{children}
					</>
				)}
			</div>
		</dialog>
	);
}

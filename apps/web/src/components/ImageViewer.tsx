import { Download, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../use-focus-trap.js";

export function ImageViewer({
	url,
	name,
	onClose,
	showDownload = true,
}: {
	url: string;
	name: string;
	onClose: () => void;
	showDownload?: boolean;
}) {
	const ref = useFocusTrap<HTMLDialogElement>();
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		dialog.showModal();
		return () => {
			dialog.close();
			document.body.style.overflow = overflow;
		};
	}, [ref]);

	return createPortal(
		<dialog
			ref={ref}
			className="image-viewer"
			aria-label={`预览 ${name}`}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
		>
			<header className="image-viewer-toolbar">
				<span className="image-viewer-name" title={name}>
					{name}
				</span>
				{showDownload && (
					<a href={url} download={name} className="icon-button" title="下载原图" aria-label="下载原图">
						<Download size={19} />
					</a>
				)}
				<button type="button" className="icon-button" title="关闭预览" aria-label="关闭预览" onClick={onClose}>
					<X size={21} />
				</button>
			</header>
			<div
				className="image-viewer-stage"
				onClick={(event) => {
					if (event.target === event.currentTarget) onClose();
				}}
			>
				<img src={url} alt={name} className="image-viewer-image" />
			</div>
		</dialog>,
		document.body
	);
}

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Image, LoaderCircle, Star, Trash2, Video } from "lucide-react";
import type { MediaKind } from "@wuming/protocol";
import "./media-model-remove-dialog.css";

export interface MediaModelRemoval {
	kind: MediaKind;
	name: string;
	id: string;
	baseUrl: string;
	active: boolean;
	remove: () => Promise<unknown>;
}

export function MediaModelRemoveDialog({
	model,
	connected,
	onClose,
}: {
	model: MediaModelRemoval;
	connected: boolean;
	onClose: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const pending = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const titleId = useId();
	const descriptionId = useId();
	const Icon = model.kind === "image" ? Image : Video;
	useEffect(() => {
		const element = dialog.current;
		const opener = document.activeElement;
		element?.showModal();
		return () => {
			element?.close();
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);
	async function remove() {
		if (pending.current || !connected) return;
		pending.current = true;
		setBusy(true);
		setError("");
		try {
			await model.remove();
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "移除失败，请重试");
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}
	return createPortal(
		<dialog
			ref={dialog}
			className="media-remove-dialog"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby={titleId}
			aria-describedby={descriptionId}
			aria-busy={busy}
			onCancel={(event) => {
				event.preventDefault();
				if (!pending.current) onClose();
			}}
			onKeyDown={(event) => event.stopPropagation()}
		>
			<header>
				<span className="media-remove-icon">
					<Trash2 size={20} aria-hidden="true" />
				</span>
				<div>
					<h2 id={titleId}>移除{model.kind === "image" ? "图片" : "视频"}模型？</h2>
					<p id={descriptionId}>将从已添加的模型中移除，之后可重新添加。</p>
				</div>
			</header>
			<div className="media-remove-model">
				<Icon size={18} aria-hidden="true" />
				<div className="media-remove-model-copy">
					<strong>{model.name}</strong>
					{model.id !== model.name && <span>{model.id}</span>}
					<span>{model.baseUrl}</span>
				</div>
			</div>
			{model.active && (
				<p className="media-remove-default">
					<Star size={14} aria-hidden="true" />
					这是当前默认模型，移除后请确认新的默认模型。
				</p>
			)}
			{error && (
				<p className="media-remove-error" role="alert">
					{error}
				</p>
			)}
			{!connected && (
				<p className="media-remove-error" role="status">
					连接已断开，请恢复连接后重试。
				</p>
			)}
			<footer>
				<button type="button" disabled={busy} onClick={onClose}>
					取消
				</button>
				<button
					type="button"
					className="media-remove-submit"
					disabled={busy || !connected}
					onClick={() => void remove()}
				>
					{busy ? (
						<LoaderCircle className="media-remove-spinner" size={15} aria-hidden="true" />
					) : (
						<Trash2 size={15} aria-hidden="true" />
					)}
					{busy ? "正在移除…" : "移除模型"}
				</button>
			</footer>
		</dialog>,
		document.body
	);
}

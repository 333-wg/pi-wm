import { useId, useRef, useState } from "react";
import { Check, ImagePlus, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { BACKGROUNDS, MAX_WALLPAPERS, wallpaperStyle } from "../lib/wallpaper.js";
import type { WallpaperState } from "../use-wallpaper.js";
import "./wallpaper.css";

export function WallpaperSettings({ wallpaper, locale }: { wallpaper: WallpaperState; locale: "zh" | "en" }) {
	const { settings, imageUrl, library, loaded, busy, error, update, importImage, selectImage, removeImage, reset } =
		wallpaper;
	const zh = locale === "zh";
	const [deleting, setDeleting] = useState<string>();
	const uploadRef = useRef<HTMLInputElement>(null);
	const uploadHelpId = useId();
	const imageName = (name: string) => name || (zh ? "原有壁纸" : "Previous wallpaper");
	const messages: Record<string, string> = zh
		? {
				limit: `最多保存 ${MAX_WALLPAPERS} 张壁纸，请删除不需要的图片后再添加。`,
				delete: "删除失败，本地存储不可用。壁纸仍保留，请稍后重试。",
				format: "仅支持 PNG、JPEG 或 WebP 图片。",
				size: "请选择不超过 10 MB 的非空图片。",
				dimensions: "图片像素过多，请缩小到 4000 万像素以内。",
				missing: "已保存的壁纸不可用，请重新导入。",
				storage: "无法保存或读取本地设置；当前调整可能仅在本次使用中有效。",
				import: "图片导入失败：文件无法解码或本地存储不可用。原有背景未被切换。",
			}
		: {
				limit: `Save up to ${MAX_WALLPAPERS} wallpapers. Remove an image before adding another.`,
				delete: "Could not delete the wallpaper. It is still saved; try again later.",
				format: "Use a PNG, JPEG or WebP image.",
				size: "Choose a non-empty image up to 10 MB.",
				dimensions: "Resize the image to at most 40 million pixels.",
				missing: "Saved wallpaper is unavailable. Import it again.",
				storage: "Local preferences could not be saved or loaded. Changes may only last for this session.",
				import:
					"Import failed: the image could not be decoded or local storage is unavailable. The current background was not switched.",
			};
	return (
		<fieldset className="wallpaper-settings" disabled={busy}>
			<legend>{zh ? "壁纸与氛围" : "Wallpaper & atmosphere"}</legend>
			<p className="wallpaper-help">
				{zh
					? "一张背景贯穿整个窗口，自动搭配按钮、文字和面板颜色。经典配色独立保留。"
					: "One continuous background with coordinated controls, text and surfaces. Classic palettes remain saved separately."}
			</p>
			<div className="wallpaper-options">
				{BACKGROUNDS.map((entry) => (
					<button
						key={entry.id}
						type="button"
						aria-pressed={settings.kind === entry.id}
						disabled={entry.id === "image" && !imageUrl}
						onClick={() => update({ kind: entry.id })}
					>
						<span
							className="wallpaper-option-art"
							aria-hidden="true"
							style={wallpaperStyle({ ...settings, kind: entry.id }, imageUrl)}
						/>
						{entry[locale]}
					</button>
				))}
			</div>
			<section className="wallpaper-library" aria-label={zh ? "我的壁纸" : "My wallpapers"}>
				<div className="wallpaper-library-heading">
					<strong>{zh ? "我的壁纸" : "My wallpapers"}</strong>
					<span>
						{library.length} / {MAX_WALLPAPERS}
					</span>
				</div>
				<p className="wallpaper-help">
					{zh
						? "添加后保存在本机，点击缩略图即可切换，无需重复导入。"
						: "Saved locally. Click a thumbnail to switch without importing again."}
				</p>
				{!loaded ? (
					<p className="wallpaper-help" role="status">
						{zh ? "正在读取壁纸…" : "Loading wallpapers…"}
					</p>
				) : library.length === 0 ? (
					<p className="wallpaper-library-empty">
						{zh ? "还没有收藏壁纸，添加一张喜欢的图片吧。" : "No saved wallpapers yet. Add an image you like."}
					</p>
				) : (
					<div className="wallpaper-library-grid">
						{library.map((image) => {
							const active = settings.kind === "image" && settings.imageRevision === image.id;
							const name = imageName(image.name);
							return (
								<div className="wallpaper-library-card" key={image.id} data-active={active}>
									<button
										className="wallpaper-library-select"
										type="button"
										aria-label={`${zh ? "使用壁纸" : "Use wallpaper"}：${name}`}
										aria-pressed={active}
										onClick={() => {
											setDeleting(undefined);
											selectImage(image.id);
										}}
									>
										<img src={image.url} alt="" loading="lazy" />
										<span className="wallpaper-library-name" title={name}>
											{name}
										</span>
										{active && (
											<span className="wallpaper-library-badge">
												<Check size={12} />
												{zh ? "使用中" : "Active"}
											</span>
										)}
									</button>
									{deleting === image.id ? (
										<div
											className="wallpaper-delete-confirm"
											role="group"
											aria-label={zh ? "确认删除壁纸" : "Confirm wallpaper deletion"}
										>
											<p>
												{active
													? zh
														? "删除后将切换为无背景。"
														: "Deleting switches to no background."
													: zh
														? "从本地壁纸库删除？"
														: "Remove from your local library?"}
											</p>
											<div>
												<button type="button" onClick={() => setDeleting(undefined)}>
													{zh ? "取消" : "Cancel"}
												</button>
												<button
													type="button"
													className="wallpaper-delete-danger"
													onClick={() =>
														void removeImage(image.id).then((removed) => {
															if (removed) setDeleting(undefined);
														})
													}
												>
													{zh ? "确认删除" : "Delete"}
												</button>
											</div>
										</div>
									) : (
										<button
											className="wallpaper-library-delete"
											type="button"
											aria-label={`${zh ? "删除壁纸" : "Delete wallpaper"}：${name}`}
											onClick={() => setDeleting(image.id)}
										>
											<Trash2 size={13} />
											{zh ? "删除" : "Delete"}
										</button>
									)}
								</div>
							);
						})}
					</div>
				)}
			</section>
			<div className="wallpaper-upload">
				<div className="wallpaper-upload-row">
					<span className="wallpaper-upload-icon" aria-hidden="true">
						<ImagePlus size={21} />
					</span>
					<div className="wallpaper-upload-copy">
						<strong>{zh ? "收藏一张喜欢的壁纸" : "Make your space yours"}</strong>
						<span>PNG / JPEG / WebP · {zh ? "最大 10 MB" : "Up to 10 MB"}</span>
					</div>
					<button
						type="button"
						className="wallpaper-upload-button"
						disabled={busy}
						aria-describedby={uploadHelpId}
						aria-busy={busy}
						onClick={() => uploadRef.current?.click()}
					>
						<Plus size={15} aria-hidden="true" />
						{busy ? (zh ? "正在处理…" : "Working…") : zh ? "添加壁纸" : "Add wallpaper"}
					</button>
				</div>
				<input
					ref={uploadRef}
					hidden
					type="file"
					aria-label={zh ? "添加壁纸" : "Add wallpaper"}
					accept="image/png,image/jpeg,image/webp"
					onChange={(event) => {
						const file = event.currentTarget.files?.[0];
						event.currentTarget.value = "";
						if (file) {
							setDeleting(undefined);
							void importImage(file);
						}
					}}
				/>
				<p className="wallpaper-upload-note" id={uploadHelpId}>
					<ShieldCheck size={13} aria-hidden="true" />
					<span>
						{zh
							? "仅保存在本机，不上传。请使用有权使用的图片。"
							: "Stored only on this device, never uploaded. Use images you have rights to."}
					</span>
				</p>
			</div>
			{settings.kind !== "none" && (
				<>
					<div
						className="wallpaper-preview"
						style={wallpaperStyle(settings, imageUrl)}
						aria-label={zh ? "壁纸预览" : "Wallpaper preview"}
					>
						<div className="wallpaper-preview-art" aria-hidden="true" />
						<div className="wallpaper-preview-surface">
							<strong>Pi-Wm</strong>
							<span>{zh ? "专注创造，保留氛围" : "Stay focused, make it yours"}</span>
						</div>
					</div>
					<label className="wallpaper-strength">
						<span>
							{zh ? "背景强度" : "Background strength"}
							<output>{100 - settings.shade}%</output>
						</span>
						<input
							type="range"
							aria-label={zh ? "背景强度" : "Background strength"}
							min={10}
							max={100}
							value={100 - settings.shade}
							onChange={(event) => update({ shade: 100 - Number(event.target.value) })}
						/>
					</label>
					<p className="wallpaper-help">
						{zh
							? "100% 不叠加全屏遮罩，保留壁纸原本的明暗。文字不易辨认时可降低强度，或在高级调整中提高面板浓度。"
							: "100% removes the full-window veil and preserves the wallpaper’s original brightness. Lower the strength or increase surface intensity in advanced adjustments if text is hard to read."}
					</p>
					<details className="wallpaper-advanced">
						<summary>{zh ? "高级调整" : "Advanced adjustments"}</summary>
						<div className="wallpaper-controls">
							{(
								[
									["shade", zh ? "背景遮罩" : "Background veil", 0, 90],
									["opacity", zh ? "面板浓度" : "Surface intensity", 60, 100],
									["blur", zh ? "背景模糊" : "Background blur", 0, 16],
									...(settings.kind === "image"
										? [
												["focusX", zh ? "水平焦点" : "Horizontal focus", 0, 100],
												["focusY", zh ? "垂直焦点" : "Vertical focus", 0, 100],
											]
										: []),
								] as ["shade" | "opacity" | "blur" | "focusX" | "focusY", string, number, number][]
							).map(([key, label, min, max]) => (
								<label key={key}>
									<span>
										{label}
										<output>
											{settings[key]}
											{key === "blur" ? "px" : "%"}
										</output>
									</span>
									<input
										type="range"
										aria-label={label}
										min={min}
										max={max}
										value={settings[key]}
										onChange={(event) => update({ [key]: Number(event.target.value) })}
									/>
								</label>
							))}
						</div>
					</details>
					{settings.kind !== "image" && (
						<label className="wallpaper-motion">
							<input
								type="checkbox"
								checked={settings.motion}
								onChange={(event) => update({ motion: event.target.checked })}
							/>
							{zh ? "缓慢流动（遵循系统减少动态效果设置）" : "Slow motion (respects reduced motion)"}
						</label>
					)}
				</>
			)}
			{error && (
				<p className="wallpaper-error" role="alert">
					{messages[error] ?? messages.import}
				</p>
			)}
			<button type="button" className="wallpaper-reset" onClick={reset}>
				{zh ? "恢复默认背景" : "Reset background"}
			</button>
		</fieldset>
	);
}

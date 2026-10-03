import type { CSSProperties } from "react";

export const WALLPAPER_KEY = "wuming.appearance.background.v1";
export type BackgroundKind = "none" | "aurora" | "dusk" | "image";
export interface WallpaperPreferences {
	version: 1;
	kind: BackgroundKind;
	focusX: number;
	focusY: number;
	shade: number;
	blur: number;
	opacity: number;
	motion: boolean;
	imageRevision: string;
}
export const DEFAULT_WALLPAPER: WallpaperPreferences = {
	version: 1,
	kind: "none",
	focusX: 50,
	focusY: 50,
	shade: 40,
	blur: 0,
	opacity: 82,
	motion: false,
	imageRevision: "",
};
export const BACKGROUNDS = [
	{ id: "none", zh: "无背景", en: "None" },
	{ id: "aurora", zh: "青绿极光", en: "Aurora" },
	{ id: "dusk", zh: "暮色流光", en: "Dusk" },
	{ id: "image", zh: "自定义壁纸", en: "Custom image" },
] as const;
export const GRADIENTS = {
	aurora:
		"radial-gradient(ellipse at 85% 15%, #65d6ae 0%, transparent 55%), radial-gradient(ellipse at 15% 85%, #547eab 0%, transparent 60%), linear-gradient(135deg, #123d35, #1c2847)",
	dusk: "radial-gradient(ellipse at 85% 20%, #e4ad82 0%, transparent 55%), radial-gradient(ellipse at 20% 85%, #8a719c 0%, transparent 60%), linear-gradient(135deg, #343451, #704951)",
};
function bounded(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
export function normalizeWallpaper(value: unknown): WallpaperPreferences {
	if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1)
		return { ...DEFAULT_WALLPAPER };
	const v = value as Record<string, unknown>;
	return {
		version: 1,
		kind: BACKGROUNDS.some((entry) => entry.id === v.kind) ? (v.kind as BackgroundKind) : "none",
		focusX: bounded(v.focusX, 50, 0, 100),
		focusY: bounded(v.focusY, 50, 0, 100),
		shade: bounded(v.shade, 40, 0, 90),
		blur: bounded(v.blur, 0, 0, 16),
		opacity: bounded(v.opacity, 82, 60, 100),
		motion: v.motion === true,
		imageRevision:
			typeof v.imageRevision === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(v.imageRevision) ? v.imageRevision : "",
	};
}
export function readWallpaper(storage: Pick<Storage, "getItem"> | undefined): WallpaperPreferences {
	try {
		return normalizeWallpaper(JSON.parse(storage?.getItem(WALLPAPER_KEY) ?? "null"));
	} catch {
		return { ...DEFAULT_WALLPAPER };
	}
}
export function wallpaperStyle(settings: WallpaperPreferences, imageUrl?: string): CSSProperties {
	const background =
		settings.kind === "image"
			? imageUrl
				? `url(${JSON.stringify(imageUrl)})`
				: "none"
			: settings.kind === "none"
				? "none"
				: GRADIENTS[settings.kind];
	return {
		"--wallpaper-art": background,
		"--wallpaper-position": `${settings.focusX}% ${settings.focusY}%`,
		"--wallpaper-shade": `${settings.shade}%`,
		"--wallpaper-blur": `${settings.blur}px`,
		"--wallpaper-panel": `${settings.opacity}%`,
	} as CSSProperties;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export function validateWallpaperFile(file: Pick<File, "size" | "type">): void {
	if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("format");
	if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new Error("size");
}
/** Decode and re-encode locally: no SVG, remote URL, metadata or executable theme payload. */
export async function prepareWallpaper(file: File): Promise<Blob> {
	validateWallpaperFile(file);
	const image = await createImageBitmap(file);
	try {
		if (image.width * image.height > 40_000_000) throw new Error("dimensions");
		const scale = Math.min(1, 2560 / Math.max(image.width, image.height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(image.width * scale));
		canvas.height = Math.max(1, Math.round(image.height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("decode");
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("decode"))), "image/webp", 0.9)
		);
	} finally {
		image.close();
	}
}

export const WALLPAPER_LIBRARY_KEY = "wuming.appearance.library.v1";
export const MAX_WALLPAPERS = 24;
export interface WallpaperImage {
	id: string;
	name: string;
	createdAt: number;
	blob: Blob;
	thumbnail: Blob;
	accent: string;
}

export async function wallpaperThumbnail(blob: Blob): Promise<Blob> {
	const image = await createImageBitmap(blob);
	try {
		const scale = Math.min(1, 320 / Math.max(image.width, image.height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(image.width * scale));
		canvas.height = Math.max(1, Math.round(image.height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("decode");
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("decode"))), "image/webp", 0.8)
		);
	} finally {
		image.close();
	}
}

/** Image bytes stay in IndexedDB, never localStorage or the user's project files. */
async function imageStore<T>(
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open("wuming-appearance", 1);
		request.onupgradeneeded = () => request.result.createObjectStore("images");
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error("storage-blocked"));
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => db.close();
			try {
				const transaction = db.transaction("images", mode);
				transaction.onabort = transaction.onerror = () => {
					db.close();
					reject(transaction.error ?? new Error("storage"));
				};
				const result = operation(transaction.objectStore("images"));
				transaction.oncomplete = () => {
					db.close();
					resolve(result.result);
				};
			} catch (error) {
				db.close();
				reject(error);
			}
		};
	});
}
/** Migrate the old singleton atomically, including images retained while wallpaper is off.
 * Keep the selected revision as its ID so existing preferences remain valid. */
export async function listWallpaperImages(legacyId: string): Promise<WallpaperImage[]> {
	await imageStore("readwrite", (store) => {
		const request = store.get("custom");
		request.onsuccess = () => {
			if (!(request.result instanceof Blob)) return;
			try {
				const id = /^[a-zA-Z0-9-]{1,80}$/.test(legacyId) ? legacyId : "legacy-custom";
				const blob = request.result;
				store.delete("custom");
				store.put({ id, name: "", createdAt: 0, blob, thumbnail: blob, accent: "" } satisfies WallpaperImage, id);
			} catch {
				store.transaction.abort();
			}
		};
		return request;
	});
	const values = await imageStore<unknown[]>("readonly", (store) => store.getAll());
	return values
		.filter((value): value is WallpaperImage => {
			if (!value || typeof value !== "object") return false;
			const item = value as WallpaperImage;
			return (
				typeof item.id === "string" &&
				typeof item.name === "string" &&
				item.blob instanceof Blob &&
				item.thumbnail instanceof Blob &&
				typeof item.createdAt === "number"
			);
		})
		.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export async function saveWallpaperImage(image: WallpaperImage): Promise<void> {
	let full = false;
	await imageStore("readwrite", (store) => {
		const request = store.count();
		request.onsuccess = () => {
			if (request.result >= MAX_WALLPAPERS) {
				full = true;
				return;
			}
			try {
				store.add(image, image.id);
			} catch {
				store.transaction.abort();
			}
		};
		return request;
	});
	if (full) throw new Error("limit");
}

export async function deleteWallpaperImage(id: string): Promise<void> {
	await imageStore("readwrite", (store) => store.delete(id));
}

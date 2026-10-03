import { useCallback, useEffect, useRef, useState } from "react";
import { themeStorage } from "./lib/theme.js";
import { FALLBACK_WALLPAPER_ACCENT, readWallpaperAccent } from "./lib/wallpaper-palette.js";
import {
	DEFAULT_WALLPAPER,
	WALLPAPER_KEY,
	WALLPAPER_LIBRARY_KEY,
	deleteWallpaperImage,
	listWallpaperImages,
	normalizeWallpaper,
	prepareWallpaper,
	readWallpaper,
	saveWallpaperImage,
	wallpaperThumbnail,
	type WallpaperImage,
	type WallpaperPreferences,
} from "./lib/wallpaper.js";

export function useWallpaper() {
	const [settings, setSettings] = useState(() => readWallpaper(themeStorage()));
	const [images, setImages] = useState<WallpaperImage[]>([]);
	const [library, setLibrary] = useState<(WallpaperImage & { url: string })[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [revision, setRevision] = useState(0);
	const [imageUrl, setImageUrl] = useState<string>();
	const [imageAccent, setImageAccent] = useState(FALLBACK_WALLPAPER_ACCENT);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const operating = useRef(false);
	const current = useRef(settings);
	const channel = useRef<BroadcastChannel | undefined>(undefined);
	current.current = settings;

	const update = useCallback((patch: Partial<WallpaperPreferences>) => {
		const next = normalizeWallpaper({ ...current.current, ...patch });
		current.current = next;
		setSettings(next);
		try {
			const storage = themeStorage();
			if (!storage) throw new Error("storage");
			storage.setItem(WALLPAPER_KEY, JSON.stringify(next));
			setError("");
		} catch {
			setError("storage");
		}
	}, []);

	const refreshLibrary = useCallback(() => {
		setRevision((value) => value + 1);
		channel.current?.postMessage("changed");
		try {
			themeStorage()?.setItem(WALLPAPER_LIBRARY_KEY, crypto.randomUUID());
		} catch {
			// IndexedDB committed successfully; BroadcastChannel still synchronizes open tabs.
		}
	}, []);

	useEffect(() => {
		const sync = (event: StorageEvent) => {
			if (event.key === WALLPAPER_KEY || event.key === null) {
				const next = readWallpaper(themeStorage());
				current.current = next;
				setSettings(next);
			}
			if (event.key === WALLPAPER_LIBRARY_KEY || event.key === WALLPAPER_KEY || event.key === null)
				setRevision((value) => value + 1);
		};
		window.addEventListener("storage", sync);
		if (typeof BroadcastChannel !== "undefined") {
			channel.current = new BroadcastChannel(WALLPAPER_LIBRARY_KEY);
			channel.current.onmessage = () => setRevision((value) => value + 1);
		}
		return () => {
			window.removeEventListener("storage", sync);
			channel.current?.close();
			channel.current = undefined;
		};
	}, []);

	useEffect(() => {
		let active = true;
		void listWallpaperImages(current.current.imageRevision)
			.then((items) => {
				if (!active) return;
				setImages(items);
				setLoaded(true);
				const selected = current.current.imageRevision;
				if (selected && !items.some((item) => item.id === selected)) {
					update({ imageRevision: "", ...(current.current.kind === "image" ? { kind: "none" } : {}) });
					setError("missing");
				} else if (!selected && items.some((item) => item.id === "legacy-custom")) {
					update({ imageRevision: "legacy-custom" });
				}
			})
			.catch(() => {
				if (active) {
					setLoaded(true);
					setError("storage");
				}
			});
		return () => {
			active = false;
		};
	}, [revision, update]);

	useEffect(() => {
		const entries = images.map((item) => ({ ...item, url: URL.createObjectURL(item.thumbnail) }));
		setLibrary(entries);
		return () => {
			for (const item of entries) URL.revokeObjectURL(item.url);
		};
	}, [images]);

	const selectedImage = images.find((item) => item.id === settings.imageRevision);
	useEffect(() => {
		let active = true;
		setImageUrl(undefined);
		setImageAccent(FALLBACK_WALLPAPER_ACCENT);
		if (!selectedImage) return;
		const url = URL.createObjectURL(selectedImage.blob);
		setImageUrl(url);
		if (selectedImage.accent) setImageAccent(selectedImage.accent);
		else
			void readWallpaperAccent(selectedImage.blob)
				.then((accent) => {
					if (active) setImageAccent(accent);
				})
				.catch(() => {
					/* Sampling must not discard a valid legacy image. */
				});
		return () => {
			active = false;
			URL.revokeObjectURL(url);
		};
	}, [selectedImage]);

	const selectImage = useCallback(
		(id: string) => {
			if (operating.current || !images.some((item) => item.id === id)) return;
			update({ kind: "image", imageRevision: id, focusX: 50, focusY: 50 });
		},
		[images, update]
	);

	const importImage = useCallback(
		async (file: File) => {
			if (operating.current) return;
			operating.current = true;
			setBusy(true);
			setError("");
			try {
				const blob = await prepareWallpaper(file);
				const [thumbnail, accent] = await Promise.all([
					wallpaperThumbnail(blob),
					readWallpaperAccent(blob).catch(() => FALLBACK_WALLPAPER_ACCENT),
				]);
				const item: WallpaperImage = {
					id: crypto.randomUUID(),
					name: file.name.slice(0, 200),
					createdAt: Date.now(),
					blob,
					thumbnail,
					accent,
				};
				// Await initial migration before inserting, even if the user imports immediately after opening settings.
				await listWallpaperImages(current.current.imageRevision);
				await saveWallpaperImage(item);
				setImages((existing) => [item, ...existing]);
				update({ kind: "image", imageRevision: item.id, focusX: 50, focusY: 50 });
				refreshLibrary();
			} catch (reason) {
				const code = reason instanceof Error ? reason.message : "decode";
				setError(["format", "size", "dimensions", "limit"].includes(code) ? code : "import");
			} finally {
				operating.current = false;
				setBusy(false);
			}
		},
		[update, refreshLibrary]
	);

	const removeImage = useCallback(
		async (id: string): Promise<boolean> => {
			if (operating.current) return false;
			operating.current = true;
			setBusy(true);
			setError("");
			try {
				await deleteWallpaperImage(id);
				setImages((items) => items.filter((item) => item.id !== id));
				if (current.current.imageRevision === id)
					update({ imageRevision: "", ...(current.current.kind === "image" ? { kind: "none" } : {}) });
				refreshLibrary();
				return true;
			} catch {
				setError("delete");
				return false;
			} finally {
				operating.current = false;
				setBusy(false);
			}
		},
		[update, refreshLibrary]
	);

	// Reset appearance only; the library and last selected image stay available.
	const reset = useCallback(
		() => update({ ...DEFAULT_WALLPAPER, imageRevision: current.current.imageRevision }),
		[update]
	);
	const accent = settings.kind === "aurora" ? "#65bda2" : settings.kind === "dusk" ? "#b88b9e" : imageAccent;
	return {
		settings,
		imageUrl,
		accent,
		library,
		loaded,
		busy,
		error,
		update,
		importImage,
		selectImage,
		removeImage,
		reset,
	};
}
export type WallpaperState = ReturnType<typeof useWallpaper>;

import type { ArtifactRef } from "@wuming/protocol";

export interface DirectoryAttachmentInput {
	kind: "directory";
	name: string;
	path?: string;
}
export type AttachmentInput = File | DirectoryAttachmentInput;

/** Presentation only; filesystem access is still checked by the gateway grant store. */
export function directoryAttachmentName(artifact: ArtifactRef): string | undefined {
	if (artifact.mimeType !== "text/x-wuming-directory") return undefined;
	return artifact.name.replace(/\.directory\.json$/, "");
}

/** Capture native paths during the drop; never enumerate or pack a directory. */
export function droppedAttachments(transfer: DataTransfer, pathForFile?: (file: File) => string): AttachmentInput[] {
	const items = Array.from(transfer.items).filter((item) => item.kind === "file");
	if (items.length === 0) return Array.from(transfer.files);
	return items.flatMap((item): AttachmentInput[] => {
		const entry = item.webkitGetAsEntry?.();
		const file = item.getAsFile?.();
		if (entry?.isDirectory) {
			let path: string | undefined;
			try { path = file && pathForFile?.(file) || undefined; } catch { /* Browser-only File. */ }
			return [{ kind: "directory", name: entry.name, ...(path ? { path } : {}) }];
		}
		return file ? [file] : [];
	});
}

export async function readUploadedArtifact(response: Response): Promise<ArtifactRef> {
	const value: unknown = await response.json().catch(() => undefined);
	const body = value && typeof value === "object" ? (value as { artifact?: ArtifactRef; error?: unknown }) : undefined;
	if (!response.ok || !body?.artifact) {
		const fallback = [502, 503, 504].includes(response.status)
			? "本地服务暂时不可用，请确认服务运行后重试"
			: `上传失败，状态码 ${response.status}`;
		throw new Error(typeof body?.error === "string" && body.error ? body.error : fallback);
	}
	return body.artifact;
}

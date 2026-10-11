import { describe, expect, it, vi } from "vitest";
import { directoryAttachmentName, droppedAttachments, readUploadedArtifact } from "../src/lib/attachment-upload.js";
function transfer(items: unknown[], files: File[] = []) { return { items, files } as unknown as DataTransfer; }
describe("directory references", () => {
	it("uses an explicit directory media type, not a filename, for folder presentation", () => {
		const ref = { id: "ref", name: "项目.directory.json", mimeType: "text/x-wuming-directory", size: 200 };
		expect(directoryAttachmentName(ref)).toBe("项目");
		expect(directoryAttachmentName({ ...ref, name: "nested.directory.json.directory.json" })).toBe("nested.directory.json");
		expect(directoryAttachmentName({ ...ref, mimeType: "application/json" })).toBeUndefined();
		expect(directoryAttachmentName({ ...ref, mimeType: "text/plain" })).toBeUndefined();
	});
	it("captures a native directory path without enumerating or reading 2000+ entries", () => {
		const createReader = vi.fn(() => { throw new Error("must not walk"); });
		const file = new File([], "项目");
		const data = transfer([{ kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: true, name: "项目", createReader }) }]);
		expect(droppedAttachments(data, () => "D:\\项目")).toEqual([{ kind: "directory", name: "项目", path: "D:\\项目" }]);
		expect(createReader).not.toHaveBeenCalled();
		expect(droppedAttachments(data)).toEqual([{ kind: "directory", name: "项目" }]);
	});
	it("preserves ordinary files in mixed drops and fallback providers", () => {
		const file = new File(["hello"], "file.txt");
		expect(droppedAttachments(transfer([], [file]))).toEqual([file]);
		expect(droppedAttachments(transfer([{ kind: "file", getAsFile: () => file }, { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true, name: "empty" }) }]))).toEqual([file, { kind: "directory", name: "empty" }]);
	});
});
describe("upload responses", () => {
	it("returns artifacts and preserves errors", async () => {
		const artifact = { id: "fixture", name: "file.txt" };
		await expect(readUploadedArtifact(Response.json({ artifact }, { status: 201 }))).resolves.toEqual(artifact);
		await expect(readUploadedArtifact(Response.json({ error: "denied" }, { status: 403 }))).rejects.toThrow("denied");
	});
	it("handles non-JSON proxies and malformed success", async () => {
		for (const status of [502, 503, 504]) await expect(readUploadedArtifact(new Response("Local service unavailable", { status }))).rejects.toThrow("本地服务暂时不可用");
		for (const body of [null, {}, { error: {} }]) await expect(readUploadedArtifact(Response.json(body))).rejects.toThrow("上传失败，状态码 200");
	});
});

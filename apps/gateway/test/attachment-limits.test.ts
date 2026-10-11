import { expect, it } from "vitest";
import { fileAttachmentLimit } from "../src/attachment-limits.js";
it("removes the local file cap without expanding remote defaults", () => {
	expect(fileAttachmentLimit(true, 1024)).toBe(Infinity);
	expect(fileAttachmentLimit(false, 1024)).toBe(1024);
	expect(fileAttachmentLimit(true, 1024, "0")).toBe(Infinity);
	expect(fileAttachmentLimit(true, 1024, "2048")).toBe(2048);
	expect(() => fileAttachmentLimit(false, 1024, "0")).toThrow("local_device");
	for (const value of ["-1", "NaN", "Infinity", "1.5"]) expect(() => fileAttachmentLimit(true, 1024, value)).toThrow();
});

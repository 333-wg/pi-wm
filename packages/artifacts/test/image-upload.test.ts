import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, validateArtifact } from "../src/index.js";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64"
);

function segment(marker: number, data: number[]): Buffer {
	const header = Buffer.from([0xff, marker, 0, 0]);
	header.writeUInt16BE(data.length + 2, 2);
	return Buffer.concat([header, Buffer.from(data)]);
}

// Structural fixture: metadata contains a thumbnail EOI, scans include escaped
// bytes and restart markers. Browser tests also exercise real encoded images.
function jpeg(progressive = false): Buffer {
	const scan = segment(0xda, [1, 1, 0, 0, 63, 0]);
	return Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0xff, 0xd9]),
		segment(progressive ? 0xc2 : 0xc0, [8, 0, 2, 0, 3, 1, 1, 0x11, 0]),
		scan,
		Buffer.from([0x12, 0xff, 0x00, 0xd9, 0xff, 0xd0, 0x34]),
		...(progressive ? [segment(0xc4, [0]), scan, Buffer.from([0x56])] : []),
		Buffer.from([0xff, 0xd9]),
	]);
}

describe("local image uploads", () => {
	it.each(["", "application/octet-stream", "image/jpeg", "image/jpg", "text/plain"])(
		"detects the image instead of trusting the browser MIME %j",
		(suppliedMimeType) => {
			expect(validateArtifact({ name: "local-photo.jpg", suppliedMimeType, content: png })).toEqual({
				name: "local-photo.jpg",
				mimeType: "image/png",
				kind: "image",
				width: 1,
				height: 1,
			});
		}
	);

	it.each([false, true])("accepts complete JPEG scans with trailing export data (progressive=%s)", (progressive) => {
		for (const trailing of [Buffer.alloc(0), Buffer.from([0, 0]), Buffer.from("export metadata")]) {
			expect(
				validateArtifact({
					name: "local-photo.jpg",
					suppliedMimeType: "image/jpeg",
					content: Buffer.concat([jpeg(progressive), trailing]),
				})
			).toMatchObject({ mimeType: "image/jpeg", kind: "image", width: 3, height: 2 });
		}
	});

	it("rejects every truncated JPEG prefix, even with an EOI in metadata or stuffed scan data", () => {
		const content = jpeg();
		for (let end = 0; end < content.length; end++) {
			expect(() =>
				validateArtifact({
					name: "broken.jpg",
					suppliedMimeType: "image/jpeg",
					content: content.subarray(0, end),
				})
			).toThrowError(expect.objectContaining({ code: "invalid" }));
		}
	});

	it("rejects malformed segments and headers without a scan", () => {
		const malformed = jpeg();
		malformed.writeUInt16BE(0xffff, 4);
		const noScan = Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			segment(0xc0, [8, 0, 2, 0, 3, 1, 1, 0x11, 0]),
			Buffer.from([0xff, 0xd9]),
		]);
		for (const content of [malformed, noScan, Buffer.from("not an image")]) {
			expect(() => validateArtifact({ name: "broken.jpg", suppliedMimeType: "image/jpeg", content })).toThrowError(
				expect.objectContaining({ code: "invalid" })
			);
		}
	});

	it("still applies byte and pixel limits with incorrect or generic MIME hints", () => {
		const input = { name: "photo.jpg", suppliedMimeType: "application/octet-stream", content: jpeg() };
		for (const options of [{ maxFileBytes: 4 }, { maxImageBytes: 4 }, { maxImagePixels: 5 }]) {
			expect(() => validateArtifact(input, options)).toThrowError(expect.objectContaining({ code: "too_large" }));
		}
	});

	it("preserves the original filename and bytes while persisting the detected MIME", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-local-images-"));
		const store = await ArtifactStore.open(":memory:", join(root, "objects"));
		try {
			for (const [name, content, mimeType] of [
				["renamed.jpg", png, "image/png"],
				["export.jpg", Buffer.concat([jpeg(), Buffer.from("export metadata")]), "image/jpeg"],
			] as const) {
				const artifact = await store.create({
					workspaceId: "workspace",
					ownerId: "user",
					name,
					suppliedMimeType: "image/jpeg",
					content,
				});
				expect(artifact.ref).toMatchObject({ name, mimeType, size: content.length });
				expect(artifact.kind).toBe("image");
				expect((await store.read(artifact.ref.id)).content).toEqual(content);
			}
		} finally {
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore, validateArtifact } from "../src/index.js";

const cleanup: string[] = [];
const onePixelPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

afterEach(async () => {
	for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temporaryStore() {
	const directory = await mkdtemp(join(tmpdir(), "wuming-artifacts-"));
	cleanup.push(directory);
	let id = 0;
	const objects = join(directory, "objects");
	const store = await ArtifactStore.open(join(directory, "artifacts.db"), objects, {
		idFactory: () => `artifact-${++id}`,
		clock: () => 100,
	});
	return { directory, objects, store };
}

describe("ArtifactStore", () => {
	it("persists immutable UTF-8 artifacts and deduplicates content objects", async () => {
		const { objects, store } = await temporaryStore();
		const content = Buffer.from("export const answer = 42;\n", "utf8");
		const first = await store.create({
			workspaceId: "workspace-1",
			ownerId: "user-1",
			name: "answer.ts",
			suppliedMimeType: "application/octet-stream",
			content,
		});
		const second = await store.create({
			workspaceId: "workspace-1",
			ownerId: "user-1",
			name: "copy.ts",
			content,
		});
		expect(first.ref).toMatchObject({ id: "artifact-1", name: "answer.ts", mimeType: "text/plain", size: content.length });
		expect(second.ref.id).toBe("artifact-2");
		expect((await store.read(first.ref.id)).content).toEqual(content);
		const prefixes = await readdir(objects);
		expect(prefixes).toHaveLength(1);
		expect(await readdir(join(objects, prefixes[0] ?? ""))).toHaveLength(1);
		store.close();
	});

	it("validates workspace scope and immutable reference metadata", async () => {
		const { store } = await temporaryStore();
		const created = await store.create({
			workspaceId: "workspace-1",
			ownerId: "user-1",
			name: "notes.md",
			content: Buffer.from("notes"),
		});
		expect(() => store.assertReference(created.ref, "workspace-2")).toThrowError(expect.objectContaining({ code: "forbidden" }));
		expect(() => store.assertReference({ ...created.ref, size: created.ref.size + 1 }, "workspace-1")).toThrowError(
			expect.objectContaining({ code: "invalid" }),
		);
		store.close();
	});

	it("detects content corruption on read", async () => {
		const { objects, store } = await temporaryStore();
		const created = await store.create({
			workspaceId: "workspace-1",
			ownerId: "user-1",
			name: "notes.txt",
			content: Buffer.from("original"),
		});
		await writeFile(join(objects, created.sha256.slice(0, 2), created.sha256), "changed");
		await expect(store.read(created.ref.id)).rejects.toMatchObject({ code: "corrupt" });
		store.close();
	});
});

describe("artifact validation", () => {
	it("accepts a dimension-bounded PNG and normalizes its MIME", () => {
		expect(validateArtifact({ name: "pixel.png", suppliedMimeType: "image/png; charset=binary", content: onePixelPng })).toEqual({
			name: "pixel.png",
			mimeType: "image/png",
			kind: "image",
			width: 1,
			height: 1,
		});
	});

	it("rejects MIME spoofing, path-shaped names, invalid UTF-8, and pixel bombs", () => {
		expect(() => validateArtifact({ name: "fake.png", suppliedMimeType: "image/png", content: Buffer.from("not png") })).toThrowError(
			expect.objectContaining({ code: "invalid" }),
		);
		expect(() => validateArtifact({ name: "../secret.txt", content: Buffer.from("secret") })).toThrowError(
			expect.objectContaining({ code: "invalid" }),
		);
		expect(() => validateArtifact({ name: "broken.txt", content: Buffer.from([0xff, 0xfe]) })).toThrowError(
			expect.objectContaining({ code: "invalid" }),
		);
		const huge = Buffer.from(onePixelPng);
		huge.writeUInt32BE(100_000, 16);
		huge.writeUInt32BE(100_000, 20);
		expect(() => validateArtifact({ name: "huge.png", content: huge })).toThrowError(
			expect.objectContaining({ code: "too_large" }),
		);
	});
});

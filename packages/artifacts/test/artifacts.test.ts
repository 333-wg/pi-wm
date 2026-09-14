import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore, extractArtifact, validateArtifact } from "../src/index.js";

const cleanup: string[] = [];
const onePixelPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64"
);

/** A single-page PDF with one uncompressed text run and a valid cross-reference table. */
function pdfWithText(text: string): Buffer {
	const content = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET\n`;
	const objects = [
		"<</Type/Catalog/Pages 2 0 R>>",
		"<</Type/Pages/Kids[3 0 R]/Count 1>>",
		"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
		`<</Length ${content.length}>>stream\n${content}endstream`,
		"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [index, body] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
	}
	const xrefOffset = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

async function nodeStdout(args: string[]): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`probe exited with ${code}: ${stderr.slice(0, 2000)}`));
		});
	});
}

async function docxWithText(text: string): Promise<Buffer> {
	const zip = new JSZip();
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
	);
	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
	);
	zip.file(
		"word/document.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`
	);
	return zip.generateAsync({ type: "nodebuffer" });
}

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
		expect(first.ref).toMatchObject({
			id: "artifact-1",
			name: "answer.ts",
			mimeType: "text/plain",
			size: content.length,
		});
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
		expect(() => store.assertReference(created.ref, "workspace-2")).toThrowError(
			expect.objectContaining({ code: "forbidden" })
		);
		expect(() => store.assertReference({ ...created.ref, size: created.ref.size + 1 }, "workspace-1")).toThrowError(
			expect.objectContaining({ code: "invalid" })
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
		expect(
			validateArtifact({
				name: "pixel.png",
				suppliedMimeType: "image/png; charset=binary",
				content: onePixelPng,
			})
		).toEqual({
			name: "pixel.png",
			mimeType: "image/png",
			kind: "image",
			width: 1,
			height: 1,
		});
	});

	it("accepts UTF-8 files without relying on an extension whitelist", () => {
		expect(
			validateArtifact({
				name: "Component.vue",
				suppliedMimeType: "application/octet-stream",
				content: Buffer.from("<template><main>Hello</main></template>\n"),
			})
		).toEqual({ name: "Component.vue", mimeType: "text/plain", kind: "text" });
		expect(
			validateArtifact({
				name: "diagram.svg",
				suppliedMimeType: "image/svg+xml",
				content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
			})
		).toEqual({ name: "diagram.svg", mimeType: "text/plain", kind: "text" });
	});

	it("accepts arbitrary binary files and infers common document MIME types", () => {
		expect(
			validateArtifact({
				name: "report.docx",
				suppliedMimeType: "application/octet-stream",
				content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]),
			})
		).toEqual({
			name: "report.docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			kind: "binary",
		});
		expect(validateArtifact({ name: "archive.bin", content: Buffer.from([0xff, 0xfe]) })).toEqual({
			name: "archive.bin",
			mimeType: "application/octet-stream",
			kind: "binary",
		});
	});

	it("extracts readable text from DOCX attachments", async () => {
		const content = await docxWithText("Quarterly result: 42");
		await expect(
			extractArtifact({
				name: "report.docx",
				mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				content,
			})
		).resolves.toMatchObject({ text: "Quarterly result: 42" });
	});

	it("rejects MIME spoofing, path-shaped names, and pixel bombs", () => {
		expect(() =>
			validateArtifact({
				name: "fake.png",
				suppliedMimeType: "image/png",
				content: Buffer.from("not png"),
			})
		).toThrowError(expect.objectContaining({ code: "invalid" }));
		expect(() => validateArtifact({ name: "../secret.txt", content: Buffer.from("secret") })).toThrowError(
			expect.objectContaining({ code: "invalid" })
		);
		const huge = Buffer.from(onePixelPng);
		huge.writeUInt32BE(100_000, 16);
		huge.writeUInt32BE(100_000, 20);
		expect(() => validateArtifact({ name: "huge.png", content: huge })).toThrowError(
			expect.objectContaining({ code: "too_large" })
		);
	});
});

describe("PDF attachment extraction", () => {
	it("extracts text through the isolated worker", async () => {
		await expect(
			extractArtifact({
				name: "quarter.pdf",
				mimeType: "application/pdf",
				content: pdfWithText("Quarterly attachment: 42"),
			})
		).resolves.toEqual({ text: "Quarterly attachment: 42\n\n-- 1 of 1 --" });
	}, 30_000);

	it("degrades to a notice when the worker exits non-zero", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-pdf-worker-"));
		cleanup.push(directory);
		await expect(
			extractArtifact(
				{
					name: "quarter.pdf",
					mimeType: "application/pdf",
					content: pdfWithText("Quarterly attachment: 42"),
				},
				200_000,
				{ workerPath: join(directory, "absent-worker.js") }
			)
		).resolves.toEqual({
			notice: "The PDF attachment was uploaded, but its text could not be extracted.",
		});
	}, 30_000);

	it("degrades to a notice when the worker exceeds its time budget", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-pdf-worker-"));
		cleanup.push(directory);
		const workerPath = join(directory, "stalling-worker.js");
		await writeFile(workerPath, "setInterval(() => {}, 1000);\n");
		const started = Date.now();
		await expect(
			extractArtifact(
				{
					name: "quarter.pdf",
					mimeType: "application/pdf",
					content: pdfWithText("Quarterly attachment: 42"),
				},
				200_000,
				{ workerPath, timeoutMs: 250 }
			)
		).resolves.toEqual({
			notice: "The PDF attachment was uploaded, but its text could not be extracted within the time limit.",
		});
		expect(Date.now() - started).toBeLessThan(15_000);
	}, 30_000);

	it("degrades to a notice when the worker emits unparseable output", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-pdf-worker-"));
		cleanup.push(directory);
		const workerPath = join(directory, "garbage-worker.js");
		await writeFile(workerPath, 'process.stdout.write("not json at all");\n');
		await expect(
			extractArtifact(
				{
					name: "quarter.pdf",
					mimeType: "application/pdf",
					content: pdfWithText("Quarterly attachment: 42"),
				},
				200_000,
				{ workerPath }
			)
		).resolves.toEqual({
			notice: "The PDF attachment was uploaded, but its text could not be extracted.",
		});
	}, 30_000);

	// A worker that answers with well-formed but oversized JSON must be cut off by
	// the output cap rather than buffered into the Gateway's heap.
	it("caps worker output instead of buffering it without bound", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-pdf-worker-"));
		cleanup.push(directory);
		const workerPath = join(directory, "flooding-worker.js");
		await writeFile(workerPath, 'process.stdout.write(JSON.stringify({ text: "x".repeat(20000) }));\n');
		await expect(
			extractArtifact(
				{
					name: "quarter.pdf",
					mimeType: "application/pdf",
					content: pdfWithText("Quarterly attachment: 42"),
				},
				100,
				{ workerPath }
			)
		).resolves.toEqual({
			notice: "The PDF attachment was uploaded, but its text could not be extracted.",
		});
	}, 30_000);

	it("keeps pdfjs and its native bindings out of the package import graph", async () => {
		const entry = new URL("../src/index.ts", import.meta.url).href;
		const probe = [
			'import { registerHooks } from "node:module";',
			"const seen = [];",
			"registerHooks({ resolve(specifier, context, next) { seen.push(specifier); return next(specifier, context); } });",
			`await import(${JSON.stringify(entry)});`,
			"process.stdout.write(JSON.stringify(seen.filter((specifier) => /pdf|canvas/i.test(specifier))));",
		].join("\n");
		const resolved = await nodeStdout(["--import", "tsx", "--input-type=module", "-e", probe]);
		expect(JSON.parse(resolved)).toEqual([]);
	}, 60_000);
});

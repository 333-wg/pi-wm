import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { boundedText } from "./bounded-text.js";

export interface ArtifactExtraction {
	text?: string;
	notice?: string;
}

export interface PdfExtractionOptions {
	/** Wall-clock budget for one PDF worker run. */
	timeoutMs?: number;
	/** Heap ceiling for the PDF worker, in MiB. */
	maxOldSpaceMb?: number;
	/** Worker entry override; tests use it to exercise the failure paths. */
	workerPath?: string;
}

const DOCX_MIMES = new Set([
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-word.document.macroenabled.12",
]);

const PDF_FAILED_NOTICE = "The PDF attachment was uploaded, but its text could not be extracted.";
const PDF_EMPTY_NOTICE = "The PDF attachment contains no extractable text; it may be image-only.";
const PDF_TIMEOUT_NOTICE =
	"The PDF attachment was uploaded, but its text could not be extracted within the time limit.";
const DEFAULT_PDF_TIMEOUT_MS = 60_000;
const DEFAULT_PDF_MAX_OLD_SPACE_MB = 1024;

function extension(name: string): string {
	const index = name.lastIndexOf(".");
	return index >= 0 ? name.slice(index).toLowerCase() : "";
}

async function extractDocx(content: Buffer, maxChars: number): Promise<ArtifactExtraction> {
	try {
		const result = await mammoth.extractRawText({ buffer: content });
		const text = boundedText(result.value, maxChars);
		return text ? { text } : { notice: "The DOCX attachment contains no extractable text." };
	} catch {
		return { notice: "The DOCX attachment was uploaded, but its text could not be extracted." };
	}
}

/** Resolve the worker beside this module, matching the extension we are running from. */
function defaultPdfWorkerPath(): string {
	const specifier = import.meta.url.endsWith(".ts") ? "./pdf-extract-worker.ts" : "./pdf-extract-worker.js";
	return fileURLToPath(new URL(specifier, import.meta.url));
}

/**
 * Extract PDF text in a bounded child process.
 *
 * `pdf-parse` pulls in pdfjs and a native image binding: roughly half a second
 * of load time, tens of MiB resident, and a failure mode that a `try`/`catch`
 * in this process cannot contain. Running it out-of-process keeps the Gateway
 * event loop free, bounds time, heap, and output, and turns every failure into
 * a notice instead of a dead session.
 */
async function extractPdf(
	content: Buffer,
	maxChars: number,
	options: PdfExtractionOptions
): Promise<ArtifactExtraction> {
	const worker = options.workerPath ?? defaultPdfWorkerPath();
	const timeoutMs = options.timeoutMs ?? DEFAULT_PDF_TIMEOUT_MS;
	const maxOutputBytes = maxChars * 4 + 4096;
	const args = [
		// Production runs the compiled worker; dev and tests run the TypeScript source.
		...(worker.endsWith(".ts") ? ["--import", "tsx"] : []),
		`--max-old-space-size=${options.maxOldSpaceMb ?? DEFAULT_PDF_MAX_OLD_SPACE_MB}`,
		worker,
		String(maxChars),
	];
	return await new Promise<ArtifactExtraction>((resolve) => {
		const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "ignore"] });
		let stdout = "";
		let bytes = 0;
		let settled = false;
		const finish = (result: ArtifactExtraction): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGKILL");
			resolve(result);
		};
		const timer = setTimeout(() => finish({ notice: PDF_TIMEOUT_NOTICE }), timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			bytes += Buffer.byteLength(chunk);
			if (bytes > maxOutputBytes) {
				finish({ notice: PDF_FAILED_NOTICE });
				return;
			}
			stdout += chunk;
		});
		// A worker that dies before draining stdin would otherwise raise EPIPE here.
		child.stdin.on("error", () => {});
		child.on("error", () => finish({ notice: PDF_FAILED_NOTICE }));
		child.on("close", (code) => {
			if (code !== 0) {
				finish({ notice: PDF_FAILED_NOTICE });
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(stdout);
			} catch {
				finish({ notice: PDF_FAILED_NOTICE });
				return;
			}
			const reply = parsed as { text?: unknown; notice?: unknown };
			if (typeof reply.text === "string") {
				finish(reply.text ? { text: reply.text } : { notice: PDF_EMPTY_NOTICE });
				return;
			}
			finish({ notice: typeof reply.notice === "string" ? reply.notice : PDF_FAILED_NOTICE });
		});
		child.stdin.end(content);
	});
}

export async function extractArtifact(
	input: { name: string; mimeType: string; content: Buffer },
	maxChars = 200_000,
	pdf: PdfExtractionOptions = {}
): Promise<ArtifactExtraction> {
	const suffix = extension(input.name);
	if (DOCX_MIMES.has(input.mimeType) || suffix === ".docx" || suffix === ".docm") {
		return extractDocx(input.content, maxChars);
	}
	if (input.mimeType === "application/pdf" || suffix === ".pdf") {
		return extractPdf(input.content, maxChars, pdf);
	}
	return {};
}

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export interface ArtifactExtraction {
	text?: string;
	notice?: string;
}

const DOCX_MIMES = new Set([
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-word.document.macroenabled.12",
]);

function extension(name: string): string {
	const index = name.lastIndexOf(".");
	return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function boundedText(value: string, maxChars: number): string {
	const normalized = value.replaceAll("\0", "").replaceAll("\r\n", "\n").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}\n\n[Attachment text truncated after ${maxChars} characters]`;
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

async function extractPdf(content: Buffer, maxChars: number): Promise<ArtifactExtraction> {
	const parser = new PDFParse({
		data: new Uint8Array(content),
		isEvalSupported: false,
		stopAtErrors: false,
		useWasm: false,
	});
	try {
		const result = await parser.getText();
		const text = boundedText(result.text, maxChars);
		return text ? { text } : { notice: "The PDF attachment contains no extractable text; it may be image-only." };
	} catch {
		return { notice: "The PDF attachment was uploaded, but its text could not be extracted." };
	} finally {
		await parser.destroy().catch(() => {});
	}
}

export async function extractArtifact(
	input: { name: string; mimeType: string; content: Buffer },
	maxChars = 200_000,
): Promise<ArtifactExtraction> {
	const suffix = extension(input.name);
	if (DOCX_MIMES.has(input.mimeType) || suffix === ".docx" || suffix === ".docm") {
		return extractDocx(input.content, maxChars);
	}
	if (input.mimeType === "application/pdf" || suffix === ".pdf") {
		return extractPdf(input.content, maxChars);
	}
	return {};
}

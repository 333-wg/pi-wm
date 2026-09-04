/**
 * One-shot PDF text extraction, isolated in its own process.
 *
 * The parent writes the PDF bytes to stdin and reads a single JSON object from
 * stdout. Keeping `pdf-parse` (and therefore pdfjs plus its native image
 * bindings) out of the Gateway process means a hostile, oversized, or simply
 * unlucky attachment cannot stall or kill the process that serves every live
 * session, and the Gateway does not pay the loader cost at startup.
 */
import { PDFParse } from "pdf-parse";
import { boundedText } from "./bounded-text.js";

const EMPTY_NOTICE = "The PDF attachment contains no extractable text; it may be image-only.";
const FAILED_NOTICE = "The PDF attachment was uploaded, but its text could not be extracted.";
const DEFAULT_MAX_CHARS = 200_000;

function reply(value: { text: string } | { notice: string }): void {
	// pdfjs can leave timers behind, so exit explicitly once stdout has flushed.
	process.stdout.write(JSON.stringify(value), () => process.exit(0));
}

async function readStdin(): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

const requested = Number.parseInt(process.argv[2] ?? "", 10);
const maxChars = Number.isSafeInteger(requested) && requested > 0 ? requested : DEFAULT_MAX_CHARS;
const content = await readStdin();
const parser = new PDFParse({
	data: new Uint8Array(content),
	isEvalSupported: false,
	stopAtErrors: false,
	useWasm: false,
});
try {
	const result = await parser.getText();
	const text = boundedText(result.text, maxChars);
	reply(text ? { text } : { notice: EMPTY_NOTICE });
} catch {
	reply({ notice: FAILED_NOTICE });
} finally {
	await parser.destroy().catch(() => {});
}

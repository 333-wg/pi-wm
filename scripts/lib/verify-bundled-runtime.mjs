import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { releaseEnvironment } from "./desktop-release.mjs";

export async function verifyBundledRuntime(runtime) {
	const code = `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { PDFParse } from 'pdf-parse';
import { createCanvas } from '@napi-rs/canvas';
new DatabaseSync(':memory:').close();
const canvas = createCanvas(8, 8);
const context = canvas.getContext('2d');
context.fillStyle = '#ff0000';
context.fillRect(0, 0, 8, 8);
assert.equal(context.getImageData(0, 0, 1, 1).data[0], 255);
const browser = await chromium.launch({ headless: true });
let parser;
try {
  const page = await browser.newPage();
  await page.setContent('<h1>PI_WM_PDF_PROOF</h1>');
  const pdf = await page.pdf();
  parser = new PDFParse({ data: new Uint8Array(pdf), isEvalSupported: false, useWasm: false });
  assert.match((await parser.getText()).text, /PI_WM_PDF_PROOF/);
} finally {
  await parser?.destroy();
  await browser.close();
}
process.stdout.write('Bundled Chromium, PDF extraction, native canvas, and SQLite passed\\n', () => process.exit(0));
`;
	const { stdout } = await promisify(execFile)(join(runtime, "node.exe"), ["--input-type=module", "-e", code], {
		cwd: runtime,
		env: { ...releaseEnvironment(process.env), PLAYWRIGHT_BROWSERS_PATH: join(runtime, "browsers") },
		windowsHide: true,
		timeout: 60_000,
		maxBuffer: 1024 * 1024,
	});
	console.log(stdout.trim());
}

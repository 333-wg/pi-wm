import { ArtifactError } from "./errors.js";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const FILE_MIMES = new Map([
	[".doc", "application/msword"],
	[".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	[".docm", "application/vnd.ms-word.document.macroenabled.12"],
	[".epub", "application/epub+zip"],
	[".odp", "application/vnd.oasis.opendocument.presentation"],
	[".ods", "application/vnd.oasis.opendocument.spreadsheet"],
	[".odt", "application/vnd.oasis.opendocument.text"],
	[".pdf", "application/pdf"],
	[".ppt", "application/vnd.ms-powerpoint"],
	[".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
	[".rtf", "application/rtf"],
	[".xls", "application/vnd.ms-excel"],
	[".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	[".zip", "application/zip"],
]);
const TEXT_APPLICATION_MIMES = new Set([
	"application/json",
	"application/ld+json",
	"application/xml",
	"application/javascript",
	"application/x-javascript",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
]);

export interface ArtifactValidationOptions {
	maxFileBytes?: number;
	maxImageBytes?: number;
	maxVideoBytes?: number;
	maxTextBytes?: number;
	maxImagePixels?: number;
}

export interface ValidatedArtifact {
	name: string;
	mimeType: string;
	kind: "binary" | "image" | "text";
	width?: number;
	height?: number;
}

function safeName(input: string): string {
	const name = input.trim();
	if (!name || name.length > 255 || /[\\/\0\r\n]/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) {
		throw new ArtifactError("invalid", "Artifact name must be a plain filename of at most 255 characters");
	}
	if (name === "." || name === "..") throw new ArtifactError("invalid", "Artifact name is invalid");
	return name;
}

function imageType(content: Buffer): string | undefined {
	if (
		content.length >= 45 &&
		content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
		content.subarray(-8, -4).toString("ascii") === "IEND"
	)
		return "image/png";
	if (content.length >= 10 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
	const header = content.subarray(0, 6).toString("ascii");
	if (content.length >= 14 && (header === "GIF87a" || header === "GIF89a") && content[content.length - 1] === 0x3b)
		return "image/gif";
	if (
		content.length >= 30 &&
		content.subarray(0, 4).toString("ascii") === "RIFF" &&
		content.subarray(8, 12).toString("ascii") === "WEBP" &&
		content.readUInt32LE(4) + 8 === content.length
	)
		return "image/webp";
	return undefined;
}

function jpegDimensions(content: Buffer): { width: number; height: number } | undefined {
	const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
	let offset = 2;
	let dimensions: { width: number; height: number } | undefined;
	let inScan = false;
	let sawScan = false;
	// Skip metadata segments; embedded thumbnail markers cannot terminate the image.
	// Local exports may retain bytes after the actual end-of-image marker.
	while (offset < content.length) {
		if (inScan) {
			offset = content.indexOf(0xff, offset);
			if (offset < 0) return undefined;
		}
		if (content[offset] !== 0xff) return undefined;
		while (content[offset] === 0xff) offset += 1;
		const marker = content[offset++];
		if (marker === undefined) return undefined;
		if (inScan && (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7))) continue;
		if (marker === 0xd9) return sawScan ? dimensions : undefined;
		if (marker === 0x01) continue;
		if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return undefined;
		if (offset + 2 > content.length) return undefined;
		const length = content.readUInt16BE(offset);
		if (length < 2 || offset + length > content.length) return undefined;
		if (sof.has(marker)) {
			if (length < 8) return undefined;
			dimensions = { height: content.readUInt16BE(offset + 3), width: content.readUInt16BE(offset + 5) };
		}
		if (marker === 0xda) {
			if (!dimensions || length < 6) return undefined;
			sawScan = true;
			inScan = true;
		} else if (marker !== 0xdc) {
			inScan = false;
		}
		offset += length;
	}
	return undefined;
}

function webpDimensions(content: Buffer): { width: number; height: number } | undefined {
	const kind = content.subarray(12, 16).toString("ascii");
	if (kind === "VP8X" && content.length >= 30) {
		return { width: 1 + content.readUIntLE(24, 3), height: 1 + content.readUIntLE(27, 3) };
	}
	if (kind === "VP8 " && content.length >= 30 && content.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
		return { width: content.readUInt16LE(26) & 0x3fff, height: content.readUInt16LE(28) & 0x3fff };
	}
	if (kind === "VP8L" && content.length >= 25 && content[20] === 0x2f) {
		const bits = content.readUInt32LE(21);
		return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
	}
	return undefined;
}

function imageDimensions(mimeType: string, content: Buffer): { width: number; height: number } | undefined {
	if (mimeType === "image/png") return { width: content.readUInt32BE(16), height: content.readUInt32BE(20) };
	if (mimeType === "image/gif") return { width: content.readUInt16LE(6), height: content.readUInt16LE(8) };
	if (mimeType === "image/jpeg") return jpegDimensions(content);
	return webpDimensions(content);
}

function normalizedSuppliedMime(input: string | undefined): string | undefined {
	const value = input?.split(";", 1)[0]?.trim().toLowerCase();
	return value && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) ? value : undefined;
}

function inferredMimeType(name: string, supplied: string | undefined): string {
	if (supplied && supplied !== "application/octet-stream") return supplied;
	const index = name.lastIndexOf(".");
	return FILE_MIMES.get(index >= 0 ? name.slice(index).toLowerCase() : "") ?? "application/octet-stream";
}

export function validateArtifact(
	input: { name: string; suppliedMimeType?: string; content: Buffer },
	options: ArtifactValidationOptions = {}
): ValidatedArtifact {
	const name = safeName(input.name);
	const supplied = normalizedSuppliedMime(input.suppliedMimeType);
	const video =
		input.content.length >= 24 &&
		input.content.subarray(4, 8).toString("ascii") === "ftyp" &&
		/^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash)$/.test(input.content.subarray(8, 12).toString("ascii"))
			? "video/mp4"
			: input.content.length >= 16 &&
				  input.content.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
				  input.content.subarray(4, 256).includes(Buffer.from("webm"))
				? "video/webm"
				: undefined;
	if (video) {
		if (supplied && supplied !== video && supplied !== "application/octet-stream")
			throw new ArtifactError("invalid", `Content is ${video}, not ${supplied}`);
		if (input.content.length > (options.maxVideoBytes ?? options.maxFileBytes ?? 10 * 1024 * 1024))
			throw new ArtifactError("too_large", "Video exceeds the artifact limit");
		return { name, mimeType: video, kind: "binary" };
	}
	if (supplied === "video/mp4" || supplied === "video/webm")
		throw new ArtifactError("invalid", `Content does not match ${supplied}`);
	if (input.content.length > (options.maxFileBytes ?? 10 * 1024 * 1024))
		throw new ArtifactError("too_large", "File exceeds the upload limit");
	if (input.content.length === 0) {
		if (supplied && IMAGE_MIMES.has(supplied)) throw new ArtifactError("invalid", "Image file is empty");
		return { name, mimeType: inferredMimeType(name, supplied), kind: "binary" };
	}
	const detectedImage = imageType(input.content);
	if (detectedImage) {
		// Browser File.type is only a hint, often derived from the local extension.
		if (input.content.length > (options.maxImageBytes ?? 10 * 1024 * 1024))
			throw new ArtifactError("too_large", "Image exceeds the upload limit");
		const dimensions = imageDimensions(detectedImage, input.content);
		if (!dimensions || dimensions.width < 1 || dimensions.height < 1)
			throw new ArtifactError("invalid", "Image dimensions are invalid or unsupported");
		if (dimensions.width * dimensions.height > (options.maxImagePixels ?? 40_000_000)) {
			throw new ArtifactError("too_large", "Image pixel dimensions exceed the limit");
		}
		return { name, mimeType: detectedImage, kind: "image", ...dimensions };
	}
	if (supplied && IMAGE_MIMES.has(supplied)) throw new ArtifactError("invalid", `Content does not match ${supplied}`);
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.content);
	} catch {
		return { name, mimeType: inferredMimeType(name, supplied), kind: "binary" };
	}
	if (decoded.includes("\0")) return { name, mimeType: inferredMimeType(name, supplied), kind: "binary" };
	if (input.content.length > (options.maxTextBytes ?? 2 * 1024 * 1024))
		throw new ArtifactError("too_large", "Text artifact exceeds the upload limit");
	return {
		name,
		mimeType:
			supplied && (supplied.startsWith("text/") || TEXT_APPLICATION_MIMES.has(supplied)) ? supplied : "text/plain",
		kind: "text",
	};
}

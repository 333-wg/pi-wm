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
	) return "image/png";
	if (
		content.length >= 10 &&
		content[0] === 0xff &&
		content[1] === 0xd8 &&
		content[2] === 0xff &&
		content[content.length - 2] === 0xff &&
		content[content.length - 1] === 0xd9
	) return "image/jpeg";
	const header = content.subarray(0, 6).toString("ascii");
	if (content.length >= 14 && (header === "GIF87a" || header === "GIF89a") && content[content.length - 1] === 0x3b) return "image/gif";
	if (
		content.length >= 30 &&
		content.subarray(0, 4).toString("ascii") === "RIFF" &&
		content.subarray(8, 12).toString("ascii") === "WEBP" &&
		content.readUInt32LE(4) + 8 === content.length
	) return "image/webp";
	return undefined;
}

function jpegDimensions(content: Buffer): { width: number; height: number } | undefined {
	const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
	let offset = 2;
	while (offset + 8 < content.length) {
		if (content[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		while (content[offset] === 0xff) offset += 1;
		const marker = content[offset];
		if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 1;
			continue;
		}
		const length = content.readUInt16BE(offset + 1);
		if (length < 2 || offset + 1 + length > content.length) break;
		if (sof.has(marker)) {
			return { height: content.readUInt16BE(offset + 4), width: content.readUInt16BE(offset + 6) };
		}
		offset += 1 + length;
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
	options: ArtifactValidationOptions = {},
): ValidatedArtifact {
	const name = safeName(input.name);
	if (input.content.length > (options.maxFileBytes ?? 10 * 1024 * 1024)) throw new ArtifactError("too_large", "File exceeds the upload limit");
	const supplied = normalizedSuppliedMime(input.suppliedMimeType);
	if (input.content.length === 0) return { name, mimeType: inferredMimeType(name, supplied), kind: "binary" };
	const detectedImage = imageType(input.content);
	if (detectedImage) {
		if (supplied && supplied !== detectedImage) throw new ArtifactError("invalid", `Content is ${detectedImage}, not ${supplied}`);
		if (input.content.length > (options.maxImageBytes ?? 10 * 1024 * 1024)) throw new ArtifactError("too_large", "Image exceeds the upload limit");
		const dimensions = imageDimensions(detectedImage, input.content);
		if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new ArtifactError("invalid", "Image dimensions are invalid or unsupported");
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
	if (input.content.length > (options.maxTextBytes ?? 2 * 1024 * 1024)) throw new ArtifactError("too_large", "Text artifact exceeds the upload limit");
	return { name, mimeType: supplied && (supplied.startsWith("text/") || TEXT_APPLICATION_MIMES.has(supplied)) ? supplied : "text/plain", kind: "text" };
}

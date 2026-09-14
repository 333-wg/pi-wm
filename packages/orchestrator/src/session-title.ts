import type { TranscriptItem, UserContentPart } from "@wuming/protocol";

const GENERATED_TITLE_MAX_CHARS = 48;
const SESSION_NAME_MAX_CHARS = 500;
const LEGACY_FORK_TITLE = /^Session(?: \(fork\))+$/i;

function compact(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^#{1,6}\s+/, "")
		.trim();
}

function truncate(value: string, maxChars: number): string {
	const characters = Array.from(value);
	if (characters.length <= maxChars) return value;
	let shortened = characters
		.slice(0, maxChars - 1)
		.join("")
		.trimEnd();
	const lastSpace = shortened.lastIndexOf(" ");
	if (lastSpace >= Math.floor(maxChars * 0.6)) shortened = shortened.slice(0, lastSpace);
	return `${shortened.replace(/[,;:-]+$/, "")}…`;
}

export function suggestSessionTitle(content: readonly UserContentPart[]): string | undefined {
	const text = compact(
		content
			.filter((part): part is Extract<UserContentPart, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join(" ")
	);
	if (text) return truncate(text, GENERATED_TITLE_MAX_CHARS);

	const attachments = compact(
		content
			.filter((part): part is Extract<UserContentPart, { type: "artifact" }> => part.type === "artifact")
			.map((part) => part.artifact.name)
			.join(", ")
	);
	return attachments ? truncate(attachments, GENERATED_TITLE_MAX_CHARS) : undefined;
}

export function suggestSessionTitleFromTranscript(transcript: readonly TranscriptItem[]): string | undefined {
	for (const item of transcript) {
		if (item.type !== "user") continue;
		const title = suggestSessionTitle(
			item.content.filter((part): part is UserContentPart => part.type === "text" || part.type === "artifact")
		);
		if (title) return title;
	}
	return undefined;
}

export function isAutomaticSessionTitle(name: string | undefined): boolean {
	return name === undefined || LEGACY_FORK_TITLE.test(name.trim());
}

export function appendForkTitle(title: string): string {
	return truncate(`${title.replace(/(?: \(fork\))+$/i, "")} (fork)`, SESSION_NAME_MAX_CHARS);
}

export function wasLegacyForkTitle(name: string | undefined): boolean {
	return name !== undefined && LEGACY_FORK_TITLE.test(name.trim());
}

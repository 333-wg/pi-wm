import type { MediaConnection } from "./media-models.js";

export type VideoProtocol = "openai" | "agnes";

export function videoProtocol(config: MediaConnection): VideoProtocol {
	const url = new URL(config.baseUrl);
	return url.origin === "https://apihub.agnes-ai.com" &&
		["", "/v1"].includes(url.pathname.replace(/\/+$/, "")) &&
		config.model === "agnes-video-v2.0"
		? "agnes"
		: "openai";
}

export function videoRequest(
	config: MediaConnection,
	params: { prompt: string; size?: string; seconds?: number }
): { protocol: VideoProtocol; body: BodyInit; json: boolean } {
	const protocol = videoProtocol(config);
	if (protocol === "agnes") {
		const seconds = params.seconds ?? 5;
		if (!Number.isInteger(seconds) || seconds < 1 || seconds > 18)
			throw new Error("Agnes video supports 1-18 seconds at 24 fps. Choose a shorter duration before submitting.");
		const dimensions = /^(\d{2,4})x(\d{2,4})$/.exec(params.size ?? "1152x768");
		if (!dimensions || Number(dimensions[1]) < 1 || Number(dimensions[2]) < 1)
			throw new Error("Invalid Agnes video size; expected WIDTHxHEIGHT.");
		return {
			protocol,
			json: true,
			body: JSON.stringify({
				model: config.model,
				prompt: params.prompt,
				width: Number(dimensions[1]),
				height: Number(dimensions[2]),
				// Agnes requires 8n + 1 frames, with at most 441 frames per task.
				num_frames: seconds * 24 + 1,
				frame_rate: 24,
			}),
		};
	}
	const form = new FormData();
	form.set("model", config.model);
	form.set("prompt", params.prompt);
	if (params.size) form.set("size", params.size);
	if (params.seconds !== undefined) form.set("seconds", String(params.seconds));
	return { protocol, body: form, json: false };
}

export function videoResultResource(config: MediaConnection, protocol: VideoProtocol, remoteId: string): string | URL {
	if (protocol !== "agnes") return `videos/${encodeURIComponent(remoteId)}`;
	const url = new URL("/agnesapi", config.baseUrl);
	url.searchParams.set("video_id", remoteId);
	url.searchParams.set("model_name", config.model);
	return url;
}
